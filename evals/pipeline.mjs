// The eval pipeline: the phases both measurement CLIs run, as named functions.
//
// evals/run.mjs (single-arm gate) and evals/compare.mjs (flows-vs-baseline A/B)
// walk the same five phases — parse argv, preflight, run arms, emit a trace,
// judge/gate — and only the middle phase genuinely differs. Everything else
// lives here so each CLI stays a thin adapter: wire its config, call the phases,
// print its own layout, exit. Each phase is importable and callable in-process,
// so it can be unit-tested without spawning a CLI.
//
// Phase ownership:
//   selectMeasurementCases  both
//   caseSpanFields          both (the case -> thulr span projection)
//   inspectTraceReport      both
//   judgeTraceRun           both
//   printScoreDeltas        both (run.mjs passes thulr.gate, compare.mjs thulr.compare)
//   gateAgainstBaseline     run.mjs only — the release gate + JUnit artifact
//   harnessExitCode         run.mjs only — the two-axis exit policy
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as thulr from "./thulr.mjs";

/** Absolute path for a repo-relative path. */
export const repoPath = (relPath) => resolve(process.cwd(), relPath);

/** Repo-relative display path — stable across machines in logs and traces. */
export const relativeToRepo = (path) => (path.startsWith(`${process.cwd()}/`) ? path.slice(process.cwd().length + 1) : path);

/** The label the trace records when an objective check fails without a case-specific tag. */
export const DEFAULT_FAILURE_MODE = "final_answer.deterministic_fail";

// --- Phase: case selection -------------------------------------------------

/**
 * The cases a run measures. Controls (threshold negatives) are excluded unless
 * asked for, and `--filter` is a substring match on the case name.
 */
export const selectMeasurementCases = (cases, { filter = "", includeControls = false } = {}) =>
	cases.filter((c) => (includeControls || !c.control) && (!filter || c.name.includes(filter)));

// --- Phase: case -> thulr span projection ----------------------------------

/**
 * Project one scored case onto the self-contained span thulr judges. The trace
 * carries judge context (answer, criterion, task, expected behavior) AND repro
 * metadata (model, cost, tokens, prompt/config version) inline, because thulr
 * reads everything from the trace — there is no separate manifest.
 *
 * The three fallbacks are the contract: a case with no explicit
 * `expectedBehavior` is judged against its criterion, a failing case with no
 * explicit `failureModes` gets the deterministic-fail tag, and `label` is
 * coerced to a boolean because it is the ground truth thulr calibrates against.
 *
 * @param {object} testCase the case definition (name, criterion, labels, …)
 * @param {object} measured the per-run values: answer, label, endMs, model, task,
 *   costUsd, tokensTotal, journeyStage, promptVersion, configVersion
 */
export function caseSpanFields(testCase, { answer, label, endMs, model, task, costUsd, tokensTotal, journeyStage, promptVersion, configVersion, caseId, trialId, traceCaseId, trialIndex }) {
	return {
		name: traceCaseId ?? testCase.name,
		baseCaseId: caseId ?? testCase.name,
		trialId,
		trialIndex,
		answer,
		criterion: testCase.criterion,
		criteria: testCase.criteria,
		label: !!label,
		labels: testCase.labels,
		judgeOnlyDimensions: testCase.judgeOnlyDimensions,
		journeyStage,
		endMs,
		model,
		task,
		expectedBehavior: testCase.expectedBehavior ?? testCase.criterion,
		failureModes: label ? [] : (testCase.failureModes ?? [DEFAULT_FAILURE_MODE]),
		costUsd,
		tokensTotal,
		promptVersion,
		configVersion,
	};
}

/** A calibration canary's fixed objective — always a deterministic negative label. */
export const calibrationObjective = (testCase) => testCase.objective ?? { pass: false, score: 0, notes: "calibration canary" };

/**
 * The span for a calibration canary: a fixed known-bad/partial answer that costs
 * nothing, defaults to the `calibration` journey stage, and measures judge TNR
 * without ever counting as a behaviour or release-gate row.
 */
export function calibrationSpanFields(testCase, { model, endMs, promptVersion, configVersion }) {
	return caseSpanFields(testCase, {
		answer: testCase.answer,
		label: calibrationObjective(testCase).pass,
		endMs,
		model,
		task: testCase.task,
		costUsd: 0,
		tokensTotal: 0,
		journeyStage: testCase.journeyStage ?? "calibration",
		promptVersion,
		configVersion,
	});
}

// --- Phase: trace inspection, judging, gating ------------------------------

/**
 * `thulr inspect-trace`, decoded: is the trace judge-grade, and what does the
 * CLI print about it. `blocking` is true when the trace has REQUIRED issues —
 * judging it anyway would spend tokens on a trace thulr cannot grade.
 */
export function inspectTraceReport(trace) {
	const report = thulr.inspectTrace(trace);
	return {
		report,
		judgeGrade: report.judge_grade ? "yes" : "no",
		issues: report.required_issue_count
			? `${report.required_issue_count} required issue(s)`
			: `${report.warning_count ?? 0} warning(s)`,
		blocking: !!report.required_issue_count,
	};
}

