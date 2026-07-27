// Judge calibration: the validity key, the coverage floor, the statistics, the
// human-review resolution, and the gate rules that read them.
//
// The worked examples below are hand-checkable on purpose. A statistics module
// nobody can verify by hand is a statistics module nobody will challenge, and
// these numbers are meant to be challenged at a release review.
import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { strict as assert } from "node:assert";
import {
	calibrationKey,
	calibrationKeyDrift,
	formatCalibrationKeyDrift,
	rubricDigest,
	thresholdFingerprint,
	traceAttributeDigest,
	CALIBRATION_KEY_INPUTS,
} from "../evals/calibration-key.mjs";
import {
	caseSplit,
	dimensionCoverage,
	formatCoverageReport,
	groundTruthClass,
	splitVersions,
	COVERAGE_REQUIREMENT,
	MAX_ABSTENTION_RATE,
} from "../evals/calibration-coverage.mjs";
import {
	abstentionEscalations,
	confusionMatrix,
	detectionMetrics,
	judgeDecision,
	perClassMetrics,
	DEFAULT_ABSTENTION_BAND,
} from "../evals/calibration-stats.mjs";
import {
	buildReviewReport,
	formatReviewReport,
	normalizeReviewSet,
	resolveReviewGroup,
	reviewGroundTruth,
	reviewerAgreement,
} from "../evals/review-agreement.mjs";
import {
	buildCalibrationReport,
	calibrationGateIssues,
	calibrationRecords,
	formatCalibrationReport,
	validateCalibrationCorpus,
} from "../evals/calibration.mjs";
import { assessCalibration, harnessExitCode } from "../evals/pipeline.mjs";

const KEY_INPUTS = {
	judgeModel: "anthropic/claude-haiku-4-5",
	judgeSamples: 1,
	judgeBin: null,
	evalSet: null,
	promptVersion: "pi-flows@0.3.0",
	configVersion: "pi-flows-eval:agent-frontmatter",
	rubric: "aaaaaaaaaaaaaaaa",
	thresholds: thresholdFingerprint({ noiseBand: 0.05 }),
	traceSchemaVersion: "pi-flows.eval-trace.v1",
	traceSerialization: "bbbbbbbbbbbbbbbb",
};

// --- The validity key -------------------------------------------------------

test("a calibration key stays put when nothing that matters changed", () => {
	const key = calibrationKey(KEY_INPUTS);
	assert.deepEqual(calibrationKeyDrift(key, calibrationKey({ ...KEY_INPUTS })), { status: "valid", changed: [] });
	assert.match(formatCalibrationKeyDrift({ status: "valid", changed: [] }, key), /unchanged/);
});

test("changing any key input invalidates the prior calibration and names what moved", () => {
	const stored = calibrationKey(KEY_INPUTS);
	const changes: Record<string, unknown> = {
		judgeModel: "openai/gpt-5.5",
		judgeSamples: 3,
		judgeBin: "/opt/judge",
		evalSet: ".thulr/eval-sets/smoke.json",
		promptVersion: "pi-flows@0.4.0",
		configVersion: "pi-flows-eval:anthropic/claude-haiku-4-5",
		rubric: "cccccccccccccccc",
		thresholds: thresholdFingerprint({ noiseBand: 0.2 }),
		traceSchemaVersion: "pi-flows.eval-trace.v2",
		traceSerialization: "dddddddddddddddd",
	};
	for (const input of CALIBRATION_KEY_INPUTS) {
		const drift = calibrationKeyDrift(stored, calibrationKey({ ...KEY_INPUTS, [input]: changes[input] }));
		assert.equal(drift.status, "stale", `changing ${input} must invalidate calibration`);
		assert.deepEqual(drift.changed, [input]);
	}
});

test("no prior calibration is unknown, not valid", () => {
	assert.deepEqual(calibrationKeyDrift(null, calibrationKey(KEY_INPUTS)), { status: "unknown", changed: [] });
	assert.match(formatCalibrationKeyDrift({ status: "unknown", changed: [] }, calibrationKey(KEY_INPUTS)), /no prior calibration/);
});

