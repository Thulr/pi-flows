// Human ground truth, and how much to believe it.
//
// A single reviewer's verdict is not ground truth, it is one opinion — and a
// reviewer who labels a case AFTER seeing the judge's verdict is not even that,
// because the judge anchored them. So human labels here are blinded (recorded
// without the judge's call in view), independent (recorded without seeing each
// other), and resolved: unanimous reviewers settle a case, disagreeing reviewers
// need an adjudicator, and a disagreement nobody adjudicated is left unresolved
// rather than quietly resolved by whoever labeled last.
//
// Agreement is reported so the ground truth can be doubted on the record. Fleiss'
// kappa is used for every group size because the review sets here are ragged —
// two reviewers on most cases, three on the contested ones — and it is defined
// for variable raters per case, where Cohen's kappa is not. Observed and expected
// agreement are reported beside it so kappa is checkable rather than magic.
//
// The reader accepts thulr's `thulr.review_set.v1` unchanged: a review set with
// no dimension, blinding, or role recorded normalizes to a criterion-dimension
// unblinded reviewer verdict, which is exactly what it is.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const REVIEW_SET_SCHEMA_VERSION = "pi-flows.review-set.v1";
export const REVIEW_VERDICTS = ["pass", "fail", "unsure"];
export const REVIEW_ROLES = ["reviewer", "adjudicator"];

/** Below this many independent blinded reviewers on a case, there is nothing to agree or disagree about. */
export const MIN_INDEPENDENT_REVIEWERS = 2;

const VERDICT_TO_CLASS = { pass: "passed", fail: "failed", partial: "partial" };

/**
 * Normalize a review set from either schema into flat records, collecting shape
 * problems rather than throwing — a malformed review should be reported and
 * skipped, not take down a run that has already spent judge tokens.
 *
 * @returns {{ reviews: object[], issues: string[], sourceSchema: string }}
 */
export function normalizeReviewSet(raw) {
	const issues = [];
	const reviews = [];
	const entries = Array.isArray(raw?.reviews) ? raw.reviews : [];
	if (!raw || typeof raw !== "object") return { reviews, issues: ["review set must be an object"], sourceSchema: "unknown" };
	if (!Array.isArray(raw.reviews)) issues.push("review set must carry a `reviews` array");

	for (const [index, entry] of entries.entries()) {
		const label = `review[${index}]`;
		const caseId = entry?.case_id ?? entry?.caseId;
		const verdict = entry?.verdict;
		if (typeof caseId !== "string" || !caseId.trim()) {
			issues.push(`${label} must name a case_id`);
			continue;
		}
		if (!REVIEW_VERDICTS.includes(verdict)) {
			issues.push(`${label} (${caseId}) verdict must be one of ${REVIEW_VERDICTS.join(" | ")}, got ${JSON.stringify(verdict)}`);
			continue;
		}
		const role = entry?.role ?? "reviewer";
		if (!REVIEW_ROLES.includes(role)) {
			issues.push(`${label} (${caseId}) role must be one of ${REVIEW_ROLES.join(" | ")}, got ${JSON.stringify(role)}`);
			continue;
		}
		const reviewer = entry?.reviewer ?? null;
		if (role === "adjudicator" && !reviewer) {
			issues.push(`${label} (${caseId}) is an adjudication with no reviewer identity; an adjudicated label must be attributable`);
			continue;
		}
		reviews.push({
			caseId,
			dimension: entry?.dimension ?? "criterion",
			reviewer,
			verdict,
			role,
			// A review set that does not record blinding was not blinded. Assuming
			// otherwise would launder an anchored opinion into independent evidence.
			blinded: entry?.blinded === true,
			note: entry?.note ?? null,
			reviewedAt: entry?.reviewed_at ?? entry?.reviewedAt ?? null,
		});
	}
	return { reviews, issues, sourceSchema: typeof raw?.schema_version === "string" ? raw.schema_version : REVIEW_SET_SCHEMA_VERSION };
}

/**
 * Group reviews by the thing being labeled. The identity travels ON the group
 * rather than encoded into its key, so nothing downstream has to parse a
 * composite key back apart to learn which case it is holding.
 */
function groupReviews(reviews) {
	const groups = new Map();
	for (const review of reviews) {
		const key = `${review.dimension}::${review.caseId}`;
		const group = groups.get(key) ?? { dimension: review.dimension, caseId: review.caseId, reviews: [] };
		group.reviews.push(review);
		groups.set(key, group);
	}
	return [...groups.values()];
}

/**
 * Resolve one case+dimension into a label, or decline to.
 *
 * Only blinded reviewer verdicts vote. `unsure` is an abstention, not a
 * disagreement, so it never blocks a resolution but also never carries one.
 */
