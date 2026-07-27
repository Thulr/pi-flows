// Flows-vs-baseline A/B: does pi-flows improve quality on the same Codex model?
//
// For each case/trial it runs TWO paired arms on the SAME subject model, task,
// trial index, and immutable workspace snapshot:
//   flows : the case's flow params — pi-flows' specialist agents + orchestration
//   baseline : direct Codex by default; optionally plain `pi --no-extensions`
//
//   npm run eval:compare -- --trials=5 --constraint=deadline:600000
//   npm run eval:compare -- --baseline=pi --constraint=cost:2 --non-inferiority-margin=0.02
//   npm run eval:compare -- --baseline=pi --constraint=generated_tokens:20000 --improvement-margin=0.03
//   npm run eval:compare -- --duel              # add native thulr pairwise quality judging
//   npm run eval:compare -- --filter=vote       # scope to keep cost down
//   npm run eval:compare -- --model=openai-codex/gpt-5.5 --judge-model=anthropic/claude-sonnet-4-6
//   npm run eval:compare -- --write=evals/compare.json  # raw rows + paired analysis
//   npm run eval:compare -- --dry-run           # wiring smoke (canned results, no model)
//
// The shared phases (argv, preflight, case->span projection, judge) live in
// evals/pipeline.mjs; the report arithmetic and per-arm lines in
// evals/compare-report.mjs. This file wires them and owns the A/B layout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { codexModelFromPi, runCodex } from "./baseline-codex.mjs";
import { runPlainPi } from "./baseline-pi.mjs";
import { corpusPreflightStep, formatPortfolioReport, portfolioReport } from "./case-contract.mjs";
import { createFlagReader } from "./cli-flags.mjs";
import { CALIBRATION_CASES, CASES, EVAL_CORPUS } from "./corpus.mjs";
import { applyDuelRows, applyJudgedRows, armLine, comparisonTotals, dryRunJudgements, duelQualitySummary, exclusionSummary, fixed, formatDuration, formatTokenComparison, judgeDelta, markUnjudgedRows, pct, pickArm, scoreText, unjudgedArm } from "./compare-report.mjs";
import { answerText, answerWithArtifacts, armBudgetSignal, exclusionForRun, flowTool, scoreObjective, DEFAULT_EVAL_MODEL, subjectModelName, sumTokenUsage, timeoutPlanForCase } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import { armExecutionTiming, buildPairedAnalysis, evaluatePairConstraint, formatPairedAnalysis, pairedArmOrder, parseBindingConstraint, parsePromotionRule } from "./paired-experiment.mjs";
import { pairedCaseWorkspaces } from "./paired-workspace.mjs";
import { calibrationSpanFields, caseSpanFields, inspectTraceReport, judgeTraceRun, printScoreDeltas, relativeToRepo as rel, repoPath as p, selectMeasurementCases } from "./pipeline.mjs";
import { loadDotenv, requireBinary, requireHealthyThulr, runPreflight } from "./preflight.mjs";
import { MAX_SUBJECT_TRIALS, trialIdentity } from "./reliability.mjs";
import * as thulr from "./thulr.mjs";

loadDotenv();
// Measurement arms must not inherit unrelated user extensions. They can add
// startup failures, tools, or prompt context to only the Pi Flows treatment.
process.env.PI_FLOWS_CHILD_NO_EXTENSIONS = "1";

const { flag, bool, flags, positiveNumberFlag, positiveIntegerFlag } = createFlagReader(process.argv.slice(2));

