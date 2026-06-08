import { test } from "node:test";
import assert from "node:assert/strict";
import { traceSpansForCase, buildLabels, gateBlocks } from "../evals/thulr.mjs";

// The trace contract was established empirically (see evals/README.md): thulr's
// judge grades the LAST `AGENT` span's `output.value` per `flow.trace_label`,
// ignores the CHAIN root, and rejects spans without numeric timestamps. So each
// case must emit exactly one AGENT span carrying the canonical final answer.
test("traceSpansForCase emits one AGENT span carrying the answer under the case label", () => {
	const spans = traceSpansForCase({ name: "my-case", answer: "the value is xyzzy-42", startMs: 1000, endMs: 2500 });

	const agents = spans.filter((s) => s.attributes["openinference.span.kind"] === "AGENT");
	assert.equal(agents.length, 1, "exactly one AGENT span (thulr grades the last AGENT span)");
	const agent = agents[0];
	assert.equal(agent.attributes["output.value"], "the value is xyzzy-42");
	assert.equal(agent.attributes["flow.trace_label"], "my-case");
	assert.equal(agent.start_time_unix_ms, 1000, "thulr rejects spans without a numeric start time");
	assert.equal(agent.end_time_unix_ms, 2500, "thulr rejects spans without a numeric end time");
});

test("traceSpansForCase nests the AGENT span under a CHAIN root in one trace", () => {
	const spans = traceSpansForCase({ name: "c", answer: "a", startMs: 0, endMs: 1 });

	const root = spans.find((s) => s.parent_span_id === null);
	const agent = spans.find((s) => s.attributes["openinference.span.kind"] === "AGENT");
	assert.ok(root, "a CHAIN root span exists");
	assert.equal(root.attributes["openinference.span.kind"], "CHAIN");
	assert.equal(agent.parent_span_id, root.span_id, "AGENT child points at the root span");
	assert.equal(agent.trace_id, root.trace_id, "child and root share one trace_id");
	assert.equal(root.attributes["flow.trace_label"], "c");
});

// thulr's --baseline-run is the deterministic objectiveScore labels it calibrates
// the judge against. Every case row must carry objectiveScore.
test("buildLabels carries per-case objectiveScore and the subject model", () => {
	const labels = buildLabels({
		model: "openai-codex/gpt-5.5",
		cases: [{ name: "k", objectiveScore: 1, pass: true, score: 1, notes: "ok" }],
	});

	assert.equal(labels.model, "openai-codex/gpt-5.5");
	assert.equal(labels.cases.length, 1);
	assert.equal(labels.cases[0].name, "k");
	assert.equal(labels.cases[0].objectiveScore, 1);
});

// thulr-evaluator gate exits 10 on FAIL (a real regression that must block);
// any non-10 exit (PASS/WARN) does not block the harness.
test("gateBlocks is true only for the thulr FAIL exit code (10)", () => {
	assert.equal(gateBlocks(10), true);
	assert.equal(gateBlocks(0), false);
});
