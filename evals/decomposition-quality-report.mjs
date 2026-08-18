import { studentTCritical95 } from "./paired-experiment.mjs";

export const QUALITY_SCORE_MAX = 4;
export const MIN_JUDGE_CALIBRATION_ACCURACY = 0.8;

/** Counterbalance anonymous candidate order across case and trial indexes. */
export function decompositionPresentationOrder(caseIndex, trialIndex) {
	return (caseIndex + trialIndex) % 2 === 0 ? ["initial", "final"] : ["final", "initial"];
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const rounded = (value) => value === null ? null : Number(value.toFixed(6));
const finiteScore = (value) => Number.isFinite(value) && value >= 0 && value <= QUALITY_SCORE_MAX;
const finiteUnitScore = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

/** The quality score excludes fragmentation and subtask count. Those values are separate guardrails. */
export function decompositionQualityScore(judgment, obligations) {
	const obligationScores = obligations.map(({ id }) => judgment?.obligations?.[id]);
	const qualityDimensions = [judgment?.overlap, judgment?.workerFit, judgment?.dependencies, judgment?.context];
	const scores = [...obligationScores, ...qualityDimensions];
	if (scores.length === 0 || scores.some((score) => !finiteScore(score))) return null;
	return rounded(mean(scores) / QUALITY_SCORE_MAX);
}

/** Normalize one valid raw judge score. Invalid values stay ineligible. */
export function normalizedFragmentationScore(value) {
	return finiteScore(value) ? value / QUALITY_SCORE_MAX : null;
}

/** PASS requires every quality and fragmentation score to be at least 3. Missing scores fail safe to REVISE. */
export function judgmentVerdict(judgment, obligations) {
	const scores = [
		...obligations.map(({ id }) => judgment?.obligations?.[id]),
		judgment?.overlap,
		judgment?.workerFit,
		judgment?.dependencies,
		judgment?.context,
		judgment?.fragmentation,
	];
	return scores.length > 0 && scores.every((score) => finiteScore(score) && score >= 3) ? "pass" : "revise";
}

export function verdictAccuracy(rows, actual = (row) => row.actual, expected = (row) => row.expected) {
	const decided = rows.filter((row) => new Set(["pass", "revise"]).has(actual(row)));
	const correct = decided.filter((row) => actual(row) === expected(row)).length;
	return { cases: rows.length, decided: decided.length, correct, accuracy: rows.length ? rounded(correct / rows.length) : null };
}

function confidence95(values) {
	if (values.length < 2) return null;
	const average = mean(values);
	const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
	const margin = studentTCritical95(values.length) * Math.sqrt(variance / values.length);
	return { lower: rounded(average - margin), upper: rounded(average + margin) };
}

function caseClustered(rows, read) {
	const byCase = new Map();
	for (const row of rows) {
		const value = read(row);
		if (!Number.isFinite(value)) continue;
		byCase.set(row.caseId, [...(byCase.get(row.caseId) ?? []), value]);
	}
	return [...byCase.values()].map((values) => mean(values));
}

export function aggregateMetrics(rows, read = (row) => row.metrics) {
	const metrics = rows.map(read).filter(Boolean);
	return {
		costUsd: rounded(metrics.reduce((sum, item) => sum + (item.costUsd ?? 0), 0)),
		generatedTokens: metrics.reduce((sum, item) => sum + (item.generatedTokens ?? 0), 0),
		totalTokens: metrics.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0),
		latencyMs: metrics.reduce((sum, item) => sum + (item.latencyMs ?? 0), 0),
	};
}

