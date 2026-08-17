// What a dispatched Decomposition leaves in the coordination trace (issue
// #148): each subtask's id is the unit key of its worker span, and each
// dependency edge is a link on the dependent span naming the handoff it
// consumed — the way graph mode already records a dependency.
//
// These run against the stub `pi` through the real dispatch path, so the spans
// asserted are the spans a real run writes. The dispatch behavior itself is
// tests/decomposition-dispatch.test.ts.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseTraceJsonl, summarizeTraceSpans, traceReportIsComplete, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";
import { encodeAuthorKey } from "../extensions/pi-flows/types.ts";
import { runFlow } from "./stub-harness.ts";

const TRACE = "flow-trace.jsonl";

async function readSpans(stubDir: string): Promise<TraceSpanRecord[]> {
	return parseTraceJsonl(await readFile(path.join(stubDir, TRACE), "utf8")).spans;
}

const attr = (span: TraceSpanRecord | undefined, key: string) => span?.attributes?.[key];
const unit = (spans: TraceSpanRecord[], key: string) => spans.find((span) => attr(span, "flow.unit_key") === key);
const unitKeys = (spans: TraceSpanRecord[]) => spans.filter((span) => attr(span, "flow.span_role") === "child").map((span) => String(attr(span, "flow.unit_key")));
const rootOf = (spans: TraceSpanRecord[]) => spans.find((span) => span.parent_span_id === null)!;
/** The dependency links a span declares, as the reader sees them. */
const dependsOn = (span: TraceSpanRecord | undefined) => String(attr(span, "flow.depends_on") ?? "").split(",").filter(Boolean);

test("each structured subtask id is its worker's unit key, and each edge is a link naming the handoff it consumed", async () => {
	const { stubDir, result } = await runFlow(
		{ task: "document how auth works", traceFile: TRACE, orchestrate: { recon: { agent: "recon" } } },
		{
			commander: JSON.stringify([
				{ id: "survey", objective: "List the auth entry points" },
				{ id: "lint", objective: "Check the lint rules" },
				{ id: "trace", objective: "Trace token refresh", dependsOn: ["survey"] },
				{ id: "diff", objective: "Compare the two", dependsOn: ["survey", "lint"] },
			]),
			recon: [
				{ whenTaskIncludes: "List the auth entry points", reply: "SURVEY_OUTPUT" },
				{ whenTaskIncludes: "Check the lint rules", reply: "LINT_OUTPUT" },
				{ whenTaskIncludes: "Trace token refresh", reply: "TRACE_OUTPUT" },
				{ whenTaskIncludes: "Compare the two", reply: "DIFF_OUTPUT" },
			],
			debrief: "MERGED_DOC",
		},
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);

	// The commander's chosen ids address the worker spans, so a reader can match
	// a span to the subtask the commander declared.
	assert.deepEqual(unitKeys(spans).sort(), ["decompose", "diff", "lint", "survey", "synthesis-1", "trace"]);

	// Every worker links the decomposition it came from; a dependent one also
	// links each dependency's validated handoff, not the raw run behind it.
	assert.deepEqual(dependsOn(unit(spans, "survey")), ["decompose.handoff"]);
	assert.deepEqual(dependsOn(unit(spans, "trace")), ["decompose.handoff", "survey.handoff"]);
	assert.deepEqual(dependsOn(unit(spans, "diff")), ["decompose.handoff", "survey.handoff", "lint.handoff"]);

	// A dependency is a link, not parentage: `trace` was scheduled by its wave.
	const waveTwo = spans.find((span) => attr(span, "flow.stage_key") === "workers-2")!;
	assert.equal(unit(spans, "trace")!.parent_span_id, waveTwo.span_id);
	assert.notEqual(unit(spans, "trace")!.parent_span_id, unit(spans, "survey")!.span_id);
	// And each link resolves to the span it names.
	assert.equal(
		attr(unit(spans, "trace"), "flow.depends_on_span_ids"),
		[unit(spans, "decompose.handoff")!.span_id, unit(spans, "survey.handoff")!.span_id].join(","),
	);

	// The synthesizer rests on every worker handoff that actually reached it.
	assert.deepEqual(dependsOn(unit(spans, "synthesis-1")).sort(), ["diff.handoff", "lint.handoff", "survey.handoff", "trace.handoff"]);
});

