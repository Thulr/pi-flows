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
import { setTimeout as delay } from "node:timers/promises";
import { makeTraceSink } from "../extensions/pi-flows/trace-sink.ts";
import { reconcileVerdicts } from "../extensions/pi-flows/trace-verify.ts";
import { stableTraceIds } from "../extensions/pi-flows/trace-identity.mjs";
import { parseTraceJsonl, strictTraceError, summarizeTraceSpans, traceEvidenceIssue, traceReportIsComplete } from "../extensions/pi-flows/trace.ts";
import type { FlowRunResult } from "../extensions/pi-flows/types.ts";

const policy = { recordContent: true, redactSecrets: true };

function traceFile(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "pi-flow-strict-")), "flow-trace.jsonl");
}

/**
 * The read-back is scoped to the sink's own invocation id as well as its trace
 * id, so a row that should break this run's trace has to carry both — the
 * forged-identity residual the scoping cannot close. The id is random and
 * internal, and the sink appends without awaiting, so a test playing the forger
 * waits for a real row to land and reads the id off it.
 */
async function writtenInvocationId(file: string): Promise<string> {
	for (let tries = 0; tries < 400; tries += 1) {
		try {
			const line = readFileSync(file, "utf8").split("\n").find((row) => row.trim());
			const id = line ? (JSON.parse(line).attributes?.["flow.invocation_id"] as string | undefined) : undefined;
			if (id) return id;
		} catch {}
		await delay(5);
	}
	throw new Error("no sink row reached the trace file");
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
	assert.equal(traceEvidenceIssue(link), null, "best-effort callers stay gated only on export accounting");
	// But the strict gate enforces the public contract itself rather than
	// trusting the wiring that upholds it (flow.ts passes verify: traceStrict):
	// absent structure means unverified, and strict mode refuses to certify
	// what nothing read back.
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE", "strict refuses a link that was never read back");
	assert.equal(strictTraceError(link, false), null, "while best-effort passes it through");
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
	const { traceId } = stableTraceIds(context, "parallel");

	const sink = makeTraceSink(file, "parallel", policy, { context, verify: true });
	sink.record(settledRun("recon"), { scope: { key: "a" } });
	// Forge a row under this run's full identity — trace id and invocation id —
	// parented to a span that does not exist: the flow's own export will be
	// complete, and the trace it belongs to still will not hold together.
	writeFileSync(file, `${JSON.stringify({
		trace_id: traceId,
		span_id: "ffffffffffffffffffffffffffffffff",
		parent_span_id: "0000000000000000",
		name: "orphan",
		start_time_unix_ms: 1,
		end_time_unix_ms: 2,
		status: { code: "OK" },
		attributes: { "flow.span_role": "child", "flow.invocation_id": await writtenInvocationId(file) },
	})}\n`, { flag: "a" });
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

/**
 * The correction must not depend on the write that carries it. A disk that
 * filled after the root was written is exactly when the revocation append
 * fails too — and `append` is best-effort by design, so it swallows that. The
 * report therefore derives the verdict from the rows it can see, and counts no
 * verified outcome for a trace that does not hold together, revocation or not.
 */
test("an invalid trace is not a verified outcome even with no revocation event", () => {
	const rootSpanId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const spans = [
		{
			trace_id: "t1", span_id: rootSpanId, parent_span_id: null, name: "flow.parallel",
			start_time_unix_ms: 1, end_time_unix_ms: 100, status: { code: "OK" },
			attributes: { "flow.span_role": "root", "flow.mode": "parallel", "flow.outcome_verified": true, "flow.outcome_success": true, "flow.trace.expected_spans": 2 },
		},
		{
			trace_id: "t1", span_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", parent_span_id: "0000000000000000", name: "orphan",
			start_time_unix_ms: 2, end_time_unix_ms: 3, status: { code: "OK" },
			attributes: { "flow.span_role": "child", "flow.mode": "parallel" },
		},
	] as unknown as Parameters<typeof summarizeTraceSpans>[0];

	assert.equal(spans.some((span: any) => span.attributes["flow.trace.structure_revoked"]), false, "no revocation was written");
	assert.equal(summarizeTraceSpans(spans, 0, "t.jsonl").verifiedOutcomes, 0, "the rows alone are enough to withhold the claim");
});

/**
 * The case the negative correction could not cover. A rewritten
 * `flow.trace.expected_spans` leaves the rows themselves a perfectly consistent
 * tree, so a reader cannot see the fault — only the run that wrote them knows
 * what it attempted. If the append carrying that knowledge fails, nothing
 * durable records it. So a strict root declares its claims contingent and the
 * reader withholds them without positive certification: every way the
 * certification can fail to arrive reads as unverified, not as verified.
 */
test("a strict root's claim is withheld when no certification arrives", () => {
	const rootSpanId = "cccccccccccccccccccccccccccccccc";
	const strictRoot = (extra: Record<string, unknown>) => ({
		trace_id: "t2", span_id: rootSpanId, parent_span_id: null, name: "flow.parallel",
		start_time_unix_ms: 1, end_time_unix_ms: 100, status: { code: "OK" },
		attributes: {
			"flow.span_role": "root", "flow.mode": "parallel",
			"flow.outcome_verified": true, "flow.outcome_success": true,
			"flow.trace.expected_spans": 2, "flow.trace.verification_pending": true,
			...extra,
		},
	});
	const certification = {
		trace_id: "t2", span_id: "dddddddddddddddddddddddddddddddd", parent_span_id: rootSpanId,
		name: "flow.parallel.event.trace.structure_verified",
		start_time_unix_ms: 50, end_time_unix_ms: 50, status: { code: "OK" },
		attributes: { "flow.span_role": "event", "flow.event_kind": "validation", "flow.trace.structure_verified": true },
	};
	const summarize = (spans: unknown[]) => summarizeTraceSpans(spans as Parameters<typeof summarizeTraceSpans>[0], 0, "t.jsonl").verifiedOutcomes;

	// Without the certification the trace is also one row short of its
	// declaration — withheld twice over, by the pending clause and by
	// completeness.
	assert.equal(summarize([strictRoot({})]), 0, "no certification: the contingent claim is not honoured");
	assert.equal(summarize([strictRoot({}), certification]), 1, "certified: the claim stands");
});

/**
 * The certification is itself a row, written after the root froze its span
 * accounting. Unless the root reserves its slot, every healthy strict trace
 * reads back with one span beyond the declared count — and the strict report
 * gate (`npm run trace:report -- --strict`, the release-trace gate) rejects
 * exactly the traces that verified clean. The event's own shape matters the
 * same way: a partial dependency attribute reads as corruption to
 * `dependenciesHold`, so a malformed certification would invalidate the very
 * tree it certifies.
 */
test("a verified strict trace passes the read-back report whole", async () => {
	const file = traceFile();
	const sink = makeTraceSink(file, "parallel", policy, { verify: true });
	sink.record(settledRun("recon"), { scope: { key: "a" } });
	sink.record(settledRun("analyst"), { scope: { key: "b" } });
	const link = await sink.finalize({ ok: true }, { "flow.outcome_verified": true, "flow.outcome_success": true });
	assert.equal(link.structure!.valid, true, `the run itself verified: ${link.structure!.issue}`);

	const parsed = parseTraceJsonl(readFileSync(file, "utf8"));
	// The persisted root and the returned link carry the same counters — the
	// documented contract (flow-reference) — so an OTel consumer reading the
	// attributes sees no false missing-span signal for a trace that verified.
	const root = parsed.spans.find((span) => span.parent_span_id === null)!;
	assert.equal(root.attributes!["flow.trace.expected_spans"], link.spans!.expectedSpans, "root and link agree on expected");
	assert.equal(root.attributes!["flow.trace.observed_spans"], link.spans!.observedSpans, "root and link agree on observed");
	assert.equal(root.attributes!["flow.trace.observed_spans"], root.attributes!["flow.trace.expected_spans"], "and a healthy trace observes what it declared");
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, file);
	assert.equal(report.verifiedOutcomes, 1, "the certified claim is honoured");
	assert.equal(report.incompleteTraces, 0, "no surplus row and no broken dependency shape");
	assert.equal(traceReportIsComplete(report), true, "and the strict report gate admits the trace the runtime admitted");
});

