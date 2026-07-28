// Opt-in, model-in-the-loop eval harness for pi-flows — now gated by thulr.
//
// Unlike `npm test` (offline, deterministic, no model), this drives REAL `flow`
// delegations through REAL `pi` and scores agent/flow behaviour — so it needs the
// `pi` CLI on PATH and a configured model provider, and it spends tokens. It is
// intentionally NOT part of `npm run check`.
//
//   npm run eval                          # use your pi default model/provider
//   npm run eval -- --filter=route        # only matching cases
//   npm run eval -- --dry-run             # framework smoke (canned results, no model, no thulr calls)
//   npm run eval -- --trace-only --trace-out=/tmp/t.jsonl   # run flows + emit the trace, no judge/gate — the
//                                         # command-template mode for `thulr run-experiment` / `thulr optimize`
//   npm run eval -- --strict-trace        # fail the run when its runtime trace evidence is incomplete
//   npm run eval:select                   # parent-model tool-selection discipline
//
// Every flag (subject/judge model, trials, samples, guardrails, calibration caps,
// baselines, JUnit output) is documented with its default in evals/README.md —
// the single place they are described, so this header cannot drift from it.
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
//
// The five phases (argv -> preflight -> run arms -> trace -> judge/gate) live in
// evals/pipeline.mjs and evals/run-report.mjs; this file wires them together.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { corpusPreflightStep, formatPortfolioReport, portfolioReport } from "./case-contract.mjs";
import { createFlagReader } from "./cli-flags.mjs";
import { CALIBRATION_CASES, CASES, EVAL_CORPUS } from "./corpus.mjs";
import { armBudgetSignal, caseWorkspace, exclusionForRun, flowTool, scoreObjective, shouldJudgeProductSpans, subjectModelName, sumTokens, DEFAULT_EVAL_MODEL, timeoutPlanForCase } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import { calibrationPreflightStep, resolveCriticalDimensions, DEFAULT_CRITICAL_MISS_RATE_CAP } from "./calibration.mjs";
import { assessCalibration, baselinePromotionBlocker, calibrationObjective, calibrationSpanFields, caseSpanFields, gateAgainstBaseline, harnessExitCode, inspectTraceReport, judgeTraceRun, relativeToRepo as rel, repoPath as p, selectMeasurementCases, traceEvidenceGate, writeReliabilityArtifact } from "./pipeline.mjs";
import { loadDotenv, requireBinary, requireHealthyThulr, runPreflight } from "./preflight.mjs";
import { behaviourCountsLine, calibrationLines, caseLines, debugBudgetWarning, finalCountsLine, headerLine, judgeHeaderLine, portfolioExcludedCaseIds, verdictLine, INFRA_WARNING } from "./run-report.mjs";
import { MAX_SUBJECT_TRIALS, traceHealthRollup, trialIdentity } from "./reliability.mjs";
import { defaultRuntimeTracePath, evalRunId, runtimeScoreFamilies, runtimeTraceContext, runtimeTraceEvidence } from "./runtime-trace.mjs";
import * as thulr from "./thulr.mjs";

process.env.PI_FLOWS_CHILD_NO_EXTENSIONS = "1";

// Load a local .env (provider keys) if present, before any child pi inherits env.
loadDotenv();

const { flag, has, bool, flags, rateFlag, positiveNumberFlag, positiveIntegerFlag } = createFlagReader(process.argv.slice(2));

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
const dryRun = bool("dry-run");
// Release-gate switch: block the run when the runtime traces backing it are
// incomplete. Off by default — tracing is best-effort, and an exporter hiccup
// must never be reported as a subject regression.
const strictTrace = bool("strict-trace");
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
const subjectTrials = positiveIntegerFlag("trials", 1, MAX_SUBJECT_TRIALS);
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
// Judge calibration. A dimension named here is trusted to BLOCK the release, so
// it must first earn that: enough independent ground truth in every class, no
// contested human labels, and a missed-defect upper bound under the cap.
//
// `criterion` is critical by default because it is already the always-on release
// guardrail — gating on a judge whose accuracy nothing checks is the hole this
// exists to close. The calibration canaries carry deterministic ground truth in
// all three classes precisely so the default is satisfiable; a test asserts the
// shipped set can clear it, so this cannot quietly become unreachable. Opt out
// per run with --critical-dimension=none.
const criticalDimensions = resolveCriticalDimensions(flags("critical-dimension"));
const criticalMissRateCap = rateFlag("critical-miss-rate", DEFAULT_CRITICAL_MISS_RATE_CAP);
// Judge scores this close to the 0.5 decision boundary abstain and escalate to
// human review instead of voting, so the judge is never scored on a coin flip.
const abstentionBand = rateFlag("abstention-band", 0.1);
// Emit-the-trace-and-stop: the command-template mode `thulr run-experiment` and
// `thulr optimize` drive ("the template MUST emit a structured JSONL trace to {out}").
const traceOnly = has("trace-only");

