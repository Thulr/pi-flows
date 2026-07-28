// How well the judge tracks ground truth, stated as numbers a release review can
// argue with.
//
// The framing that makes the rest legible: the judge's job here is DETECTING
// THAT AN ANSWER SHOULD NOT SHIP. So the positive class is "should not pass",
// which makes a false negative a missed defect — the error a release gate exists
// to prevent, and the one whose upper confidence bound matters more than its
// point estimate. A judge that missed 0 of 4 defects has a 0% miss rate and a
// 95% upper bound near 49%; reporting only the 0% would be a lie of omission.
//
// Ground truth has three classes and the judge decides in two: it says pass or
// fail, so `partial` and `failed` share one predicted bucket. Their per-class
// recalls differ (how often each is caught) and their precisions report how that
// one bucket is composed. Both are reported; neither is invented.
//
// Abstention is a third decision, not a wrong answer. A verdict whose score sits
// in the ambiguity band around the decision boundary declines instead of voting,
// is excluded from the confusion matrix, and is escalated to human review. That
// keeps a judge from being scored on coin flips — but it can also be gamed by
// abstaining on everything, so the abstention rate is itself a coverage
// requirement (see calibration-coverage.mjs).
import { CALIBRATION_CLASSES } from "./calibration-coverage.mjs";
import { wilson95 } from "./reliability.mjs";

/** Scores within this distance of the 0.5 decision boundary are too close to call. */
export const DEFAULT_ABSTENTION_BAND = 0.1;

export const JUDGE_DECISIONS = ["pass", "fail", "abstain"];

/**
 * The judge's decision for one dimension of one case.
 *
 * `verdict` is thulr's boolean call and `score` its 0..1 quality. A missing score
 * cannot be near-or-far from the boundary, so it never abstains — an absent
 * measurement is not an ambiguous one.
 */
export function judgeDecision(dimensionVerdict, { abstentionBand = DEFAULT_ABSTENTION_BAND } = {}) {
	if (!dimensionVerdict || typeof dimensionVerdict !== "object") return null;
	const score = Number(dimensionVerdict.score);
	if (Number.isFinite(score) && abstentionBand > 0 && Math.abs(score - 0.5) <= abstentionBand) return "abstain";
	return dimensionVerdict.verdict === true ? "pass" : "fail";
}

const zeroDecisions = () => Object.fromEntries(JUDGE_DECISIONS.map((decision) => [decision, 0]));

/**
 * Truth class x judge decision. The raw evidence behind every rate below, kept
 * in the report so a reader can recompute anything they doubt.
 */
export function confusionMatrix(records) {
	const matrix = Object.fromEntries(CALIBRATION_CLASSES.map((klass) => [klass, zeroDecisions()]));
	for (const record of records ?? []) {
		if (!matrix[record?.truth] || !JUDGE_DECISIONS.includes(record?.decision)) continue;
		matrix[record.truth][record.decision] += 1;
	}
	return matrix;
}

const rateWithBounds = (successes, samples) => ({
	value: samples ? successes / samples : null,
	samples,
	confidence95: wilson95(successes, samples),
});

/** Predicted-positive for a one-vs-rest view of `klass`. The judge only decides pass/fail, so the two not-passed classes share a bucket. */
const predictsClass = (decision, klass) => (klass === "passed" ? decision === "pass" : decision === "fail");

/**
 * One-vs-rest precision, recall, and error rates per truth class, over decided
 * verdicts only. `falseNegativeRate` is 1 - recall: members of the class the
 * judge did not catch.
 */
export function perClassMetrics(matrix) {
	const decided = (klass) => matrix[klass].pass + matrix[klass].fail;
	const metrics = {};
	for (const klass of CALIBRATION_CLASSES) {
		let truePositives = 0;
		let predicted = 0;
		let negativeSupport = 0;
		let falsePositives = 0;
		for (const other of CALIBRATION_CLASSES) {
			for (const decision of ["pass", "fail"]) {
				const count = matrix[other][decision];
				const predictsThis = predictsClass(decision, klass);
				if (predictsThis) predicted += count;
				if (other === klass) {
					if (predictsThis) truePositives += count;
				} else {
					negativeSupport += count;
					if (predictsThis) falsePositives += count;
				}
			}
		}
		const support = decided(klass);
		metrics[klass] = {
			support,
			abstained: matrix[klass].abstain,
			predicted,
			truePositives,
			precision: rateWithBounds(truePositives, predicted),
			recall: rateWithBounds(truePositives, support),
			falsePositiveRate: rateWithBounds(falsePositives, negativeSupport),
			falseNegativeRate: rateWithBounds(support - truePositives, support),
		};
	}
	return metrics;
}

/**
 * The headline binary view: positive = "this answer should not pass". A false
 * negative here is a defect the judge waved through, which is the failure mode a
 * release gate cannot tolerate — so its upper confidence bound is what a gate
 * should read, not its point estimate.
 */
export function detectionMetrics(matrix) {
	const notPassed = ["partial", "failed"];
	const sum = (classes, decision) => classes.reduce((total, klass) => total + matrix[klass][decision], 0);
	const truePositives = sum(notPassed, "fail");
	const falseNegatives = sum(notPassed, "pass");
	const falsePositives = matrix.passed.fail;
	const trueNegatives = matrix.passed.pass;
	return {
		positiveClass: "should-not-pass",
		truePositives,
		falseNegatives,
		falsePositives,
		trueNegatives,
		abstained: CALIBRATION_CLASSES.reduce((total, klass) => total + matrix[klass].abstain, 0),
		precision: rateWithBounds(truePositives, truePositives + falsePositives),
		recall: rateWithBounds(truePositives, truePositives + falseNegatives),
		falsePositiveRate: rateWithBounds(falsePositives, falsePositives + trueNegatives),
		/** Missed defects. The critical one. */
		falseNegativeRate: rateWithBounds(falseNegatives, truePositives + falseNegatives),
	};
}

