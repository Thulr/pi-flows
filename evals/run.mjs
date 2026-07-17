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
//   npm run eval -- --judge-bin=/path/to/judge-wrapper   # override thulr's judge command
//   npm run eval -- --samples=3           # judge each case 3x: majority verdict, mean score, judge-noise stddev + flake warnings
//   npm run eval -- --eval-set=.thulr/eval-sets/smoke.json   # overlay promoted criteria/authority metadata
//   npm run eval -- --reviews=.thulr/reviews/thulr-trace.reviews.json   # fold human SME verdicts into calibration (judge-vs-human TPR/TNR)
//   npm run eval -- --efficiency-guardrail=cost_usd --efficiency-guardrail=tokens   # fail on spend/size regressions
//   npm run eval -- --score-guardrail=evidence_quality   # also gate a named-criteria dimension's score (criterion is always gated)
//   npm run eval -- --noise-band=0.10    # judge/efficiency regression tolerance (default 0.05)
//   npm run eval -- --write-baseline      # promote this run to evals/thulr-baseline.json (the gate baseline)
//   npm run eval -- --compare-baseline=evals/thulr-baseline.json   # gate against a specific baseline
//   npm run eval -- --junit=.thulr/runs/gate.junit.xml   # also write the gate verdict as a JUnit XML testsuite (CI ingestion)
//   npm run eval -- --trace-only --trace-out=/tmp/t.jsonl   # run flows + emit the trace, no judge/gate — the
//                                         # command-template mode for `thulr run-experiment` / `thulr optimize`
//   npm run eval -- --dry-run             # framework smoke (canned results, no model, no thulr calls)
//   npm run eval:select                   # parent-model tool-selection discipline
//
// For the flows-vs-plain A/B ("does pi-flows beat plain pi?") see `npm run eval:compare`.
// For "should the parent model call flow at all?" see `npm run eval:select`.
//
// Two axes, decomposed (not one god-metric):
//   1. an objective, deterministic check per case (the chosen route, a known
//      answer, a passing gate) — this gates BEHAVIOUR and becomes the
//      objectiveScore label thulr calibrates its judge against.
//   2. thulr's calibrated LLM judge grades each case's answer against one literal
//      criterion, then gates QUALITY regressions vs a baseline EvalRun. The judge
//      runs on a different vendor than the subject (default anthropic/claude-
//      haiku-4-5 — cheap models on both axes) so it never grades its own family.
// Fixed calibration canaries are appended to the trace as known-bad/partial
// answers; they measure judge TNR and partial-score behavior, but never count as
// behaviour or release-gate rows.
//
// The harness emits ONE self-contained trace (evals/thulr-trace.jsonl) — each case's
// answer, criterion, objective label, task text, expected behavior, failure labels,
// config/prompt version, and cost/token telemetry inline —
// and shells out to the `thulr` CLI for judge -> calibrate -> gate ->
// baseline. thulr reads everything from the trace, so there are no separate
// cases-manifest or labels files.
//
// Exit code is 0 when every selected case passes (objective AND thulr criterion)
// and thulr's gate reports no regression; 1 otherwise. In --trace-only mode the
// exit code only says whether a judgeable trace was emitted — the driver
// (thulr run-experiment / optimize) owns judging and selection.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CALIBRATION_CASES, CASES } from "./cases.mjs";
import { caseCwd, exclusionForRun, flowTool, scoreObjective, shouldJudgeProductSpans, subjectModelName, sumTokens, DEFAULT_EVAL_MODEL, timeoutPlanForCase } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import * as thulr from "./thulr.mjs";

