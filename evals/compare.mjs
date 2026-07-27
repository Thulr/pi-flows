// Paired A/B harness: runs two named arms on the same subject model, task,
// trial identity, binding constraint, and immutable workspace snapshot.
// The default compares full Pi Flows against direct Codex; `--baseline=pi`
// selects plain headless Pi. Repeated trials, named ablations, promotion rules,
// trace linkage, and output flags are documented in evals/README.md.
// Shared phases live in evals/pipeline.mjs; report arithmetic and per-arm
// lines live in evals/compare-report.mjs. This file owns the A/B layout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { codexModelFromPi, runCodex } from "./baseline-codex.mjs";
import { runPlainPi } from "./baseline-pi.mjs";
import { corpusPreflightStep, formatPortfolioReport, portfolioReport } from "./case-contract.mjs";
import { createFlagReader } from "./cli-flags.mjs";
import { CALIBRATION_CASES, CASES, EVAL_CORPUS } from "./corpus.mjs";
import { ablationAttribution, experimentArmInfo, parseArmSelection, planExperimentArm } from "./experiment-arms.mjs";
import { applyDuelRows, applyJudgedRows, comparisonTotals, dryRunJudgements, duelQualitySummary, exclusionSummary, formatDuration, markUnjudgedRows, scoreText, unjudgedArm } from "./compare-report.mjs";
import { rawArtifactRows, reportPerCase, reportSummary } from "./comparison-output.mjs";
import { answerText, answerWithArtifacts, armBudgetSignal, exclusionForRun, flowTool, scoreObjective, DEFAULT_EVAL_MODEL, subjectModelName, sumTokenUsage, timeoutPlanForCase } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import { armExecutionTiming, buildPairedAnalysis, evaluatePairConstraint, formatPairedAnalysis, pairedArmOrder, parseBindingConstraint, parsePromotionRule } from "./paired-experiment.mjs";
import { deadlineExpiredArm, runArmWithRetry } from "./paired-retry.mjs";
import { pairedCaseWorkspaces } from "./paired-workspace.mjs";
import { calibrationSpanFields, caseSpanFields, inspectTraceReport, judgeTraceRun, printScoreDeltas, relativeToRepo as rel, repoPath as p, selectMeasurementCases } from "./pipeline.mjs";
import { loadDotenv, requireBinary, requireHealthyThulr, runPreflight } from "./preflight.mjs";
import { MAX_SUBJECT_TRIALS, trialIdentity } from "./reliability.mjs";
import { evalRunId, measurementRuntimeEvidence, runtimeTraceContext } from "./runtime-trace.mjs";
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
let armNames;
try {
	armNames = parseArmSelection(flag("arms", null));
} catch (error) {
	console.error(error.message);
	process.exit(2);
}
const armPair = { reference: experimentArmInfo(armNames[0]), candidate: experimentArmInfo(armNames[1]) };
const referenceLabel = armPair.reference.name;
const candidateLabel = armPair.candidate.name;
const legacyDefaultArms = referenceLabel === "direct" && candidateLabel === "full";
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
if ([armPair.reference, armPair.candidate].some((arm) => arm.runner === "baseline") && baselineKind === "codex" && bindingConstraint.kind !== "deadline") {
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
const EVAL_RUN_ID = evalRunId(flag("run-id", null));
const RUNTIME_TRACE = p(flag("runtime-trace", ".thulr/runs/ab-runtime.trace.jsonl"));
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

function comparisonTimeoutPlan(testCase) {
	const base = timeoutPlanForCase(testCase, { defaultTimeoutMs: timeoutMs });
	return bindingConstraint.kind === "deadline"
		? { ...base, effectiveTimeoutMs: bindingConstraint.value }
		: base;
}

function inapplicableMeasurement(plan, testCase, workspace) {
	return {
		...unjudgedArm(),
		objective: { pass: false, score: 0, notes: plan.exclusion.detail },
		exclusion: plan.exclusion,
		timeoutPlan: comparisonTimeoutPlan(testCase),
		result: null,
		durationMs: 0,
		workerTimeMs: 0,
		answer: "",
		task: testCase.params.task,
		modelName: useAgentModels ? "agent-frontmatter" : model,
		reportedModels: [],
		workspaceSnapshotId: workspace.snapshotId,
		tokensTotal: 0,
		tokenUsage: { known: false, input: null, output: null, total: null },
		cost: 0,
		costKnown: false,
		deadlineExcludedMs: 0,
		arm: { name: plan.name, component: plan.component, topology: plan.topology, configurationIdentity: plan.configurationIdentity, computeAllocation: plan.computeAllocation ?? null },
	};
}

async function runArm(kind, plan, testCase, flow, signal, workspace, identity, remainingTimeoutMs, attempt = 1) {
	if (!plan.applicable) return inapplicableMeasurement(plan, testCase, workspace);
	const cwd = workspace.cwd;
	const flowCtx = { cwd, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
	const ctx = { flow, model: subjectModel, dryRun, flowCtx };
	const startedAt = Date.now();
	const traceContext = runtimeTraceContext(EVAL_RUN_ID, { ...identity, arm: plan.name, attempt });
	const task = plan.task ?? plan.params?.task ?? testCase.params.task;
	const timeoutPlan = comparisonTimeoutPlan(testCase);
	const effectiveTimeoutMs = timeoutPlan.effectiveTimeoutMs;
	const executionTimeoutMs = Math.max(1, Math.min(effectiveTimeoutMs, remainingTimeoutMs ?? effectiveTimeoutMs));
	const armBudget = armBudgetSignal(signal, dryRun ? 0 : executionTimeoutMs);
	const progress = (message) => {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`   ${plan.name} +${elapsed}s ${String(message ?? "").replace(/\s+/g, " ").slice(0, 180)}`);
	};

	let result;
	let thrown;
	if (dryRun) {
		result = testCase.mock;
	} else if (plan.runner === "flow") {
		const constraintBudget = bindingConstraint.kind === "cost"
			? { maxCostUsd: bindingConstraint.value }
			: bindingConstraint.kind === "generated_tokens" ? { maxGeneratedTokens: bindingConstraint.value } : {};
		const params = {
			...injectModel(plan.params, model),
			...constraintBudget,
			traceFile: RUNTIME_TRACE,
			traceLabel: identity.traceCaseId,
			traceContext,
			timeoutMs: executionTimeoutMs,
		};
		try {
			result = await flow.execute(`cmp:${plan.name}:${identity.trialId}`, params, armBudget.signal, (partial) => progress(partial?.content?.[0]?.text), flowCtx);
		} catch (error) {
			thrown = error;
		}
	} else {
		try {
			progress(`starting ${baselineLabel} process...`);
			result = baselineKind === "codex"
				? await runCodex({ task, cwd, model: codexModel, reportedModel: subjectModel, timeoutMs: executionTimeoutMs, signal: armBudget.signal })
				: await runPlainPi({ task, cwd, model: subjectModel, timeoutMs: executionTimeoutMs, signal: armBudget.signal,
					...(bindingConstraint.kind === "cost" ? { maxCostUsd: bindingConstraint.value } : {}),
					...(bindingConstraint.kind === "generated_tokens" ? { maxGeneratedTokens: bindingConstraint.value } : {}) });
		} catch (error) {
			thrown = error;
		}
	}
	armBudget.dispose();
	const executionEndedAt = Date.now();
	const postExecutionStartedAt = performance.now();
	const timing = armExecutionTiming(result, executionEndedAt - startedAt);
	const objective = await scoreObjective({ result, thrown, testCase, ctx });
	const exclusion = armBudget.timedOut
		? {
			reason: timeoutPlan.debugBudget ? "debug_budget" : "infra",
			detail: `${timeoutPlan.debugBudget ? "debug " : ""}arm timed out after ${executionTimeoutMs}ms (case budget ${timeoutPlan.caseTimeoutMs}ms)`,
		}
		: exclusionForRun({ reachedModel: objective.reachedModel, timeoutPlan });
	const children = result?.details?.results ?? [];
	const tokenUsage = sumTokenUsage(result);
	const { runtimeTrace, scoreFamilies } = measurementRuntimeEvidence({
		dryRun, runner: plan.runner, result, thrown, objective: objective.objective,
		traceFile: RUNTIME_TRACE, displayTraceFile: rel(RUNTIME_TRACE), context: traceContext,
		baselineMode: `baseline.${baselineKind}`, startMs: startedAt, endMs: executionEndedAt,
		model: subjectModelName(result, model),
	});
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
		reportedModels: [...new Set(children.map((child) => child?.model).filter(Boolean))],
		workspaceSnapshotId: workspace.snapshotId,
		tokensTotal: tokenUsage.total,
		tokenUsage,
		costKnown: children.length > 0 && children.every((child) => child?.usage?.costKnown === true),
		deadlineExcludedMs: performance.now() - postExecutionStartedAt,
		arm: { name: plan.name, component: plan.component, topology: plan.topology, configurationIdentity: plan.configurationIdentity, computeAllocation: plan.computeAllocation ?? null },
		runtimeTrace,
		scoreFamilies,
	};
}

