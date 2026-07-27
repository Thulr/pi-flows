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
//   writeReliabilityArtifact run.mjs only — the per-trial reliability artifact
//   assessCalibration       run.mjs only — judge calibration + its gate rules
//   gateAgainstBaseline     run.mjs only — the release gate + JUnit artifact
//   harnessExitCode         run.mjs only — the two-axis exit policy
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as thulr from "./thulr.mjs";
import { caseSplit } from "./calibration-coverage.mjs";
import { buildCalibrationReport, calibrationGateIssues, calibrationRecords, formatCalibrationReport, DEFAULT_CRITICAL_MISS_RATE_CAP } from "./calibration.mjs";
import { calibrationKey, rubricDigest, traceAttributeDigest, EVAL_TRACE_SCHEMA_VERSION } from "./calibration-key.mjs";
import { buildReviewReport, reviewGroundTruth, reviewSetPath } from "./review-agreement.mjs";
import { buildReliabilityReport, formatReliabilitySummary } from "./reliability.mjs";

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
export function caseSpanFields(testCase, { answer, label, endMs, model, task, costUsd, tokensTotal, journeyStage, promptVersion, configVersion, caseId, trialId, traceCaseId, trialIndex, evalRunId, runtimeTrace, scoreFamilies }) {
	return {
		name: traceCaseId ?? testCase.name,
		baseCaseId: caseId ?? testCase.name,
		trialId,
		trialIndex,
		evalRunId,
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
		runtimeTrace,
		scoreFamilies,
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

// --- Phase: reliability artifact -------------------------------------------
/**
 * Project the run's per-case summaries onto raw trials, build the reliability
 * report, write it, and print its headline. A phase rather than a statistics
 * helper: it does IO and prints, so it lives here and `reliability.mjs` stays a
 * pure builder plus formatter.
 *
 * `judgeAvailable` is false in dry runs and in runs with nothing judgeable: with
 * no judge verdict, a trial passes on its objective check alone rather than on a
 * verdict that was never rendered.
 */
export function writeReliabilityArtifact(summaries, verdicts, { judgeAvailable, out, subjectTrials, judgeSamples, runId, runtimeTraceFile, displayPath = out, log = console.log }) {
	const rawTrials = summaries.map((summary) => {
		const judge = verdicts.get(summary.traceCaseId) ?? null;
		return {
			caseId: summary.caseId,
			trialId: summary.trialId,
			traceCaseId: summary.traceCaseId,
			trialIndex: summary.trialIndex,
			pass: !summary.exclusion && summary.objective.pass && (!judgeAvailable || judge?.criterion?.verdict === true),
			objective: summary.objective,
			judge,
			answer: summary.answer,
			costUsd: summary.costUsd,
			tokens: summary.tokens,
			durationMs: summary.durationMs,
			exclusion: summary.exclusion,
			infraFailure: summary.infraFailure,
			runtimeTrace: summary.runtimeTrace,
			scoreFamilies: summary.scoreFamilies,
		};
	});
	const report = buildReliabilityReport(rawTrials, { subjectTrials, judgeSamples, runId, runtimeTraceFile });
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	for (const line of formatReliabilitySummary(report)) log(line);
	log(`Raw trial reliability report: ${displayPath} (subject trials ${subjectTrials}; judge-noise samples ${judgeSamples})`);
	return report;
}

// --- Phase: judge calibration ----------------------------------------------

const readJsonOrNull = (path) => {
	try {
		return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
	} catch {
		return null;
	}
};

/** The trace's span shapes, so a changed case -> span projection invalidates calibration on its own. */
function traceSpans(trace) {
	if (!existsSync(trace)) return [];
	return readFileSync(trace, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

/**
 * Calibrate the judge against ground truth, then decide whether that calibration
 * is good enough to gate a release.
 *
 * The stored calibration from the previous run is read back purely to detect
 * drift: if this run's judge, rubric, thresholds, or trace projection differ, the
 * old numbers are reported as stale rather than silently carried forward.
 *
 * @returns {{ report: object, issues: string[], blocks: boolean, path: string|null }}
 */
export function assessCalibration({
	corpus,
	summaries,
	verdicts,
	keyInputs,
	reviewsPath = null,
	criticalDimensions = [],
	criticalMissRateCap = DEFAULT_CRITICAL_MISS_RATE_CAP,
	abstentionBand,
	trace,
	out = null,
	log = console.log,
}) {
	const groups = { measurement: corpus.measurement ?? [], calibration: corpus.calibration ?? [] };
	const allCases = [...groups.measurement, ...groups.calibration];
	const byId = new Map(allCases.map((testCase) => [testCase.id ?? testCase.name, testCase]));
	const splitEntries = Object.entries(groups).flatMap(([group, cases]) => cases.map((testCase) => ({ testCase, split: caseSplit(testCase, { group }) })));

	// Two identities, deliberately. `caseId` is the BASE case, which is what
	// coverage counts — five trials of one case are one observation, and keying
	// coverage on the per-trial id would let `--trials=3` manufacture three
	// "independent" labels out of one. `verdictKey` is the per-trial id the judge
	// actually rendered a verdict against.
	const cases = summaries
		.filter((summary) => !summary.excludedReason)
		.map((summary) => {
			const testCase = byId.get(summary.caseId ?? summary.name);
			return testCase && {
				testCase,
				caseId: summary.caseId ?? summary.name,
				verdictKey: summary.traceCaseId ?? summary.name,
				objective: summary.objective,
				split: caseSplit(testCase, { group: summary.calibration ? "calibration" : "measurement" }),
			};
		})
		.filter(Boolean);

	// Prefer the extended review set `npm run eval:review` writes — it carries the
	// dimension, blinding, and adjudication thulr's schema has no room for. Falling
	// back to thulr's own set costs only those fields: it normalizes as unblinded
	// criterion verdicts, which is exactly what it is.
	const extended = reviewSetPath(trace);
	const reviewSet = readJsonOrNull(existsSync(extended) ? extended : reviewsPath);
	const humanTruth = reviewGroundTruth(buildReviewReport(reviewSet ?? { reviews: [] }));
	const records = calibrationRecords({ cases, verdicts, humanTruth, abstentionBand });
	const key = calibrationKey({
		...keyInputs,
		rubric: rubricDigest(allCases),
		traceSchemaVersion: EVAL_TRACE_SCHEMA_VERSION,
		traceSerialization: traceAttributeDigest(traceSpans(trace)),
	});
	const report = buildCalibrationReport({ key, storedKey: readJsonOrNull(out)?.key ?? null, splitEntries, records, reviewSet, criticalDimensions, abstentionBand });
	const issues = calibrationGateIssues(report, { criticalMissRateCap });

	log("\njudge calibration:");
	log(formatCalibrationReport(report));
	if (issues.length) {
		log("\ncalibration blocks the release gate:");
		for (const issue of issues) log(`  ✗ ${issue}`);
	}
	if (out) {
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		log(`calibration report written to ${relativeToRepo(out)}`);
	}
	return { report, issues, blocks: issues.length > 0, path: out };
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
 * passed both axes, the gate found no regression, the judge is calibrated well
 * enough on every dimension trusted to block, and nothing was excluded as
 * infrastructure. A run with zero measured cases is green only if infra was not
 * the reason there are none — otherwise a total auth failure would exit 0.
 *
 * `calibrationBlocks` is separate from `gateBlocks` so the reason a run is red
 * stays legible: a regression and an uncalibrated judge are different problems
 * with different fixes.
 *
 * Pure so the policy can be read and tested without running an eval.
 *
 * @param {{ measured: number, passed: number, infraExcluded?: number, gateBlocks?: boolean, calibrationBlocks?: boolean }} counts
 * @returns {0 | 1}
 */
export function harnessExitCode({ measured, passed, infraExcluded = 0, gateBlocks = false, calibrationBlocks = false }) {
	const infraBlocked = infraExcluded > 0;
	const measuredPass = measured === 0 ? !infraBlocked : passed === measured;
	return measuredPass && !gateBlocks && !calibrationBlocks && !infraBlocked ? 0 : 1;
}
