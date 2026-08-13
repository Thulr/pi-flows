// #127: stableTraceIds derives a trace id from the trace context and the mode
// so an eval row and its runtime trace correlate — which means the id is
// deliberately reusable, and two calls sharing both write into one file under
// one id. The live case is a project-preset refusal and the retry after it:
// the refusal's sink records the refusal on the caller's own trace settings,
// and the retry's strict read-back then saw two roots under its own id and
// refused TRACE_INCOMPLETE — a false refusal of a healthy run, in exactly the
// population (strict eval/release runs sharing PI_FLOWS_TRACE_FILE) that turns
// the gate on. These tests pin the fix: every row carries the sink's own
// random `flow.invocation_id`, and both readings — the runtime read-back and
// the report — judge each invocation only on its own rows, while the stable
// ids the eval linkage needs stay untouched.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTraceSink } from "../extensions/pi-flows/trace-sink.ts";
import { stableTraceIds } from "../extensions/pi-flows/trace-identity.mjs";
import { parseTraceJsonl, strictTraceError, summarizeTraceSpans, traceReportIsComplete } from "../extensions/pi-flows/trace.ts";
import type { FlowRunResult, FlowTraceContext, FlowTraceLink } from "../extensions/pi-flows/types.ts";

const policy = { recordContent: true, redactSecrets: true };

function traceFile(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "pi-flow-invocation-")), "flow-trace.jsonl");
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

/** What traceProjectPresetRefusal writes: a refusal event and a failed root on the caller's own trace settings, unverified. */
async function recordRefusal(file: string, context: FlowTraceContext): Promise<FlowTraceLink> {
	const sink = makeTraceSink(file, "single", policy, { context });
	sink.event({
		kind: "approval",
		name: "project_preset",
		ok: false,
		attributes: { "flow.approval.decision": "required", "flow.approval.interactive": false },
	});
	return sink.finalize({ ok: false }, { "flow.child_count": 0, "flow.refused_before_spawn": "PROJECT_PRESET_APPROVAL_REQUIRED" });
}

/**
 * The false refusal itself. A refusal and its retry share the trace context,
 * the mode, and the file, so they share a stable trace id — and before the
 * invocation scoping, the retry's read-back reported the refusal's root and
 * event as its own duplicates and surplus, failing work that succeeded.
 */
test("a retry after a traced refusal verifies clean under the shared stable trace id", async () => {
	const file = traceFile();
	const context = { runId: "r1", caseId: "c1", trialId: "t1" };
	const refusalLink = await recordRefusal(file, context);

	const retry = makeTraceSink(file, "single", policy, { context, verify: true });
	retry.record(settledRun("recon"), { scope: { key: "single" } });
	const retryLink = await retry.finalize({ ok: true });

	assert.equal(retryLink.traceId, refusalLink.traceId, "the stable id is shared — that correlation is the eval linkage and must survive");
	assert.equal(retryLink.rootSpanId, refusalLink.rootSpanId, "both roots answer to the stable root id for the same reason");
	assert.ok(refusalLink.invocationId && retryLink.invocationId, "each call names which rows are its own");
	assert.notEqual(retryLink.invocationId, refusalLink.invocationId, "with a discriminator distinct per call");
	assert.equal(retryLink.health, "recorded");
	assert.equal(retryLink.structure!.valid, true, `the retry is judged on its own rows alone: ${retryLink.structure!.issue}`);
	assert.equal(strictTraceError(retryLink, true), null, "so the strict gate admits the healthy run");
});

/**
 * The live gate and the report gate must accept by the same criteria. Grouped
 * by trace id alone, this file is two roots sharing a span id — duplicates and
 * an ambiguous root — so the report would refuse the very file whose runs both
 * verified. Split by invocation, it is two whole runs.
 */
test("the report judges each invocation of a shared trace id as its own run", async () => {
	const file = traceFile();
	const context = { runId: "r2", caseId: "c2", trialId: "t2" };
	await recordRefusal(file, context);
	const retry = makeTraceSink(file, "single", policy, { context, verify: true });
	retry.record(settledRun("recon"), { scope: { key: "single" } });
	assert.equal((await retry.finalize({ ok: true })).structure!.valid, true);

	const parsed = parseTraceJsonl(readFileSync(file, "utf8"));
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, file);
	assert.equal(report.traces, 2, "one stable trace id, two runs");
	assert.equal(report.duplicateSpans, 0, "the shared root span id is not a duplicate across runs");
	assert.equal(report.incompleteTraces, 0);
	assert.equal(report.structurallyInvalidTraces, 0);
	assert.equal(traceReportIsComplete(report), true, "the report gate admits what the live gate admitted");
});

/**
 * The scoping must not become a place for corruption to hide. A row under a
 * discriminated trace id that carries no invocation id is a row no run claims
 * — so it joins every invocation of that trace id, and whichever run it would
 * have corrupted when the rows were merged, it still corrupts when split.
 */