/** Cases the judge declined to call, with enough identity for a reviewer to pick them up. */
export function abstentionEscalations(records) {
	return (records ?? [])
		.filter((record) => record?.decision === "abstain")
		.map((record) => ({
			caseId: record.caseId,
			dimension: record.dimension,
			score: record.score ?? null,
			truth: record.truth ?? null,
			reason: record.abstentionReason ?? "judge score sat inside the ambiguity band around the decision boundary",
		}))
		.sort((left, right) => `${left.dimension}::${left.caseId}`.localeCompare(`${right.dimension}::${right.caseId}`));
}

/**
 * Collapse repeat trials into one observation per case-dimension.
 *
 * Statistics answer "how often does the judge get a CASE right", so five trials
 * of one case must not read as five independent observations inside a confidence
 * bound — that is the same inflation coverage already refuses, and here it would
 * quietly tighten the very interval the gate reads. Trials that disagree are
 * exactly the ambiguity abstention exists for, so a decision without a strict
 * majority collapses to `abstain` and escalates rather than being resolved by a
 * coin flip.
 */
export function collapseTrials(records) {
	const byCase = new Map();
	for (const record of records ?? []) {
		if (!record?.dimension || !record?.caseId) continue;
		const key = `${record.dimension}::${record.caseId}`;
		byCase.set(key, [...(byCase.get(key) ?? []), record]);
	}
	return [...byCase.values()].map((trials) => {
		// Ground truth is collapsed by the same rule as the decision, never by trial
		// order: a stochastic case whose objective check passes twice and fails once
		// must not have its label decided by which trial happened to run first.
		const truth = strictMajority(trials.map((trial) => trial.truth));
		const decided = strictMajority(trials.map((trial) => trial.decision)) ?? "abstain";
		// No stable label means the case cannot calibrate anything — a `null` truth
		// is dropped downstream by coverage and the confusion matrix alike, and the
		// case is escalated rather than scored against a label it does not have.
		const decision = truth === null ? "abstain" : decided;
		const scores = trials.map((trial) => trial.score).filter(Number.isFinite);
		return {
			...trials[0],
			truth,
			decision,
			abstained: decision === "abstain",
			abstentionReason: abstentionReason({ truth, decided, trials: trials.length }),
			score: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
			trials: trials.length,
		};
	});
}

/** The value more than half the entries agree on, or null when nothing commands a strict majority. */
function strictMajority(values) {
	const counts = values.reduce((totals, value) => ({ ...totals, [value]: (totals[value] ?? 0) + 1 }), {});
	const [top, count] = Object.entries(counts).sort(([, left], [, right]) => right - left)[0] ?? [];
	return count * 2 > values.length ? top : null;
}

/** Why this observation carries no usable verdict. Named per cause, because the fix differs. */
function abstentionReason({ truth, decided, trials }) {
	if (truth === null) return `${trials} repeat trial(s) disagreed on the ground truth, so this case has no stable label to calibrate against`;
	if (decided !== "abstain") return null;
	return trials > 1
		? `${trials} repeat trials disagreed on the verdict without a majority`
		: "judge score sat inside the ambiguity band around the decision boundary";
}

/** Per-dimension statistics over normalized records. */
export function dimensionStatistics(records) {
	const byDimension = new Map();
	for (const record of records ?? []) {
		if (!record?.dimension) continue;
		byDimension.set(record.dimension, [...(byDimension.get(record.dimension) ?? []), record]);
	}
	const statistics = {};
	for (const [dimension, dimensionRecords] of [...byDimension.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const confusion = confusionMatrix(dimensionRecords);
		statistics[dimension] = { confusion, perClass: perClassMetrics(confusion), detection: detectionMetrics(confusion) };
	}
	return statistics;
}

const percent = (value) => (value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);
const bounded = (rate) => `${percent(rate.value)}${rate.confidence95 ? ` (95% CI ${percent(rate.confidence95.lower)}–${percent(rate.confidence95.upper)}, n=${rate.samples})` : ""}`;

export function formatDimensionStatistics(statistics) {
	const dimensions = Object.keys(statistics);
	if (!dimensions.length) return "calibration statistics: nothing to measure";
	return dimensions
		.flatMap((dimension) => {
			const { confusion, detection, perClass } = statistics[dimension];
			const counts = CALIBRATION_CLASSES.map((klass) => `${klass}[pass ${confusion[klass].pass} fail ${confusion[klass].fail} abstain ${confusion[klass].abstain}]`).join(" ");
			return [
				`  ${dimension}: ${counts}`,
				`    missed defects ${bounded(detection.falseNegativeRate)}  ·  false alarms ${bounded(detection.falsePositiveRate)}  ·  precision ${bounded(detection.precision)}`,
				`    per-class recall: ${CALIBRATION_CLASSES.map((klass) => `${klass} ${percent(perClass[klass].recall.value)}`).join(", ")}`,
			];
		})
		.join("\n");
}
