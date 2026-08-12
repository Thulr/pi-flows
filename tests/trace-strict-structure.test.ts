// A strict run must not report evidence it never verified. Trace health is
// export accounting the writer knows while writing: it counts what the sink
// attempted against what reached the file, so a trace can be "recorded" and
// still not be a span tree. traceStructure() could always answer that question,
// but it had exactly one caller — the read-back report — and the strict gate's
// own refusal text sent readers there by hand. These tests pin that a strict
// finalize reads its own export back, and that an ordinary flow does not pay
// for it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTraceSink } from "../extensions/pi-flows/trace-sink.ts";
import { strictTraceError, traceEvidenceIssue } from "../extensions/pi-flows/trace.ts";
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
	const sink = makeTraceSink(file, "single", policy, undefined, undefined, true);
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

	const first = makeTraceSink(file, "single", policy, undefined, undefined, true);
	first.record(settledRun("recon"), { scope: { key: "single" } });
	const firstLink = await first.finalize({ ok: true });
	assert.equal(firstLink.structure!.valid, true);

	const second = makeTraceSink(file, "single", policy, undefined, undefined, true);
	second.record(settledRun("analyst"), { scope: { key: "single" } });
	const secondLink = await second.finalize({ ok: true });

	assert.notEqual(secondLink.traceId, firstLink.traceId, "two flows, two traces in one file");
	assert.equal(secondLink.structure!.valid, true, `the second flow is judged on its own rows, not the file: ${secondLink.structure!.issue}`);
	assert.equal(strictTraceError(secondLink, true), null, "and the strict gate admits it");
});