export function resolveReviewGroup(reviews) {
	const independent = reviews.filter((review) => review.role === "reviewer" && review.blinded);
	// Adjudications are stored per reviewer, so two of them can coexist. Picking
	// whichever came first would let array order decide a label that overrides the
	// deterministic objective — the same trap as ordering ground truth by trial.
	const adjudications = reviews.filter((review) => review.role === "adjudicator" && review.verdict !== "unsure");
	const adjudicated = new Set(adjudications.map((review) => review.verdict));
	const adjudication = adjudicated.size === 1 ? adjudications[0] : null;
	const conflictingAdjudication = adjudicated.size > 1;
	const decided = independent.filter((review) => review.verdict !== "unsure");
	const distinct = new Set(decided.map((review) => review.verdict));
	const reviewers = [...new Set(independent.map((review) => review.reviewer ?? "anonymous"))];

	// Checked before every resolution path, not after: two adjudicators pulling in
	// opposite directions means the case is contested no matter how neatly the
	// blinded reviewers happen to agree.
	if (conflictingAdjudication) {
		return {
			label: null,
			resolution: "conflicting-adjudication",
			reviewers,
			adjudicator: adjudications.map((review) => review.reviewer).sort().join(", "),
			independentReviewers: reviewers.length,
		};
	}

	// Corroboration, not just a verdict. One decided opinion is one opinion however
	// confidently it is held, and `reviewGroundTruth` lets a resolved label override
	// the deterministic objective — so a lone review must not become ground truth.
	// Adjudication below stays the explicit single-actor resolution path.
	const decidedReviewers = new Set(decided.map((review) => review.reviewer ?? "anonymous"));
	if (distinct.size === 1 && decidedReviewers.size >= MIN_INDEPENDENT_REVIEWERS) {
		return { label: VERDICT_TO_CLASS[[...distinct][0]], resolution: "unanimous", reviewers, adjudicator: null, independentReviewers: reviewers.length };
	}
	if (distinct.size === 1 && !adjudication) {
		return { label: null, resolution: "insufficient-reviewers", reviewers, adjudicator: null, independentReviewers: reviewers.length };
	}
	if (distinct.size > 1) {
		if (!adjudication) {
			return { label: null, resolution: "unadjudicated", reviewers, adjudicator: adjudication?.reviewer ?? null, independentReviewers: reviewers.length };
		}
		return { label: VERDICT_TO_CLASS[adjudication.verdict], resolution: "adjudicated", reviewers, adjudicator: adjudication.reviewer, independentReviewers: reviewers.length };
	}
	// Nothing decided by enough reviewers: none was blinded, every blinded reviewer
	// abstained, or a lone decided verdict lacked corroboration.
	const resolution = independent.length === 0 ? "no-blinded-review" : decided.length === 0 ? "abstained" : "insufficient-reviewers";
	if (adjudication) {
		return { label: VERDICT_TO_CLASS[adjudication.verdict], resolution: "adjudicated", reviewers, adjudicator: adjudication.reviewer, independentReviewers: reviewers.length };
	}
	return { label: null, resolution, reviewers, adjudicator: adjudication?.reviewer ?? null, independentReviewers: reviewers.length };
}

/**
 * Fleiss' kappa over groups with at least two independent blinded reviewers,
 * tolerating a different number of reviewers per group. Returns nulls rather
 * than a number when there is nothing to compute from — an undefined kappa is
 * more honest than a zero.
 */