const stableRepoPath = (path) => path ? rel(path) : path;
const configuredJudgeBin = flag("judge-bin", null) ?? process.env.THULR_JUDGE_BIN ?? null;
const judgeBin = configuredJudgeBin ? stableRepoPath(configuredJudgeBin) : null;
process.env.PI_FLOWS_JUDGE_MODEL = judgeModel;
// Dry-run gets its own trace path: mock spans must never clobber the last real
// trace (which re-judging with a different judge model depends on).
const TRACE = p(flag("trace-out", dryRun ? "evals/thulr-trace.dry-run.jsonl" : "evals/thulr-trace.jsonl"));
const EVAL_RUN_ID = evalRunId(flag("run-id", null));
const RUNTIME_TRACE = p(flag("runtime-trace", defaultRuntimeTracePath({ dryRun })));
const RELIABILITY = p(flag("reliability-out", ".thulr/runs/reliability.json"));
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
const CALIBRATION = p(flag("calibration-out", ".thulr/runs/calibration.json"));
// Everything the reliability artifact needs except `judgeAvailable`, which is the
// one thing that differs between the trace-only and judged exits.
const RELIABILITY_OPTIONS = { out: RELIABILITY, displayPath: rel(RELIABILITY), subjectTrials, judgeSamples: samples, runId: EVAL_RUN_ID, runtimeTraceFile: rel(RUNTIME_TRACE) };
// Human-review calibration (thulr review): an SME verdict set folded into
// `thulr calibrate` as judge-vs-human ground truth (TPR/TNR) on top of the
// deterministic-label axis. Defaults to the path `thulr review` writes for this
// trace, so recording a verdict (`npm run eval:review -- --case <id> --verdict
// <pass|fail>`) is enough — the next `npm run eval` picks it up with no flag.
const reviewsFlag = flag("reviews", null);
const reviewsDefault = p(`.thulr/reviews/${basename(TRACE).replace(/\.jsonl$/, "")}.reviews.json`);
const reviews = reviewsFlag ? p(reviewsFlag) : existsSync(reviewsDefault) ? reviewsDefault : null;

// `thulr doctor` is the real thulr preflight: it verifies the binary, the
// workspace, the store, AND that thulr's judge binary (pi) resolves. Trace-only
// mode never invokes thulr — the driver (run-experiment/optimize) does.
function preflight() {
	return runPreflight([
		corpusPreflightStep(EVAL_CORPUS),
		calibrationPreflightStep(EVAL_CORPUS),
		...(dryRun ? [] : [
			requireBinary("pi", "✗ `pi` was not found on PATH.\n  The eval harness needs the pi CLI and a configured model provider.\n  Install: npm i -g @earendil-works/pi-coding-agent\n  Or smoke-test the harness offline with: npm run eval -- --dry-run"),
			...(traceOnly ? [] : [requireHealthyThulr((why) => `✗ ${why}\n  The eval gate judges answer quality and blocks regressions through thulr.\n  Install it (e.g. \`cargo install thulr\`), run \`thulr doctor\` for the full diagnosis,\n  or smoke-test the harness offline with: npm run eval -- --dry-run`)]),
		]),
	]);
}

