// The calibration report, and the release-gate rules that read it.
//
// The pieces live next door — the validity key, the coverage floor, the
// statistics, the human review — and this is where they become one versioned
// artifact plus one question: may this dimension block a release?
//
// A dimension is a release signal only when it is `authoritative`: enough
// independent ground truth in all three classes, not drowning in abstentions,
// and its human labels resolved rather than contested. Everything else is
// `provisional` — measured and reported, but not trusted to say no.
//
// Which dimensions are CRITICAL is a policy choice, not a fact about the judge,
// so it is opt-in (`--critical-dimension=criterion`). That matches how score
// guardrails already work here: a dimension is observed for a few runs before it
// is allowed to block. What is not optional is that an opted-in dimension which
// fails its calibration requirements blocks the gate rather than quietly
// degrading to a warning.
import { authoritativeDimensions, caseSplit, dimensionCoverage, formatCoverageReport, groundTruthClass, splitVersions, CALIBRATION_CLASSES, CALIBRATION_SPLITS, COVERAGE_REQUIREMENT } from "./calibration-coverage.mjs";
import { DEFAULT_ABSTENTION_BAND, abstentionEscalations, dimensionStatistics, formatDimensionStatistics, judgeDecision } from "./calibration-stats.mjs";
import { calibrationKey, calibrationKeyDrift, formatCalibrationKeyDrift, rubricDigest, thresholdFingerprint, traceAttributeDigest, EVAL_TRACE_SCHEMA_VERSION } from "./calibration-key.mjs";
import { buildReviewReport, formatReviewReport, reviewGroundTruth } from "./review-agreement.mjs";

export const CALIBRATION_SCHEMA_VERSION = "pi-flows.calibration.v1";

/** Missed defects a critical dimension may carry and still gate. Zero by default: a dimension trusted to block must not be waving defects through. */
export const DEFAULT_CRITICAL_MISS_RATE_CAP = 0;

export {
	CALIBRATION_CLASSES,
	CALIBRATION_SPLITS,
	COVERAGE_REQUIREMENT,
	DEFAULT_ABSTENTION_BAND,
	EVAL_TRACE_SCHEMA_VERSION,
	calibrationKey,
	calibrationKeyDrift,
	rubricDigest,
	thresholdFingerprint,
	traceAttributeDigest,
};

/**
 * Judge verdicts joined to ground truth, one record per case-dimension.
 *
 * Human labels override deterministic ones where both exist: a reviewed case has
 * been looked at by a person who could see what the objective check could not.
 *
 * @param {object[]} cases the judged cases, each `{ testCase, caseId, objective }`
 * @param {Map<string, object>} verdicts caseId -> `{ dimension: { verdict, score } }`
 * @param {object[]} humanTruth resolved review labels from review-agreement.mjs
 */
export function calibrationRecords({ cases, verdicts, humanTruth = [], abstentionBand = DEFAULT_ABSTENTION_BAND }) {
	const humanByKey = new Map(humanTruth.map((entry) => [`${entry.dimension} ${entry.caseId}`, entry]));
	const records = [];
	for (const entry of cases ?? []) {
		const { testCase, caseId, objective, split } = entry;
		const dimensions = verdicts?.get?.(caseId) ?? {};
		for (const [dimension, dimensionVerdict] of Object.entries(dimensions)) {
			// A judge-only dimension is declared as having no ground truth; scoring it
			// against a guessed label would manufacture agreement or disagreement.
			if (testCase?.judgeOnlyDimensions?.includes(dimension)) continue;
			const human = humanByKey.get(`${dimension} ${caseId}`);
			const truth = human?.truth ?? groundTruthClass(testCase, dimension, objective);
			if (!truth) continue;
			const decision = judgeDecision(dimensionVerdict, { abstentionBand });
			if (!decision) continue;
			records.push({
				caseId,
				dimension,
				split: split ?? caseSplit(testCase),
				truth,
				source: human ? "human" : "deterministic",
				reviewer: human?.reviewer ?? null,
				decision,
				abstained: decision === "abstain",
				score: Number.isFinite(Number(dimensionVerdict?.score)) ? Number(dimensionVerdict.score) : null,
			});
		}
	}
	return records;
}

/**
 * Assemble the versioned calibration artifact.
 *
 * @returns {{ schemaVersion: string, key: object, drift: object, splits: object, coverage: object, statistics: object, review: object, escalations: object[], authority: object }}
 */
export function buildCalibrationReport({
	key,
	storedKey = null,
	splitEntries = [],
	records = [],
	reviewSet = null,
	criticalDimensions = [],
	abstentionBand = DEFAULT_ABSTENTION_BAND,
	generatedAt = new Date().toISOString(),
}) {
	const review = buildReviewReport(reviewSet ?? { reviews: [] });
	const coverage = dimensionCoverage(records);
	const authoritative = authoritativeDimensions(coverage);
	return {
		schemaVersion: CALIBRATION_SCHEMA_VERSION,
		generatedAt,
		key,
		drift: calibrationKeyDrift(storedKey, key),
		abstentionBand,
		splits: splitVersions(splitEntries),
		coverage,
		statistics: dimensionStatistics(records.filter((record) => record.decision)),
		review,
		escalations: abstentionEscalations(records),
		authority: {
			authoritative,
			provisional: Object.keys(coverage).filter((dimension) => !coverage[dimension].authoritative),
			critical: [...criticalDimensions].sort(),
		},
	};
}