const cliModel = flag("model", null);
const model = cliModel ?? DEFAULT_EVAL_MODEL;
const useAgentModels = ["agent", "default", ""].includes(model);
const subjectModel = useAgentModels ? undefined : model;
const baselineKind = flag("baseline", "codex").toLowerCase();
if (!new Set(["codex", "pi"]).has(baselineKind)) {
	console.error("--baseline must be codex or pi");
	process.exit(2);
}
if (useAgentModels) {
	console.error("paired comparison requires an explicit model shared by both arms; --model=agent/default is not supported");
	process.exit(2);
}
const codexModel = baselineKind === "codex" ? codexModelFromPi(model) : null;
const baselineLabel = baselineKind === "codex" ? "Codex" : "plain Pi";
const baselineSlug = baselineKind === "codex" ? "codex" : "plain";
const judgeModel = flag("judge-model", null) ?? process.env.PI_FLOWS_JUDGE_MODEL ?? "anthropic/claude-haiku-4-5";
const samples = Math.min(10, Math.max(1, Number(flag("samples", "1")) || 1));
const subjectTrials = positiveIntegerFlag("trials", 1, MAX_SUBJECT_TRIALS);
const timeoutMs = Number(flag("timeout", process.env.PI_FLOWS_TIMEOUT_MS ?? "120000"));
const armTimeoutMs = positiveNumberFlag("arm-timeout");
const constraintFlag = flag("constraint", null);
const legacyCap = flag("cap", null);
let bindingConstraint;
let promotionRule;
try {
	const declarations = [constraintFlag, legacyCap, armTimeoutMs].filter((value) => value !== null);
	if (declarations.length > 1) throw new Error("choose exactly one binding constraint: --constraint, --cap, or --arm-timeout");
	const declaration = constraintFlag ?? (legacyCap === null ? armTimeoutMs === null ? null : `deadline:${armTimeoutMs}` : `cost:${legacyCap}`);
	bindingConstraint = parseBindingConstraint(declaration, timeoutMs);
	promotionRule = parsePromotionRule(flag("improvement-margin", null), flag("non-inferiority-margin", null));
} catch (error) {
	console.error(error.message);
	process.exit(2);
}
if (baselineKind === "codex" && bindingConstraint.kind !== "deadline") {
	console.error(`--constraint=${bindingConstraint.kind}:... requires --baseline=pi because Codex CLI cannot enforce that resource ceiling during execution`);
	process.exit(2);
}
const dryRun = bool("dry-run");
const duelEnabled = bool("duel") || bool("pairwise");
const filter = flag("filter", "");
const includeControls = bool("include-controls") || filter.length > 0;
const writeArtifact = flag("write", "");
const redaction = flag("redaction", null);
const rate = Number(flag("rate", "0"));
const noiseBand = Number(flag("noise-band", "0.05"));
const efficiencyGuardrails = flags("efficiency-guardrail");
const infraRetries = Math.max(0, Math.min(3, Math.floor(Number(flag("infra-retries", "1")) || 0)));
const infraRetryDelayMs = Math.max(0, Number(flag("infra-retry-delay", "15000")) || 0);

const stableRepoPath = (path) => path ? rel(path) : path;
const configuredJudgeBin = flag("judge-bin", null) ?? process.env.THULR_JUDGE_BIN ?? null;
const judgeBin = configuredJudgeBin ? stableRepoPath(configuredJudgeBin) : null;
process.env.PI_FLOWS_JUDGE_MODEL = judgeModel;
const TRACE_DIR = p(flag("trace-dir", ".thulr/runs"));
const FLOWS_TRACE = p(flag("flows-trace", ".thulr/runs/ab-flows.trace.jsonl"));
const PLAIN_TRACE = p(flag("baseline-trace", flag("plain-trace", `.thulr/runs/ab-${baselineSlug}.trace.jsonl`)));
const FLOWS_RUN = p(".thulr/runs/ab-flows.json");
const PLAIN_RUN = p(`.thulr/runs/ab-${baselineSlug}.json`);
const FLOWS_COMPARE = p(".thulr/runs/ab-flows.compare.json");
const PLAIN_COMPARE = p(`.thulr/runs/ab-${baselineSlug}.compare.json`);
const FLOWS_LABELS = p(".thulr/runs/ab-flows.labels.json");
const PLAIN_LABELS = p(`.thulr/runs/ab-${baselineSlug}.labels.json`);
const DUEL_REPORT = p(flag("duel-out", ".thulr/runs/ab-duel.json"));
const PROMPT_VERSION = `pi-flows@${JSON.parse(readFileSync(p("package.json"), "utf8")).version}`;
const CONFIG_VERSION = `pi-flows-ab:${baselineKind}:${useAgentModels ? "agent-frontmatter" : model}`;