test("a row no invocation claims corrupts every invocation of its trace id", async () => {
	const file = traceFile();
	const context = { runId: "r3", caseId: "c3", trialId: "t3" };
	const { traceId, rootSpanId } = stableTraceIds(context, "single");
	await recordRefusal(file, context);
	const retry = makeTraceSink(file, "single", policy, { context, verify: true });
	retry.record(settledRun("recon"), { scope: { key: "single" } });
	await retry.finalize({ ok: true });

	const now = Date.now();
	appendFileSync(file, `${JSON.stringify({
		trace_id: traceId,
		span_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		parent_span_id: rootSpanId,
		name: "flow.single.child (unclaimed)",
		start_time_unix_ms: now,
		end_time_unix_ms: now,
		status: { code: "OK" },
		attributes: { "flow.span_role": "child" },
	})}\n`, "utf8");

	const parsed = parseTraceJsonl(readFileSync(file, "utf8"));
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, file);
	assert.equal(report.incompleteTraces, 2, "the unclaimed surplus row counts against both runs");
	assert.equal(traceReportIsComplete(report), false, "so stripping a discriminator cannot launder a row past the gate");
});

/**
 * A writer that predates the discriminator can share the stable id too — a
 * pre-upgrade refusal already in the file when a post-upgrade retry runs. Its
 * rows carry no stamp, but they declare their own root, so both gates judge
 * them as the whole run they are instead of as anyone's corruption. Refusing
 * the stamped run over them would be the same false refusal this fix closes,
 * surfacing at whichever gate reads the file next.
 */
test("a pre-discriminator co-tenant run fails neither the live gate nor the report", async () => {
	const file = traceFile();
	const context = { runId: "r4", caseId: "c4", trialId: "t4" };
	const { traceId, rootSpanId } = stableTraceIds(context, "single");
	// The shape the sink wrote before flow.invocation_id existed: a whole,
	// self-accounting trace — declared root, contained event, no stamps.
	const event = {
		trace_id: traceId,
		span_id: "abababababababababababababababab",
		parent_span_id: rootSpanId,
		name: "flow.single.event.approval.project_preset",
		start_time_unix_ms: 20,
		end_time_unix_ms: 20,
		status: { code: "ERROR" },
		attributes: { "flow.span_role": "event", "flow.event_kind": "approval", "flow.mode": "single" },
	};
	const root = {
		trace_id: traceId,
		span_id: rootSpanId,
		parent_span_id: null,
		name: "flow.single",
		start_time_unix_ms: 10,
		end_time_unix_ms: 30,
		status: { code: "ERROR" },
		attributes: { "flow.span_role": "root", "flow.mode": "single", "flow.execution_success": false, "flow.trace.expected_spans": 2, "flow.trace.observed_spans": 2 },
	};
	appendFileSync(file, `${JSON.stringify(event)}\n${JSON.stringify(root)}\n`, "utf8");

	const retry = makeTraceSink(file, "single", policy, { context, verify: true });
	retry.record(settledRun("recon"), { scope: { key: "single" } });
	const link = await retry.finalize({ ok: true });
	assert.equal(link.structure!.valid, true, `a whole unstamped run is not this run's corruption: ${link.structure!.issue}`);
	assert.equal(strictTraceError(link, true), null);

	const parsed = parseTraceJsonl(readFileSync(file, "utf8"));
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, file);
	assert.equal(report.traces, 2, "the unstamped run is its own run");
	assert.equal(report.incompleteTraces, 0);
	assert.equal(traceReportIsComplete(report), true, "and the report gate agrees with the live gate");
});

/**
 * The live half of the launder check: a stampless row that is not a whole run
 * counts against this run at the report, so the live gate must refuse it too —
 * certifying what the report rejects is the drift both gates exist to prevent.
 */
test("the live gate refuses a stampless remainder the report would count against it", async () => {
	const file = traceFile();
	const context = { runId: "r5", caseId: "c5", trialId: "t5" };
	const { traceId, rootSpanId } = stableTraceIds(context, "single");

	const sink = makeTraceSink(file, "single", policy, { context, verify: true });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	const now = Date.now();
	appendFileSync(file, `${JSON.stringify({
		trace_id: traceId,
		span_id: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
		parent_span_id: rootSpanId,
		name: "flow.single.child (stripped)",
		start_time_unix_ms: now,
		end_time_unix_ms: now,
		status: { code: "OK" },
		attributes: { "flow.span_role": "child" },
	})}\n`, "utf8");
	const link = await sink.finalize({ ok: true });

	assert.equal(link.structure!.valid, false, "rows no invocation claims are refused, not ignored");
	assert.match(link.structure!.issue!, /no invocation claims/, link.structure!.issue);
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE");
});

/** Every row the sink writes carries its stamp — the property the read-back's scoping stands on. */
test("every exported row carries the invocation id its link reports", async () => {
	const file = traceFile();
	const sink = makeTraceSink(file, "parallel", policy, { verify: true });
	sink.record(settledRun("recon"), { scope: { key: "a", stage: { key: "wave-1", name: "wave 1" } } });
	sink.event({ kind: "artifact", name: "note", attributes: {} });
	const link = await sink.finalize({ ok: true });

	const rows = parseTraceJsonl(readFileSync(file, "utf8")).spans;
	assert.ok(rows.length >= 4, "root, stage, child, event, certification");
	for (const row of rows) {
		assert.equal(row.attributes?.["flow.invocation_id"], link.invocationId, `row ${row.name} carries the invocation stamp`);
	}
});
