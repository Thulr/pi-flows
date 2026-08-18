// Deterministic calculations for the live Decomposition-quality evaluation.
// The live model calls remain opt-in through npm run eval:decomposition-quality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DECOMPOSITION_QUALITY_CASES, validateDecompositionQualityCases } from "../evals/decomposition-quality-cases.mjs";
import {
	decompositionPresentationOrder,
	decompositionQualityScore,
	judgmentVerdict,
	normalizedFragmentationScore,
	pairedDecompositionQualityReport,
	verdictAccuracy,
} from "../evals/decomposition-quality-report.mjs";

const obligations = [{ id: "a", text: "A" }, { id: "b", text: "B" }];
const good = { obligations: { a: 4, b: 4 }, overlap: 4, workerFit: 4, dependencies: 4, context: 4, fragmentation: 4 };

test("the quality corpus covers both shapes and every required quality defect", () => {
	assert.deepEqual(validateDecompositionQualityCases(), []);
	const families = new Set(DECOMPOSITION_QUALITY_CASES.map((testCase) => testCase.family));
	for (const family of ["flat-control", "structured-control", "coverage-gap", "overlap", "worker-fit", "dependency", "context", "fragmentation"]) {
		assert.ok(families.has(family), `missing quality family: ${family}`);
	}
	assert.ok(DECOMPOSITION_QUALITY_CASES.some((testCase) => typeof testCase.entries[0] === "string"), "flat shape is present");
	assert.ok(DECOMPOSITION_QUALITY_CASES.some((testCase) => typeof testCase.entries[0] === "object"), "structured shape is present");
});

test("extra subtasks cannot increase the quality score by themselves", () => {
	const score = decompositionQualityScore(good, obligations);
	assert.equal(score, 1);
	// Subtask count is not an input to the score. It is reported as a guardrail.
	assert.equal(decompositionQualityScore({ ...good, fragmentation: 0 }, obligations), score, "fragmentation is also a separate dimension");
	assert.equal(judgmentVerdict({ ...good, fragmentation: 0 }, obligations), "revise", "fragmentation still controls PASS/REVISE");
});

test("each goal obligation is required once and missing scores fail safe", () => {
	assert.equal(decompositionQualityScore(good, obligations), 1);
	assert.equal(decompositionQualityScore({ ...good, obligations: { a: 4 } }, obligations), null);
	assert.equal(judgmentVerdict({ ...good, obligations: { a: 4 } }, obligations), "revise");
});

test("fragmentation normalization rejects nonnumeric and out-of-range judge values", () => {
	assert.equal(normalizedFragmentationScore(4), 1);
	for (const invalid of [null, "", true, Number.NaN, -1, 5]) {
		assert.equal(normalizedFragmentationScore(invalid), null);
	}
});

test("the paired report claims improvement only for a positive interval without fragmentation regression", () => {
	const rows = ["one", "two", "three"].map((caseId) => ({
		caseId,
		reviewPassed: true,
		initialQuality: 0.4,
		finalQuality: 0.8,
		initialFragmentation: 0.5,
		finalFragmentation: 0.75,
		initialSubtasks: 3,
		finalSubtasks: 2,
	}));
	const calibration = verdictAccuracy([{ expected: "pass", actual: "pass" }, { expected: "revise", actual: "revise" }]);
	const improved = pairedDecompositionQualityReport(rows, calibration);
	assert.equal(improved.claimImprovement, true);
	assert.ok(improved.quality.confidence95!.lower > 0);

	const fragmented = pairedDecompositionQualityReport(rows.map((row) => ({ ...row, finalFragmentation: 0.25 })), calibration);
	assert.equal(fragmented.claimImprovement, false);
	assert.ok(fragmented.claimBlockers.includes("fragmentation regressed"));

	const uncalibrated = pairedDecompositionQualityReport(rows, { ...calibration, accuracy: 0.5 });
	assert.equal(uncalibrated.claimImprovement, false);

	const rejected = pairedDecompositionQualityReport(rows.map((row) => ({ ...row, reviewPassed: false })), calibration);
	assert.equal(rejected.rows, 0);
	assert.equal(rejected.claimImprovement, false);

	for (const invalid of [Number.NaN, -0.25, 1.25]) {
		const malformed = pairedDecompositionQualityReport(rows.map((row) => ({ ...row, finalFragmentation: invalid })), calibration);
		assert.equal(malformed.rows, 0);
		assert.equal(malformed.claimImprovement, false);
	}
});

test("candidate presentation order is blind and counterbalanced", () => {
	assert.deepEqual(decompositionPresentationOrder(0, 1), ["final", "initial"]);
	assert.deepEqual(decompositionPresentationOrder(0, 2), ["initial", "final"]);
	assert.deepEqual(decompositionPresentationOrder(1, 1), ["initial", "final"]);
});

test("the dry-run CLI emits every required report field without a model", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "decomposition-quality-test-"));
	const out = path.join(dir, "report.json");
	const run = spawnSync(process.execPath, ["--import", "tsx", "evals/decomposition-quality.mjs", "--dry-run", `--out=${out}`], {
		cwd: path.resolve(import.meta.dirname, ".."),
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(run.status, 0, run.stderr || run.stdout);
	const report = JSON.parse(readFileSync(out, "utf8"));
	assert.equal(report.dryRun, true);
	assert.equal(report.reviewerAccuracy.accuracy, 1);
	assert.equal(report.judgeAccuracy.accuracy, 1);
	assert.ok(report.paired.quality.confidence95.lower > 0);
	assert.equal(report.paired.claimImprovement, true);
	for (const field of ["costUsd", "generatedTokens", "totalTokens", "latencyMs"]) {
		assert.equal(typeof report.subjectMetrics[field], "number");
		assert.equal(typeof report.judgeMetrics[field], "number");
	}
});