test("a threshold fingerprint ignores guardrail ordering but not guardrail membership", () => {
	const left = thresholdFingerprint({ noiseBand: 0.05, scoreGuardrails: ["b", "a"], criticalDimensions: ["criterion"] });
	const right = thresholdFingerprint({ noiseBand: 0.05, scoreGuardrails: ["a", "b"], criticalDimensions: ["criterion"] });
	assert.deepEqual(left, right);
	assert.notDeepEqual(left, thresholdFingerprint({ noiseBand: 0.05, scoreGuardrails: ["a"], criticalDimensions: ["criterion"] }));
});

test("the rubric digest tracks the grading instructions and nothing else", () => {
	const cases = [{ id: "a", criterion: "Finds the bug.", criteria: { evidence_quality: "Cites a path." } }];
	const base = rubricDigest(cases);
	assert.equal(base, rubricDigest([{ ...cases[0], task: "irrelevant to grading" }]), "case fields the judge never reads must not invalidate");
	assert.notEqual(base, rubricDigest([{ ...cases[0], criterion: "Finds the bug and explains it." }]));
	assert.notEqual(base, rubricDigest([{ ...cases[0], criteria: { evidence_quality: "Cites a path and a line." } }]));
	assert.notEqual(base, rubricDigest([{ ...cases[0], judgeOnlyDimensions: ["evidence_quality"] }]));
});

test("the trace serialization digest tracks what the judge is told, not what it is told about", () => {
	const spans = [{ attributes: { "thulr.answer": "one", "thulr.criterion": "c" } }];
	assert.equal(traceAttributeDigest(spans), traceAttributeDigest([{ attributes: { "thulr.criterion": "x", "thulr.answer": "two" } }]), "values vary per case; shape must not");
	assert.notEqual(traceAttributeDigest(spans), traceAttributeDigest([{ attributes: { "thulr.answer": "one", "thulr.criterion": "c", "thulr.expected_behavior": "e" } }]));
});

// --- Coverage and splits ----------------------------------------------------

const labelRecords = (entries: Array<[string, string, string]>) =>
	entries.map(([caseId, dimension, truth]) => ({ caseId, dimension, truth, source: "deterministic", abstained: false }));

test("a dimension is authoritative only with independent labels in every class", () => {
	const coverage = dimensionCoverage(
		labelRecords([
			["case-1", "criterion", "failed"],
			["case-2", "criterion", "failed"],
			["case-3", "criterion", "failed"],
			["case-4", "criterion", "passed"],
			["case-5", "criterion", "partial"],
		]),
	);
	assert.equal(coverage.criterion.authoritative, true);
	assert.deepEqual(coverage.criterion.independent, { passed: 1, partial: 1, failed: 3 });
	assert.deepEqual(coverage.criterion.shortfalls, []);
});

test("repeating one case is one observation, however many times it is recorded", () => {
	const coverage = dimensionCoverage(
		labelRecords([
			["case-1", "criterion", "failed"],
			["case-1", "criterion", "failed"],
			["case-1", "criterion", "failed"],
			["case-4", "criterion", "passed"],
			["case-5", "criterion", "partial"],
		]),
	);
	assert.equal(coverage.criterion.labels.failed, 3, "every label is still counted");
	assert.equal(coverage.criterion.independent.failed, 1, "but they are one case's worth of evidence");
	assert.equal(coverage.criterion.authoritative, false);
	assert.match(coverage.criterion.shortfalls.join(" "), new RegExp(`needs ${COVERAGE_REQUIREMENT.failed} independent failed`));
});

test("a missing class is named specifically, not reported as a generic shortfall", () => {
	const coverage = dimensionCoverage(
		labelRecords([
			["case-1", "criterion", "failed"],
			["case-2", "criterion", "failed"],
			["case-3", "criterion", "failed"],
			["case-4", "criterion", "passed"],
		]),
	);
	assert.equal(coverage.criterion.authoritative, false);
	assert.deepEqual(coverage.criterion.shortfalls, ["needs 1 independent partial label(s), has 0"]);
	assert.match(formatCoverageReport(coverage), /provisional/);
});

test("a judge that abstains its way to a clean score is not authoritative", () => {
	const records = [
		...labelRecords([
			["case-1", "criterion", "failed"],
			["case-2", "criterion", "failed"],
			["case-3", "criterion", "failed"],
			["case-4", "criterion", "passed"],
			["case-5", "criterion", "partial"],
		]),
		{ caseId: "case-6", dimension: "criterion", truth: "failed", source: "deterministic", abstained: true },
		{ caseId: "case-7", dimension: "criterion", truth: "failed", source: "deterministic", abstained: true },
	];
	const coverage = dimensionCoverage(records);
	assert.ok(coverage.criterion.abstentionRate > MAX_ABSTENTION_RATE);
	assert.equal(coverage.criterion.authoritative, false);
	assert.match(coverage.criterion.shortfalls.join(" "), /abstained on 28\.6%/);
});

