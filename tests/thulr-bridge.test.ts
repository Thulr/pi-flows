import { test } from "node:test";
import assert from "node:assert/strict";
import { traceSpansForCase, gateBlocks, gateArgs } from "../evals/thulr.mjs";

// thulr 0.1.1 ingests a SELF-CONTAINED trace: each case's criterion and its
// deterministic (objective) label travel INLINE in the span attributes — no more
// separate cases-manifest or labels files. thulr groups by `thulr.case_id` and
// grades the latest span's `output.value`. (See thulr's openinference_trace adapter.)
test("traceSpansForCase emits a self-contained span: case_id, criterion, label, answer inline", () => {
	const spans = traceSpansForCase({
		name: "my-case",
		answer: "the value is xyzzy-42",
		criterion: "The answer states the value is xyzzy-42.",
		label: true,
		endMs: 2500,
	});

	const graded = spans.find((s) => s.attributes["output.value"] !== undefined);
	assert.ok(graded, "a span carries output.value for the judge to grade");
	assert.equal(graded.attributes["thulr.case_id"], "my-case");
	assert.equal(graded.attributes["thulr.criterion"], "The answer states the value is xyzzy-42.");
	assert.equal(graded.attributes["thulr.deterministic_label"], true);
	assert.equal(graded.attributes["output.value"], "the value is xyzzy-42");
	assert.equal(graded.end_time_unix_ms, 2500, "thulr needs a numeric end_time_unix_ms");
});

// The deterministic label is a boolean (objective pass/fail), not a score — false
// for a failing case so thulr can measure the judge's true-negative rate.
test("traceSpansForCase carries the deterministic label as a boolean", () => {
	const spans = traceSpansForCase({ name: "c", answer: "wrong", criterion: "x", label: false, endMs: 1 });
	const graded = spans.find((s) => s.attributes["output.value"] !== undefined);
	assert.equal(graded.attributes["thulr.deterministic_label"], false);
});

// thulr gate exits 10 on FAIL (a real regression that must block);
// any non-10 exit (PASS/WARN) does not block the harness.
test("gateBlocks is true only for the thulr FAIL exit code (10)", () => {
	assert.equal(gateBlocks(10), true);
	assert.equal(gateBlocks(0), false);
});

// The gate guards BOTH axes: a pass-rate regression (--guardrail) and a mean-SCORE
// regression that holds pass-rate (--score-guardrail, thulr's "Gap 1").
test("gateArgs passes both the pass-rate and mean-score guardrails", () => {
	const args = gateArgs({
		baseline: "base.json",
		candidate: "cand.json",
		guardrails: ["criterion"],
		scoreGuardrails: ["criterion"],
		noiseBand: 0.05,
	});

	assert.deepEqual(args, [
		"gate",
		"--guardrail", "criterion",
		"--score-guardrail", "criterion",
		"--noise-band", "0.05",
		"base.json", "cand.json",
	]);
});
