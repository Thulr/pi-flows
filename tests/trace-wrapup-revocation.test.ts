// Reading back a revoked budget wrap-up (#112): the child span is exported
// with status OK before envelope validation demotes the run, and an exported
// span is immutable — the correction travels on the linked rejection event
// (`flow.budget.wrapup_revoked`). These pin the reader half: per-child outcome
// derivation must apply that correction, or a trace query classifies the
// dishonored run as successful while every live surface reports it failed.
import { strict as assert } from "node:assert";
import test from "node:test";
import { summarizeTraceSpans, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";

const span = (overrides: Record<string, unknown>): TraceSpanRecord => ({
	trace_id: "t1",
	span_id: "s0",
	parent_span_id: null,
	name: "flow.single",
	start_time_unix_ms: 0,
	end_time_unix_ms: 1,
	status: { code: "OK" },
	attributes: {},
	...overrides,
} as TraceSpanRecord);

/**
 * A minimal trace whose ROOT carries no `flow.execution_success` verdict, so
 * the reader must derive the outcome from the child spans — exactly the path a
 * truncated trace (root never written) or a foreign writer forces.
 */
function wrapUpTrace(revoked: boolean): TraceSpanRecord[] {
	const root = span({ span_id: "root", name: "flow.single", attributes: { "flow.span_role": "root", "flow.mode": "single", "flow.trace.expected_spans": 3, "flow.trace.observed_spans": 3 } });
	const child = span({
		span_id: "child-1",
		parent_span_id: "root",
		name: "flow.single.recon",
		attributes: { "flow.span_role": "child", "flow.agent": "recon", "flow.stop_reason": "budget_wrap_up", "flow.unit_key": "single" },
	});
	const event = span({
		span_id: "event-1",
		parent_span_id: "root",
		name: "flow.event.envelope.rejected",
		attributes: {
			"flow.span_role": "event",
			"flow.event_kind": "validation",
			"flow.event_name": "envelope.rejected",
			"flow.error_code": "RETURN_ENVELOPE_INVALID",
			"flow.unit_key": "single.validation",
			"flow.depends_on_span_ids": "child-1",
			...(revoked ? { "flow.budget.wrapup_revoked": true } : {}),
		},
	});
	return [root, child, event];
}

test("the reader fails a child a revocation event points at, whatever its span status says", () => {
	const revoked = summarizeTraceSpans(wrapUpTrace(true));
	assert.equal(revoked.traces, 1);
	assert.equal(revoked.executionSuccesses, 0, "per-child trace queries must not classify the revoked run as successful");

	// Control: the same shape without the revocation flag stays a successful
	// execution — an ordinary envelope rejection does not retroactively fail a
	// child span, only a revoked provisional wrap-up does.
	const ordinary = summarizeTraceSpans(wrapUpTrace(false));
	assert.equal(ordinary.executionSuccesses, 1);
});

test("a root that recorded its own verdict is not overridden by the correction", () => {
	// The writer's root verdict already accounts for the flow error; the
	// correction exists for readers that never get one.
	const spans = wrapUpTrace(true).map((record) =>
		record.span_id === "root"
			? { ...record, attributes: { ...record.attributes, "flow.execution_success": false } }
			: record,
	);
	assert.equal(summarizeTraceSpans(spans as TraceSpanRecord[]).executionSuccesses, 0);
});
