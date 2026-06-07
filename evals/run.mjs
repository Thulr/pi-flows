// Opt-in, model-in-the-loop eval harness for pi-flows.
//
// Unlike `npm test` (offline, deterministic, no model), this drives REAL `flow`
// delegations through REAL `pi` and scores agent/flow behaviour — so it needs the
// `pi` CLI on PATH and a configured model provider, and it spends tokens. It is
// intentionally NOT part of `npm run check`.
//
//   npm run eval                          # use your pi default model/provider
//   npm run eval -- --filter=route        # only matching cases
//   npm run eval -- --model=openai-codex/gpt-5.5   # provider/id (OAuth providers need the prefix)
//   npm run eval -- --model=agent         # use each agent's own frontmatter model
//   npm run eval -- --cap=1.00            # per-case USD ceiling (default 0.50)
//   npm run eval -- --judge-model=anthropic/claude-opus-4-8   # cross-model judge (default below)
//   npm run eval -- --write-baseline=evals/baseline.json
//   npm run eval -- --compare-baseline=evals/baseline.json
//   npm run eval -- --dry-run             # framework smoke (canned results, no model)
//
// For the flows-vs-plain A/B ("does pi-flows beat plain pi?") see `npm run eval:compare`.
//
// Model: with no --model, the harness uses your pi default (defaultProvider/
// defaultModel from ~/.pi/agent/settings.json), so it "just works" with whatever
// you run pi with. Auth is pi's own — an OAuth subscription (`pi` /login, stored
// in ~/.pi/agent/auth.json) or a provider API key (drop it in a gitignored .env;
// see .env.example).
//
// Judge: every case is ALSO graded by a cross-model LLM judge — a single tool-less
// `redteam` call (see judge.mjs) — so answer quality is checked independently of
// the subject model. Defaults to anthropic/claude-sonnet-4-6 (override with
// --judge-model or PI_FLOWS_JUDGE_MODEL). Point it at a different vendor than
// --model so the judge never grades its own model family. A case passes only when
// the objective check AND the judge agree.
//
// Exit code is 0 when every selected case passes, 1 otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CASES } from "./cases.mjs";
import { caseCwd, flowTool, piDefaultModel, scoreArm } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import { exportCases } from "./export-cases.mjs";

// Load a local .env (provider keys) if present, before any child pi inherits env.
const dotenvPath = join(process.cwd(), ".env");
if (existsSync(dotenvPath)) {
	try { process.loadEnvFile(dotenvPath); } catch { /* ignore a malformed .env */ }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const cliModel = flag("model", null);
const piDefault = piDefaultModel();
const model = cliModel ?? piDefault ?? "agent";
const modelSource = cliModel ? "--model" : piDefault ? "pi default" : "agent frontmatter";
// `--model=agent` (or empty) keeps each agent's own frontmatter model.
const useAgentModels = ["agent", "default", ""].includes(model);
const capUsd = Number(flag("cap", "0.50"));
const dryRun = args.includes("--dry-run");
const filter = flag("filter", "");
const writeBaseline = flag("write-baseline", "");
const compareBaseline = flag("compare-baseline", "");
// Cross-model judge: a different vendor than the subject under test breaks self-grading.
const judgeModel = flag("judge-model", null) ?? process.env.PI_FLOWS_JUDGE_MODEL ?? "anthropic/claude-sonnet-4-6";

function preflight() {
	if (dryRun) return true;
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		console.error("✗ `pi` was not found on PATH.\n  The eval harness needs the pi CLI and a configured model provider.\n  Install: npm i -g @earendil-works/pi-coding-agent\n  Or smoke-test the harness offline with: npm run eval -- --dry-run");
		return false;
	}
}

