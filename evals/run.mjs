// Opt-in, model-in-the-loop eval harness for pi-flows — now gated by thulr.
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
//   npm run eval -- --cap=1.00            # per-case USD ceiling on flow delegations (default 0.50)
//   npm run eval -- --judge-model=anthropic/claude-opus-4-8   # thulr judge model (default below)
//   npm run eval -- --write-baseline      # promote this run to evals/thulr-baseline.json (the gate baseline)
//   npm run eval -- --compare-baseline=evals/thulr-baseline.json   # gate against a specific baseline
//   npm run eval -- --dry-run             # framework smoke (canned results, no model, no thulr calls)
//
// For the flows-vs-plain A/B ("does pi-flows beat plain pi?") see `npm run eval:compare`.
//
// Two axes, decomposed (not one god-metric):
//   1. an objective, deterministic check per case (the chosen route, a known
//      answer, a passing gate) — this gates BEHAVIOUR and becomes the
//      objectiveScore label thulr calibrates its judge against.
//   2. thulr's calibrated LLM judge grades each case's answer against one literal
//      criterion, then gates QUALITY regressions vs a baseline EvalRun. The judge
//      runs on a different vendor than the subject (default anthropic/claude-
//      sonnet-4-6) so it never grades its own family.
//
// The harness emits ONE self-contained trace (evals/thulr-trace.jsonl) — each case's
// answer, criterion, and objective label inline — and shells out to the `thulr` CLI
// for judge -> calibrate -> gate -> baseline. thulr 0.1.1 reads everything from the
// trace, so there are no separate cases-manifest or labels files.
//
// Exit code is 0 when every selected case passes (objective AND thulr criterion)
// and thulr's gate reports no regression; 1 otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CASES } from "./cases.mjs";
import { caseCwd, flowTool, scoreObjective, DEFAULT_EVAL_MODEL } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import * as thulr from "./thulr.mjs";

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
const has = (name) => args.includes(`--${name}`) || args.some((a) => a.startsWith(`--${name}=`));

const cliModel = flag("model", null);
const model = cliModel ?? DEFAULT_EVAL_MODEL;
const modelSource = cliModel ? "--model" : process.env.PI_FLOWS_EVAL_MODEL ? "PI_FLOWS_EVAL_MODEL" : "eval default";
// `--model=agent` (or empty) keeps each agent's own frontmatter model.
const useAgentModels = ["agent", "default", ""].includes(model);
const capUsd = Number(flag("cap", "0.50"));
// Per-agent timeout. Default 120s for remote models; crank it up for slow local
// models (llama.cpp etc.) that legitimately take minutes per turn — they're free,
// so a long ceiling beats spurious timeouts. Override: --timeout=600000 (ms) or PI_FLOWS_TIMEOUT_MS.
const timeoutMs = Number(flag("timeout", process.env.PI_FLOWS_TIMEOUT_MS ?? "120000"));
const dryRun = args.includes("--dry-run");
const filter = flag("filter", "");
// Cross-model judge: a different vendor than the subject under test breaks self-grading.
const judgeModel = flag("judge-model", null) ?? process.env.PI_FLOWS_JUDGE_MODEL ?? "anthropic/claude-sonnet-4-6";

const p = (relPath) => resolve(process.cwd(), relPath);
const rel = (abs) => (abs.startsWith(`${process.cwd()}/`) ? abs.slice(process.cwd().length + 1) : abs);
const TRACE = p("evals/thulr-trace.jsonl");
const CANDIDATE = p(".thulr/runs/candidate.json");
const BASELINE_DEFAULT = p("evals/thulr-baseline.json");

// Gate against an explicit baseline, else the default if it already exists (the
// first run has nothing to gate against and just seeds it via --write-baseline).
const compareFlag = flag("compare-baseline", null);
const gateBaseline = compareFlag ? p(compareFlag) : existsSync(BASELINE_DEFAULT) ? BASELINE_DEFAULT : null;
const writeBaseline = has("write-baseline") ? p(flag("write-baseline", "") || BASELINE_DEFAULT) : null;

