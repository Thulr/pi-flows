// Human ground truth: normalization, blinding, corroboration, adjudication, and
// how much the resulting labels can be believed.
//
// Split out of tests/eval-calibration.test.ts because it is its own subject —
// these exercise review-agreement.mjs, which the calibration report consumes but
// does not define.
import test from "node:test";
import { strict as assert } from "node:assert";
import {
	buildReviewReport,
	formatReviewReport,
	normalizeReviewSet,
	resolveReviewGroup,
	reviewGroundTruth,
	reviewerAgreement,
} from "../evals/review-agreement.mjs";

// --- Human review -----------------------------------------------------------

// Raw review-set entries, as `thulr review` writes them.
const review = (overrides: Record<string, unknown> = {}) => ({ case_id: "case-1", verdict: "fail", reviewer: "ada", blinded: true, ...overrides });
// Normalized records, as resolveReviewGroup consumes them.
const labelled = (overrides: Record<string, unknown> = {}) => ({ caseId: "case-1", dimension: "criterion", verdict: "fail", reviewer: "ada", role: "reviewer", blinded: true, ...overrides });

test("a review set with no blinding recorded was not blinded", () => {
	const { reviews, issues } = normalizeReviewSet({ schema_version: "thulr.review_set.v1", reviews: [{ case_id: "case-1", verdict: "pass", reviewer: "ada" }] });
	assert.deepEqual(issues, []);
	assert.equal(reviews[0].blinded, false, "assuming otherwise would launder an anchored opinion into independent evidence");
	assert.equal(reviews[0].dimension, "criterion");
	assert.equal(reviews[0].role, "reviewer");
});

test("malformed reviews are reported and skipped, not thrown", () => {
	const { reviews, issues } = normalizeReviewSet({
		reviews: [review(), { verdict: "pass" }, review({ case_id: "case-2", verdict: "maybe" }), review({ case_id: "case-3", role: "judge" }), review({ case_id: "case-4", role: "adjudicator", reviewer: null })],
	});
	assert.equal(reviews.length, 1, "the one good review survives");
	assert.equal(issues.length, 4);
	assert.match(issues.join("\n"), /must name a case_id/);
	assert.match(issues.join("\n"), /verdict must be one of pass \| fail \| unsure/);
	assert.match(issues.join("\n"), /adjudication with no reviewer identity/);
});

test("unanimous blinded reviewers resolve a case", () => {
	const resolved = resolveReviewGroup([labelled({ reviewer: "ada" }), labelled({ reviewer: "grace" })]);
	assert.deepEqual(
		{ label: resolved.label, resolution: resolved.resolution, independentReviewers: resolved.independentReviewers },
		{ label: "failed", resolution: "unanimous", independentReviewers: 2 },
	);
});

test("a disagreement nobody adjudicated stays unresolved", () => {
	const resolved = resolveReviewGroup([labelled({ reviewer: "ada", verdict: "fail" }), labelled({ reviewer: "grace", verdict: "pass" })]);
	assert.equal(resolved.label, null);
	assert.equal(resolved.resolution, "unadjudicated");
});

test("an adjudicator settles a disagreement and is named for it", () => {
	const resolved = resolveReviewGroup([
		labelled({ reviewer: "ada", verdict: "fail" }),
		labelled({ reviewer: "grace", verdict: "pass" }),
		labelled({ reviewer: "barbara", verdict: "fail", role: "adjudicator" }),
	]);
	assert.deepEqual({ label: resolved.label, resolution: resolved.resolution, adjudicator: resolved.adjudicator }, { label: "failed", resolution: "adjudicated", adjudicator: "barbara" });
});

test("two adjudicators who disagree are refused, not settled by array order", () => {
	const conflicted = resolveReviewGroup([
		labelled({ reviewer: "ada", verdict: "fail" }),
		labelled({ reviewer: "grace", verdict: "pass" }),
		labelled({ reviewer: "barbara", verdict: "fail", role: "adjudicator" }),
		labelled({ reviewer: "katherine", verdict: "pass", role: "adjudicator" }),
	]);
	assert.equal(conflicted.label, null, "a label that overrides deterministic truth must not depend on ordering");
	assert.equal(conflicted.resolution, "conflicting-adjudication");
	assert.equal(conflicted.adjudicator, "barbara, katherine", "both are named so the conflict is auditable");

	// Adjudicators who agree still settle it, whichever order they arrive in.
	const agreed = [labelled({ reviewer: "ada", verdict: "fail" }), labelled({ reviewer: "grace", verdict: "pass" }), labelled({ reviewer: "barbara", verdict: "fail", role: "adjudicator" }), labelled({ reviewer: "katherine", verdict: "fail", role: "adjudicator" })];
	assert.equal(resolveReviewGroup(agreed).resolution, "adjudicated");
	assert.equal(resolveReviewGroup([...agreed].reverse()).label, "failed");
});