async function main() {
	if (!preflight()) process.exit(2);

	// Keep the external-evaluator manifest (evals/thulr-cases.json) in sync so tools
	// like thulr-evaluator can read each case's criterion without importing this JS.
	exportCases();

	const selected = CASES.filter((c) => !filter || c.name.includes(filter));
	if (selected.length === 0) {
		console.error(`No eval cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	console.log(`pi-flows evals  ·  subject ${useAgentModels ? "(agent frontmatter)" : model} (${modelSource})  ·  judge ${dryRun ? "(skipped)" : judgeModel}  ·  cap $${capUsd.toFixed(2)}/case${dryRun ? "  ·  DRY RUN" : ""}\n`);

	let passed = 0;
	let totalCost = 0;
	let sawInfraError = false;
	const summaries = [];
	for (const testCase of selected) {
		const flowCtx = { cwd: caseCwd(testCase, { dryRun }), hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
		const ctx = { flow, model: useAgentModels ? undefined : model, dryRun, flowCtx };
		const judgeCtx = { flow, model: judgeModel, dryRun, flowCtx };
		const startedAt = Date.now();

		let result;
		let thrown;
		if (dryRun) {
			result = testCase.mock;
		} else {
			const params = { ...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params, model)), traceLabel: testCase.name, maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: testCase.params.timeoutMs ?? 120000 };
			try {
				result = await flow.execute(`eval:${testCase.name}`, params, new AbortController().signal, undefined, flowCtx);
			} catch (error) {
				thrown = error;
			}
		}

		const { pass, score, objective, judged, reachedModel, cost } = await scoreArm({ result, thrown, testCase, ctx, judgeCtx });
		totalCost += cost;
		if (pass) passed++;
		if (!pass && reachedModel) sawInfraError = true;
		const status = pass ? "✓" : reachedModel ? "⚠" : "✗";
		const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`${status} ${testCase.name.padEnd(34)} score ${score.toFixed(2)}  $${cost.toFixed(4)}  ${seconds}s`);
		const breakdown = `obj ${(objective.score ?? 0).toFixed(2)}${objective.pass ? "" : "✗"} · judge ${(judged.score ?? 0).toFixed(2)}${judged.pass ? "" : "✗"}`;
		const reason = reachedModel ?? (pass ? (judged.reasoning && !judged.reasoning.startsWith("(") ? judged.reasoning : objective.notes) : !objective.pass ? objective.notes : judged.reasoning);
		console.log(`    ↳ ${breakdown}${reason ? `  ·  ${reason}` : ""}`);
		summaries.push({
			name: testCase.name,
			pass,
			score,
			objectiveScore: objective.score,
			judgeScore: judged.score,
			notes: objective.notes,
			judgeReasoning: judged.reasoning,
			infraError: reachedModel ?? null,
			cost,
			durationMs: Date.now() - startedAt,
		});
	}

	console.log(`\n${passed}/${selected.length} passed  ·  total $${totalCost.toFixed(4)}${dryRun ? "  (dry-run, no model)" : ""}`);
	const baselineRegressions = [];
	if (writeBaseline) {
		const baselinePath = resolve(process.cwd(), writeBaseline);
		writeFileSync(
			baselinePath,
			`${JSON.stringify({ createdAt: new Date().toISOString(), model: useAgentModels ? "agent" : model, judgeModel: dryRun ? null : judgeModel, filter, capUsd, cases: summaries }, null, 2)}\n`,
			"utf8",
		);
		console.log(`Wrote baseline: ${baselinePath}`);
	}
	if (compareBaseline) {
		const baselinePath = resolve(process.cwd(), compareBaseline);
		const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
		const current = new Map(summaries.map((summary) => [summary.name, summary]));
		for (const previous of baseline.cases ?? []) {
			const now = current.get(previous.name);
			if (!now) continue;
			if (previous.pass && !now.pass) baselineRegressions.push(`${previous.name}: pass -> fail`);
			else if (Number.isFinite(previous.score) && Number.isFinite(now.score) && now.score + 0.05 < previous.score) {
				baselineRegressions.push(`${previous.name}: score ${previous.score.toFixed(2)} -> ${now.score.toFixed(2)}`);
			}
		}
		if (baselineRegressions.length > 0) {
			console.log("\nBaseline regressions:");
			for (const regression of baselineRegressions) console.log(`  - ${regression}`);
		} else {
			console.log(`Compared baseline: ${baselinePath} (no regressions)`);
		}
	}
	if (sawInfraError) {
		console.log("\n⚠ Some cases could not reach the model (auth, credits, network, or timeout) — that's an environment issue, not an eval failure.\n  Fixes: add credits / `pi` /login, set a provider key in .env (see .env.example), or pass --model=<provider/id> for a provider you have quota on.");
	}
	process.exit(passed === selected.length && baselineRegressions.length === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(`eval harness failed: ${error?.stack ?? error}`);
	process.exit(1);
});
