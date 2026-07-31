import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES } from "../evals/cases.mjs";
import { DEFAULT_EVAL_JUDGE_MODEL, timeoutPlanForCase } from "../evals/lib.mjs";
import { PATTERN_CASES } from "../evals/pattern-cases.mjs";
import { selectCalibrationReviewSet, selectMeasurementCases } from "../evals/pipeline.mjs";

test("every live eval case carries a delegation justification", () => {
	for (const testCase of CASES) {
		assert.equal(typeof testCase.params?.why, "string", `${testCase.name} must pass the flow spawning gate`);
		assert.ok(testCase.params.why.trim().length > 0, `${testCase.name} must explain why delegation is warranted`);
	}
});

test("evals default to the authenticated Codex judge", () => {
	assert.equal(DEFAULT_EVAL_JUDGE_MODEL, "openai-codex/gpt-5.5");
});

test("the release suite pass-gates behaviour while hard cases remain score tracks", () => {
	const cases = [
		{ name: "behaviour" },
		{ name: "hard-headroom", hard: true },
		{ name: "threshold-control", control: true },
		{ name: "imported-regression", productionFailure: {} },
	];
	assert.deepEqual(
		selectMeasurementCases(cases, { releaseSuite: true }).map((entry) => entry.name),
		["behaviour", "imported-regression"],
	);
});

test("auto-discovered review sets apply only to cases in the current run", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-flows-review-selection-"));
	const trace = join(dir, "trace.jsonl");
	const stale = join(dir, "stale.reviews.json");
	const matching = join(dir, "matching.reviews.json");
	writeFileSync(stale, JSON.stringify({ reviews: [{ case_id: "old-case", verdict: "pass" }] }));
	writeFileSync(matching, JSON.stringify({ reviews: [{ case_id: "current-case", verdict: "pass" }] }));

	assert.equal(selectCalibrationReviewSet({ trace, preferredPath: stale, caseIds: ["current-case"] }), null);
	assert.equal(selectCalibrationReviewSet({ trace, preferredPath: matching, caseIds: ["current-case"] }), matching);
	assert.equal(selectCalibrationReviewSet({ trace, preferredPath: stale, explicit: true, caseIds: ["current-case"] }), stale);
});

test("the evidence-heavy regional debate budget covers two rounds and adjudication", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-debate-holdout-regional-writes");
	assert.equal(timeoutPlanForCase(testCase, { defaultTimeoutMs: 120_000 }).caseTimeoutMs, 900_000);
});

test("signing-key workflow objective accepts a continuous-hours gate", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-workflow-holdout-keys");
	const scored = testCase.score({
		content: [{ type: "text", text: "Use a 48-hour overlap with the old key verify-only. Require all three regions at 99.9% for 6 continuous hours, Security approval, and a clock-skew check." }],
	}, { dryRun: true, flowCtx: { cwd: "" } });
	assert.equal(scored.pass, true, scored.notes);
});

test("hard debate holdout objective accepts equivalent live decision-record wording", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-debate-holdout-regional-writes");
	const scored = testCase.score({ content: [{ type: "text", text: `DECISION: A
Use upper-bound measurements and lower-bound control effectiveness.
Monthly cost <= $28k: A is 25 + 2 = $27k, so it passes; fencing deploys in 6 days before day 10.
Write p99 < 175ms: A is 164 + 9 = 173ms, so it passes.
Duplicates <= 0.25%: A is 1.60% * 0.10 = 0.16%, so it passes.
Failover and lag are 42s / 12s, both within their limits.
Failover CPU <= 90%: B is 68% + 24pp = 92% raw. The add-on gives 92 - 8 = 84%, but its cost is 21 + 8 = $29k, over the $28k cap. Batch eviction gives 86% but is unavailable until day 31.
Strongest cases:
- A passes every day-10 constraint with fencing.
- B has zero duplicates, 158ms latency, costs $21k, and is operationally simpler.
Disable secondary writes and return to single-primary when duplicates exceed 0.25% for two consecutive 15-minute windows, or write p99 is at least 175ms for 10 continuous minutes.
architecture.md:3 measurements.csv:2 change-window.md:3 constraints.md:3 incident.md:3` }] });
	assert.equal(scored.pass, true, scored.notes);
});