process.env.PI_FLOWS_CHILD_NO_EXTENSIONS = "1";

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
const positiveNumberFlag = (name) => {
	if (!has(name)) return null;
	const value = Number(flag(name, "0"));
	if (!Number.isFinite(value) || value <= 0) {
		console.error(`--${name} must be a positive number of milliseconds`);
		process.exit(2);
	}
	return value;
};
const flags = (name) => args
	.filter((a) => a.startsWith(`--${name}=`))
	.flatMap((a) => a.slice(name.length + 3).split(",").map((x) => x.trim()).filter(Boolean));

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
const armTimeoutMs = positiveNumberFlag("arm-timeout");
const dryRun = args.includes("--dry-run");
const filter = flag("filter", "");
const includeControls = has("include-controls") || filter.length > 0;
// Cross-model judge: a different vendor than the subject under test breaks
// self-grading. Default is the cheap anthropic tier — the suite standardizes on
// cheap models for both axes; escalate per-run (--judge-model=anthropic/claude-
// sonnet-4-6) when a verdict needs a stronger second opinion.
const judgeModel = flag("judge-model", null) ?? process.env.PI_FLOWS_JUDGE_MODEL ?? "anthropic/claude-haiku-4-5";
// Judge repeat-sampling: each case judged N times, majority verdict +
// mean score; the EvalRun's score_stddev becomes judge noise. Costs N× judge spend.
const samples = Math.min(10, Math.max(1, Number(flag("samples", "1")) || 1));
const evalSet = flag("eval-set", null);
const redaction = flag("redaction", null);
const rate = Number(flag("rate", "0"));
const efficiencyGuardrails = flags("efficiency-guardrail");
// Opt-in per-dimension SCORE guardrails beyond the always-on `criterion`: name a
// thulr.criteria.<dimension> (e.g. --score-guardrail=evidence_quality) to fail the
// gate when that named dimension's mean score regresses. Off by default so a new
// dimension is observed for a few runs before it can block.
const extraScoreGuardrails = flags("score-guardrail");
const noiseBand = Number(flag("noise-band", "0.05"));
// Emit-the-trace-and-stop: the command-template mode `thulr run-experiment` and
// `thulr optimize` drive ("the template MUST emit a structured JSONL trace to {out}").
const traceOnly = has("trace-only");

const p = (relPath) => resolve(process.cwd(), relPath);
const rel = (path) => (path.startsWith(`${process.cwd()}/`) ? path.slice(process.cwd().length + 1) : path);
const stableRepoPath = (path) => path ? rel(path) : path;
const configuredJudgeBin = flag("judge-bin", null) ?? process.env.THULR_JUDGE_BIN ?? null;
const judgeBin = configuredJudgeBin ? stableRepoPath(configuredJudgeBin) : null;
process.env.PI_FLOWS_JUDGE_MODEL = judgeModel;
// Dry-run gets its own trace path: mock spans must never clobber the last real
// trace (which re-judging with a different judge model depends on).
const TRACE = p(flag("trace-out", dryRun ? "evals/thulr-trace.dry-run.jsonl" : "evals/thulr-trace.jsonl"));
const CANDIDATE = p(".thulr/runs/candidate.json");
const GATE_CANDIDATE = p(".thulr/runs/candidate.gate.json");
const BASELINE_DEFAULT = p("evals/thulr-baseline.json");
// Reproducibility stamp for the trace/EvalRun: the agent prompts ship with the
// package, so the package version IS the prompt version.
const PROMPT_VERSION = `pi-flows@${JSON.parse(readFileSync(p("package.json"), "utf8")).version}`;
const CONFIG_VERSION = `pi-flows-eval:${useAgentModels ? "agent-frontmatter" : model}`;
// Optional CI artifact: the gate verdict re-rendered as a JUnit XML testsuite.
const junitOut = has("junit") ? p(flag("junit", "") || ".thulr/runs/gate.junit.xml") : null;