async function runArmWithInfraRetry(kind, plan, testCase, flow, signal, workspaces, identity) {
	if (!plan.applicable) return inapplicableMeasurement(plan, testCase, workspaces[kind]);
	return runArmWithRetry({
		maxRetries: infraRetries,
		retryDelayMs: infraRetryDelayMs,
		timeoutMs: comparisonTimeoutPlan(testCase).effectiveTimeoutMs,
		freshWorkspace: (attempt) => attempt === 1 ? workspaces[kind] : workspaces.freshArm(kind),
		runAttempt: ({ attempt, timeoutMs: remainingTimeoutMs, workspace }) => runArm(kind, plan, testCase, flow, signal, workspace, identity, remainingTimeoutMs, attempt),
		onRetry: ({ arm, attempt, maxRetries }) => console.log(`   ${plan.name} infra retry ${attempt}/${maxRetries} after zero-token failure: ${String(arm.exclusion.detail).replace(/\s+/g, " ").slice(0, 240)}`),
		onDeadline: ({ arm }) => deadlineExpiredArm(arm, { timeoutPlan: comparisonTimeoutPlan(testCase), task: testCase.params.task, modelName: model, snapshotId: workspaces.snapshotId }),
	});
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
		configVersion: `${CONFIG_VERSION}:${arm.arm.configurationIdentity}`,
		evalRunId: EVAL_RUN_ID,
		runtimeTrace: arm.runtimeTrace,
		scoreFamilies: arm.scoreFamilies,
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
				const plans = {
					plain: planExperimentArm(armPair.reference.name, testCase, { bindingConstraint, seed: identity.trialId }),
					flows: planExperimentArm(armPair.candidate.name, testCase, { bindingConstraint, seed: identity.trialId }),
				};
				const arms = {};
				for (const kind of armOrder) arms[kind] = await runArmWithInfraRetry(kind, plans[kind], testCase, flow, signal, workspaces, identity);
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
				const suffix = pairExcluded ? `  inconclusive (${flows.exclusion ? `${candidateLabel} ${flows.exclusion.reason}` : ""}${flows.exclusion && plain.exclusion ? "; " : ""}${plain.exclusion ? `${referenceLabel} ${plain.exclusion.reason}` : ""})` : constraintInvalid ? `  inconclusive (${bindingConstraint.kind} constraint)` : "";
				console.log(`   result ${candidateLabel} obj ${flows.exclusion ? "n/a" : scoreText(flows.objective.score ?? 0)}  ${referenceLabel} obj ${plain.exclusion ? "n/a" : scoreText(plain.objective.score ?? 0)}${suffix}`);
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
	inspectTrace(candidateLabel, FLOWS_TRACE);
	inspectTrace(referenceLabel, PLAIN_TRACE);
	const flowsRun = judgeTrace(candidateLabel, { trace: FLOWS_TRACE, out: FLOWS_RUN, compareOut: FLOWS_COMPARE, labels: FLOWS_LABELS });
	const plainRun = judgeTrace(referenceLabel, { trace: PLAIN_TRACE, out: PLAIN_RUN, compareOut: PLAIN_COMPARE, labels: PLAIN_LABELS });
	applyJudgedRows(rows, flowsRun.gateEvalRun, plainRun.gateEvalRun);

	const dimensions = thulr.sharedGateDimensions(plainRun.gateEvalRun, flowsRun.gateEvalRun, thulr.evalRunDimensions(flowsRun.gateEvalRun));
	const compareOptions = { baseline: plainRun.comparePath, candidate: flowsRun.comparePath, guardrails: dimensions, scoreGuardrails: dimensions, efficiencyGuardrails, noiseBand, redaction };
	printScoreDeltas({
		run: thulr.compare,
		options: compareOptions,
			heading: `\nthulr A/B deltas (${referenceLabel} -> ${candidateLabel}):`,
		unavailable: "\nthulr A/B deltas unavailable",
	});
	const compare = thulr.compare(compareOptions);
	console.log(`\nthulr compare (${referenceLabel} -> ${candidateLabel}):`);
	process.stdout.write(compare.report);

	if (duelEnabled) {
		console.log(`\nthulr duel (${referenceLabel} vs ${candidateLabel}; selected A/B cases only in headline):`);
		const duel = thulr.duel({
			traceA: PLAIN_TRACE,
			traceB: FLOWS_TRACE,
			labelA: referenceLabel,
			labelB: candidateLabel,
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
	mkdirSync(dirname(RUNTIME_TRACE), { recursive: true });
	thulr.startTrace(FLOWS_TRACE);
	thulr.startTrace(PLAIN_TRACE);
	writeFileSync(RUNTIME_TRACE, "", "utf8");

	const flow = flowTool();
	const signal = new AbortController().signal;
	const trace = process.env.PI_FLOWS_TRACE_FILE ? `  -  trace ${process.env.PI_FLOWS_TRACE_FILE}` : "";
	const judgeBinLabel = !dryRun && judgeBin ? ` via ${rel(judgeBin)}` : "";
	const constraintLabel = `${bindingConstraint.kind} ${bindingConstraint.value} ${bindingConstraint.unit}`;
	const safetyTimeoutLabel = bindingConstraint.kind === "deadline" ? "" : `  -  safety timeout ${formatDuration(timeoutMs)} default; per-case budgets honored`;
	console.log(`pi-flows paired A/B (${referenceLabel} reference vs ${candidateLabel} candidate)  -  subject ${useAgentModels ? "(agent frontmatter)" : model}  -  ${subjectTrials} subject trial${subjectTrials === 1 ? "" : "s"}  -  judge ${dryRun ? "(skipped)" : `${judgeModel}${judgeBinLabel}`}${duelEnabled ? " +duel" : ""}  -  binding constraint ${constraintLabel}${safetyTimeoutLabel}${trace}${dryRun ? "  -  DRY RUN" : ""}\n`);

	const { rows, flowsJudged, plainJudged } = await runComparisonCases(selected, flow, signal);
	const { flowsRun, plainRun } = judgeAndCompare(rows, flowsJudged, plainJudged);

	const outputLabels = { candidateLabel, referenceLabel, legacyDefaultArms };
	reportPerCase(rows, outputLabels);
	const totals = comparisonTotals(rows);
	const exclusions = exclusionSummary(rows);
	reportSummary(rows, totals, exclusions, { ...outputLabels, duelEnabled });
	const rawRows = rawArtifactRows(rows, outputLabels);
	const analysis = buildPairedAnalysis(rawRows, promotionRule);
	analysis.ablation = ablationAttribution(analysis, armPair);
	console.log(`\n${formatPairedAnalysis(analysis).join("\n")}`);
	console.log(`  attributed ${analysis.ablation.component} lift: quality ${analysis.ablation.qualityLift ?? "n/a"}, reliability ${analysis.ablation.reliabilityLift ?? "n/a"} (${referenceLabel} -> ${candidateLabel})`);
	const excludedIds = selected
		.filter((testCase) => rows.filter((row) => row.caseId === testCase.name).every((row) => !row.flowsTraceOk || !row.plainTraceOk))
		.map((testCase) => testCase.name);
	console.log(formatPortfolioReport(portfolioReport(selected, { excluded: excludedIds })));

	if (writeArtifact) {
		const out = resolve(process.cwd(), writeArtifact);
			writeFileSync(out, `${JSON.stringify({ schemaVersion: "pi-flows.paired-comparison.v1", runId: EVAL_RUN_ID, runtimeTraceFile: rel(RUNTIME_TRACE), model: useAgentModels ? "agent" : model, baseline: { kind: baselineKind, label: baselineLabel }, arms: armPair, judgeModel, subjectTrials, constraint: bindingConstraint, promotionRule, costBasis: "model-price-estimate", duel: duelEnabled, qualityRows: totals.qualityRows.length, exclusions, thulr: { flows: flowsRun ? rel(flowsRun.comparePath) : null, baseline: plainRun ? rel(plainRun.comparePath) : null, duel: duelEnabled && flowsRun && plainRun ? rel(DUEL_REPORT) : null }, analysis, rawRows }, null, 2)}\n`, "utf8");
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
