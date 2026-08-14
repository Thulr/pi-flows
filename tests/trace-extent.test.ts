// #129: since #126 every strict finalize read its whole trace file back. In
// the documented eval setup one PI_FLOWS_TRACE_FILE accumulates every flow of
// a run, so flow N reread flows 1..N-1 on each finalize — quadratic I/O whose
// only purpose was to skip rows by a substring test. The file is append-only,
// so the fix is a boundary, not an index: the sink records the file's size the
// moment it is born, and the read-back reads only from that byte. Nothing
// before it can carry this invocation's random id honestly (the id does not
// exist yet), and anything a concurrent writer lands after the sink exists is
// inside the extent and judged exactly as before. These tests pin the
// boundary: the extent bounds the read, an under-estimated start stays safe,
// and rows that predate the flow call are its predecessors' record — the
// whole-file report's business, no longer the live gate's.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTraceSink } from "../extensions/pi-flows/trace-sink.ts";
import { verifyExportedTrace } from "../extensions/pi-flows/trace-verify.ts";
import { stableTraceIds } from "../extensions/pi-flows/trace-identity.mjs";
import { parseTraceJsonl, strictTraceError, summarizeTraceSpans, traceReportIsComplete } from "../extensions/pi-flows/trace.ts";
import type { FlowRunResult } from "../extensions/pi-flows/types.ts";

const policy = { recordContent: true, redactSecrets: true };

function traceFile(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "pi-flow-extent-")), "flow-trace.jsonl");
}

function settledRun(agent: string): FlowRunResult {
	return {
		agent,
		agentSource: "package",
		task: "inspect",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		stderr: "",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
		durationMs: 5,
	} as unknown as FlowRunResult;
}

/** A whole, self-consistent strict record as the sink leaves one: child, root declaring the count, certification. */
function ownRecord(traceId: string, rootSpanId: string, invocationId: string): string {
	const rows = [
		{
			trace_id: traceId, span_id: "11111111111111111111111111111111", parent_span_id: rootSpanId,
			name: "flow.single.recon", start_time_unix_ms: 2, end_time_unix_ms: 3, status: { code: "OK" },
			attributes: { "flow.span_role": "child", "flow.invocation_id": invocationId },
		},
		{
			trace_id: traceId, span_id: rootSpanId, parent_span_id: null,
			name: "flow.single", start_time_unix_ms: 1, end_time_unix_ms: 100, status: { code: "OK" },
			attributes: { "flow.span_role": "root", "flow.trace.expected_spans": 3, "flow.invocation_id": invocationId },
		},
		{
			trace_id: traceId, span_id: "22222222222222222222222222222222", parent_span_id: rootSpanId,
			name: "flow.single.event.trace.structure_verified", start_time_unix_ms: 50, end_time_unix_ms: 50, status: { code: "OK" },
			attributes: { "flow.span_role": "event", "flow.trace.structure_verified": true, "flow.invocation_id": invocationId },
		},
	];
	return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

/**
 * The extent is what bounds the read. The same file holds a row forging both
 * halves of this run's identity ahead of the extent and the run's own whole
 * record inside it: read whole the forgery is surplus and refuses, read from
 * the extent it is never loaded — which is the entire cost the boundary
 * removes, an unbounded prefix the reading had to traverse to ignore.
 */
test("the read-back reads only from the extent it is given", async () => {
	const file = traceFile();
	const context = { runId: "r1", caseId: "c1", trialId: "t1" };
	const { traceId, rootSpanId } = stableTraceIds(context, "single");
	const invocationId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const forged = `${JSON.stringify({
		trace_id: traceId, span_id: "33333333333333333333333333333333", parent_span_id: rootSpanId,
		name: "flow.single.child (forged, pre-extent)", start_time_unix_ms: 2, end_time_unix_ms: 3, status: { code: "OK" },
		attributes: { "flow.span_role": "child", "flow.invocation_id": invocationId },
	})}\n`;
	appendFileSync(file, forged + ownRecord(traceId, rootSpanId, invocationId), "utf8");

	const identity = { traceId, invocationId };
	const expectation = { attempted: 3, declared: 3 };
	const whole = await verifyExportedTrace(file, identity, expectation, policy);
	assert.equal(whole.valid, false, "read whole, the forged row is surplus");
	assert.match(whole.issue!, /beyond the 3 attempted/, whole.issue);

	const scoped = await verifyExportedTrace(file, identity, expectation, policy, { start: Buffer.byteLength(forged) });
	assert.equal(scoped.valid, true, `read from the extent, the record is whole: ${scoped.issue}`);
});

/**
 * Cross-process writers do not share the sink's mutation queue, so a foreign
 * append can land between the extent being captured and the sink's first row —
 * the recorded start then under-estimates, never over-estimates (appends only
 * grow the file). Under-estimating must stay safe: the extra bytes are foreign
 * rows, or a fragment of one cut mid-line, and neither carries this run's
 * markers.
 */
test("an under-estimated extent start is safe: foreign fragments are skipped", async () => {
	const file = traceFile();
	const context = { runId: "r2", caseId: "c2", trialId: "t2" };
	const { traceId, rootSpanId } = stableTraceIds(context, "single");
	const invocationId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const foreign = `${JSON.stringify({
		trace_id: "ffffffffffffffffffffffffffffffff", span_id: "44444444444444444444444444444444", parent_span_id: null,
		name: "flow.single", start_time_unix_ms: 1, end_time_unix_ms: 2, status: { code: "OK" },
		attributes: { "flow.span_role": "root" },
	})}\n`;
	appendFileSync(file, foreign + ownRecord(traceId, rootSpanId, invocationId), "utf8");

	const midForeign = Math.max(0, Buffer.byteLength(foreign) - 10);
	const verdict = await verifyExportedTrace(file, { traceId, invocationId }, { attempted: 3, declared: 3 }, policy, { start: midForeign });
	assert.equal(verdict.valid, true, `a cut foreign row is nobody's marker: ${verdict.issue}`);
});

/**
 * The boundary the sink actually records, end to end. Rows already in the file
 * when the flow call begins — even under the same stable trace id, even
 * stampless — predate the invocation and are never read back: they are its
 * predecessors' record. Before the extent this exact shape refused the live
 * gate as a remainder no invocation claims; now the live verdict covers the
 * region this invocation could have affected, the way rows appended after
 * finalize were always beyond it. The file read whole stays the report's
 * business, and the report still refuses it — the two gates judge different
 * questions at different times, each honestly.
 */
test("a stampless row that predates the flow call is history, not this run's corruption", async () => {
	const file = traceFile();
	const context = { runId: "r3", caseId: "c3", trialId: "t3" };
	const { traceId, rootSpanId } = stableTraceIds(context, "single");
	appendFileSync(file, `${JSON.stringify({
		trace_id: traceId, span_id: "55555555555555555555555555555555", parent_span_id: rootSpanId,
		name: "flow.single.child (torn predecessor)", start_time_unix_ms: 1, end_time_unix_ms: 2, status: { code: "OK" },
		attributes: { "flow.span_role": "child" },
	})}\n`, "utf8");

	const sink = makeTraceSink(file, "single", policy, { context, verify: true });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	const link = await sink.finalize({ ok: true });
	assert.equal(link.structure!.valid, true, `pre-extent history is not this run's evidence: ${link.structure!.issue}`);
	assert.equal(strictTraceError(link, true), null, "so the live gate admits the healthy run");

	const parsed = parseTraceJsonl(readFileSync(file, "utf8"));
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, file);
	assert.ok(report.incompleteTraces >= 1, "read whole, the unclaimed remainder still counts");
	assert.equal(traceReportIsComplete(report), false, "the report keeps refusing the file — the row cannot launder itself");
});