export function reviewerAgreement(groups) {
	const usable = groups.filter((group) => group.verdicts.length >= MIN_INDEPENDENT_REVIEWERS);
	if (!usable.length) return { groups: 0, observedAgreement: null, expectedAgreement: null, kappa: null, unanimousGroups: 0 };

	const categories = REVIEW_VERDICTS;
	const totals = Object.fromEntries(categories.map((category) => [category, 0]));
	let totalRatings = 0;
	let observedSum = 0;
	let unanimousGroups = 0;

	for (const group of usable) {
		const counts = Object.fromEntries(categories.map((category) => [category, 0]));
		for (const verdict of group.verdicts) counts[verdict] += 1;
		const raters = group.verdicts.length;
		const squared = categories.reduce((sum, category) => sum + counts[category] ** 2, 0);
		observedSum += (squared - raters) / (raters * (raters - 1));
		if (categories.some((category) => counts[category] === raters)) unanimousGroups += 1;
		for (const category of categories) totals[category] += counts[category];
		totalRatings += raters;
	}

	const observedAgreement = observedSum / usable.length;
	const expectedAgreement = categories.reduce((sum, category) => sum + (totals[category] / totalRatings) ** 2, 0);
	const kappa = expectedAgreement === 1 ? null : (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
	return { groups: usable.length, observedAgreement, expectedAgreement, kappa, unanimousGroups };
}

/**
 * The full human-review picture: resolved labels usable as ground truth, the
 * groups that could not be resolved, per-reviewer volume, and agreement.
 */
export function buildReviewReport(raw) {
	const { reviews, issues, sourceSchema } = normalizeReviewSet(raw);
	const resolutions = [];
	const agreementGroups = [];
	for (const { caseId, dimension, reviews: group } of groupReviews(reviews)) {
		const resolved = resolveReviewGroup(group);
		resolutions.push({ caseId, dimension, ...resolved });
		agreementGroups.push({ caseId, dimension, verdicts: group.filter((review) => review.role === "reviewer" && review.blinded).map((review) => review.verdict) });
	}
	resolutions.sort((left, right) => `${left.dimension}::${left.caseId}`.localeCompare(`${right.dimension}::${right.caseId}`));

	const reviewers = {};
	for (const review of reviews) {
		const name = review.reviewer ?? "anonymous";
		reviewers[name] ??= { reviews: 0, blinded: 0, adjudications: 0 };
		reviewers[name].reviews += 1;
		if (review.blinded) reviewers[name].blinded += 1;
		if (review.role === "adjudicator") reviewers[name].adjudications += 1;
	}

	return {
		sourceSchema,
		issues,
		reviewCount: reviews.length,
		reviewers,
		resolutions,
		unresolved: resolutions.filter((entry) => entry.label === null),
		agreement: reviewerAgreement(agreementGroups),
	};
}

/** The resolved labels, as ground-truth records the coverage and statistics passes consume. */
export function reviewGroundTruth(report) {
	return report.resolutions
		.filter((entry) => entry.label !== null)
		.map((entry) => ({
			caseId: entry.caseId,
			dimension: entry.dimension,
			truth: entry.label,
			source: "human",
			reviewer: entry.adjudicator ?? entry.reviewers[0] ?? null,
			resolution: entry.resolution,
		}));
}

// --- Storage ---------------------------------------------------------------

/**
 * Where the extended review set for a trace lives: beside that trace, not at the
 * repo root. A review set is *about* one trace, and deriving the path from the
 * trace keeps the two together for an alternate `--trace` and makes this callable
 * without depending on the process working directory.
 */
export function reviewSetPath(tracePath) {
	return join(dirname(tracePath), ".thulr", "reviews", `${basename(tracePath).replace(/\.jsonl$/, "")}.pi-flows.json`);
}

/**
 * Record one verdict, replacing this reviewer's prior verdict on the same
 * case-dimension-role rather than stacking a second one — a reviewer who
 * changes their mind has one opinion, not two.
 */
export function recordReview(file, entry) {
	const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
	const reviews = Array.isArray(existing?.reviews) ? existing.reviews : [];
	const identity = (review) => `${review.case_id ?? review.caseId}|${review.dimension ?? "criterion"}|${review.reviewer ?? ""}|${review.role ?? "reviewer"}`;
	const next = [...reviews.filter((review) => identity(review) !== identity(entry)), entry];
	const set = { schema_version: REVIEW_SET_SCHEMA_VERSION, source_trace: existing?.source_trace ?? null, reviews: next };
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(set, null, 2)}\n`, "utf8");
	return set;
}

const percent = (value) => (value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function formatReviewReport(report) {
	if (!report.reviewCount) return "human review: no verdicts recorded";
	const { agreement } = report;
	const lines = [
		`human review: ${report.reviewCount} verdict(s) from ${Object.keys(report.reviewers).length} reviewer(s); ${report.resolutions.length - report.unresolved.length}/${report.resolutions.length} case-dimensions resolved`,
		agreement.groups
			? `  inter-reviewer agreement over ${agreement.groups} multiply-reviewed case(s): observed ${percent(agreement.observedAgreement)}, expected ${percent(agreement.expectedAgreement)}, Fleiss kappa ${agreement.kappa === null ? "n/a" : agreement.kappa.toFixed(3)}`
			: `  inter-reviewer agreement: not measurable — no case has ${MIN_INDEPENDENT_REVIEWERS} independent blinded reviews`,
	];
	for (const entry of report.unresolved) {
		lines.push(`  unresolved ${entry.dimension}:${entry.caseId} — ${entry.resolution}${entry.resolution === "unadjudicated" ? " (reviewers disagreed and nobody adjudicated)" : ""}`);
	}
	for (const issue of report.issues) lines.push(`  review set issue: ${issue}`);
	return lines.join("\n");
}