/**
 * The verifier and the report must accept by the same criteria, or the live
 * gate certifies evidence the downstream gate rejects. A surplus row — a
 * concurrent writer forging this run's trace and invocation ids — leaves the
 * tree connected and contained, so `structure.invalid` stays false; only
 * `unexpectedSpans` sees it, and the report refuses on that field. The
 * verifier has to as well.
 */
test("a surplus row forging this run's identity fails verification, not just the report", async () => {
	const file = traceFile();
	const context = { runId: "r2", caseId: "c2", trialId: "t2" };
	const { rootSpanId } = stableTraceIds(context, "single");
	const traceId = stableTraceIds(context, "single").traceId;

	const sink = makeTraceSink(file, "single", policy, { context, verify: true });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	// A well-formed, connected, contained row this run never wrote, appended by
	// a concurrent writer forging both halves of its identity — the residual
	// the invocation scoping cannot close, so the count has to.
	const now = Date.now();
	writeFileSync(file, `${JSON.stringify({
		trace_id: traceId,
		span_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		parent_span_id: rootSpanId,
		name: "flow.single.child (foreign)",
		start_time_unix_ms: now,
		end_time_unix_ms: now,
		status: { code: "OK" },
		attributes: { "flow.span_role": "child", "flow.invocation_id": await writtenInvocationId(file) },
	})}\n`, { flag: "a" });

	const link = await sink.finalize({ ok: true });
	assert.equal(link.structure!.valid, false, "rows the run never claimed are not its evidence");
	// The preliminary reading found the surplus, and under reconcileVerdicts a
	// preliminary failure takes precedence over the final reading — so the fault
	// names the pre-certification yardstick. The final reading's own verdict
	// only surfaces when the preliminary passed and the file then changed,
	// which only I/O faults can produce; its precedence rule is pinned as the
	// pure function instead.
	assert.match(link.structure!.issue!, /beyond the 2 attempted/, link.structure!.issue);
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE", "so the live gate refuses what the report gate would");
});

