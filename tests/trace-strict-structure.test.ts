// A strict run must not report evidence it never verified. Trace health is
// export accounting the writer knows while writing: it counts what the sink
// attempted against what reached the file, so a trace can be "recorded" and
// still not be a span tree. traceStructure() could always answer that question,
// but it had exactly one caller — the read-back report — and the strict gate's
// own refusal text sent readers there by hand. These tests pin that a strict
// finalize reads its own export back, and that an ordinary flow does not pay
// for it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTraceSink } from "../extensions/pi-flows/trace-sink.ts";
import { stableTraceIds } from "../extensions/pi-flows/trace-identity.mjs";
import { parseTraceJsonl, strictTraceError, summarizeTraceSpans, traceEvidenceIssue } from "../extensions/pi-flows/trace.ts";
import type { FlowRunResult } from "../extensions/pi-flows/types.ts";

const policy = { recordContent: true, redactSecrets: true };

function traceFile(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "pi-flow-strict-")), "flow-trace.jsonl");
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

test("a verified strict export reports a valid structure and passes the gate", async () => {
	const file = traceFile();
	const sink = makeTraceSink(file, "single", policy, { verify: true });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	const link = await sink.finalize({ ok: true });

	assert.equal(link.health, "recorded");
	assert.ok(link.structure, "a strict run reads its export back, so the verdict is present");
	assert.equal(link.structure!.valid, true, `expected a span tree, got: ${link.structure!.issue}`);
	assert.equal(traceEvidenceIssue(link), null);
	assert.equal(strictTraceError(link, true), null);
});

test("an ordinary flow is not charged for the read-back", async () => {
	const file = traceFile();
	const sink = makeTraceSink(file, "single", policy);
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	const link = await sink.finalize({ ok: true });

	assert.equal(link.health, "recorded");
	assert.equal(link.structure, undefined, "absent means unverified, never verified-fine");
	assert.equal(strictTraceError(link, false), null, "and best-effort tracing still never gates");
});

/**
 * The gap this closes, pinned at the gate. Corruption that lands after a
 * successful write is invisible to the writer's accounting — every span it
 * attempted reached the file — so `health` stays `recorded` and the old gate
 * passed a trace no reader can follow. Asserted here against a link rather
 * than by corrupting a file mid-write, because the sink reads back exactly
 * once, immediately after writing its own root: there is no deterministic
 * moment for a test to damage that trace in between.
 */
test("a trace that exported completely but is not a span tree is refused", () => {
	const link = {
		health: "recorded" as const,
		traceFile: "~/flow-trace.jsonl",
		traceId: "abc",
		rootSpanId: "def",
		spans: { expectedSpans: 3, observedSpans: 3, droppedSpans: 0, redactedSpans: 0, failedExports: 0 },
		structure: { valid: false, issue: "1 span(s) not reaching the root or outside its interval", danglingLinks: 0 },
	};

	const issue = traceEvidenceIssue(link);
	assert.match(issue!, /exported completely but is not a readable span tree/, issue ?? "expected a structural refusal");
	assert.match(issue!, /not reaching the root/, "and it names the fault the reading found");
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE");
	assert.equal(strictTraceError(link, false), null, "while a best-effort run is unaffected");
});

test("an unverified link is not treated as a verified one", () => {
	const link = {
		health: "recorded" as const,
		traceFile: "~/flow-trace.jsonl",
		traceId: "abc",
		rootSpanId: "def",
		spans: { expectedSpans: 3, observedSpans: 3, droppedSpans: 0, redactedSpans: 0, failedExports: 0 },
	};
	assert.equal(traceEvidenceIssue(link), null, "a run that never asked for a read-back is still gated only on export accounting");
});

/**
 * One JSONL file routinely holds many flows — an eval sets PI_FLOWS_TRACE_FILE
 * once for a whole run — so a read-back that validated the file whole would
 * judge every flow after the first against its predecessors' rows and refuse it
 * for a surplus that is someone else's trace. Strict runs are exactly the
 * population that shares a trace file, so this is the case that matters most.
 */
test("flows sharing one trace file each verify only their own trace", async () => {
	const file = traceFile();

	const first = makeTraceSink(file, "single", policy, { verify: true });
	first.record(settledRun("recon"), { scope: { key: "single" } });
	const firstLink = await first.finalize({ ok: true });
	assert.equal(firstLink.structure!.valid, true);

	const second = makeTraceSink(file, "single", policy, { verify: true });
	second.record(settledRun("analyst"), { scope: { key: "single" } });
	const secondLink = await second.finalize({ ok: true });

	assert.notEqual(secondLink.traceId, firstLink.traceId, "two flows, two traces in one file");
	assert.equal(secondLink.structure!.valid, true, `the second flow is judged on its own rows, not the file: ${secondLink.structure!.issue}`);
	assert.equal(strictTraceError(secondLink, true), null, "and the strict gate admits it");
});

/**
 * The root is written before the export can be read back, so a strict run that
 * fails verification has already claimed `flow.outcome_verified` on disk. An
 * exported span is immutable, so the correction arrives the way a revoked
 * budget wrap-up's does — a linked event the reader applies. Without it a
 * report would keep counting a run the gate refused as a verified outcome.
 */
test("a failed verification revokes the root's verified-outcome claim", async () => {
	const file = traceFile();
	const context = { runId: "r1", caseId: "c1", trialId: "t1" };
	// Seed a row under the id this sink will use, parented to a span that does
	// not exist: the flow's own export will be complete, and the trace it belongs
	// to still will not hold together.
	const { traceId } = stableTraceIds(context, "parallel");
	writeFileSync(file, `${JSON.stringify({
		trace_id: traceId,
		span_id: "ffffffffffffffffffffffffffffffff",
		parent_span_id: "0000000000000000",
		name: "orphan",
		start_time_unix_ms: 1,
		end_time_unix_ms: 2,
		status: { code: "OK" },
		attributes: { "flow.span_role": "child" },
	})}\n`);

	const sink = makeTraceSink(file, "parallel", policy, { context, verify: true });
	sink.record(settledRun("recon"), { scope: { key: "a" } });
	const link = await sink.finalize({ ok: true }, { "flow.outcome_verified": true, "flow.outcome_success": true });

	assert.equal(link.structure!.valid, false, `expected the seeded orphan to break the tree: ${link.structure!.issue}`);
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE", "the gate refuses the run");

	const parsed = parseTraceJsonl(readFileSync(file, "utf8"));
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, file);
	assert.equal(report.verifiedOutcomes, 0, "and the report no longer counts it as a verified outcome");
	assert.ok(
		parsed.spans.some((span) => span.attributes?.["flow.trace.structure_revoked"] === true),
		"because the revocation is on the trace, linked to the root the gate could not unsay",
	);
});
