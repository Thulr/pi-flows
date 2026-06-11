import { test } from "node:test";
import assert from "node:assert/strict";
import { traceSpansForCase, gateBlocks, gateArgs, judgeArgs } from "../evals/thulr.mjs";

// thulr ingests a SELF-CONTAINED trace: each case's criterion and its
// deterministic (objective) label travel INLINE in the span attributes — no more
// separate cases-manifest or labels files. thulr groups by `thulr.case_id` and
// grades the latest span's `output.value`. (See thulr's docs/trace-contract.md.)
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

// thulr's trace contract takes optional judge context + repro telemetry per case:
// the task text (input.value), cost/tokens (summed into the EvalRun), and the
// prompt version (queryable via `thulr query-traces --prompt-version`).
test("traceSpansForCase carries task, cost, tokens, and prompt version when given", () => {
	const [span] = traceSpansForCase({
		name: "c",
		answer: "a",
		criterion: "x",
		endMs: 1,
		task: "Find the value of MAGIC_TOKEN.",
		costUsd: 0.0421,
		tokensTotal: 1234,
		promptVersion: "pi-flows@0.1.0",
	});

	assert.equal(span.attributes["input.value"], "Find the value of MAGIC_TOKEN.", "the task text is the judge's input context");
	assert.equal(span.attributes["thulr.cost_usd"], 0.0421);
	assert.equal(span.attributes["llm.token_count.total"], 1234);
	assert.equal(span.attributes["thulr.prompt_version"], "pi-flows@0.1.0");
});

// Without a task the span stays valid: input.value falls back to the case id, and
// none of the optional telemetry attributes appear half-set.
test("traceSpansForCase omits optional telemetry and falls back input.value to the case id", () => {
	const [span] = traceSpansForCase({ name: "c", answer: "a", criterion: "x", endMs: 1 });
	assert.equal(span.attributes["input.value"], "c");
	assert.equal("thulr.cost_usd" in span.attributes, false);
	assert.equal("llm.token_count.total" in span.attributes, false);
	assert.equal("thulr.prompt_version" in span.attributes, false);
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

// `--format junit` (thulr 0.1.2) replaces the terminal report on stdout with a
// JUnit XML testsuite for CI test ingestion; exit codes are unchanged.
test("gateArgs renders the CI-native JUnit format when asked", () => {
	const args = gateArgs({ baseline: "b.json", candidate: "c.json", format: "junit" });
	assert.deepEqual(args, ["gate", "--format", "junit", "b.json", "c.json"]);
});

// Judge repeat-sampling (thulr 0.1.2): `--samples N` judges each case N times and
// aggregates (majority verdict, mean score). N=1 is the default — no flag emitted,
// byte-identical to single-sample judging.
test("judgeArgs passes --samples only when repeat-sampling is on", () => {
	assert.deepEqual(
		judgeArgs({ trace: "t.jsonl", out: "run.json", model: "anthropic/claude-sonnet-4-6", concurrency: 4, samples: 3 }),
		["judge", "--trace", "t.jsonl", "--out", "run.json", "--model", "anthropic/claude-sonnet-4-6", "--concurrency", "4", "--samples", "3"],
	);
	assert.deepEqual(
		judgeArgs({ trace: "t.jsonl", out: "run.json", samples: 1 }),
		["judge", "--trace", "t.jsonl", "--out", "run.json"],
	);
});