function preflight() {
	if (dryRun) return true;
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore" });
	} catch {
		console.error("✗ `pi` was not found on PATH.\n  The eval harness needs the pi CLI and a configured model provider.\n  Install: npm i -g @earendil-works/pi-coding-agent\n  Or smoke-test the harness offline with: npm run eval -- --dry-run");
		return false;
	}
	if (!thulr.available()) {
		console.error("✗ `thulr` was not found on PATH.\n  The eval gate now judges answer quality and blocks regressions through thulr.\n  Install it (e.g. `cargo install thulr`) so it is on PATH,\n  or smoke-test the harness offline with: npm run eval -- --dry-run");
		return false;
	}
	return true;
}

async function main() {
	if (!preflight()) process.exit(2);

	const selected = CASES.filter((c) => !filter || c.name.includes(filter));
	if (selected.length === 0) {
		console.error(`No eval cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	console.log(`pi-flows evals  ·  subject ${useAgentModels ? "(agent frontmatter)" : model} (${modelSource})  ·  judge ${dryRun ? "(skipped)" : judgeModel}  ·  cap $${capUsd.toFixed(2)}/case  ·  timeout ${Math.round(timeoutMs / 1000)}s/agent${dryRun ? "  ·  DRY RUN" : ""}\n`);

	// --- Phase 1: run every flow, score the objective axis, emit the self-contained thulr trace ---
	thulr.startTrace(TRACE);
	let judgedCount = 0;
	const summaries = [];
	let totalCost = 0;
	let sawInfraError = false;
	for (const testCase of selected) {
		const flowCtx = { cwd: caseCwd(testCase, { dryRun }), hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
		const ctx = { flow, model: useAgentModels ? undefined : model, dryRun, flowCtx };
		const startedAt = Date.now();

		let result;
		let thrown;
		if (dryRun) {
			result = testCase.mock;
		} else {
			const params = { ...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params, model)), traceLabel: testCase.name, maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: testCase.params.timeoutMs ?? timeoutMs };
			try {
				result = await flow.execute(`eval:${testCase.name}`, params, new AbortController().signal, undefined, flowCtx);
			} catch (error) {
				thrown = error;
			}
		}

		const { objective, reachedModel, cost, answer } = await scoreObjective({ result, thrown, testCase, ctx });
		const endedAt = Date.now();
		totalCost += cost;
		if (reachedModel) sawInfraError = true;

		// Only cases that reached the model carry a real answer to judge and a
		// trustworthy label to calibrate against; infra failures are reported as ⚠.
		if (!reachedModel) {
			thulr.appendCaseSpans(TRACE, { name: testCase.name, answer, criterion: testCase.criterion, label: !!objective.pass, endMs: endedAt, model: useAgentModels ? undefined : model });
			judgedCount += 1;
		}

		// Hard cases are score-tracked (◐), not pass/fail — a partial objective score is expected.
		const status = reachedModel ? "⚠" : testCase.hard ? "◐" : objective.pass ? "✓" : "✗";
		const seconds = ((endedAt - startedAt) / 1000).toFixed(1);
		console.log(`${status} ${testCase.name.padEnd(34)} obj ${(objective.score ?? 0).toFixed(2)}  $${cost.toFixed(4)}  ${seconds}s`);
		console.log(`    ↳ ${reachedModel ?? objective.notes ?? ""}`);
		summaries.push({ name: testCase.name, hard: !!testCase.hard, objective, reachedModel, cost, durationMs: endedAt - startedAt });
	}
	const behaviourCases = summaries.filter((s) => !s.hard);
	const hardCount = summaries.length - behaviourCases.length;
	const objPassed = behaviourCases.filter((s) => !s.reachedModel && s.objective.pass).length;
	console.log(`\n${objPassed}/${behaviourCases.length} behaviour checks passed${hardCount ? `  ·  ${hardCount} hard case${hardCount === 1 ? "" : "s"} score-tracked` : ""}  ·  total $${totalCost.toFixed(4)}${dryRun ? "  (dry-run, no model)" : ""}`);

	// --- Phase 2: thulr judge -> calibrate -> gate -> baseline (skipped in dry-run) ---
	const verdicts = new Map();
	let gateResult = null;

	if (dryRun) {
		console.log(`\n(dry-run) emitted ${judgedCount} self-contained case(s) to ${rel(TRACE)}; thulr judge/gate skipped (no tokens).`);
	} else if (judgedCount === 0) {
		console.log("\nNo case reached the model — skipping thulr judge (nothing to grade).");
	} else {
		mkdirSync(dirname(CANDIDATE), { recursive: true });
		console.log(`\nthulr judge (${judgeModel})  ·  ${judgedCount} case${judgedCount === 1 ? "" : "s"}`);
		thulr.judge({ trace: TRACE, model: judgeModel, out: CANDIDATE });
		const evalRun = JSON.parse(readFileSync(CANDIDATE, "utf8"));
		for (const c of evalRun.cases ?? []) verdicts.set(c.case_id, c.dims?.criterion ?? {});
		for (const s of summaries) {
			if (s.reachedModel) continue;
			const v = verdicts.get(s.name) ?? {};
			const glyph = s.hard ? "◐" : v.verdict === false ? "✗" : "✓";
			console.log(`${glyph} ${s.name.padEnd(34)} criterion ${(v.score ?? 0).toFixed(2)}`);
		}

		// Calibration: how well the judge's verdicts track the deterministic labels.
		console.log("");
		process.stdout.write(thulr.calibrate(CANDIDATE));

		if (gateBaseline) {
			gateResult = thulr.gate({ baseline: gateBaseline, candidate: CANDIDATE, guardrails: ["criterion"], scoreGuardrails: ["criterion"], noiseBand: 0.05 });
			console.log(`\ngate vs ${rel(gateBaseline)}:`);
			process.stdout.write(gateResult.report);
		} else {
			console.log(`\nNo gate baseline yet (${rel(BASELINE_DEFAULT)} absent) — seed it with: npm run eval -- --write-baseline`);
		}

		if (writeBaseline) {
			if (gateResult?.blocks) {
				console.log(`\nNot promoting baseline: the gate reported a regression. Fix it before advancing ${rel(writeBaseline)}.`);
			} else {
				thulr.promoteBaseline({ input: CANDIDATE, output: writeBaseline });
				console.log(`\nPromoted this run to baseline: ${rel(writeBaseline)}`);
			}
		}
	}

	// A behaviour case passes only when its objective check AND thulr's criterion
	// agree (the two-axis contract). Hard cases are score-tracked, not pass-gated —
	// only a regression in their score (caught by --score-guardrail) blocks the run.
	const passed = behaviourCases.filter((s) => !s.reachedModel && s.objective.pass && (dryRun || verdicts.get(s.name)?.verdict !== false)).length;
	console.log(`\n${passed}/${behaviourCases.length} behaviour cases passed${hardCount ? `  ·  ${hardCount} hard score-tracked` : ""}${gateResult ? `  ·  gate ${gateResult.blocks ? "FAIL" : "ok"}` : ""}`);

	if (sawInfraError) {
		console.log("\n⚠ Some cases could not reach the model (auth, credits, network, or timeout) — that's an environment issue, not an eval failure.\n  Fixes: add credits / `pi` /login, set a provider key in .env (see .env.example), or pass --model=<provider/id> for a provider you have quota on.");
	}
	process.exit(passed === behaviourCases.length && !gateResult?.blocks ? 0 : 1);
}

main().catch((error) => {
	console.error(`eval harness failed: ${error?.stack ?? error}`);
	process.exit(1);
});