/** Build paired quality evidence. A positive quality interval alone is not enough when fragmentation regresses. */
export function pairedDecompositionQualityReport(rows, judgeCalibration) {
	const eligible = rows.filter((row) => row.reviewPassed === true
		&& [row.initialQuality, row.finalQuality, row.initialFragmentation, row.finalFragmentation].every(finiteUnitScore));
	const initial = caseClustered(eligible, (row) => row.initialQuality);
	const final = caseClustered(eligible, (row) => row.finalQuality);
	const deltas = caseClustered(eligible, (row) => row.finalQuality - row.initialQuality);
	const fragmentationDeltas = caseClustered(eligible, (row) => row.finalFragmentation - row.initialFragmentation);
	const countDeltas = caseClustered(eligible, (row) => row.finalSubtasks - row.initialSubtasks);
	const interval = confidence95(deltas);
	const qualityImproved = interval !== null && interval.lower > 0;
	const fragmentationDelta = rounded(mean(fragmentationDeltas));
	const fragmentationDidNotRegress = fragmentationDelta !== null && fragmentationDelta >= 0;
	const judgeCalibrated = (judgeCalibration?.accuracy ?? 0) >= MIN_JUDGE_CALIBRATION_ACCURACY;
	return {
		method: "case-clustered paired mean with 95% t interval",
		rows: eligible.length,
		caseClusters: deltas.length,
		quality: { initialMean: rounded(mean(initial)), finalMean: rounded(mean(final)), meanDelta: rounded(mean(deltas)), confidence95: interval },
		fragmentation: { initialMean: rounded(mean(caseClustered(eligible, (row) => row.initialFragmentation))), finalMean: rounded(mean(caseClustered(eligible, (row) => row.finalFragmentation))), meanDelta: fragmentationDelta },
		subtaskCount: { initialMean: rounded(mean(caseClustered(eligible, (row) => row.initialSubtasks))), finalMean: rounded(mean(caseClustered(eligible, (row) => row.finalSubtasks))), meanDelta: rounded(mean(countDeltas)) },
		judgeCalibration,
		claimImprovement: judgeCalibrated && qualityImproved && fragmentationDidNotRegress,
		claimBlockers: [
			...(judgeCalibrated ? [] : [`judge accuracy is less than ${MIN_JUDGE_CALIBRATION_ACCURACY}`]),
			...(qualityImproved ? [] : ["the paired quality interval is not positive"]),
			...(fragmentationDidNotRegress ? [] : ["fragmentation regressed"]),
		],
	};
}

const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const number = (value) => value === null ? "n/a" : value.toFixed(3);

export function formatDecompositionQualityReport(report) {
	const interval = report.paired.quality.confidence95;
	return [
		`review verdict accuracy  ${report.reviewerAccuracy.correct}/${report.reviewerAccuracy.cases} (${percent(report.reviewerAccuracy.accuracy)})`,
		`judge calibration        ${report.judgeAccuracy.correct}/${report.judgeAccuracy.cases} (${percent(report.judgeAccuracy.accuracy)})`,
		`paired quality           ${number(report.paired.quality.initialMean)} -> ${number(report.paired.quality.finalMean)} | delta ${number(report.paired.quality.meanDelta)} | 95% CI ${interval ? `[${number(interval.lower)}, ${number(interval.upper)}]` : "n/a"}`,
		`fragmentation            ${number(report.paired.fragmentation.initialMean)} -> ${number(report.paired.fragmentation.finalMean)} | delta ${number(report.paired.fragmentation.meanDelta)}`,
		`subtask-count guardrail  ${number(report.paired.subtaskCount.initialMean)} -> ${number(report.paired.subtaskCount.finalMean)} | delta ${number(report.paired.subtaskCount.meanDelta)}`,
		`subject resources        $${report.subjectMetrics.costUsd.toFixed(4)} | ${report.subjectMetrics.generatedTokens} generated tokens | ${report.subjectMetrics.totalTokens} total tokens | ${report.subjectMetrics.latencyMs}ms`,
		`judge resources          $${report.judgeMetrics.costUsd.toFixed(4)} | ${report.judgeMetrics.generatedTokens} generated tokens | ${report.judgeMetrics.totalTokens} total tokens | ${report.judgeMetrics.latencyMs}ms`,
		`improvement claim        ${report.paired.claimImprovement ? "YES" : `NO — ${report.paired.claimBlockers.join(" | ")}`}`,
	].join("\n");
}
