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