function preflight() {
	return runPreflight([
		corpusPreflightStep(EVAL_CORPUS),
		...(dryRun ? [] : [
			requireBinary("pi", "FAIL `pi` was not found on PATH. Install: npm i -g @earendil-works/pi-coding-agent  -  or smoke-test offline with --dry-run"),
			...(baselineKind === "codex" ? [requireBinary("codex", "FAIL `codex` was not found on PATH. Install Codex CLI or use --baseline=pi.")] : []),
			requireHealthyThulr((why) => `FAIL ${why}\n  eval:compare now judges both arms through thulr. Smoke-test wiring with: npm run eval:compare -- --dry-run`),
		]),
	]);
}

const normalizedModel = (value) => String(value ?? "").split("/").at(-1)?.trim() ?? "";

function enforceModelParity(flows, baseline) {
	if (dryRun || flows.exclusion || baseline.exclusion) return;
	const expected = normalizedModel(model);
	const wrong = (arm) => arm.reportedModels.length === 0 || arm.reportedModels.some((reported) => normalizedModel(reported) !== expected);
	if (!wrong(flows) && !wrong(baseline)) return;
	const detail = `model parity failed: expected ${expected}; flows reported ${flows.reportedModels.join(",") || "none"}; ${baselineSlug} reported ${baseline.reportedModels.join(",") || "none"}`;
	const exclusion = { reason: "infra", detail };
	flows.exclusion = exclusion;
	baseline.exclusion = exclusion;
}