test("unsure is an abstention: it never blocks, and it never corroborates", () => {
	// One decided verdict beside an abstention is still one opinion, so the group
	// is under-reviewed rather than resolved — but it is not a disagreement either,
	// so it does not demand an adjudicator.
	assert.equal(resolveReviewGroup([labelled({ reviewer: "ada", verdict: "unsure" }), labelled({ reviewer: "grace", verdict: "fail" })]).resolution, "insufficient-reviewers");
	assert.equal(resolveReviewGroup([labelled({ reviewer: "ada", verdict: "unsure" }), labelled({ reviewer: "grace", verdict: "unsure" })]).resolution, "abstained");
});

test("one reviewer is one opinion, not ground truth", () => {
	const lone = resolveReviewGroup([labelled({ reviewer: "ada", verdict: "fail" })]);
	assert.equal(lone.label, null, "a single blinded review must not override the deterministic objective");
	assert.equal(lone.resolution, "insufficient-reviewers");

	// Two distinct reviewers corroborate; the same person twice does not.
	assert.equal(resolveReviewGroup([labelled({ reviewer: "ada" }), labelled({ reviewer: "ada" })]).resolution, "insufficient-reviewers");
	assert.equal(resolveReviewGroup([labelled({ reviewer: "ada" }), labelled({ reviewer: "grace" })]).resolution, "unanimous");

	// Adjudication stays the explicit single-actor path.
	const adjudicated = resolveReviewGroup([labelled({ reviewer: "ada", verdict: "fail" }), labelled({ reviewer: "barbara", verdict: "fail", role: "adjudicator" })]);
	assert.equal(adjudicated.resolution, "adjudicated");
	assert.equal(adjudicated.label, "failed");
});

test("an unblinded review does not resolve anything on its own", () => {
	const resolved = resolveReviewGroup([labelled({ blinded: false })]);
	assert.equal(resolved.label, null);
	assert.equal(resolved.resolution, "no-blinded-review");
});

test("Fleiss kappa reads 1 for perfect agreement and -1 for perfect disagreement", () => {
	const perfect = reviewerAgreement([{ verdicts: ["pass", "pass"] }, { verdicts: ["fail", "fail"] }]);
	assert.equal(perfect.observedAgreement, 1);
	assert.equal(perfect.expectedAgreement, 0.5);
	assert.equal(perfect.kappa, 1);
	assert.equal(perfect.unanimousGroups, 2);

	const opposed = reviewerAgreement([{ verdicts: ["pass", "fail"] }, { verdicts: ["pass", "fail"] }]);
	assert.equal(opposed.observedAgreement, 0);
	assert.equal(opposed.kappa, -1);
	assert.equal(opposed.unanimousGroups, 0);
});

test("agreement over ragged reviewer counts is measured, and an unmeasurable one says so", () => {
	const ragged = reviewerAgreement([{ verdicts: ["pass", "pass", "fail"] }, { verdicts: ["fail", "fail"] }, { verdicts: ["pass"] }]);
	assert.equal(ragged.groups, 2, "a single-reviewer case has nothing to agree about");
	assert.ok(ragged.kappa !== null);

	const nothing = reviewerAgreement([{ verdicts: ["pass"] }]);
	assert.deepEqual(nothing, { groups: 0, observedAgreement: null, expectedAgreement: null, kappa: null, unanimousGroups: 0 });
});

test("a review report names reviewers, resolutions, and what stayed contested", () => {
	const report = buildReviewReport({
		reviews: [
			review({ case_id: "agreed", reviewer: "ada", verdict: "fail" }),
			review({ case_id: "agreed", reviewer: "grace", verdict: "fail" }),
			review({ case_id: "contested", reviewer: "ada", verdict: "fail" }),
			review({ case_id: "contested", reviewer: "grace", verdict: "pass" }),
		],
	});
	assert.equal(report.reviewCount, 4);
	assert.deepEqual(report.reviewers.ada, { reviews: 2, blinded: 2, adjudications: 0 });
	assert.deepEqual(report.unresolved.map((entry) => entry.caseId), ["contested"]);
	assert.deepEqual(reviewGroundTruth(report), [{ caseId: "agreed", dimension: "criterion", truth: "failed", source: "human", reviewer: "ada", resolution: "unanimous" }]);
	assert.match(formatReviewReport(report), /unresolved criterion:contested — unadjudicated/);
});