// Gate against an explicit baseline, else the default if it already exists (the
// first run has nothing to gate against and just seeds it via --write-baseline).
const compareFlag = flag("compare-baseline", null);
const gateBaseline = compareFlag ? p(compareFlag) : existsSync(BASELINE_DEFAULT) ? BASELINE_DEFAULT : null;
const writeBaseline = has("write-baseline") ? p(flag("write-baseline", "") || BASELINE_DEFAULT) : null;
const LABELS = p(".thulr/runs/candidate.labels.json");
// Human-review calibration (thulr review): an SME verdict set folded into
// `thulr calibrate` as judge-vs-human ground truth (TPR/TNR) on top of the
// deterministic-label axis. Defaults to the path `thulr review` writes for this
// trace, so recording a verdict (`npm run eval:review -- --case <id> --verdict
// <pass|fail>`) is enough — the next `npm run eval` picks it up with no flag.
const reviewsFlag = flag("reviews", null);
const reviewsDefault = p(`.thulr/reviews/${basename(TRACE).replace(/\.jsonl$/, "")}.reviews.json`);
const reviews = reviewsFlag ? p(reviewsFlag) : existsSync(reviewsDefault) ? reviewsDefault : null;
const formatDuration = (ms) => ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;

function preflight() {
	if (dryRun) return true;
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore" });
	} catch {
		console.error("✗ `pi` was not found on PATH.\n  The eval harness needs the pi CLI and a configured model provider.\n  Install: npm i -g @earendil-works/pi-coding-agent\n  Or smoke-test the harness offline with: npm run eval -- --dry-run");
		return false;
	}
	// Trace-only mode never invokes thulr — the driver (run-experiment/optimize) does.
	if (traceOnly) return true;
	// `thulr doctor` is the real preflight: it verifies the binary, the workspace,
	// the store, AND that thulr's judge binary (pi) resolves — and exits 1 when
	// any check fails, with the structured report saying which.
	const doc = thulr.doctor();
	if (!doc.ok) {
		const why = doc.report === null
			? "`thulr` was not found on PATH."
			: doc.report.judge_bin_found === false
				? `thulr is installed but its judge binary \`${doc.report.judge_bin}\` was not found on PATH.`
				: "`thulr doctor` reports an unhealthy environment.";
		console.error(`✗ ${why}\n  The eval gate judges answer quality and blocks regressions through thulr.\n  Install it (e.g. \`cargo install thulr\`), run \`thulr doctor\` for the full diagnosis,\n  or smoke-test the harness offline with: npm run eval -- --dry-run`);
		return false;
	}
	return true;
}

