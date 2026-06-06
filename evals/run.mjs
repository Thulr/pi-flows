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
//   npm run eval -- --write-baseline=evals/baseline.json
//   npm run eval -- --compare-baseline=evals/baseline.json
//   npm run eval -- --dry-run             # framework smoke (canned results, no model)
//
// Model: with no --model, the harness uses your pi default (defaultProvider/
// defaultModel from ~/.pi/agent/settings.json), so it "just works" with whatever
// you run pi with. Auth is pi's own — an OAuth subscription (`pi` /login, stored
// in ~/.pi/agent/auth.json) or a provider API key (drop it in a gitignored .env;
// see .env.example).
//
// Exit code is 0 when every selected case passes, 1 otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import { CASES } from "./cases.mjs";

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

// pi's configured default, e.g. "openai-codex/gpt-5.5" — used when no --model is given.
function piDefaultModel() {
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
		if (settings.defaultProvider && settings.defaultModel) return `${settings.defaultProvider}/${settings.defaultModel}`;
		return settings.defaultModel ?? null;
	} catch {
		return null;
	}
}

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

// Resolve a real `pi` from PATH rather than re-running this script. getPiInvocation
// falls through to { command: "pi" } when argv[1] is not an existing script file.
process.argv[1] = "";

function flowTool() {
	const tools = new Map();
	registerPiFlows({ registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
	return tools.get("flow");
}

// Push the chosen model into every agent reference the params expose, so a run does
// not silently fall back to pricier per-agent (frontmatter) defaults. maxCostUsd caps.
function injectModel(params) {
	const p = structuredClone(params);
	const ref = (r) => { if (r && typeof r === "object" && !r.model) r.model = model; };
	if (p.agent && !p.model) p.model = model;
	for (const t of p.tasks ?? []) ref(t);
	for (const s of p.chain ?? []) ref(s);
	if (p.evaluate) { ref(p.evaluate.operator); const critics = Array.isArray(p.evaluate.redteam) ? p.evaluate.redteam : [p.evaluate.redteam]; critics.forEach(ref); }
	if (p.vote) { (p.vote.voters ?? []).forEach(ref); ref(p.vote.debrief); }
	if (p.route) ref(p.route.controller);
	if (p.orchestrate) for (const k of ["commander", "recon", "debrief", "verify"]) ref(p.orchestrate[k]);
	return p;
}

const sumCost = (r) => (r?.details?.results ?? []).reduce((acc, x) => acc + (x?.usage?.cost ?? 0), 0);

// Distinguish "couldn't reach the model" (auth/credits/network/timeout) from "ran
// but scored low". Returns a short reason string, or null.
function infraError(result) {
	if (result?.details?.error) return result.details.error.message ?? String(result.details.error.code ?? "flow error");
	for (const child of result?.details?.results ?? []) {
		if (child?.error) return child.error.message ?? "child error";
		if ((typeof child?.exitCode === "number" && child.exitCode !== 0) || child?.stopReason === "error" || child?.stopReason === "timeout") {
			return child?.errorMessage ?? `child ${child.stopReason ?? "exited with error"}`;
		}
	}
	const text = result?.content?.[0]?.text ?? "";
	if (/"type":\s*"error"|invalid_request_error|authentication|out of (extra )?usage|rate.?limit|\b40[13]\b|api[_ -]?key/i.test(text)) return "provider/API error";
	return null;
}

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

	const selected = CASES.filter((c) => !filter || c.name.includes(filter));
	if (selected.length === 0) {
		console.error(`No eval cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	console.log(`pi-flows evals  ·  model ${useAgentModels ? "(agent frontmatter)" : model} (${modelSource})  ·  cap $${capUsd.toFixed(2)}/case${dryRun ? "  ·  DRY RUN" : ""}\n`);

	let passed = 0;
	let totalCost = 0;
	let sawInfraError = false;
	const summaries = [];
	for (const testCase of selected) {
		const flowCtx = { cwd: testCase.cwd ?? process.cwd(), hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
		const ctx = { flow, model: useAgentModels ? undefined : model, dryRun, flowCtx };
		const startedAt = Date.now();

		let result;
		let thrown;
		if (dryRun) {
			result = testCase.mock;
		} else {
			const params = { ...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params)), maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: testCase.params.timeoutMs ?? 120000 };
			try {
				result = await flow.execute(`eval:${testCase.name}`, params, new AbortController().signal, undefined, flowCtx);
			} catch (error) {
				thrown = error;
			}
		}

		let scored;
		if (thrown) {
			scored = { pass: false, score: 0, notes: `flow threw: ${thrown.message}` };
		} else {
			try {
				scored = await testCase.score(result, ctx);
			} catch (error) {
				scored = { pass: false, score: 0, notes: `scorer threw: ${error.message}` };
			}
		}

		const cost = sumCost(result);
		totalCost += cost;
		if (scored.pass) passed++;
		const reachedModel = thrown ? thrown.message : infraError(result);
		const status = scored.pass ? "✓" : reachedModel ? "⚠" : "✗";
		if (!scored.pass && reachedModel) sawInfraError = true;
		const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`${status} ${testCase.name.padEnd(34)} score ${scored.score.toFixed(2)}  $${cost.toFixed(4)}  ${seconds}s`);
		const note = scored.pass ? scored.notes : reachedModel ?? scored.notes;
		if (note) console.log(`    ↳ ${note}`);
		summaries.push({
			name: testCase.name,
			pass: scored.pass,
			score: scored.score,
			notes: scored.notes,
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
			`${JSON.stringify({ createdAt: new Date().toISOString(), model: useAgentModels ? "agent" : model, filter, capUsd, cases: summaries }, null, 2)}\n`,
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
