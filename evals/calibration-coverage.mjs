// Per-dimension calibration coverage, and the corpus splits that keep it honest.
//
// A judge dimension earns the right to block a release by being MEASURED, and
// the measurement is only as good as the ground truth behind it. A dimension
// calibrated against two failures and nothing else has not been shown to
// separate good from bad — it has been shown to agree with two data points. So a
// dimension is `provisional` until it has enough independent ground truth, and
// only an `authoritative` dimension can be treated as a release signal.
//
// "Independent" means distinct cases the judge actually DECIDED. Two rules follow
// from that. The judge's error on a case is one error however many times it is
// recorded, so five repeat trials of one case, or three reviewers agreeing on it,
// is one observation — reviewer multiplicity buys confidence in the LABEL, and is
// reported as agreement in review-agreement.mjs. And an abstention is not
// evidence the judge can tell classes apart: a dimension that abstained on every
// defect has demonstrated nothing about catching defects, so abstained labels are
// counted and reported but never credited as coverage.
//
// The splits exist for the same reason as a train/test split anywhere else. A
// rubric tuned until it agrees with the cases it was tuned on tells you nothing.
// Each split is versioned separately, so a report can say the held-out set is
// untouched while the rubric-development set churns.
import { canonicalDigest } from "./calibration-key.mjs";

/** Where a case sits in the calibration lifecycle. Registered per case; see `caseSplit`. */
export const CALIBRATION_SPLITS = ["rubric-development", "calibration", "held-out"];

/** The three-valued ground truth a dimension is calibrated against. */
export const CALIBRATION_CLASSES = ["passed", "partial", "failed"];

/**
 * What a dimension must show before it is authoritative. Three independent
 * failures is the floor that makes a claimed failure-detection rate mean
 * anything; the passed and partial examples are what stop a judge that fails
 * everything from scoring perfectly on failure detection.
 */
export const COVERAGE_REQUIREMENT = { failed: 3, passed: 1, partial: 1 };

/** Above this share of abstentions a dimension is not authoritative: the rubric is too ambiguous to grade against. */
export const MAX_ABSTENTION_RATE = 0.25;

/**
 * The split a case belongs to. An explicit `calibrationSplit` on the case wins.
 * Otherwise the corpus's own train/holdout naming convention decides, and
 * calibration canaries — cases that exist only to measure the judge — are
 * calibration by construction.
 */
export function caseSplit(testCase, { group } = {}) {
	if (CALIBRATION_SPLITS.includes(testCase?.calibrationSplit)) return testCase.calibrationSplit;
	if (group === "calibration") return "calibration";
	const id = testCase?.id ?? testCase?.name ?? "";
	return id.includes("-holdout-") ? "held-out" : "rubric-development";
}

/**
 * Version each split on its own. A digest over the ids and rubric text in a
 * split changes when that split changes and stays put when a different one does,
 * so "the held-out set has not moved" is a checkable claim rather than a promise.
 *
 * @param {Array<{ testCase: object, split: string }>} entries
 */
export function splitVersions(entries) {
	const bySplit = Object.fromEntries(CALIBRATION_SPLITS.map((split) => [split, []]));
	for (const { testCase, split } of entries) {
		if (!bySplit[split]) continue;
		bySplit[split].push({
			id: testCase.id ?? testCase.name,
			criterion: testCase.criterion ?? null,
			criteria: testCase.criteria ?? null,
		});
	}
	return Object.fromEntries(
		CALIBRATION_SPLITS.map((split) => {
			const cases = bySplit[split].sort((left, right) => String(left.id).localeCompare(String(right.id)));
			return [split, { caseCount: cases.length, caseIds: cases.map((entry) => entry.id), digest: canonicalDigest(cases) }];
		}),
	);
}

/**
 * The ground-truth class for a case on a dimension.
 *
 * An explicit three-valued `calibrationLabels[dimension]` wins. Failing that, a
 * boolean `labels[dimension]` is a clean pass or fail. Failing that, the
 * `criterion` dimension falls back to the deterministic objective, where a
 * non-zero score on a failing case is what "partial" means everywhere else in
 * this corpus. A dimension with none of those has no ground truth and is left
 * out rather than guessed at.
 */