async function runArm(kind, testCase, flow, signal, workspace, identity) {
	const cwd = workspace.cwd;
	const flowCtx = { cwd, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
	const ctx = { flow, model: subjectModel, dryRun, flowCtx };
	const startedAt = Date.now();
	const task = testCase.params.task;
	const baseTimeoutPlan = timeoutPlanForCase(testCase, { defaultTimeoutMs: timeoutMs });
	const timeoutPlan = bindingConstraint.kind === "deadline"
		? { ...baseTimeoutPlan, effectiveTimeoutMs: bindingConstraint.value }
		: baseTimeoutPlan;
	const effectiveTimeoutMs = timeoutPlan.effectiveTimeoutMs;
	const armBudget = armBudgetSignal(signal, dryRun ? 0 : effectiveTimeoutMs);
	const progress = (message) => {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`   ${kind} +${elapsed}s ${String(message ?? "").replace(/\s+/g, " ").slice(0, 180)}`);
	};

	let result;
	let thrown;
	if (dryRun) {
		result = testCase.mock;
	} else if (kind === "flows") {
		const constraintBudget = bindingConstraint.kind === "cost"
			? { maxCostUsd: bindingConstraint.value }
			: bindingConstraint.kind === "generated_tokens" ? { maxGeneratedTokens: bindingConstraint.value } : {};
		const params = { ...injectModel(testCase.params, model), ...constraintBudget, traceLabel: identity.traceCaseId, timeoutMs: effectiveTimeoutMs };
		try {
			result = await flow.execute(`cmp:flows:${identity.trialId}`, params, armBudget.signal, (partial) => progress(partial?.content?.[0]?.text), flowCtx);
		} catch (error) {
			thrown = error;
		}
	} else {
		try {
			progress(`starting ${baselineLabel} process...`);
			result = baselineKind === "codex"
				? await runCodex({ task, cwd, model: codexModel, reportedModel: subjectModel, timeoutMs: effectiveTimeoutMs, signal: armBudget.signal })
				: await runPlainPi({ task, cwd, model: subjectModel, timeoutMs: effectiveTimeoutMs, signal: armBudget.signal,
					...(bindingConstraint.kind === "cost" ? { maxCostUsd: bindingConstraint.value } : {}),
					...(bindingConstraint.kind === "generated_tokens" ? { maxGeneratedTokens: bindingConstraint.value } : {}) });
		} catch (error) {
			thrown = error;
		}
	}
	armBudget.dispose();
	const timing = armExecutionTiming(result, Date.now() - startedAt);

	const objective = await scoreObjective({ result, thrown, testCase, ctx });
	const exclusion = armBudget.timedOut
		? {
			reason: timeoutPlan.debugBudget ? "debug_budget" : "infra",
			detail: `${timeoutPlan.debugBudget ? "debug " : ""}arm timed out after ${effectiveTimeoutMs}ms (case budget ${timeoutPlan.caseTimeoutMs}ms)`,
		}
		: exclusionForRun({ reachedModel: objective.reachedModel, timeoutPlan });
	const tokenUsage = sumTokenUsage(result);
	return {
		// Judged fields start explicitly empty; exactly one of applyJudgedRows /
		// dryRunJudgements / markUnjudgedRows fills them in before anything reads them.
		...unjudgedArm(),
		...objective,
		exclusion,
		timeoutPlan,
		result,
		...timing,
		answer: answerWithArtifacts(objective.answer || answerText(result), cwd, testCase.judgeArtifacts),
		task,
		modelName: subjectModelName(result, useAgentModels ? "agent-frontmatter" : model),
		reportedModels: [...new Set((result?.details?.results ?? []).map((child) => child?.model).filter(Boolean))],
		workspaceSnapshotId: workspace.snapshotId,
		tokensTotal: tokenUsage.total,
		tokenUsage,
		costKnown: (result?.details?.results ?? []).every((child) => child?.usage?.costKnown !== false),
	};
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function runArmWithInfraRetry(kind, testCase, flow, signal, workspace, identity) {
	let arm;
	for (let attempt = 1; attempt <= infraRetries + 1; attempt += 1) {
		arm = await runArm(kind, testCase, flow, signal, workspace, identity);
		arm.attempts = attempt;
		const retryable = arm.exclusion?.reason === "infra"
			&& arm.tokensTotal === 0
			&& arm.cost === 0
			&& !/timeout|timed out|aborted/i.test(arm.exclusion.detail ?? "");
		if (!retryable || attempt > infraRetries) return arm;
		console.log(`   ${kind} infra retry ${attempt}/${infraRetries} after zero-token failure: ${String(arm.exclusion.detail).replace(/\s+/g, " ").slice(0, 240)}`);
		if (infraRetryDelayMs > 0) await wait(infraRetryDelayMs);
	}
	return arm;
}

function appendArmTrace(trace, arm, testCase, identity) {
	if (arm.exclusion) return false;
	thulr.appendCaseSpans(trace, caseSpanFields(testCase, {
		answer: arm.answer,
		label: arm.objective.pass,
		endMs: Date.now(),
		model: arm.modelName,
		task: arm.task,
		costUsd: arm.costKnown ? arm.cost : undefined,
		tokensTotal: arm.tokensTotal,
		journeyStage: testCase.journeyStage,
		promptVersion: PROMPT_VERSION,
		configVersion: CONFIG_VERSION,
		...identity,
	}));
	return true;
}

function appendCalibration(trace, modelName) {
	for (const testCase of CALIBRATION_CASES) {
		thulr.appendCaseSpans(trace, calibrationSpanFields(testCase, {
			model: modelName,
			endMs: Date.now(),
			promptVersion: PROMPT_VERSION,
			configVersion: CONFIG_VERSION,
		}));
	}
}

function inspectTrace(label, trace) {
	const inspection = inspectTraceReport(trace);
	console.log(`thulr inspect-trace ${label}: judge-grade=${inspection.judgeGrade}  -  ${inspection.issues}`);
	if (inspection.blocking) {
		throw new Error(`${label} trace is not judge-grade; inspect with: thulr inspect-trace --trace ${rel(trace)}`);
	}
}

function judgeTrace(label, { trace, out, compareOut, labels }) {
	const judged = judgeTraceRun({
		trace,
		out,
		compareOut,
		labels,
		header: `\nthulr judge ${label} (${judgeModel}${samples > 1 ? ` x${samples} samples` : ""})`,
		judgeModel,
		samples,
		rate,
		redaction,
		judgeBin,
		excludeCaseIds: CALIBRATION_CASES.map((c) => c.name),
	});
	process.stdout.write(thulr.calibrate(out, { labels }));
	return judged;
}

function readDuelReport(result) {
	try {
		return JSON.parse(result.report);
	} catch {
		return JSON.parse(readFileSync(DUEL_REPORT, "utf8"));
	}
}

// --- Phase: run both arms per case, emit both traces ------------------------
async function runComparisonCases(selected, flow, signal) {
	const rows = [];
	let flowsJudged = 0;
	let plainJudged = 0;
	for (const [caseIndex, testCase] of selected.entries()) {
		for (let trialIndex = 1; trialIndex <= subjectTrials; trialIndex += 1) {
			const identity = trialIdentity(testCase.name, trialIndex, subjectTrials);
			console.log(`${identity.trialId}`);
			const workspaces = pairedCaseWorkspaces(testCase, { dryRun, trialId: identity.trialId });
			try {
				const armOrder = pairedArmOrder(caseIndex, trialIndex);
				const arms = {};
				for (const kind of armOrder) arms[kind] = await runArmWithInfraRetry(kind, testCase, flow, signal, { ...workspaces[kind], snapshotId: workspaces.snapshotId }, identity);
				const { flows, plain } = arms;
				enforceModelParity(flows, plain);
				const constraint = evaluatePairConstraint(flows, plain, bindingConstraint);
				let flowsTraceOk = false;
				let plainTraceOk = false;
				if (dryRun && constraint.pairEligible) {
					flowsTraceOk = true;
					plainTraceOk = true;
				} else if (!dryRun && constraint.pairEligible) {
					flowsTraceOk = appendArmTrace(FLOWS_TRACE, flows, testCase, identity);
					plainTraceOk = appendArmTrace(PLAIN_TRACE, plain, testCase, identity);
					if (flowsTraceOk) flowsJudged += 1;
					if (plainTraceOk) plainJudged += 1;
				}

				rows.push({ ...identity, name: identity.traceCaseId, suite: testCase.suite, taskFamily: testCase.taskFamily, armOrder, constraint, flows, plain, flowsTraceOk, plainTraceOk, duel: null });
				const pairExcluded = flows.exclusion || plain.exclusion;
				const constraintInvalid = !constraint.pairEligible && !pairExcluded;
				const suffix = pairExcluded ? `  inconclusive (${flows.exclusion ? `flows ${flows.exclusion.reason}` : ""}${flows.exclusion && plain.exclusion ? "; " : ""}${plain.exclusion ? `${baselineSlug} ${plain.exclusion.reason}` : ""})` : constraintInvalid ? `  inconclusive (${bindingConstraint.kind} constraint)` : "";
				console.log(`   result flows obj ${flows.exclusion ? "n/a" : scoreText(flows.objective.score ?? 0)}  ${baselineSlug} obj ${plain.exclusion ? "n/a" : scoreText(plain.objective.score ?? 0)}${suffix}`);
			} finally {
				workspaces.dispose();
			}
		}
	}
	return { rows, flowsJudged, plainJudged };
}

// --- Phase: judge both traces, compare them, optionally duel ---------------
function judgeAndCompare(rows, flowsJudged, plainJudged) {
	if (dryRun) {
		dryRunJudgements(rows);
		return { flowsRun: null, plainRun: null };
	}
	if (rows.filter((row) => row.flowsTraceOk && row.plainTraceOk).length === 0) {
		markUnjudgedRows(rows);
		console.log("\nNo selected A/B cases produced judgeable output from both arms; skipping thulr judge/compare/duel. Calibration canaries were not judged because there is no shared product output to compare.");
		return { flowsRun: null, plainRun: null };
	}

	appendCalibration(FLOWS_TRACE, useAgentModels ? "agent-frontmatter" : model);
	appendCalibration(PLAIN_TRACE, useAgentModels ? "agent-frontmatter" : model);
	const flowsCases = flowsJudged + CALIBRATION_CASES.length;
	const plainCases = plainJudged + CALIBRATION_CASES.length;
	console.log(`\ntraces: ${rel(FLOWS_TRACE)} (${flowsCases} cases)  |  ${rel(PLAIN_TRACE)} (${plainCases} cases)`);
	inspectTrace("flows", FLOWS_TRACE);
	inspectTrace(baselineSlug, PLAIN_TRACE);
	const flowsRun = judgeTrace("flows", { trace: FLOWS_TRACE, out: FLOWS_RUN, compareOut: FLOWS_COMPARE, labels: FLOWS_LABELS });
	const plainRun = judgeTrace(baselineSlug, { trace: PLAIN_TRACE, out: PLAIN_RUN, compareOut: PLAIN_COMPARE, labels: PLAIN_LABELS });
	applyJudgedRows(rows, flowsRun.gateEvalRun, plainRun.gateEvalRun);

	const dimensions = thulr.sharedGateDimensions(plainRun.gateEvalRun, flowsRun.gateEvalRun, thulr.evalRunDimensions(flowsRun.gateEvalRun));
	const compareOptions = { baseline: plainRun.comparePath, candidate: flowsRun.comparePath, guardrails: dimensions, scoreGuardrails: dimensions, efficiencyGuardrails, noiseBand, redaction };
	printScoreDeltas({
		run: thulr.compare,
		options: compareOptions,
		heading: `\nthulr A/B deltas (${baselineSlug} -> flows):`,
		unavailable: "\nthulr A/B deltas unavailable",
	});
	const compare = thulr.compare(compareOptions);
	console.log(`\nthulr compare (baseline ${baselineLabel} -> candidate Pi Flows):`);
	process.stdout.write(compare.report);

	if (duelEnabled) {
		console.log(`\nthulr duel (${baselineSlug} vs flows; selected A/B cases only in headline):`);
		const duel = thulr.duel({
			traceA: PLAIN_TRACE,
			traceB: FLOWS_TRACE,
			labelA: baselineSlug,
			labelB: "flows",
			out: DUEL_REPORT,
			model: judgeModel,
			json: true,
			judgeBin,
		});
		applyDuelRows(rows, readDuelReport(duel));
		const summary = duelQualitySummary(rows);
		console.log(`  flows wins ${summary.flows} - ${baselineSlug} wins ${summary.plain} - ties ${summary.ties} - flips ${summary.flips}${summary.skipped ? ` - skipped ${summary.skipped}` : ""}`);
		console.log(`  report ${rel(DUEL_REPORT)}`);
	}
	return { flowsRun, plainRun };
}

// --- Phase: per-case and summary layout ------------------------------------
function reportPerCase(rows) {
	console.log("\nPer-case results");
	for (const row of rows) {
		const delta = judgeDelta(row);
		const arrow = delta === null ? "inconclusive" : delta > 0.001 ? "flows" : delta < -0.001 ? baselineSlug : "tie";
		console.log(row.name);
		console.log(armLine("flows", row.flows));
		console.log(armLine(baselineSlug, row.plain));
		console.log(`   judge delta ${delta === null ? "n/a" : fixed(delta)}  ${arrow}`);
		if (row.duel) {
			if (row.duel.winner === "skipped") {
				console.log(`   duel skipped (${row.duel.reason})`);
			} else {
				console.log(`   duel ${row.duel.winner}  (passes: ${row.duel.first_pass}, ${row.duel.second_pass})`);
			}
		}
	}
}

function reportSummary(rows, totals, exclusions) {
	const comparable = totals.qualityRows.length;
	const caseCount = new Set(rows.map((row) => row.caseId)).size;
	console.log(`\nSummary over ${rows.length} paired trial${rows.length === 1 ? "" : "s"} across ${caseCount} case${caseCount === 1 ? "" : "s"}`);
	const inconclusive = rows.length - comparable;
	console.log(`  quality rows    ${comparable}/${rows.length} comparable${inconclusive ? `  ·  inconclusive ${inconclusive}` : ""}`);
	const duelSummary = duelQualitySummary(rows);
	if (duelEnabled && duelSummary.decided + duelSummary.skipped > 0) {
		console.log(`  thulr duel     flows wins ${duelSummary.flows} - ${baselineSlug} wins ${duelSummary.plain} - ties ${duelSummary.ties} - flips ${duelSummary.flips}${duelSummary.skipped ? ` - skipped ${duelSummary.skipped}` : ""}`);
	}
	console.log(`  thulr pass     flows ${totals.flowsCriterionPasses}/${comparable} (${pct(totals.flowsCriterionPasses, comparable)})    ${baselineSlug} ${totals.plainCriterionPasses}/${comparable} (${pct(totals.plainCriterionPasses, comparable)})`);
	console.log(`  thulr mean     flows ${comparable ? totals.flowsJudgeMean.toFixed(2) : "n/a"}    ${baselineSlug} ${comparable ? totals.plainJudgeMean.toFixed(2) : "n/a"}    lift ${comparable ? fixed(totals.flowsJudgeMean - totals.plainJudgeMean) : "n/a"}`);
	console.log(`  abs per-case   flows wins ${totals.wins} - ${baselineSlug} wins ${totals.losses} - ties ${comparable - totals.wins - totals.losses}`);
	if (exclusions.flows.infra || exclusions.plain.infra || exclusions.flows.debug_budget || exclusions.plain.debug_budget) {
		console.log(`  exclusions     flows infra ${exclusions.flows.infra}, debug ${exclusions.flows.debug_budget}  ·  ${baselineSlug} infra ${exclusions.plain.infra}, debug ${exclusions.plain.debug_budget}`);
	}
	console.log(`  est. cost      flows $${totals.flowsCost.toFixed(4)}    ${baselineSlug} ${totals.baselineCostKnown ? `$${totals.plainCost.toFixed(4)}` : "n/a (model price unavailable)"}${totals.baselineCostKnown && totals.plainCost > 0 ? `    (${(totals.flowsCost / totals.plainCost).toFixed(1)}x baseline)` : ""}`);
	console.log(`  ${formatTokenComparison("flows", totals.flowsTokens, baselineSlug, totals.plainTokens)}`);
	console.log(`  wall-clock     flows ${totals.flowsSeconds.toFixed(0)}s    ${baselineSlug} ${totals.plainSeconds.toFixed(0)}s`);
	console.log(`\nNote: ${baselineLabel} is the baseline and Pi Flows is the candidate in thulr compare. Both arms must report the same underlying model or the pair is excluded. Native thulr duel is the head-to-head quality signal.`);
}

function rawArtifactRows(rows) {
	return rows.map((row) => ({
		caseId: row.caseId,
		trialId: row.trialId,
		traceCaseId: row.traceCaseId,
		trialIndex: row.trialIndex,
		suite: row.suite,
		taskFamily: row.taskFamily,
		armOrder: row.armOrder.map((kind) => kind === "plain" ? "baseline" : kind),
		constraint: row.constraint,
		duel: row.duel,
		comparable: row.flowsTraceOk && row.plainTraceOk,
		flows: pickArm(row.flows),
		baseline: pickArm(row.plain),
	}));
}

async function main() {
	if (!preflight()) process.exit(2);

	const selected = selectMeasurementCases(CASES, { filter, includeControls });
	if (selected.length === 0) {
		console.error(`No cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	mkdirSync(TRACE_DIR, { recursive: true });
	mkdirSync(dirname(FLOWS_TRACE), { recursive: true });
	mkdirSync(dirname(PLAIN_TRACE), { recursive: true });
	thulr.startTrace(FLOWS_TRACE);
	thulr.startTrace(PLAIN_TRACE);

	const flow = flowTool();
	const signal = new AbortController().signal;
	const trace = process.env.PI_FLOWS_TRACE_FILE ? `  -  trace ${process.env.PI_FLOWS_TRACE_FILE}` : "";
	const judgeBinLabel = !dryRun && judgeBin ? ` via ${rel(judgeBin)}` : "";
	const constraintLabel = `${bindingConstraint.kind} ${bindingConstraint.value} ${bindingConstraint.unit}`;
	const safetyTimeoutLabel = bindingConstraint.kind === "deadline" ? "" : `  -  safety timeout ${formatDuration(timeoutMs)} default; per-case budgets honored`;
	console.log(`pi-flows paired A/B (${baselineLabel} baseline vs Pi Flows)  -  subject ${useAgentModels ? "(agent frontmatter)" : model}  -  ${subjectTrials} subject trial${subjectTrials === 1 ? "" : "s"}  -  judge ${dryRun ? "(skipped)" : `${judgeModel}${judgeBinLabel}`}${duelEnabled ? " +duel" : ""}  -  binding constraint ${constraintLabel}${safetyTimeoutLabel}${trace}${dryRun ? "  -  DRY RUN" : ""}\n`);

	const { rows, flowsJudged, plainJudged } = await runComparisonCases(selected, flow, signal);
	const { flowsRun, plainRun } = judgeAndCompare(rows, flowsJudged, plainJudged);

	reportPerCase(rows);
	const totals = comparisonTotals(rows);
	const exclusions = exclusionSummary(rows);
	reportSummary(rows, totals, exclusions);
	const rawRows = rawArtifactRows(rows);
	const analysis = buildPairedAnalysis(rawRows, promotionRule);
	console.log(`\n${formatPairedAnalysis(analysis).join("\n")}`);
	const excludedIds = selected
		.filter((testCase) => rows.filter((row) => row.caseId === testCase.name).every((row) => !row.flowsTraceOk || !row.plainTraceOk))
		.map((testCase) => testCase.name);
	console.log(formatPortfolioReport(portfolioReport(selected, { excluded: excludedIds })));

	if (writeArtifact) {
		const out = resolve(process.cwd(), writeArtifact);
		writeFileSync(out, `${JSON.stringify({ schemaVersion: "pi-flows.paired-comparison.v1", model: useAgentModels ? "agent" : model, baseline: { kind: baselineKind, label: baselineLabel }, judgeModel, subjectTrials, constraint: bindingConstraint, promotionRule, costBasis: "model-price-estimate", duel: duelEnabled, qualityRows: totals.qualityRows.length, exclusions, thulr: { flows: flowsRun ? rel(flowsRun.comparePath) : null, baseline: plainRun ? rel(plainRun.comparePath) : null, duel: duelEnabled && flowsRun && plainRun ? rel(DUEL_REPORT) : null }, analysis, rawRows }, null, 2)}\n`, "utf8");
		console.log(`\nWrote comparison: ${out}`);
	}

	if (rows.some((r) => r.flows.exclusion?.reason === "infra" || r.plain.exclusion?.reason === "infra")) {
		console.log("\nWARN Some arms could not complete (auth, credits, network, or timeout) - inconclusive infra, not a quality verdict.");
	}
}

main().catch((error) => {
	console.error(`compare failed: ${error?.stack ?? error}`);
	process.exit(1);
});
