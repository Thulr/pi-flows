// The calibration report, and the release-gate rules that read it.
//
// The pieces live next door — the validity key, the coverage floor, the
// statistics, the human review — and this is where they become one versioned
// artifact plus one question: may this dimension block a release?
//
// A dimension is a release signal only when it is `authoritative`: enough
// independent ground truth in all three classes, decided rather than abstained,
// and not drowning in abstentions overall. Everything else is `provisional` —
// measured and reported, but not trusted to say no. Contested human labels and
// missed defects are checked separately, per critical dimension, by
// `calibrationGateIssues` — a dimension can be authoritative and still be refused
// the right to block.
//
// `criterion` is CRITICAL by default, because it is already the always-on release
// guardrail: gating a release on a judge whose accuracy nothing checks is the
// hole this module exists to close. Named dimensions stay opt-in, matching how
// score guardrails work here — a new dimension is observed for a few runs before
// it is allowed to block. Either way, a critical dimension that fails its
// calibration requirements blocks the gate rather than degrading to a warning.
import { authoritativeDimensions, caseSplit, dimensionCoverage, formatCoverageReport, groundTruthClass, splitVersions, CALIBRATION_CLASSES, CALIBRATION_SPLITS, GATING_SPLITS } from "./calibration-coverage.mjs";
import { DEFAULT_ABSTENTION_BAND, abstentionEscalations, collapseTrials, dimensionStatistics, formatDimensionStatistics, judgeDecision } from "./calibration-stats.mjs";
import { calibrationKeyDrift, formatCalibrationKeyDrift } from "./calibration-key.mjs";
import { buildReviewReport, formatReviewReport } from "./review-agreement.mjs";

export const CALIBRATION_SCHEMA_VERSION = "pi-flows.calibration.v1";

/**
 * The most a critical dimension's missed-defect rate may plausibly be and still
 * gate — read against the 95% UPPER BOUND, not the point estimate. Zero misses
 * out of four is a 0% rate with an upper bound near 49%; gating on the point
 * estimate would call that release-grade on four observations. The consequence is
 * deliberate: clearing this needs more evidence than the coverage floor alone.
 */
export const DEFAULT_CRITICAL_MISS_RATE_CAP = 0.35;

/** The dimension that gates by default: already the always-on release guardrail. */
export const DEFAULT_CRITICAL_DIMENSIONS = ["criterion"];

/**
 * Which dimensions this run lets block a release. Named dimensions replace the
 * default rather than adding to it, and the literal `none` opts out entirely —
 * so "report calibration but do not gate on it" stays expressible without
 * making the safe case the silent one.
 */
export function resolveCriticalDimensions(requested = []) {
	if (requested.includes("none")) return [];
	return requested.length > 0 ? requested : [...DEFAULT_CRITICAL_DIMENSIONS];
}

/**
 * Judge verdicts joined to ground truth, one record per case-dimension.
 *
 * Human labels override deterministic ones where both exist: a reviewed case has
 * been looked at by a person who could see what the objective check could not.
 *
 * @param {object[]} cases the judged cases, each `{ testCase, caseId, verdictKey?, objective }`.
 *   `caseId` is the base case (what coverage counts); `verdictKey` is the trial the
 *   judge graded, and defaults to `caseId` when a case ran once.
 * @param {Map<string, object>} verdicts verdictKey -> `{ dimension: { verdict, score } }`
 * @param {object[]} humanTruth resolved review labels from review-agreement.mjs
 */