export function groundTruthClass(testCase, dimension, objective) {
	const declared = testCase?.calibrationLabels?.[dimension];
	if (CALIBRATION_CLASSES.includes(declared)) return declared;
	const labelled = testCase?.labels?.[dimension];
	if (typeof labelled === "boolean") return labelled ? "passed" : "failed";
	if (dimension !== "criterion" || !objective) return null;
	if (objective.pass) return "passed";
	return Number(objective.score) > 0 ? "partial" : "failed";
}

const emptyCounts = () => Object.fromEntries(CALIBRATION_CLASSES.map((klass) => [klass, 0]));

/**
 * Per-dimension coverage over normalized label records. Independence is counted
 * by `caseId` alone: `source` and `reviewer` travel on the record for reporting
 * (see `groundTruthSources`), not for counting.
 *
 * @param {Array<{ dimension: string, caseId: string, truth: string, source?: string, abstained?: boolean }>} records
 */
export function dimensionCoverage(records, { requirement = COVERAGE_REQUIREMENT, maxAbstentionRate = MAX_ABSTENTION_RATE } = {}) {
	const byDimension = new Map();
	for (const record of records ?? []) {
		if (!record?.dimension || !CALIBRATION_CLASSES.includes(record.truth)) continue;
		if (!byDimension.has(record.dimension)) {
			byDimension.set(record.dimension, { labels: emptyCounts(), independent: new Map(), decided: 0, abstained: 0 });
		}
		const entry = byDimension.get(record.dimension);
		entry.labels[record.truth] += 1;
		if (record.abstained) entry.abstained += 1;
		else entry.decided += 1;
		if (!entry.independent.has(record.truth)) entry.independent.set(record.truth, new Set());
		if (!record.abstained) entry.independent.get(record.truth).add(record.caseId);
	}

	const coverage = {};
	for (const [dimension, entry] of [...byDimension.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		const independent = Object.fromEntries(CALIBRATION_CLASSES.map((klass) => [klass, entry.independent.get(klass)?.size ?? 0]));
		const total = entry.decided + entry.abstained;
		const abstentionRate = total ? entry.abstained / total : 0;
		const shortfalls = CALIBRATION_CLASSES.filter((klass) => independent[klass] < (requirement[klass] ?? 0)).map(
			(klass) => `needs ${requirement[klass]} independent ${klass} label(s), has ${independent[klass]}`,
		);
		if (abstentionRate > maxAbstentionRate) {
			shortfalls.push(`abstained on ${(abstentionRate * 100).toFixed(1)}% of labelled cases (cap ${(maxAbstentionRate * 100).toFixed(0)}%)`);
		}
		coverage[dimension] = {
			labels: entry.labels,
			independent,
			decided: entry.decided,
			abstained: entry.abstained,
			abstentionRate,
			authoritative: shortfalls.length === 0,
			shortfalls,
		};
	}
	return coverage;
}

/** The dimensions a gate may treat as a release signal. */
export const authoritativeDimensions = (coverage) => Object.keys(coverage).filter((dimension) => coverage[dimension].authoritative);

export function formatCoverageReport(coverage) {
	const dimensions = Object.keys(coverage);
	if (!dimensions.length) return "calibration coverage: no dimension has ground truth to calibrate against";
	return dimensions
		.map((dimension) => {
			const entry = coverage[dimension];
			const counts = CALIBRATION_CLASSES.map((klass) => `${klass} ${entry.labels[klass]}/${entry.independent[klass]} indep`).join(", ");
			const status = entry.authoritative ? "authoritative" : `provisional (${entry.shortfalls.join("; ")})`;
			const abstained = entry.abstained ? `, abstained ${entry.abstained}` : "";
			return `  ${dimension}: ${status} — ${counts}${abstained}`;
		})
		.join("\n");
}