test("a subtask id that would collide with the key separator is escaped the way graph escapes an author id", async () => {
	// Ids come from a model, so one containing a dot must not be readable as a
	// two-part key. `encodeAuthorKey` is the one place that escaping is decided.
	const { stubDir, result } = await runFlow(
		{ task: "document how auth works", traceFile: TRACE, orchestrate: { recon: { agent: "recon" } } },
		{
			commander: JSON.stringify([
				{ id: "auth.login", objective: "Map the login flow" },
				{ id: "auth.refresh", objective: "Map token refresh", dependsOn: ["auth.login"] },
			]),
			recon: [
				{ whenTaskIncludes: "Map the login flow", reply: "LOGIN_OUTPUT" },
				{ whenTaskIncludes: "Map token refresh", reply: "REFRESH_OUTPUT" },
			],
			debrief: "MERGED_DOC",
		},
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);

	// Two escapes reach the attribute, exactly as they do for a graph node id of
	// the same shape: encodeAuthorKey turns the author's dot into "%2E" so it
	// cannot answer to a framework-suffixed key, and the attribute writer then
	// escapes that "%" again for the comma-joined lists.
	assert.equal(encodeAuthorKey("auth.login"), "auth%2Elogin");
	assert.ok(unit(spans, "auth%252Elogin"), "the dotted id reaches the trace escaped");
	assert.equal(unit(spans, "auth.login"), undefined, "and never as a raw two-part key");
	assert.equal(unit(spans, "auth"), undefined, "so nothing answers to the prefix before the dot");
	assert.deepEqual(dependsOn(unit(spans, "auth%252Erefresh")), ["decompose.handoff", "auth%252Elogin.handoff"]);
});

test("a flat subtask list keeps its positional unit keys and links only the decomposition", async () => {
	const { stubDir, result } = await runFlow(
		{ task: "document how auth works", traceFile: TRACE, orchestrate: { recon: { agent: "recon" }, maxSubtasks: 2 } },
		{ commander: '["map the login flow", "map token refresh"]', recon: "WORKER_FINDING", debrief: "MERGED_DOC" },
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);

	assert.deepEqual(unitKeys(spans).sort(), ["decompose", "synthesis-1", "worker-1", "worker-2"]);
	assert.deepEqual(dependsOn(unit(spans, "worker-1")), ["decompose.handoff"]);
	assert.deepEqual(dependsOn(unit(spans, "worker-2")), ["decompose.handoff"]);
});

test("a stranded subtask leaves no span, and the trace still passes the read-back gate", async () => {
	// Stranded work never spawned, so claiming a span for it would put evidence
	// in the trace for a child that does not exist.
	const { stubDir, result } = await runFlow(
		{ task: "document how auth works", traceFile: TRACE, orchestrate: { recon: { agent: "recon" } } },
		{
			commander: JSON.stringify([
				{ id: "survey", objective: "List the auth entry points" },
				{ id: "lint", objective: "Check the lint rules" },
				{ id: "trace", objective: "Trace token refresh", dependsOn: ["survey"] },
			]),
			recon: [
				{ whenTaskIncludes: "List the auth entry points", reply: "SURVEY_CRASHED", exitCode: 1 },
				{ whenTaskIncludes: "Check the lint rules", reply: "LINT_OUTPUT" },
			],
			debrief: "MERGED_DOC",
		},
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);

	assert.ok(unit(spans, "survey"), "the failed subtask ran and is recorded");
	assert.equal(unit(spans, "trace"), undefined, "the stranded subtask has no span");
	assert.equal(unit(spans, "survey.handoff"), undefined, "a failed run produced no handoff to consume");
	assert.deepEqual(dependsOn(unit(spans, "synthesis-1")), ["lint.handoff"], "the answer rests only on the finding that arrived");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("dispatching a Decomposition records no coordination event kind outside orchestrate's declaration", async () => {
	// The wave scheduler records no event of its own hand; the mode's
	// declaration is unchanged, and the read-back would refuse any kind added
	// outside it.
	const { stubDir, result } = await runFlow(
		{
			task: "document how auth works",
			traceFile: TRACE,
			orchestrate: { recon: { agent: "recon" }, verify: { agent: "overwatch" }, verifyPolicy: "revise", verifyMaxIterations: 2 },
			concurrency: 1,
		},
		{
			commander: JSON.stringify([
				{ id: "survey", objective: "List the auth entry points" },
				{ id: "trace", objective: "Trace token refresh", dependsOn: ["survey"] },
			]),
			recon: [
				{ whenTaskIncludes: "List the auth entry points", reply: "SURVEY_OUTPUT" },
				{ whenTaskIncludes: "Trace token refresh", reply: "TRACE_OUTPUT" },
			],
			debrief: ["INCOMPLETE_DOC", "COMPLETE_DOC"],
			overwatch: ["VERDICT: REVISE\nmissing the refresh path", "VERDICT: PASS\nok"],
		},
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);

	assert.equal(attr(rootOf(spans), "flow.trace.owed_event_kinds"), "retry,validation");
	const handPlaced = spans
		.filter((span) => attr(span, "flow.span_role") === "event" && attr(span, "flow.event_minted") !== true)
		.map((span) => String(attr(span, "flow.event_kind")));
	assert.deepEqual([...new Set(handPlaced)].sort(), ["retry", "validation"], "only the kinds the mode declared; the handoff rows are the seam's and carry its stamp");
	const report = summarizeTraceSpans(spans, 0, TRACE);
	assert.equal(report.undeclaredEvents, 0);
	assert.equal(traceReportIsComplete(report), true);
});