export function calibrationRecords({ cases, verdicts, humanTruth = [], abstentionBand = DEFAULT_ABSTENTION_BAND }) {
	const humanByKey = new Map(humanTruth.map((entry) => [`${entry.dimension}::${entry.caseId}`, entry]));
	const records = [];
	for (const entry of cases ?? []) {
		const { testCase, caseId, verdictKey, objective, split } = entry;
		const dimensions = verdicts?.get?.(verdictKey ?? caseId) ?? {};
		for (const [dimension, dimensionVerdict] of Object.entries(dimensions)) {
			// A judge-only dimension is declared as having no ground truth; scoring it
			// against a guessed label would manufacture agreement or disagreement.
			if (testCase?.judgeOnlyDimensions?.includes(dimension)) continue;
			const human = humanByKey.get(`${dimension}::${caseId}`);
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
	// One observation per case, everywhere. Repeat trials are the judge answering
	// the same question again, not a second question — so coverage, statistics, and
	// the escalation queue all speak in cases rather than in trials.
	const observations = collapseTrials(records);
	// Splits are only worth versioning if they decide something. Cases the rubric
	// was TUNED against cannot also be the evidence that the rubric works, so they
	// are reported separately and never counted toward gate authority — otherwise
	// an overfit judge clears the floor on the very cases it was fitted to.
	const gating = observations.filter((record) => GATING_SPLITS.includes(record.split));
	const tuning = observations.filter((record) => !GATING_SPLITS.includes(record.split));
	const coverage = dimensionCoverage(gating);
	const authoritative = authoritativeDimensions(coverage);
	// Ground truth from a deterministic objective check is independent of the judge,
	// which is what calibration needs — but a reader deciding how far to trust an
	// authoritative dimension should be able to see how much of it a person looked at.
	const groundTruthSources = gating.reduce((counts, record) => ({ ...counts, [record.source]: (counts[record.source] ?? 0) + 1 }), {});
	return {
		schemaVersion: CALIBRATION_SCHEMA_VERSION,
		generatedAt,
		key,
		drift: calibrationKeyDrift(storedKey, key),
		abstentionBand,
		splits: splitVersions(splitEntries),
		coverage,
		groundTruthSources,
		statistics: dimensionStatistics(gating.filter((record) => record.decision)),
		/** Reported, never gating: the cases the rubric was tuned against. */
		rubricDevelopment: { observations: tuning.length, coverage: dimensionCoverage(tuning), statistics: dimensionStatistics(tuning.filter((record) => record.decision)) },
		review,
		escalations: abstentionEscalations(gating),
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
		// The bound, not the estimate: a gate that reads the point estimate treats
		// "0 misses out of 4" as proof of a 0% miss rate.
		const missed = report.statistics[dimension]?.detection?.falseNegativeRate;
		const bound = missed?.confidence95?.upper ?? missed?.value;
		if (bound !== null && bound !== undefined && bound > criticalMissRateCap) {
			issues.push(
				`critical dimension "${dimension}" could be missing up to ${(bound * 100).toFixed(1)}% of defects (95% upper bound over ${missed.samples} observation(s); point estimate ${(missed.value * 100).toFixed(1)}%), above the ${(criticalMissRateCap * 100).toFixed(1)}% cap. Add labelled defect cases to tighten the bound, or fix the judge.`,
			);
		}
		const contested = report.review.unresolved.filter((entry) => entry.dimension === dimension);
		if (contested.length) {
			issues.push(
				`critical dimension "${dimension}" has ${contested.length} contested human label(s) (${contested.map((entry) => entry.caseId).join(", ")}). Adjudicate them with \`npm run eval:review -- --role adjudicator\` before gating on this dimension.`,
			);
		}
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
		...(report.drift.status === "stale" ? ["  (this run recomputed calibration from scratch, so the stale prior is superseded, not relied on)"] : []),
		`splits: ${CALIBRATION_SPLITS.map((split) => `${split} ${report.splits[split].caseCount} (${report.splits[split].digest})`).join(", ")}`,
		formatCoverageReport(report.coverage),
		formatDimensionStatistics(report.statistics),
		formatReviewReport(report.review),
	];
	lines.push(`ground truth (gating splits ${GATING_SPLITS.join(" + ")}): ${Object.entries(report.groundTruthSources).map(([source, count]) => `${count} ${source}`).join(", ") || "none"}`);
	lines.push(`rubric-development observations (reported, never gating): ${report.rubricDevelopment.observations}`);
	if (report.escalations.length) {
		lines.push(`escalated to human review — the judge abstained on ${report.escalations.length} case-dimension(s). Record a blinded verdict for each:`);
		for (const entry of report.escalations) {
			lines.push(`  ${entry.dimension}:${entry.caseId} — ${entry.reason}`);
			lines.push(`    npm run eval:review -- --case ${entry.caseId} --dimension ${entry.dimension} --blinded --reviewer <you> --verdict <pass|fail|unsure>`);
		}
	}
	if (report.authority.critical.length) {
		lines.push(`critical dimensions: ${report.authority.critical.join(", ")} — authoritative: ${report.authority.authoritative.join(", ") || "none"}`);
	} else {
		lines.push("critical dimensions: none declared (pass --critical-dimension=<name> to let a calibrated dimension block the gate)");
	}
	return lines.join("\n");
}