async function main() {
	if (!preflight()) process.exit(2);

	const selected = CASES.filter((c) => (includeControls || !c.control) && (!filter || c.name.includes(filter)));
	const selectedCalibration = CALIBRATION_CASES.filter((c) => !filter || c.name.includes(filter));
	if (selected.length + selectedCalibration.length === 0) {
		console.error(`No eval cases match --filter=${filter}. Available: ${[...CASES, ...CALIBRATION_CASES].map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	const judgeLabel = dryRun || traceOnly ? "(skipped)" : samples > 1 ? `${judgeModel} ×${samples} samples` : judgeModel;
	const judgeBinLabel = !dryRun && !traceOnly && judgeBin ? ` via ${rel(judgeBin)}` : "";
	const efficiencyLabel = efficiencyGuardrails.length ? `  ·  efficiency ${efficiencyGuardrails.join(",")}` : "";
	const timeoutLabel = armTimeoutMs !== null ? `arm-timeout ${formatDuration(armTimeoutMs)} DEBUG/SMOKE` : `timeout ${formatDuration(timeoutMs)}/agent default; per-case budgets honored`;
	console.log(`pi-flows evals  ·  subject ${useAgentModels ? "(agent frontmatter)" : model} (${modelSource})  ·  judge ${judgeLabel}${judgeBinLabel}  ·  cap $${capUsd.toFixed(2)}/case  ·  ${timeoutLabel}${efficiencyLabel}${dryRun ? "  ·  DRY RUN" : traceOnly ? "  ·  TRACE ONLY" : ""}\n`);

	// --- Phase 1: run every flow, score the objective axis, emit the self-contained thulr trace ---
	thulr.startTrace(TRACE);
	let judgedCount = 0;
	let productJudgedCount = 0;
	const summaries = [];
	const calibrationSummaries = [];
	let totalCost = 0;
	let sawInfraError = false;
	for (const testCase of selected) {
		const flowCtx = { cwd: caseCwd(testCase, { dryRun, arm: "flows" }), hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
		const ctx = { flow, model: useAgentModels ? undefined : model, dryRun, flowCtx };
		const startedAt = Date.now();
		const timeoutPlan = timeoutPlanForCase(testCase, { defaultTimeoutMs: timeoutMs, armTimeoutMs });

		let result;
		let thrown;
		if (dryRun) {
			result = testCase.mock;
		} else {
			const params = { ...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params, model)), traceLabel: testCase.name, maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: timeoutPlan.effectiveTimeoutMs };
			try {
				result = await flow.execute(`eval:${testCase.name}`, params, new AbortController().signal, undefined, flowCtx);
			} catch (error) {
				thrown = error;
			}
		}

		const { objective, reachedModel, cost, answer } = await scoreObjective({ result, thrown, testCase, ctx });
		const endedAt = Date.now();
		const exclusion = exclusionForRun({ reachedModel, timeoutPlan });
		const excludedReason = exclusion?.reason ?? null;
		totalCost += cost;
		if (reachedModel) sawInfraError = true;

		// Only cases that reached the model carry a real answer to judge and a
		// trustworthy label to calibrate against; infra failures are reported as ⚠.
		// Task text, cost, tokens, and the prompt version ride along per thulr's
		// trace contract — judge context plus repro metadata in the EvalRun.
		if (!excludedReason) {
			thulr.appendCaseSpans(TRACE, {
				name: testCase.name,
				answer,
				criterion: testCase.criterion,
				criteria: testCase.criteria,
				label: !!objective.pass,
				labels: testCase.labels,
				judgeOnlyDimensions: testCase.judgeOnlyDimensions,
				journeyStage: testCase.journeyStage,
				endMs: endedAt,
				model: subjectModelName(result, useAgentModels ? "agent-frontmatter" : model),
				task: testCase.params.task,
				expectedBehavior: testCase.expectedBehavior ?? testCase.criterion,
				failureModes: objective.pass ? [] : (testCase.failureModes ?? ["final_answer.deterministic_fail"]),
				costUsd: cost,
				tokensTotal: sumTokens(result),
				promptVersion: PROMPT_VERSION,
				configVersion: CONFIG_VERSION,
			});
			judgedCount += 1;
			productJudgedCount += 1;
		}

		// Hard cases are score-tracked (◐), not pass/fail — a partial objective score is expected.
		const status = reachedModel ? "⚠" : timeoutPlan.debugBudget ? "⚑" : testCase.hard ? "◐" : objective.pass ? "✓" : "✗";
		const seconds = ((endedAt - startedAt) / 1000).toFixed(1);
		console.log(`${status} ${testCase.name.padEnd(34)} obj ${excludedReason ? "n/a" : (objective.score ?? 0).toFixed(2)}  $${cost.toFixed(4)}  ${seconds}s`);
		const debugNote = timeoutPlan.debugBudget ? `debug budget: arm-timeout ${formatDuration(timeoutPlan.effectiveTimeoutMs)} overrides case budget ${formatDuration(timeoutPlan.caseTimeoutMs)}; excluded from quality verdict` : null;
		console.log(`    ↳ ${reachedModel ?? debugNote ?? objective.notes ?? ""}`);
		summaries.push({ name: testCase.name, hard: !!testCase.hard, objective, reachedModel, exclusion, excludedReason, cost, durationMs: endedAt - startedAt });
	}
	for (const testCase of selectedCalibration) {
		const endedAt = Date.now();
		const objective = testCase.objective ?? { pass: false, score: 0, notes: "calibration canary" };
		thulr.appendCaseSpans(TRACE, {
			name: testCase.name,
			answer: testCase.answer,
			criterion: testCase.criterion,
			criteria: testCase.criteria,
			label: !!objective.pass,
			labels: testCase.labels,
			judgeOnlyDimensions: testCase.judgeOnlyDimensions,
			journeyStage: testCase.journeyStage ?? "calibration",
			endMs: endedAt,
			model: useAgentModels ? "agent-frontmatter" : model,
			task: testCase.task,
			expectedBehavior: testCase.expectedBehavior ?? testCase.criterion,
			failureModes: objective.pass ? [] : (testCase.failureModes ?? ["final_answer.deterministic_fail"]),
			costUsd: 0,
			tokensTotal: 0,
			promptVersion: PROMPT_VERSION,
			configVersion: CONFIG_VERSION,
		});
		judgedCount += 1;
		calibrationSummaries.push({ name: testCase.name, calibration: true, objective, reachedModel: null, cost: 0, durationMs: 0 });
		console.log(`· ${testCase.name.padEnd(34)} canary ${(objective.score ?? 0).toFixed(2)}  $0.0000  0.0s`);
		console.log(`    ↳ ${objective.notes ?? ""}`);
	}
	const behaviourCases = summaries.filter((s) => !s.hard);
	const measuredBehaviourCases = behaviourCases.filter((s) => !s.excludedReason);
	const hardCount = summaries.length - behaviourCases.length;
	const calibrationCount = calibrationSummaries.length;
	const objPassed = measuredBehaviourCases.filter((s) => s.objective.pass).length;
	const excludedBehaviour = behaviourCases.length - measuredBehaviourCases.length;
	console.log(`\n${objPassed}/${measuredBehaviourCases.length} behaviour checks passed${excludedBehaviour ? `  ·  ${excludedBehaviour} inconclusive/excluded` : ""}${hardCount ? `  ·  ${hardCount} hard case${hardCount === 1 ? "" : "s"} score-tracked` : ""}${calibrationCount ? `  ·  ${calibrationCount} calibration canar${calibrationCount === 1 ? "y" : "ies"}` : ""}  ·  total $${totalCost.toFixed(4)}${dryRun ? "  (dry-run, no model)" : ""}`);

	// --- Phase 2: thulr judge -> calibrate -> gate -> baseline (skipped in dry-run) ---
	const verdicts = new Map();
	let gateResult = null;

	if (traceOnly) {
		// Re-run-mode contract: the driver (thulr run-experiment / optimize) judges,
		// ranks, and selects. Exit 0 iff a judgeable trace was emitted — objective
		// misses are labels in the trace, not a candidate failure.
		console.log(`\n(trace-only) emitted ${judgedCount} self-contained case(s) to ${rel(TRACE)}; judge/gate left to the driver.`);
		process.exit(productJudgedCount > 0 ? 0 : 1);
	}

	if (dryRun) {
		console.log(`\n(dry-run) emitted ${judgedCount} self-contained case(s) to ${rel(TRACE)}; thulr judge/gate skipped (no tokens).`);
	} else if (!shouldJudgeProductSpans({ dryRun, traceOnly, productSpans: productJudgedCount })) {
		console.log("\nNo product case is eligible for judging — skipping thulr judge/gate/baseline (calibration canaries alone are not a candidate).");
	} else {
		mkdirSync(dirname(CANDIDATE), { recursive: true });
		const traceReport = thulr.inspectTrace(TRACE);
		const traceWarning = traceReport.required_issue_count
			? `${traceReport.required_issue_count} required issue(s)`
			: `${traceReport.warning_count ?? 0} warning(s)`;
		console.log(`\nthulr inspect-trace: judge-grade=${traceReport.judge_grade ? "yes" : "no"}  ·  ${traceWarning}`);
		if (traceReport.required_issue_count) {
			console.error(`Trace is not judge-grade; inspect with: thulr inspect-trace --trace ${rel(TRACE)}`);
			process.exit(1);
		}
		thulr.labelFailures({ trace: TRACE, out: LABELS });
		console.log(`\nthulr judge (${judgeModel}${samples > 1 ? ` ×${samples} samples` : ""})  ·  ${judgedCount} case${judgedCount === 1 ? "" : "s"}`);
		thulr.judge({ trace: TRACE, model: judgeModel, out: CANDIDATE, samples, evalSet, rate, redaction, judgeBin });
		const evalRun = JSON.parse(readFileSync(CANDIDATE, "utf8"));
		let gateEvalRun = evalRun;
		let gateCandidate = CANDIDATE;
		if (calibrationSummaries.length) {
			gateEvalRun = thulr.gateCandidateForEvalRun(evalRun, {
				excludeCaseIds: calibrationSummaries.map((s) => s.name),
			});
			writeFileSync(GATE_CANDIDATE, `${JSON.stringify(gateEvalRun, null, 2)}\n`, "utf8");
			gateCandidate = GATE_CANDIDATE;
		}
		for (const c of evalRun.cases ?? []) verdicts.set(c.case_id, c.dims ?? {});
		for (const s of [...summaries, ...calibrationSummaries]) {
			if (s.excludedReason) continue;
			const dims = verdicts.get(s.name) ?? {};
			const v = dims.criterion ?? {};
			const role = s.calibration ? "canary" : s.hard ? "hard" : "behaviour";
			const verdict = v.verdict === false ? "fail" : v.verdict === true ? "pass" : "unknown";
			const dimScores = Object.entries(dims)
				.map(([dimension, result]) => `${dimension} ${(result.score ?? 0).toFixed(2)}${result.verdict === false ? "!" : ""}`)
				.join("  ");
			console.log(`${s.name.padEnd(34)} ${dimScores || "criterion n/a"}  ${role} ${verdict}`);
		}
		// With repeat sampling, the EvalRun's score_stddev is the pooled within-case
		// sample variance — i.e. how noisy the judge itself is on this suite.
		if (samples > 1) {
			const crit = (evalRun.summary ?? []).find((d) => d.dimension === "criterion");
			if (crit) console.log(`  judge noise across ${samples} samples: score stddev ±${(crit.score_stddev ?? 0).toFixed(3)}`);
		}

		// Calibration: how well the judge's verdicts track the deterministic labels
		// (and human SME verdicts too, when a review set is present — judge-vs-human
		// TPR/TNR). thulr also queues every judge/ground-truth disagreement onto
		// the triage queue (`thulr queue`) and feeds this calibration into the gate:
		// a judge blind in either direction downgrades a clean PASS to WARN.
		console.log("");
		process.stdout.write(thulr.calibrate(CANDIDATE, { labels: LABELS, reviews }));
		if (reviews) console.log(`folded human review verdicts from ${rel(reviews)} into calibration (judge-vs-human TPR/TNR above).`);
		if (calibrationSummaries.length) {
			console.log(`release gate excludes ${calibrationSummaries.length} calibration canar${calibrationSummaries.length === 1 ? "y" : "ies"} from pass-rate comparison; full judged run remains ${rel(CANDIDATE)}.`);
		}

		if (gateBaseline) {
			const baselineRun = JSON.parse(readFileSync(gateBaseline, "utf8"));
			const candidateDimensions = thulr.evalRunDimensions(gateEvalRun);
			const gateDimensions = thulr.sharedGateDimensions(baselineRun, gateEvalRun, candidateDimensions);
			const waitingForBaseline = candidateDimensions.filter((dimension) => !gateDimensions.includes(dimension));
			const requestedScoreGuardrails = [...new Set(["criterion", ...extraScoreGuardrails])];
			const guardrails = gateDimensions.filter((dimension) => dimension === "criterion");
			const scoreGuardrails = gateDimensions.filter((dimension) => requestedScoreGuardrails.includes(dimension));
			const gateOptions = { baseline: gateBaseline, candidate: gateCandidate, guardrails, scoreGuardrails, efficiencyGuardrails, noiseBand, redaction };
			if (waitingForBaseline.length) {
				console.log(`\nnamed dimensions awaiting refreshed baseline: ${waitingForBaseline.join(", ")}`);
			}
			try {
				const gateJson = thulr.gate({ ...gateOptions, json: true });
				const deltaLines = thulr.formatGateScoreSummary(gateJson.report);
				if (deltaLines.length) {
					console.log("\nthulr score deltas:");
					for (const line of deltaLines) console.log(`  ${line}`);
				}
			} catch (error) {
				console.log(`\nthulr score deltas unavailable: ${error?.message ?? error}`);
			}
			gateResult = thulr.gate(gateOptions);
			console.log(`\ngate vs ${rel(gateBaseline)}:`);
			process.stdout.write(gateResult.report);
			if (junitOut) {
				// Gate is free, so render the same comparison a second time as JUnit
				// XML — one testcase per case×dimension — for CI test ingestion.
				const junit = thulr.gate({ ...gateOptions, format: "junit" });
				mkdirSync(dirname(junitOut), { recursive: true });
				writeFileSync(junitOut, junit.report, "utf8");
				console.log(`junit gate report written to ${rel(junitOut)}`);
			}
		} else {
			console.log(`\nNo gate baseline yet (${rel(BASELINE_DEFAULT)} absent) — seed it with: npm run eval -- --write-baseline${junitOut ? "  (--junit skipped: nothing to gate)" : ""}`);
		}

		if (writeBaseline) {
			if (gateResult?.blocks) {
				console.log(`\nNot promoting baseline: the gate reported a regression. Fix it before advancing ${rel(writeBaseline)}.`);
			} else {
				thulr.promoteBaseline({ input: gateCandidate, output: writeBaseline });
				console.log(`\nPromoted this run to baseline: ${rel(writeBaseline)}`);
			}
		}
	}

	// A behaviour case passes only when its objective check AND thulr's criterion
	// agree (the two-axis contract). Hard cases are score-tracked, not pass-gated —
	// only a regression in their score (caught by --score-guardrail) blocks the run.
	const passed = measuredBehaviourCases.filter((s) => s.objective.pass && (dryRun || verdicts.get(s.name)?.criterion?.verdict !== false)).length;
	const excludedByReason = (reason) => summaries.filter((s) => s.excludedReason === reason).length;
	console.log(`\n${passed}/${measuredBehaviourCases.length} behaviour cases passed${excludedBehaviour ? `  ·  ${excludedBehaviour} inconclusive/excluded` : ""}${hardCount ? `  ·  ${hardCount} hard score-tracked` : ""}${calibrationCount ? `  ·  ${calibrationCount} calibration canar${calibrationCount === 1 ? "y" : "ies"}` : ""}${gateResult ? `  ·  gate ${gateResult.blocks ? "FAIL" : "ok"}` : ""}`);

	if (sawInfraError) {
		console.log("\n⚠ Some cases could not complete (auth, credits, network, or timeout) — inconclusive infra, not an answer-quality failure.");
	}
	if (excludedByReason("debug_budget")) {
		console.log(`\n⚑ ${excludedByReason("debug_budget")} case${excludedByReason("debug_budget") === 1 ? " used" : "s used"} an --arm-timeout smoke/debug override and ${excludedByReason("debug_budget") === 1 ? "was" : "were"} excluded from quality verdicts.`);
	}
	const infraBlocked = excludedByReason("infra") > 0;
	const measuredPass = measuredBehaviourCases.length === 0 ? !infraBlocked : passed === measuredBehaviourCases.length;
	process.exit(measuredPass && !gateResult?.blocks && !infraBlocked ? 0 : 1);
}

main().catch((error) => {
	console.error(`eval harness failed: ${error?.stack ?? error}`);
	process.exit(1);
});