/**
 * A certification is not a waiver of completeness. A certified trace that
 * later gains a surplus row (or loses one) is still a connected tree, so
 * `structure.invalid` stays false — but the report already refuses the trace
 * as incomplete, and a verified-outcome count that disagreed with that would
 * credit metrics with evidence the same report rejected.
 */
test("a certified trace that went incomplete afterwards is not a verified outcome", () => {
	const rootSpanId = "abababababababababababababababab";
	const spans = [
		{
			trace_id: "t3", span_id: rootSpanId, parent_span_id: null, name: "flow.single",
			start_time_unix_ms: 1, end_time_unix_ms: 100, status: { code: "OK" },
			attributes: {
				"flow.span_role": "root", "flow.mode": "single",
				"flow.outcome_verified": true, "flow.outcome_success": true,
				"flow.trace.expected_spans": 2, "flow.trace.verification_pending": true,
			},
		},
		{
			trace_id: "t3", span_id: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd", parent_span_id: rootSpanId,
			name: "flow.single.event.trace.structure_verified",
			start_time_unix_ms: 50, end_time_unix_ms: 50, status: { code: "OK" },
			attributes: { "flow.span_role": "event", "flow.event_kind": "validation", "flow.trace.structure_verified": true },
		},
		{
			trace_id: "t3", span_id: "efefefefefefefefefefefefefefefef", parent_span_id: rootSpanId,
			name: "surplus", start_time_unix_ms: 60, end_time_unix_ms: 60, status: { code: "OK" },
			attributes: { "flow.span_role": "child" },
		},
	] as unknown as Parameters<typeof summarizeTraceSpans>[0];

	const report = summarizeTraceSpans(spans, 0, "t.jsonl");
	assert.equal(report.incompleteTraces, 1, "the surplus row makes the trace incomplete");
	assert.equal(report.verifiedOutcomes, 0, "and incomplete evidence supports no verified outcome, certification or not");
});

/**
 * The two readings can disagree only through transient I/O — a read error that
 * clears between them — which nothing in-process can fake deterministically,
 * so the precedence rule is pinned as the pure function the sink wires in. A
 * preliminary failure is already durable as a revocation; a live verdict that
 * overturned it would pass a run whose trace every later reader withholds.
 */
test("a preliminary failure is never overturned by a recovering final reading", () => {
	const failed = { valid: false, issue: "the trace could not be read back: transient" };
	const recovered = { valid: true };
	assert.deepEqual(reconcileVerdicts(failed, recovered), failed, "the durable revocation wins");
	assert.deepEqual(reconcileVerdicts({ valid: true }, failed), failed, "while a final failure stands on its own");
	assert.deepEqual(reconcileVerdicts({ valid: true }, recovered), recovered, "and agreement passes through");
});

/**
 * When the final reading fails after a positive certification landed, the sink
 * appends a best-effort revocation. Its durability is double: the flag itself,
 * and — should a reader somehow miss it — its bare presence as one row past
 * the declared count. Both directions pin here: revocation beats
 * certification, and the surplus alone already withholds.
 */
test("a revocation after a certification withholds the claim twice over", () => {
	const rootSpanId = "fafafafafafafafafafafafafafafafa";
	const root = {
		trace_id: "t4", span_id: rootSpanId, parent_span_id: null, name: "flow.single",
		start_time_unix_ms: 1, end_time_unix_ms: 100, status: { code: "OK" },
		attributes: {
			"flow.span_role": "root", "flow.mode": "single",
			"flow.outcome_verified": true, "flow.outcome_success": true,
			"flow.trace.expected_spans": 2, "flow.trace.verification_pending": true,
		},
	};
	const event = (id: string, verified: boolean) => ({
		trace_id: "t4", span_id: id, parent_span_id: rootSpanId,
		name: `flow.single.event.trace.${verified ? "structure_verified" : "structure_invalid"}`,
		start_time_unix_ms: 50, end_time_unix_ms: 50, status: { code: verified ? "OK" : "ERROR" },
		attributes: { "flow.span_role": "event", "flow.event_kind": "validation", ...(verified ? { "flow.trace.structure_verified": true } : { "flow.trace.structure_revoked": true }) },
	});
	const spans = [root, event("12121212121212121212121212121212", true), event("3434343434343434343434343434343434".slice(0, 32), false)] as unknown as Parameters<typeof summarizeTraceSpans>[0];

	const report = summarizeTraceSpans(spans, 0, "t.jsonl");
	assert.equal(report.verifiedOutcomes, 0, "the revocation wins over the surviving certification");
	assert.equal(report.incompleteTraces, 1, "and the extra row alone already makes the trace incomplete");
});