// --- Phase: run every flow, score the objective axis, emit the thulr trace ---
async function runCases(selected, selectedCalibration, flow) {
	const summaries = [];
	const calibrationSummaries = [];
	let judgedCount = 0;
	let productJudgedCount = 0;
	let totalCost = 0;
	let sawInfraError = false;

	for (const testCase of selected) {
		for (let trialIndex = 1; trialIndex <= subjectTrials; trialIndex += 1) {
			const identity = trialIdentity(testCase.name, trialIndex, subjectTrials);
			const traceContext = runtimeTraceContext(EVAL_RUN_ID, { ...identity, arm: "flows" });
			const workspace = caseWorkspace(testCase, { dryRun, arm: "flows", isolate: true });
			const flowCtx = { cwd: workspace.cwd, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
			const ctx = { flow, model: useAgentModels ? undefined : model, dryRun, flowCtx };
			const startedAt = Date.now();
			const timeoutPlan = timeoutPlanForCase(testCase, { defaultTimeoutMs: timeoutMs, armTimeoutMs });

			let result;
			let thrown;
			const armBudget = armBudgetSignal(new AbortController().signal, dryRun ? 0 : timeoutPlan.effectiveTimeoutMs);
			try {
				if (dryRun) {
					result = testCase.mock;
				} else {
					const params = {
						...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params, model)),
						traceFile: RUNTIME_TRACE,
						traceLabel: identity.trialId,
						traceContext,
						maxCostUsd: testCase.params.maxCostUsd ?? capUsd,
						timeoutMs: timeoutPlan.effectiveTimeoutMs,
					};
					try {
						result = await flow.execute(`eval:${identity.trialId}`, params, armBudget.signal, undefined, flowCtx);
					} catch (error) {
						thrown = error;
					}
				}

				const { objective, reachedModel, cost, answer } = await scoreObjective({ result, thrown, testCase, ctx });
				const endedAt = Date.now();
				const exclusion = armBudget.timedOut
					? {
						reason: timeoutPlan.debugBudget ? "debug_budget" : "infra",
						detail: `${timeoutPlan.debugBudget ? "debug " : ""}arm timed out after ${timeoutPlan.effectiveTimeoutMs}ms (case budget ${timeoutPlan.caseTimeoutMs}ms)`,
					}
					: exclusionForRun({ reachedModel, timeoutPlan });
				const excludedReason = exclusion?.reason ?? null;
				const tokens = sumTokens(result);
				totalCost += cost;
				if (excludedReason === "infra") sawInfraError = true;
				const runtimeTrace = runtimeTraceEvidence(result, rel(RUNTIME_TRACE), traceContext);
				const scoreFamilies = runtimeScoreFamilies({ result, thrown, objective, trace: runtimeTrace });

				if (!excludedReason) {
					thulr.appendCaseSpans(TRACE, caseSpanFields(testCase, {
						answer,
						label: objective.pass,
						endMs: endedAt,
						model: subjectModelName(result, useAgentModels ? "agent-frontmatter" : model),
						task: testCase.params.task,
						costUsd: cost,
						tokensTotal: tokens,
						journeyStage: testCase.journeyStage,
						promptVersion: PROMPT_VERSION,
						configVersion: CONFIG_VERSION,
						evalRunId: EVAL_RUN_ID,
						runtimeTrace,
						scoreFamilies,
						...identity,
					}));
					judgedCount += 1;
					productJudgedCount += 1;
				}

				const durationMs = endedAt - startedAt;
				for (const line of caseLines({ name: identity.trialId, objective, excludedReason, timeoutPlan, reachedModel, cost, durationMs, hard: testCase.hard })) console.log(line);
				summaries.push({
					...identity,
					name: identity.trialId,
					hard: !!testCase.hard,
					objective,
					answer,
					reachedModel,
					exclusion,
					excludedReason,
					infraFailure: excludedReason === "infra" ? (exclusion?.detail ?? reachedModel ?? "infrastructure failure") : null,
					cost,
					costUsd: cost,
					tokens,
					durationMs,
					runtimeTrace,
					scoreFamilies,
				});
			} finally {
				armBudget.dispose();
				workspace.dispose();
			}
		}
	}

	for (const testCase of selectedCalibration) {
		const objective = calibrationObjective(testCase);
		thulr.appendCaseSpans(TRACE, calibrationSpanFields(testCase, {
			model: useAgentModels ? "agent-frontmatter" : model,
			endMs: Date.now(),
			promptVersion: PROMPT_VERSION,
			configVersion: CONFIG_VERSION,
		}));
		judgedCount += 1;
		calibrationSummaries.push({ name: testCase.name, calibration: true, objective, reachedModel: null, cost: 0, durationMs: 0 });
		for (const line of calibrationLines({ name: testCase.name, objective })) console.log(line);
	}

	return { summaries, calibrationSummaries, judgedCount, productJudgedCount, totalCost, sawInfraError };
}