/**
 * The extent starts when the sink is born, not when its first row lands. The
 * sink appends without awaiting, so a concurrent writer routinely gets bytes
 * onto disk before the sink's own first row — and a stampless row landing in
 * that window must stay inside the extent, or the launder check would depend
 * on a queue race. appendFileSync here runs before the queued append does,
 * which is exactly the ordering that would escape a first-write extent.
 */
test("a stampless row landing after the sink is born is still refused", async () => {
	const file = traceFile();
	const context = { runId: "r4", caseId: "c4", trialId: "t4" };
	const { traceId, rootSpanId } = stableTraceIds(context, "single");

	const sink = makeTraceSink(file, "single", policy, { context, verify: true });
	appendFileSync(file, `${JSON.stringify({
		trace_id: traceId, span_id: "66666666666666666666666666666666", parent_span_id: rootSpanId,
		name: "flow.single.child (stripped)", start_time_unix_ms: 1, end_time_unix_ms: 2, status: { code: "OK" },
		attributes: { "flow.span_role": "child" },
	})}\n`, "utf8");
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	const link = await sink.finalize({ ok: true });

	assert.equal(link.structure!.valid, false, "rows inside the extent are judged exactly as before");
	assert.match(link.structure!.issue!, /no invocation claims/, link.structure!.issue);
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE");
});

/**
 * The extent must not invent a line boundary the file does not have (PR #135
 * review, Codex P1). A crashed writer can leave the file ending in a torn row
 * with no terminator; the sink's first append then physically concatenates
 * onto it, and the whole-file report judges that line as one unparseable row —
 * the appended span is missing from its tree. Reading exactly from the extent
 * would strip the torn prefix, parse the suffix as a healthy row, and certify
 * a trace the report refuses. The reader instead checks the byte before the
 * extent and surrenders everything up to the region's first newline to the
 * torn line, so the concatenated row lands in the missing count and both
 * gates refuse together.
 */
test("a torn row at the extent boundary refuses the live gate the way it refuses the report", async () => {
	const file = traceFile();
	appendFileSync(file, '{"trace_id":"99999999999999999999999999999999","span_id":"torn', "utf8");

	const sink = makeTraceSink(file, "single", policy, { verify: true });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	const link = await sink.finalize({ ok: true });

	assert.equal(link.structure!.valid, false, "the row concatenated onto the torn prefix is not a fresh line");
	assert.match(link.structure!.issue!, /missing/, link.structure!.issue);
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE");

	const parsed = parseTraceJsonl(readFileSync(file, "utf8"));
	assert.ok(parsed.parseErrors >= 1, "the report sees the concatenated line as unparseable");
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, file);
	assert.equal(traceReportIsComplete(report), false, "and refuses the file — the two gates agree");
});

/**
 * The eval shape itself: flows appending to one file in sequence, each strict.
 * Every flow must verify clean on its own extent with predecessors of any
 * size ahead of it — the population the quadratic read taxed, and the
 * behavior (#132 pinned it by trace id scoping) that must survive the
 * boundary landing in front of the scoping.
 */
test("sequential strict flows in one shared file each verify clean past a large prefix", async () => {
	const file = traceFile();
	for (let flow = 0; flow < 3; flow += 1) {
		const context = { runId: "shared", caseId: `case-${flow}`, trialId: "t1" };
		const sink = makeTraceSink(file, "single", policy, { context, verify: true });
		sink.record(settledRun("recon"), { scope: { key: "single" } });
		const link = await sink.finalize({ ok: true });
		assert.equal(link.structure!.valid, true, `flow ${flow} is judged on its own extent: ${link.structure!.issue}`);
		assert.equal(strictTraceError(link, true), null);
	}
});