test("splits are versioned independently of each other", () => {
	const entries = [
		{ testCase: { id: "dev-a", criterion: "Dev rubric." }, split: "rubric-development" },
		{ testCase: { id: "canary-a", criterion: "Canary rubric." }, split: "calibration" },
		{ testCase: { id: "hold-a", criterion: "Held rubric." }, split: "held-out" },
	];
	const before = splitVersions(entries);
	const after = splitVersions([{ ...entries[0], testCase: { id: "dev-a", criterion: "Dev rubric, reworded." } }, entries[1], entries[2]]);
	assert.notEqual(after["rubric-development"].digest, before["rubric-development"].digest, "the split that changed must move");
	assert.equal(after["held-out"].digest, before["held-out"].digest, "the held-out set must be provably untouched");
	assert.equal(after.calibration.digest, before.calibration.digest);
	assert.deepEqual(before["held-out"].caseIds, ["hold-a"]);
});

test("split assignment prefers an explicit declaration, then the corpus naming convention", () => {
	assert.equal(caseSplit({ id: "anything", calibrationSplit: "held-out" }), "held-out");
	assert.equal(caseSplit({ id: "pattern-debate-holdout-audit" }), "held-out");
	assert.equal(caseSplit({ id: "pattern-debate-train-queue" }), "rubric-development");
	assert.equal(caseSplit({ id: "calibration-known-value-wrong" }, { group: "calibration" }), "calibration");
});

test("ground truth is read from the most specific declaration available", () => {
	assert.equal(groundTruthClass({ calibrationLabels: { criterion: "partial" }, labels: { criterion: true } }, "criterion", { pass: true }), "partial");
	assert.equal(groundTruthClass({ labels: { evidence_quality: false } }, "evidence_quality", null), "failed");
	assert.equal(groundTruthClass({}, "criterion", { pass: false, score: 0.5 }), "partial");
	assert.equal(groundTruthClass({}, "criterion", { pass: false, score: 0 }), "failed");
	assert.equal(groundTruthClass({}, "criterion", { pass: true, score: 1 }), "passed");
	assert.equal(groundTruthClass({}, "evidence_quality", { pass: true }), null, "a named dimension with no label has no ground truth to guess at");
});

test("the corpus preflight refuses vocabularies that do not exist", () => {
	const corpus = {
		measurement: [{ id: "a", calibrationSplit: "holdout" }, { id: "b", calibrationLabels: { criterion: "mostly" } }],
		calibration: [{ id: "c" }],
	};
	const validation = validateCalibrationCorpus(corpus);
	assert.equal(validation.ok, false);
	assert.match(validation.issues.join("\n"), /a declares calibrationSplit "holdout"/);
	assert.match(validation.issues.join("\n"), /b labels dimension "criterion" as "mostly"/);
	assert.match(validation.issues.join("\n"), /the held-out split is empty/);
});

test("the corpus preflight passes a corpus with all three splits populated", () => {
	const validation = validateCalibrationCorpus({
		measurement: [{ id: "dev-a" }, { id: "pattern-x-holdout-y" }],
		calibration: [{ id: "canary-a" }],
	});
	assert.deepEqual(validation.issues, []);
	assert.equal(validation.ok, true);
});

// --- Statistics -------------------------------------------------------------

test("abstention is a decision about the boundary, not about the verdict", () => {
	assert.equal(judgeDecision({ verdict: true, score: 0.95 }), "pass");
	assert.equal(judgeDecision({ verdict: false, score: 0.05 }), "fail");
	assert.equal(judgeDecision({ verdict: true, score: 0.5 }), "abstain");
	assert.equal(judgeDecision({ verdict: false, score: 0.5 + DEFAULT_ABSTENTION_BAND }), "abstain");
	assert.equal(judgeDecision({ verdict: true, score: 0.5 + DEFAULT_ABSTENTION_BAND + 0.001 }), "pass");
	assert.equal(judgeDecision({ verdict: true, score: 0.5 }, { abstentionBand: 0 }), "pass", "abstention can be switched off");
	assert.equal(judgeDecision({ verdict: true }), "pass", "an absent score is not an ambiguous one");
	assert.equal(judgeDecision(null), null);
});