/**
 * Why this calibration may not gate a release. An empty list means every
 * critical dimension earned the right to block.
 *
 * @returns {string[]} blocking issues, each naming the dimension and the fix
 */
export function calibrationGateIssues(report, { criticalMissRateCap = DEFAULT_CRITICAL_MISS_RATE_CAP } = {}) {
	const issues = [];
	for (const dimension of report.authority.critical) {
		const coverage = report.coverage[dimension];
		if (!coverage) {
			issues.push(`critical dimension "${dimension}" has no ground truth in this run — it cannot gate a release until cases label it. Add labelled cases or drop --critical-dimension=${dimension}.`);
			continue;
		}
		if (!coverage.authoritative) {
			issues.push(`critical dimension "${dimension}" is provisional: ${coverage.shortfalls.join("; ")}. Add the missing labelled cases before letting it gate.`);
		}
		const missed = report.statistics[dimension]?.detection?.falseNegativeRate;
		if (missed?.value !== null && missed?.value !== undefined && missed.value > criticalMissRateCap) {
			const upper = missed.confidence95 ? ` (95% upper bound ${(missed.confidence95.upper * 100).toFixed(1)}%)` : "";
			issues.push(
				`critical dimension "${dimension}" missed ${(missed.value * 100).toFixed(1)}% of defects${upper}, above the ${(criticalMissRateCap * 100).toFixed(1)}% cap. Fix the rubric or the judge before trusting this dimension to block.`,
			);
		}
		const contested = report.review.unresolved.filter((entry) => entry.dimension === dimension);
		if (contested.length) {
			issues.push(
				`critical dimension "${dimension}" has ${contested.length} contested human label(s) (${contested.map((entry) => entry.caseId).join(", ")}). Adjudicate them with \`npm run eval:review -- --role adjudicator\` before gating on this dimension.`,
			);
		}
	}
	if (report.drift.status === "stale" && report.authority.critical.length) {
		issues.push(`prior calibration is stale — it was measured with a different ${report.drift.changed.join(", ")}. Re-run calibration before gating on it.`);
	}
	return issues;
}

/**
 * Corpus-level checks that run before any model is invoked: a case cannot
 * declare a split or calibration label that does not exist, and every split must
 * be non-empty so "held-out" is a real set rather than an aspiration.
 *
 * @returns {{ ok: boolean, issues: string[] }}
 */
export function validateCalibrationCorpus(corpus) {
	const issues = [];
	const groups = ["measurement", "calibration"];
	const entries = [];
	for (const group of groups) {
		for (const testCase of corpus?.[group] ?? []) {
			const id = testCase.id ?? testCase.name;
			if (testCase.calibrationSplit !== undefined && !CALIBRATION_SPLITS.includes(testCase.calibrationSplit)) {
				issues.push(`${id} declares calibrationSplit ${JSON.stringify(testCase.calibrationSplit)}; expected one of ${CALIBRATION_SPLITS.join(" | ")}`);
			}
			for (const [dimension, klass] of Object.entries(testCase.calibrationLabels ?? {})) {
				if (!CALIBRATION_CLASSES.includes(klass)) {
					issues.push(`${id} labels dimension "${dimension}" as ${JSON.stringify(klass)}; expected one of ${CALIBRATION_CLASSES.join(" | ")}`);
				}
			}
			entries.push({ testCase, split: caseSplit(testCase, { group }) });
		}
	}
	const versions = splitVersions(entries);
	for (const split of CALIBRATION_SPLITS) {
		if (versions[split].caseCount === 0) issues.push(`the ${split} split is empty; calibration cannot separate rubric tuning from measurement without one`);
	}
	return { ok: issues.length === 0, issues, splits: versions };
}

/** Preflight step in the shape runPreflight expects: a string is a refusal, null is a pass. */
export function calibrationPreflightStep(corpus, { onValid = console.log } = {}) {
	return () => {
		const validation = validateCalibrationCorpus(corpus);
		if (!validation.ok) return `Calibration corpus preflight failed before model invocation:\n- ${validation.issues.join("\n- ")}`;
		onValid(`Calibration splits: ${CALIBRATION_SPLITS.map((split) => `${split} ${validation.splits[split].caseCount} (${validation.splits[split].digest})`).join(", ")}`);
		return null;
	};
}

export function formatCalibrationReport(report) {
	const lines = [
		formatCalibrationKeyDrift(report.drift, report.key),
		`splits: ${CALIBRATION_SPLITS.map((split) => `${split} ${report.splits[split].caseCount} (${report.splits[split].digest})`).join(", ")}`,
		formatCoverageReport(report.coverage),
		formatDimensionStatistics(report.statistics),
		formatReviewReport(report.review),
	];
	if (report.escalations.length) {
		lines.push(`escalated to human review (judge abstained): ${report.escalations.map((entry) => `${entry.dimension}:${entry.caseId}`).join(", ")}`);
	}
	if (report.authority.critical.length) {
		lines.push(`critical dimensions: ${report.authority.critical.join(", ")} — authoritative: ${report.authority.authoritative.join(", ") || "none"}`);
	} else {
		lines.push("critical dimensions: none declared (pass --critical-dimension=<name> to let a calibrated dimension block the gate)");
	}
	return lines.join("\n");
}