// --- Phase: thulr judge -> calibrate -> gate -> baseline (skipped in dry-run) ---
function judgeAndGate({ judgedCount, calibrationSummaries, summaries, verdicts, traceBlocks }) {
	mkdirSync(dirname(CANDIDATE), { recursive: true });
	const inspection = inspectTraceReport(TRACE);
	console.log(`\nthulr inspect-trace: judge-grade=${inspection.judgeGrade}  ·  ${inspection.issues}`);
	if (inspection.blocking) {
		console.error(`Trace is not judge-grade; inspect with: thulr inspect-trace --trace ${rel(TRACE)}`);
		process.exit(1);
	}

	const judged = judgeTraceRun({
		trace: TRACE,
		out: CANDIDATE,
		compareOut: GATE_CANDIDATE,
		labels: LABELS,
		header: judgeHeaderLine({ judgeModel, samples, judgedCount }),
		judgeModel,
		samples,
		evalSet,
		rate,
		redaction,
		judgeBin,
		excludeCaseIds: calibrationSummaries.map((s) => s.name),
	});
	for (const c of judged.evalRun.cases ?? []) verdicts.set(c.case_id, c.dims ?? {});
	for (const s of [...summaries, ...calibrationSummaries]) {
		if (s.excludedReason) continue;
		console.log(verdictLine(s, verdicts.get(s.traceCaseId ?? s.name) ?? {}));
	}
	// With repeat sampling, the EvalRun's score_stddev is the pooled within-case
	// sample variance — i.e. how noisy the judge itself is on this suite.
	if (samples > 1) {
		const crit = (judged.evalRun.summary ?? []).find((d) => d.dimension === "criterion");
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

	const calibration = assessCalibration({
		corpus: EVAL_CORPUS,
		summaries: [...summaries, ...calibrationSummaries],
		verdicts,
		keyInputs: { judgeModel, judgeSamples: samples, judgeBin, evalSet, promptVersion: PROMPT_VERSION, configVersion: CONFIG_VERSION },
		reviews: { path: reviews, explicit: Boolean(reviewsFlag) },
		criticalDimensions,
		criticalMissRateCap,
		abstentionBand,
		guardrails: { noiseBand, scoreGuardrails: extraScoreGuardrails, efficiencyGuardrails },
		trace: TRACE,
		out: CALIBRATION,
	});

	let gateResult = null;
	if (gateBaseline) {
		gateResult = gateAgainstBaseline({
			baseline: gateBaseline,
			candidate: judged.comparePath,
			gateEvalRun: judged.gateEvalRun,
			extraScoreGuardrails,
			efficiencyGuardrails,
			noiseBand,
			redaction,
			junitOut,
		});
	} else {
		console.log(`\nNo gate baseline yet (${rel(BASELINE_DEFAULT)} absent) — seed it with: npm run eval -- --write-baseline${junitOut ? "  (--junit skipped: nothing to gate)" : ""}`);
	}

	if (writeBaseline) {
		const blocker = baselinePromotionBlocker({ gateBlocks: gateResult?.blocks, calibrationBlocks: calibration.blocks, traceBlocks });
		if (blocker) {
			console.log(`\nNot promoting baseline: ${blocker}. Fix it before advancing ${rel(writeBaseline)}.`);
		} else {
			thulr.promoteBaseline({ input: judged.comparePath, output: writeBaseline });
			console.log(`\nPromoted this run to baseline: ${rel(writeBaseline)}`);
		}
	}
	return { gateResult, calibration };
}

async function main() {
	if (!preflight()) process.exit(2);

	const selected = selectMeasurementCases(CASES, { filter, includeControls });
	const selectedCalibration = CALIBRATION_CASES.filter((c) => !filter || c.name.includes(filter));
	if (selected.length + selectedCalibration.length === 0) {
		console.error(`No eval cases match --filter=${filter}. Available: ${[...CASES, ...CALIBRATION_CASES].map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	console.log(headerLine({
		subject: useAgentModels ? "(agent frontmatter)" : model,
		modelSource,
		subjectTrials,
		judgeModel,
		samples,
		judgeBin: judgeBin ? rel(judgeBin) : null,
		capUsd,
		timeoutMs,
		armTimeoutMs,
		efficiencyGuardrails,
		dryRun,
		traceOnly,
	}));

	thulr.startTrace(TRACE);
	mkdirSync(dirname(RUNTIME_TRACE), { recursive: true });
	writeFileSync(RUNTIME_TRACE, "", "utf8");
	const { summaries, calibrationSummaries, judgedCount, productJudgedCount, totalCost, sawInfraError } = await runCases(selected, selectedCalibration, flow);

	const behaviourCases = summaries.filter((s) => !s.hard);
	const measuredBehaviourCases = behaviourCases.filter((s) => !s.excludedReason);
	const hardCount = summaries.length - behaviourCases.length;
	const calibrationCount = calibrationSummaries.length;
	const excludedBehaviour = behaviourCases.length - measuredBehaviourCases.length;
	console.log(behaviourCountsLine({
		passed: measuredBehaviourCases.filter((s) => s.objective.pass).length,
		measured: measuredBehaviourCases.length,
		excluded: excludedBehaviour,
		hard: hardCount,
		calibration: calibrationCount,
		totalCost,
		dryRun,
	}));
	const excludedIds = portfolioExcludedCaseIds(summaries);
	console.log(formatPortfolioReport(portfolioReport([...selected, ...selectedCalibration], { excluded: excludedIds })));

	const verdicts = new Map();
	let gateResult = null;
	let calibrationResult = null;

	if (traceOnly) {
		// Re-run-mode contract: the driver (thulr run-experiment / optimize) judges,
		// ranks, and selects. Exit 0 iff a judgeable trace was emitted — objective
		// misses are labels in the trace, not a candidate failure.
		console.log(`\n(trace-only) emitted ${judgedCount} self-contained case(s) to ${rel(TRACE)}; judge/gate left to the driver.`);
		const traceOnlyReliability = writeReliabilityArtifact(summaries, verdicts, { ...RELIABILITY_OPTIONS, judgeAvailable: false });
		// Judging is the driver's job here, but evidence is not: a caller that asked
		// for strict traces must not be handed a 0 for an unauditable experiment.
		const traceOnlyGate = traceEvidenceGate(traceOnlyReliability, { strict: strictTrace });
		for (const issue of traceOnlyGate.issues) console.log(`✗ ${issue}`);
		process.exit(productJudgedCount > 0 && !traceOnlyGate.blocks ? 0 : 1);
	}

	if (dryRun) {
		console.log(`\n(dry-run) emitted ${judgedCount} self-contained case(s) to ${rel(TRACE)}; thulr judge/gate skipped (no tokens).`);
	} else if (!shouldJudgeProductSpans({ dryRun, traceOnly, productSpans: productJudgedCount })) {
		console.log("\nNo product case is eligible for judging — skipping thulr judge/gate/baseline (calibration canaries alone are not a candidate).");
	} else {
		// Knowable before the judge runs — and it has to be, because promotion happens inside this call.
		const preJudgeTraceGate = traceEvidenceGate({ overall: { traceHealth: traceHealthRollup(summaries) } }, { strict: strictTrace });
		({ gateResult, calibration: calibrationResult } = judgeAndGate({ judgedCount, calibrationSummaries, summaries, verdicts, traceBlocks: preJudgeTraceGate.blocks }));
	}
	const reliability = writeReliabilityArtifact(summaries, verdicts, { ...RELIABILITY_OPTIONS, judgeAvailable: !dryRun && productJudgedCount > 0 });
	// Recomputed over the same summaries the pre-judge verdict used; the judge cannot change trace health, so the two agree.
	const traceGate = traceEvidenceGate(reliability, { strict: strictTrace });
	for (const issue of traceGate.issues) console.log(`✗ ${issue}`);

	// A behaviour case passes only when its objective check AND thulr's criterion
	// agree (the two-axis contract). Hard cases are score-tracked, not pass-gated —
	// only a regression in their score (caught by --score-guardrail) blocks the run.
	const passed = measuredBehaviourCases.filter((s) => s.objective.pass && (dryRun || verdicts.get(s.traceCaseId)?.criterion?.verdict === true)).length;
	const excludedByReason = (reason) => summaries.filter((s) => s.excludedReason === reason).length;
	console.log(finalCountsLine({
		passed,
		measured: measuredBehaviourCases.length,
		excluded: excludedBehaviour,
		hard: hardCount,
		calibration: calibrationCount,
		gateBlocks: gateResult ? !!gateResult.blocks : null,
	}));
	if (sawInfraError) console.log(INFRA_WARNING);
	if (excludedByReason("debug_budget")) console.log(debugBudgetWarning(excludedByReason("debug_budget")));
	process.exit(harnessExitCode({
		measured: measuredBehaviourCases.length,
		passed,
		infraExcluded: excludedByReason("infra"),
		gateBlocks: !!gateResult?.blocks,
		calibrationBlocks: !!calibrationResult?.blocks,
		traceBlocks: traceGate.blocks,
	}));
}

main().catch((error) => {
	console.error(`eval harness failed: ${error?.stack ?? error}`);
	process.exit(1);
});