/**
 * The worked example every metric below is checked against.
 *
 *            pass  fail  abstain
 *   passed     3     1      0
 *   partial    1     2      1
 *   failed     1     4      0
 */
const WORKED = [
	...Array.from({ length: 3 }, (_, index) => ({ caseId: `p${index}`, dimension: "criterion", truth: "passed", decision: "pass" })),
	{ caseId: "p9", dimension: "criterion", truth: "passed", decision: "fail" },
	{ caseId: "q1", dimension: "criterion", truth: "partial", decision: "pass" },
	{ caseId: "q2", dimension: "criterion", truth: "partial", decision: "fail" },
	{ caseId: "q3", dimension: "criterion", truth: "partial", decision: "fail" },
	{ caseId: "q4", dimension: "criterion", truth: "partial", decision: "abstain", score: 0.52 },
	{ caseId: "f1", dimension: "criterion", truth: "failed", decision: "pass" },
	...Array.from({ length: 4 }, (_, index) => ({ caseId: `f${index + 2}`, dimension: "criterion", truth: "failed", decision: "fail" })),
];

test("the confusion matrix is the raw evidence behind every rate", () => {
	assert.deepEqual(confusionMatrix(WORKED), {
		passed: { pass: 3, fail: 1, abstain: 0 },
		partial: { pass: 1, fail: 2, abstain: 1 },
		failed: { pass: 1, fail: 4, abstain: 0 },
	});
});

test("missed defects are measured with an upper bound, not just a point estimate", () => {
	const detection = detectionMetrics(confusionMatrix(WORKED));
	assert.equal(detection.positiveClass, "should-not-pass");
	assert.deepEqual([detection.truePositives, detection.falseNegatives, detection.falsePositives, detection.trueNegatives], [6, 2, 1, 3]);
	assert.equal(detection.abstained, 1);
	assert.equal(detection.falseNegativeRate.value, 0.25);
	assert.equal(detection.falseNegativeRate.samples, 8);
	assert.equal(detection.falsePositiveRate.value, 0.25);
	assert.equal(detection.recall.value, 0.75);
	assert.equal(detection.precision.value, 6 / 7);
	const bound = detection.falseNegativeRate.confidence95;
	assert.ok(bound.lower < 0.25 && bound.upper > 0.25, "the interval must bracket the estimate");
	assert.ok(bound.upper > 0.5, "eight samples do not pin a 25% miss rate down tightly, and the report must say so");
});

test("a perfect judge on thin evidence still reports how thin the evidence is", () => {
	const clean = detectionMetrics(confusionMatrix([
		{ truth: "failed", decision: "fail" },
		{ truth: "failed", decision: "fail" },
		{ truth: "partial", decision: "fail" },
		{ truth: "passed", decision: "pass" },
	]));
	assert.equal(clean.falseNegativeRate.value, 0);
	assert.ok(clean.falseNegativeRate.confidence95.upper > 0.4, "zero misses out of three is not evidence of a zero miss rate");
});

test("per-class metrics report the composition of the one bucket the judge can predict", () => {
	const perClass = perClassMetrics(confusionMatrix(WORKED));
	assert.deepEqual(
		[perClass.passed.support, perClass.passed.truePositives, perClass.passed.predicted],
		[4, 3, 5],
	);
	assert.equal(perClass.passed.precision.value, 3 / 5);
	assert.equal(perClass.passed.recall.value, 3 / 4);
	assert.equal(perClass.passed.falsePositiveRate.value, 2 / 8);
	assert.equal(perClass.passed.falseNegativeRate.value, 1 / 4);

	assert.equal(perClass.failed.support, 5);
	assert.equal(perClass.failed.recall.value, 4 / 5);
	assert.equal(perClass.failed.precision.value, 4 / 7);
	assert.equal(perClass.partial.recall.value, 2 / 3, "partial and failed share a predicted bucket but not a support");
	assert.equal(perClass.partial.precision.value, 2 / 7);
	assert.equal(perClass.partial.abstained, 1);
});

test("abstained verdicts leave the matrix and enter the escalation queue", () => {
	const escalations = abstentionEscalations(WORKED);
	assert.equal(escalations.length, 1);
	assert.deepEqual(
		{ caseId: escalations[0].caseId, dimension: escalations[0].dimension, score: escalations[0].score, truth: escalations[0].truth },
		{ caseId: "q4", dimension: "criterion", score: 0.52, truth: "partial" },
	);
	assert.match(escalations[0].reason, /ambiguity band/);
});

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