/**
 * Label failures, judge the trace, and derive the gate/compare candidate.
 *
 * When `excludeCaseIds` is empty the judged EvalRun IS the gate candidate and no
 * second file is written; otherwise the named cases (calibration canaries) are
 * dropped and the reduced run is written to `compareOut`, so the release gate
 * never compares pass rates that include fixed known-bad answers.
 *
 * @returns {{ evalRun: object, gateEvalRun: object, path: string, comparePath: string }}
 */
export function judgeTraceRun({ trace, out, compareOut, labels, header, judgeModel, samples, evalSet, rate, redaction, judgeBin, excludeCaseIds = [], log = console.log }) {
	thulr.labelFailures({ trace, out: labels });
	if (header) log(header);
	thulr.judge({ trace, model: judgeModel, out, samples, evalSet, rate, redaction, judgeBin });
	const evalRun = JSON.parse(readFileSync(out, "utf8"));
	if (excludeCaseIds.length === 0) return { evalRun, gateEvalRun: evalRun, path: out, comparePath: out };
	const gateEvalRun = thulr.gateCandidateForEvalRun(evalRun, { excludeCaseIds });
	writeFileSync(compareOut, `${JSON.stringify(gateEvalRun, null, 2)}\n`, "utf8");
	return { evalRun, gateEvalRun, path: out, comparePath: compareOut };
}

/**
 * Print the per-dimension score/efficiency deltas from a gate or compare run.
 * `run` is `thulr.gate` or `thulr.compare`; both are free (no judge calls), so
 * rendering the comparison twice costs nothing and a failure here is reported
 * rather than fatal — the deltas are commentary on the verdict, not the verdict.
 */
export function printScoreDeltas({ run, options, heading, unavailable, log = console.log }) {
	try {
		const json = run({ ...options, json: true });
		const deltaLines = thulr.formatGateScoreSummary(json.report);
		if (deltaLines.length) {
			log(heading);
			for (const line of deltaLines) log(`  ${line}`);
		}
	} catch (error) {
		log(`${unavailable}: ${error?.message ?? error}`);
	}
}

/**
 * The release gate: compare the candidate against the baseline on the dimensions
 * BOTH runs carry (a dimension the baseline has never seen cannot regress), then
 * optionally re-render the same comparison as JUnit XML for CI ingestion.
 *
 * @returns {{ blocks: boolean, report: string }} thulr's gate result
 */
export function gateAgainstBaseline({ baseline, candidate, gateEvalRun, extraScoreGuardrails = [], efficiencyGuardrails, noiseBand, redaction, junitOut = null, log = console.log }) {
	const baselineRun = JSON.parse(readFileSync(baseline, "utf8"));
	const candidateDimensions = thulr.evalRunDimensions(gateEvalRun);
	const gateDimensions = thulr.sharedGateDimensions(baselineRun, gateEvalRun, candidateDimensions);
	const waitingForBaseline = candidateDimensions.filter((dimension) => !gateDimensions.includes(dimension));
	const requestedScoreGuardrails = [...new Set(["criterion", ...extraScoreGuardrails])];
	const guardrails = gateDimensions.filter((dimension) => dimension === "criterion");
	const scoreGuardrails = gateDimensions.filter((dimension) => requestedScoreGuardrails.includes(dimension));
	const gateOptions = { baseline, candidate, guardrails, scoreGuardrails, efficiencyGuardrails, noiseBand, redaction };
	if (waitingForBaseline.length) {
		log(`\nnamed dimensions awaiting refreshed baseline: ${waitingForBaseline.join(", ")}`);
	}
	printScoreDeltas({ run: thulr.gate, options: gateOptions, heading: "\nthulr score deltas:", unavailable: "\nthulr score deltas unavailable", log });
	const gateResult = thulr.gate(gateOptions);
	log(`\ngate vs ${relativeToRepo(baseline)}:`);
	process.stdout.write(gateResult.report);
	if (junitOut) {
		const junit = thulr.gate({ ...gateOptions, format: "junit" });
		mkdirSync(dirname(junitOut), { recursive: true });
		writeFileSync(junitOut, junit.report, "utf8");
		log(`junit gate report written to ${relativeToRepo(junitOut)}`);
	}
	return gateResult;
}

// --- Phase: exit policy ----------------------------------------------------

/**
 * The harness exit code. A run is green only when every MEASURED behaviour case
 * passed both axes, the gate found no regression, and nothing was excluded as
 * infrastructure. A run with zero measured cases is green only if infra was not
 * the reason there are none — otherwise a total auth failure would exit 0.
 *
 * Pure so the policy can be read and tested without running an eval.
 *
 * @param {{ measured: number, passed: number, infraExcluded?: number, gateBlocks?: boolean }} counts
 * @returns {0 | 1}
 */
export function harnessExitCode({ measured, passed, infraExcluded = 0, gateBlocks = false }) {
	const infraBlocked = infraExcluded > 0;
	const measuredPass = measured === 0 ? !infraBlocked : passed === measured;
	return measuredPass && !gateBlocks && !infraBlocked ? 0 : 1;
}