test("unsure is an abstention, so it neither blocks nor carries a resolution", () => {
	assert.equal(resolveReviewGroup([labelled({ reviewer: "ada", verdict: "unsure" }), labelled({ reviewer: "grace", verdict: "fail" })]).resolution, "unanimous");
	assert.equal(resolveReviewGroup([labelled({ reviewer: "ada", verdict: "unsure" }), labelled({ reviewer: "grace", verdict: "unsure" })]).resolution, "abstained");
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

// --- Records, report assembly, and the gate rules ---------------------------

const verdictsFor = (entries: Record<string, Record<string, { verdict: boolean; score: number }>>) => new Map(Object.entries(entries));

test("human labels override deterministic ones, and judge-only dimensions are left alone", () => {
	const records = calibrationRecords({
		cases: [
			{ testCase: { id: "case-1", judgeOnlyDimensions: ["evidence_quality"] }, caseId: "case-1", objective: { pass: false, score: 0 } },
		],
		verdicts: verdictsFor({ "case-1": { criterion: { verdict: false, score: 0.05 }, evidence_quality: { verdict: true, score: 0.9 } } }),
		humanTruth: [{ caseId: "case-1", dimension: "criterion", truth: "partial", source: "human", reviewer: "ada" }],
	});
	assert.equal(records.length, 1, "a judge-only dimension has no ground truth and is not scored against a guess");
	assert.deepEqual(
		{ dimension: records[0].dimension, truth: records[0].truth, source: records[0].source, decision: records[0].decision },
		{ dimension: "criterion", truth: "partial", source: "human", decision: "fail" },
	);
});

const authoritativeRecords = (dimension = "criterion") =>
	[
		["c1", "failed", false, 0.05],
		["c2", "failed", false, 0.05],
		["c3", "failed", false, 0.05],
		["c4", "passed", true, 0.95],
		["c5", "partial", false, 0.2],
	].map(([caseId, truth, verdict, score]) => ({
		caseId,
		dimension,
		truth,
		source: "deterministic",
		decision: judgeDecision({ verdict, score }),
		abstained: false,
		score,
	}));

test("nothing blocks until a dimension is declared critical", () => {
	const report = buildCalibrationReport({ key: calibrationKey(KEY_INPUTS), records: authoritativeRecords() });
	assert.deepEqual(calibrationGateIssues(report), []);
	assert.match(formatCalibrationReport(report), /critical dimensions: none declared/);
});

test("a critical dimension that is only provisional blocks the gate", () => {
	const report = buildCalibrationReport({
		key: calibrationKey(KEY_INPUTS),
		records: authoritativeRecords().slice(0, 4),
		criticalDimensions: ["criterion"],
	});
	const issues = calibrationGateIssues(report);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /critical dimension "criterion" is provisional/);
	assert.match(issues[0], /needs 1 independent partial label/);
});

test("a critical dimension with no ground truth at all blocks, and says how to unblock", () => {
	const report = buildCalibrationReport({ key: calibrationKey(KEY_INPUTS), records: authoritativeRecords(), criticalDimensions: ["evidence_quality"] });
	const issues = calibrationGateIssues(report);
	assert.match(issues[0], /critical dimension "evidence_quality" has no ground truth/);
	assert.match(issues[0], /--critical-dimension=evidence_quality/);
});

test("a critical dimension that waves defects through blocks, with the uncertainty on the record", () => {
	const records = authoritativeRecords().map((record) => (record.caseId === "c1" ? { ...record, decision: "pass", score: 0.95 } : record));
	const report = buildCalibrationReport({ key: calibrationKey(KEY_INPUTS), records, criticalDimensions: ["criterion"] });
	const issues = calibrationGateIssues(report);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /missed 25\.0% of defects \(95% upper bound \d+\.\d%\)/);

	assert.deepEqual(calibrationGateIssues(report, { criticalMissRateCap: 0.5 }), [], "a deliberately loosened cap is honoured");
});

test("a contested human label on a critical dimension blocks until it is adjudicated", () => {
	const report = buildCalibrationReport({
		key: calibrationKey(KEY_INPUTS),
		records: authoritativeRecords(),
		reviewSet: { reviews: [review({ case_id: "c1", reviewer: "ada", verdict: "fail" }), review({ case_id: "c1", reviewer: "grace", verdict: "pass" })] },
		criticalDimensions: ["criterion"],
	});
	const issues = calibrationGateIssues(report);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /1 contested human label\(s\) \(c1\)/);
	assert.match(issues[0], /--role adjudicator/);
});

test("a stale prior calibration blocks a gate that depends on it", () => {
	const report = buildCalibrationReport({
		key: calibrationKey(KEY_INPUTS),
		storedKey: calibrationKey({ ...KEY_INPUTS, judgeModel: "openai/gpt-5.5" }),
		records: authoritativeRecords(),
		criticalDimensions: ["criterion"],
	});
	assert.deepEqual(calibrationGateIssues(report), ["prior calibration is stale — it was measured with a different judgeModel. Re-run calibration before gating on it."]);
});

test("an uncalibrated judge fails the run for a different reason than a regression", () => {
	assert.equal(harnessExitCode({ measured: 3, passed: 3 }), 0);
	assert.equal(harnessExitCode({ measured: 3, passed: 3, calibrationBlocks: true }), 1);
	assert.equal(harnessExitCode({ measured: 3, passed: 3, gateBlocks: true }), 1);
});

// --- The phase, end to end --------------------------------------------------

test("assessCalibration writes a versioned artifact and detects drift against it", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-flow-calibration-"));
	const trace = path.join(dir, "trace.jsonl");
	const out = path.join(dir, "calibration.json");
	await writeFile(trace, `${JSON.stringify({ attributes: { "thulr.answer": "a", "thulr.criterion": "c" } })}\n`);

	const corpus = {
		measurement: [
			{ id: "case-pass", criterion: "Finds it." },
			{ id: "pattern-x-holdout-y", criterion: "Finds it too." },
		],
		calibration: [
			{ id: "canary-bad", criterion: "Finds it." },
			{ id: "canary-partial", criterion: "Finds it." },
			{ id: "canary-worse", criterion: "Finds it." },
		],
	};
	const summaries = [
		{ name: "case-pass", caseId: "case-pass", traceCaseId: "case-pass", objective: { pass: true, score: 1 } },
		{ name: "pattern-x-holdout-y", caseId: "pattern-x-holdout-y", traceCaseId: "pattern-x-holdout-y", objective: { pass: false, score: 0 } },
		{ name: "canary-bad", calibration: true, objective: { pass: false, score: 0 } },
		{ name: "canary-partial", calibration: true, objective: { pass: false, score: 0.5 } },
		{ name: "canary-worse", calibration: true, objective: { pass: false, score: 0 } },
	];
	const verdicts = verdictsFor({
		"case-pass": { criterion: { verdict: true, score: 0.95 } },
		"pattern-x-holdout-y": { criterion: { verdict: false, score: 0.1 } },
		"canary-bad": { criterion: { verdict: false, score: 0.05 } },
		"canary-partial": { criterion: { verdict: false, score: 0.3 } },
		"canary-worse": { criterion: { verdict: false, score: 0.05 } },
	});
	const options = { corpus, summaries, verdicts, keyInputs: KEY_INPUTS, trace, out, log: () => undefined };

	const first = assessCalibration(options);
	assert.equal(first.report.schemaVersion, "pi-flows.calibration.v1");
	assert.equal(first.report.drift.status, "unknown", "the first run has nothing to compare against");
	assert.equal(first.report.coverage.criterion.authoritative, true);
	assert.equal(first.report.coverage.criterion.independent.failed, 3);
	assert.deepEqual(first.issues, []);
	assert.equal(first.blocks, false);

	const written = JSON.parse(readFileSync(out, "utf8"));
	assert.equal(written.splits["held-out"].caseCount, 1);
	assert.equal(written.splits.calibration.caseCount, 3);

	assert.equal(assessCalibration(options).report.drift.status, "valid", "an unchanged run matches its own stored key");

	const reworded = { ...corpus, measurement: [{ ...corpus.measurement[0], criterion: "Finds it, and explains why." }, corpus.measurement[1]] };
	const drifted = assessCalibration({ ...options, corpus: reworded });
	assert.equal(drifted.report.drift.status, "stale");
	assert.deepEqual(drifted.report.drift.changed, ["rubric"], "rewording a rubric invalidates the calibration measured against the old one");
});
