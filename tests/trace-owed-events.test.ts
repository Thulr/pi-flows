// Owed event kinds (#133): a mode declares beside its handler which
// coordination-event kinds that handler records by its own hand, the sink
// stamps the declaration on the root, and the read-back refuses a recorded
// kind the mode never declared the way it already refuses forged surplus.
//
// Four surfaces pin here: the mode table's declarations themselves, the sink's
// root stamp and minted-row marking, the reader (traceStructure /
// verifyExportedTrace / the strict report) judging events against the
// persisted declaration, and the four verdict events the handlers newly
// record (loop, debate, vote, search) — exercised through the same stub `pi`
// dispatch path the other mode/trace tests use. Corruption cases follow the
// trace-gate house rule: assert both that the fault is refused and that the
// counters which would normally notice were left looking healthy.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTraceSink } from "../extensions/pi-flows/trace-sink.ts";
import { verifyExportedTrace } from "../extensions/pi-flows/trace-verify.ts";
import { traceStructure } from "../extensions/pi-flows/trace-structure.ts";
import { formatTraceReport, parseTraceJsonl, strictTraceError, summarizeTraceSpans, traceReportIsComplete, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";
import { RUN_MODE_CONTRACTS, owedEventKindsForMode } from "../extensions/pi-flows/modes/contract.ts";
import { mintEvent, type CoordinationEventKind, type FlowRunResult, type RecordEvent } from "../extensions/pi-flows/types.ts";
import { runFlow } from "./stub-harness.ts";

const TRACE = "flow-trace.jsonl";
const policy = { recordContent: true, redactSecrets: true };

function sinkFile(): string {
	return path.join(mkdtempSync(path.join(tmpdir(), "pi-flow-owed-")), TRACE);
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

function readSinkSpans(file: string): TraceSpanRecord[] {
	return parseTraceJsonl(readFileSync(file, "utf8")).spans;
}

async function readRunSpans(stubDir: string): Promise<TraceSpanRecord[]> {
	return parseTraceJsonl(await readFile(path.join(stubDir, TRACE), "utf8")).spans;
}

const attr = (span: TraceSpanRecord | undefined, key: string) => span?.attributes?.[key];
const rootOf = (spans: TraceSpanRecord[]) => spans.find((span) => span.parent_span_id === null)!;
const eventsNamed = (spans: TraceSpanRecord[], name: string) => spans.filter((span) => attr(span, "flow.event_name") === name);

// ---------------------------------------------------------------------------
// The mode table's declarations
// ---------------------------------------------------------------------------

/**
 * The endorsed per-mode declarations from the #133 design. A mode added to the
 * table without an entry here fails by name below, so the declaration cannot
 * be waved through as whatever the author happened to type.
 */
const ENDORSED: Record<string, readonly CoordinationEventKind[]> = {
	single: [],
	parallel: [],
	chain: [],
	graph: [],
	dossier: [],
	evaluate: ["retry", "validation"],
	loop: ["retry", "validation"],
	orchestrate: ["retry", "validation"],
	vote: ["validation"],
	debate: ["validation"],
	search: ["validation"],
	route: ["state"],
	workflow: ["state"],
	worktree: ["state"],
	monitor: ["state"],
};

test("every run mode declares the endorsed owed event kinds on its contract", () => {
	for (const contract of RUN_MODE_CONTRACTS) {
		const expected = ENDORSED[contract.mode];
		assert.ok(
			expected !== undefined,
			`mode "${contract.mode}" has no endorsed owed-event-kinds entry in this test — decide its declaration and add it here`,
		);
		assert.deepEqual(
			[...contract.owedEventKinds].sort(),
			[...expected].sort(),
			`mode "${contract.mode}" declares ${JSON.stringify(contract.owedEventKinds)}`,
		);
	}
	assert.equal(RUN_MODE_CONTRACTS.length, Object.keys(ENDORSED).length, "every endorsed mode is still on the table");
});

test("owedEventKindsForMode resolves the declaration, empty included, and is undefined off the table", () => {
	assert.deepEqual([...owedEventKindsForMode("loop")!].sort(), ["retry", "validation"]);
	assert.deepEqual([...owedEventKindsForMode("vote")!], ["validation"]);
	assert.deepEqual([...owedEventKindsForMode("workflow")!], ["state"]);
	// A declaration of none is an answer, not an absence.
	assert.deepEqual([...owedEventKindsForMode("single")!], []);
	// The non-run surfaces are not on the table and make no declaration.
	assert.equal(owedEventKindsForMode("list"), undefined);
	assert.equal(owedEventKindsForMode("config"), undefined);
});

// ---------------------------------------------------------------------------
// The sink: root stamp and minted-row marking
// ---------------------------------------------------------------------------

test("the root stamps the declaration sorted, deduped, and comma-joined", async () => {
	const file = sinkFile();
	const sink = makeTraceSink(file, "loop", policy, { owedEventKinds: ["validation", "retry", "validation"] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	await sink.finalize({ ok: true });
	assert.equal(attr(rootOf(readSinkSpans(file)), "flow.trace.owed_event_kinds"), "retry,validation");
});

test("an empty declaration stamps the empty string; an absent one stamps nothing", async () => {
	// Presence with no kinds is a declaration of none; absence means a
	// pre-declaration writer. The empty string must survive the write — a helper
	// that drops empty strings would collapse the two.
	const declared = sinkFile();
	const declaredSink = makeTraceSink(declared, "single", policy, { owedEventKinds: [] });
	declaredSink.record(settledRun("recon"), { scope: { key: "single" } });
	await declaredSink.finalize({ ok: true });
	const declaredRoot = rootOf(readSinkSpans(declared));
	assert.equal("flow.trace.owed_event_kinds" in declaredRoot.attributes!, true, "the declared-empty root carries the attribute");
	assert.equal(declaredRoot.attributes!["flow.trace.owed_event_kinds"], "");

	const bare = sinkFile();
	const bareSink = makeTraceSink(bare, "single", policy);
	bareSink.record(settledRun("recon"), { scope: { key: "single" } });
	await bareSink.finalize({ ok: true });
	assert.equal("flow.trace.owed_event_kinds" in rootOf(readSinkSpans(bare)).attributes!, false, "no declaration, no attribute");
});

test("mintEvent and minted events carry flow.event_minted; hand-placed rows never do", async () => {
	const file = sinkFile();
	const sink = makeTraceSink(file, "single", policy);
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	mintEvent({ record: sink.mintedEvent, name: "gate.check", scope: { key: "gate" } }, { kind: "validation", ok: true, attributes: { "flow.gate.command": "npm test" } });
	sink.event({ kind: "validation", name: "hand.placed" });
	sink.mintedEvent({ kind: "approval", name: "seam.stamp", minted: true });
	await sink.finalize({ ok: true });
	const spans = readSinkSpans(file);

	const minted = eventsNamed(spans, "gate.check")[0];
	assert.equal(attr(minted, "flow.event_minted"), true, "mintEvent's one home stamps the flag");
	assert.equal(attr(minted, "flow.event_kind"), "validation");
	assert.equal(attr(eventsNamed(spans, "seam.stamp")[0], "flow.event_minted"), true, "a seam saying minted:true is stamped");
	// Omitted when falsy, never `false`: the flag exists only as the seam's
	// positive statement. `minted: false` is not a value the type admits at all —
	// the mode's door carries no minted member, and the seam's requires `true`.
	assert.equal("flow.event_minted" in eventsNamed(spans, "hand.placed")[0].attributes!, false, "a hand-placed event carries no stamp");
});

// ---------------------------------------------------------------------------
// Minting is the seam's capability, not a field or an attribute (PR #136)
// ---------------------------------------------------------------------------

test("a mode cannot mint by hand: the reserved attribute never reaches the row", async () => {
	// The forge direction, and the whole point of the declaration gate — a
	// handler recording a kind it never declared must not be able to excuse the
	// row with the seam's word for it. The minted claim itself is unreachable
	// from this door (it is not a member of the type `sink.event` accepts), so
	// the attribute below is the only forge a handler has left.
	const file = sinkFile();
	const sink = makeTraceSink(file, "loop", policy, { verify: true, owedEventKinds: ["retry"] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	sink.event({ kind: "state", name: "loop.smuggled", scope: { key: "smuggled" }, attributes: { "flow.event_minted": true } });
	const link = await sink.finalize({ ok: true });

	const smuggled = eventsNamed(readSinkSpans(file), "loop.smuggled")[0];
	assert.equal("flow.event_minted" in smuggled.attributes!, false, "the caller's attribute never reaches the row");
	assert.equal(link.structure!.valid, false, "so the read-back still refuses the undeclared kind");
	assert.match(link.structure!.issue!, /1 event span\(s\) of a kind the mode never declared/);
});

test("a seam's provenance survives a caller attribute that would erase it", async () => {
	// The erase direction. A healthy run must not be refused because a seam's own
	// attribution happened to carry the reserved key: the sink's fact wins in
	// both directions, not only when it is stamping.
	const file = sinkFile();
	const sink = makeTraceSink(file, "loop", policy, { verify: true, owedEventKinds: [] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	sink.mintedEvent({ kind: "approval", name: "seam.approval", minted: true, scope: { key: "approval" }, attributes: { "flow.event_minted": false } });
	const link = await sink.finalize({ ok: true });

	assert.equal(attr(eventsNamed(readSinkSpans(file), "seam.approval")[0], "flow.event_minted"), true, "the sink's stamp wins over the caller's value");
	assert.equal(link.structure!.valid, true, `a declared-none mode's seam events still certify: ${link.structure!.issue}`);
});

test("a caller attribute cannot rewrite the kind the declaration is judged against", async () => {
	// Recorded as `retry`, dressed as the declared `state`. Compliance is judged
	// on the kind the sink wrote, which is the kind the caller actually asked for.
	const file = sinkFile();
	const sink = makeTraceSink(file, "route", policy, { verify: true, owedEventKinds: ["state"] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	sink.event({ kind: "retry", name: "route.disguised", scope: { key: "disguised" }, attributes: { "flow.event_kind": "state" } });
	const link = await sink.finalize({ ok: true });

	assert.equal(attr(eventsNamed(readSinkSpans(file), "route.disguised")[0], "flow.event_kind"), "retry");
	assert.equal(link.structure!.valid, false, "the disguise buys no compliance");
	assert.match(link.structure!.issue!, /1 event span\(s\) of a kind the mode never declared/);
});

test("the minting door is not assignable to the mode-facing recorder", () => {
	const sink = makeTraceSink(sinkFile(), "single", policy);
	// The type-level half of the capability, enforced by `npm run typecheck`
	// rather than asserted in prose: parameters are contravariant under `strict`,
	// so a RecordMintedEvent cannot stand in for a RecordEvent — which is what
	// stops a mode-facing port from being wired to the minting door. Remove the
	// capability and this line compiles, failing the expectation instead.
	// @ts-expect-error RecordMintedEvent requires `minted: true` on its parameter, which a CoordinationEvent does not carry.
	const modeFacing: RecordEvent = sink.mintedEvent;
	assert.equal(typeof modeFacing, "function", "the runtime value is one implementation behind both doors");
});

// ---------------------------------------------------------------------------
// traceStructure: counting events against the persisted declaration
// ---------------------------------------------------------------------------

const ROOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fixtureTrace(rootExtra: Record<string, unknown>, events: Array<Record<string, unknown>>): TraceSpanRecord[] {
	return [
		{
			trace_id: "t1", span_id: ROOT_ID, parent_span_id: null, name: "flow.loop",
			start_time_unix_ms: 1, end_time_unix_ms: 100, status: { code: "OK" },
			attributes: { "flow.span_role": "root", "flow.mode": "loop", "flow.trace.expected_spans": events.length + 1, ...rootExtra },
		},
		...events.map((extra, index) => ({
			trace_id: "t1", span_id: `${"b".repeat(30)}${String(index).padStart(2, "0")}`, parent_span_id: ROOT_ID,
			name: "flow.loop.event.fixture", start_time_unix_ms: 50, end_time_unix_ms: 50, status: { code: "OK" },
			attributes: { "flow.span_role": "event", ...extra },
		})),
	] as unknown as TraceSpanRecord[];
}

const structureOf = (spans: TraceSpanRecord[]) => traceStructure(spans, { declared: spans.length, present: true });

test("an unminted event outside the declaration is counted; minted rows are the seams' and exempt", () => {
	const declared = { "flow.trace.owed_event_kinds": "retry,validation" };

	// Every hand-placed kind inside the declaration: nothing to count.
	const healthy = structureOf(fixtureTrace(declared, [{ "flow.event_kind": "validation" }, { "flow.event_kind": "retry" }]));
	assert.equal(healthy.undeclaredEvents, 0);
	assert.equal(healthy.invalid, false);

	// One hand-placed kind the mode never declared: counted, and counted as its
	// own category — a counter beside `invalid`, exactly like unexpectedSpans.
	const stray = structureOf(fixtureTrace(declared, [{ "flow.event_kind": "validation" }, { "flow.event_kind": "state" }]));
	assert.equal(stray.undeclaredEvents, 1);
	assert.equal(stray.invalid, false, "the count is a separate verdict, not a structural invalidation");

	// The same undeclared kind carrying the minted stamp is a seam's statement,
	// outside the mode's declaration by design.
	const seam = structureOf(fixtureTrace(declared, [{ "flow.event_kind": "state", "flow.event_minted": true }]));
	assert.equal(seam.undeclaredEvents, 0);
	assert.equal(seam.invalid, false);
});

test("an unminted event whose kind is missing cannot be checked and counts as undeclared", () => {
	// A stripped kind is corruption, not absence: the event cannot be judged
	// against the declaration, so it must not pass by being unjudgeable.
	const structure = structureOf(fixtureTrace({ "flow.trace.owed_event_kinds": "retry,validation" }, [{}]));
	assert.equal(structure.undeclaredEvents, 1);
});

test("a root with no declaration exempts the whole trace", () => {
	// A pre-declaration writer stamped nothing; its events predate the contract
	// and stay silent — fire on corruption, not on what a healthy legacy run
	// produced.
	const structure = structureOf(fixtureTrace({}, [{ "flow.event_kind": "state" }, { "flow.event_kind": "handoff" }]));
	assert.equal(structure.undeclaredEvents, 0);
	assert.equal(structure.invalid, false);
});

test("a declaration present but not a string invalidates the trace rather than exempting it", () => {
	// A stated declaration nothing can read is not an absent one — the same
	// presence-over-readability rule the expectation already follows.
	for (const unreadable of [7, null, true] as const) {
		const structure = structureOf(fixtureTrace({ "flow.trace.owed_event_kinds": unreadable }, [{ "flow.event_kind": "state" }]));
		assert.equal(structure.invalid, true, `declaration ${JSON.stringify(unreadable)} must invalidate`);
	}
	// The control: the same trace with a readable declaration is judged, not
	// refused, so the unreadability check above is the one doing the work.
	assert.equal(structureOf(fixtureTrace({ "flow.trace.owed_event_kinds": "state" }, [{ "flow.event_kind": "state" }])).invalid, false);
});

test("the empty declaration is a declaration of none, not an absent one", () => {
	const none = { "flow.trace.owed_event_kinds": "" };
	// A mode that declared none and hand-placed nothing: clean.
	const clean = structureOf(fixtureTrace(none, [{ "flow.event_kind": "approval", "flow.event_minted": true }]));
	assert.equal(clean.undeclaredEvents, 0);
	assert.equal(clean.invalid, false);
	// Under the same declaration any unminted event at all is one the mode's own
	// hand never owned up to.
	assert.equal(structureOf(fixtureTrace(none, [{ "flow.event_kind": "validation" }])).undeclaredEvents, 1);
});

// ---------------------------------------------------------------------------
// verifyExportedTrace: the strict read-back
// ---------------------------------------------------------------------------

test("a strict run refuses its own export when its handler recorded an undeclared kind", async () => {
	const file = sinkFile();
	const sink = makeTraceSink(file, "loop", policy, { verify: true, owedEventKinds: ["state"] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	sink.event({ kind: "retry", name: "loop.iterate", scope: { key: "iterate" } });
	const link = await sink.finalize({ ok: true });

	assert.equal(link.health, "recorded", "export accounting sees nothing wrong — the refusal is the reader's");
	assert.equal(link.structure!.valid, false);
	assert.match(link.structure!.issue!, /1 event span\(s\) of a kind the mode never declared/);
	assert.equal(strictTraceError(link, true)?.code, "TRACE_INCOMPLETE", "the strict gate refuses the run");
	// Evidence is never suppressed: the undeclared event was still WRITTEN, and
	// only the read-back refuses it.
	assert.equal(eventsNamed(readSinkSpans(file), "loop.iterate").length, 1);
});

test("a strict run whose hand-placed kinds sit inside the declaration certifies, seam events exempt", async () => {
	const file = sinkFile();
	const sink = makeTraceSink(file, "loop", policy, { verify: true, owedEventKinds: ["retry"] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	sink.event({ kind: "retry", name: "loop.iterate", scope: { key: "iterate" } });
	const link = await sink.finalize({ ok: true });

	assert.equal(link.structure!.valid, true, `expected a certified export, got: ${link.structure!.issue}`);
	// The sink's own certification event is kind "validation" — outside this
	// declaration — and passes because it carries the seam's minted stamp.
	const certification = eventsNamed(readSinkSpans(file), "trace.structure_verified")[0];
	assert.ok(certification, "the certification event reached the file");
	assert.equal(attr(certification, "flow.event_kind"), "validation");
	assert.equal(attr(certification, "flow.event_minted"), true, "the certification is the sink seam's own statement");
});

test("a rewritten or stripped root declaration is refused with both values named", async () => {
	const file = sinkFile();
	const sink = makeTraceSink(file, "route", policy, { owedEventKinds: ["state"] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	sink.event({ kind: "state", name: "route.selected", scope: { key: "selection" } });
	const link = await sink.finalize({ ok: true });
	const expected = link.spans!.expectedSpans;
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	const invocationId = String((JSON.parse(lines[0]) as TraceSpanRecord).attributes!["flow.invocation_id"]);
	const identity = { traceId: link.traceId!, invocationId };
	const expectation = { attempted: expected, declared: expected, owedEventKinds: "state" };

	// The pristine file verifies, so everything below is the check under test.
	assert.equal((await verifyExportedTrace(file, identity, expectation, policy)).valid, true);

	const rewriteRoot = (patch: (attributes: Record<string, unknown>) => void) => {
		writeFileSync(file, `${lines.map((line) => {
			const row = JSON.parse(line) as TraceSpanRecord;
			if (row.parent_span_id === null) patch(row.attributes as Record<string, unknown>);
			return JSON.stringify(row);
		}).join("\n")}\n`);
	};

	// Widened to bless kinds the run never declared: the structure above judged
	// the events against the persisted root, so without this check the rewrite
	// would pass. The fault names both sides.
	rewriteRoot((attributes) => { attributes["flow.trace.owed_event_kinds"] = "retry,state,validation"; });
	const widened = await verifyExportedTrace(file, identity, expectation, policy);
	assert.equal(widened.valid, false);
	assert.equal(widened.issue, 'the root now declares owed event kinds "retry,state,validation" where the run declared "state"');

	// Stripped entirely: absence exempts the structure count, so only the
	// rewrite check sees a declaration was removed.
	rewriteRoot((attributes) => { delete attributes["flow.trace.owed_event_kinds"]; });
	const stripped = await verifyExportedTrace(file, identity, expectation, policy);
	assert.equal(stripped.valid, false);
	assert.equal(stripped.issue, 'the root now declares owed event kinds (none) where the run declared "state"');
});

// ---------------------------------------------------------------------------
// The strict report
// ---------------------------------------------------------------------------

test("the strict report treats an undeclared-kind event as incomplete evidence", async () => {
	const file = sinkFile();
	const sink = makeTraceSink(file, "route", policy, { owedEventKinds: ["state"] });
	sink.record(settledRun("recon"), { scope: { key: "single" } });
	sink.event({ kind: "retry", name: "route.retry", scope: { key: "retry" } });
	const link = await sink.finalize({ ok: true });
	assert.equal(link.health, "recorded", "the writer's accounting stays healthy");

	const report = summarizeTraceSpans(readSinkSpans(file), 0, TRACE);
	assert.equal(report.undeclaredEvents, 1);
	assert.equal(report.structurallyInvalidTraces, 0, "the trace is a sound tree — the declaration is what it breaks");
	assert.equal(report.incompleteTraces, 1);
	assert.equal(traceReportIsComplete(report), false, "the strict report gate refuses");
	assert.match(formatTraceReport(report), /1 event span of a kind the mode never declared/);

	// The control: the same shape with the kind declared passes whole.
	const declared = sinkFile();
	const declaredSink = makeTraceSink(declared, "route", policy, { owedEventKinds: ["retry", "state"] });
	declaredSink.record(settledRun("recon"), { scope: { key: "single" } });
	declaredSink.event({ kind: "retry", name: "route.retry", scope: { key: "retry" } });
	await declaredSink.finalize({ ok: true });
	const declaredReport = summarizeTraceSpans(readSinkSpans(declared), 0, TRACE);
	assert.equal(declaredReport.undeclaredEvents, 0);
	assert.equal(traceReportIsComplete(declaredReport), true);
});

// ---------------------------------------------------------------------------
// The four newly recorded verdicts, through the real dispatch path
// ---------------------------------------------------------------------------

test("loop records its judge verdict where the stop decision is made", async () => {
	const { stubDir } = await runFlow(
		{ task: "draft release notes", traceFile: TRACE, loop: { body: { agent: "operator" }, judge: { agent: "redteam" }, maxIterations: 3 }, concurrency: 1 },
		{ operator: ["DRAFT_A", "DRAFT_B"], redteam: ["VERDICT: REVISE\nmissing migration note", "VERDICT: PASS\nok"] },
	);
	const spans = await readRunSpans(stubDir);
	const verdicts = eventsNamed(spans, "loop.judge_verdict");
	assert.equal(verdicts.length, 2, "one verdict per judged iteration");
	for (const verdict of verdicts) {
		assert.equal(attr(verdict, "flow.event_kind"), "validation");
		assert.equal("flow.event_minted" in verdict.attributes!, false, "the verdict is the mode's own hand, not a seam's");
	}
	const first = verdicts.find((span) => attr(span, "flow.verdict.iteration") === 1)!;
	const second = verdicts.find((span) => attr(span, "flow.verdict.iteration") === 2)!;
	assert.equal(attr(first, "flow.verdict.value"), "revise");
	assert.equal(first.status?.code, "ERROR", "a revise verdict is a failed check");
	assert.equal(attr(second, "flow.verdict.value"), "pass");
	assert.equal(second.status?.code, "OK");
	assert.equal(attr(first, "flow.verdict.fallback_used"), false);
	// The verdict hangs off the judge that produced it.
	assert.equal(attr(first, "flow.unit_key"), "iteration-1.verdict");
	assert.equal(attr(first, "flow.depends_on"), "iteration-1.judge");

	// The composition root wired the mode table's declaration onto the root, and
	// the newly recorded verdicts sit inside it: the whole trace passes the gate.
	assert.equal(attr(rootOf(spans), "flow.trace.owed_event_kinds"), "retry,validation");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("a loop judge whose output states no verdict records the fallback as a fallback", async () => {
	const { stubDir } = await runFlow(
		{ task: "draft docs", traceFile: TRACE, loop: { body: { agent: "operator" }, judge: { agent: "redteam" }, maxIterations: 1 }, concurrency: 1 },
		{ operator: "DRAFT_A", redteam: "looks fine to me" },
	);
	const spans = await readRunSpans(stubDir);
	const verdict = eventsNamed(spans, "loop.judge_verdict")[0];
	assert.ok(verdict, "the fallback decision is still a recorded decision");
	assert.equal(attr(verdict, "flow.verdict.value"), "revise", "parseVerdict's default");
	assert.equal(attr(verdict, "flow.verdict.fallback_used"), true, "and the record says the parse fell back");
	assert.equal(verdict.status?.code, "ERROR");
});

test("debate records the adjudicator's decision as its judge verdict", async () => {
	const { stubDir } = await runFlow(
		{
			task: "choose A or B",
			traceFile: TRACE,
			debate: { participants: [{ agent: "recon" }, { agent: "analyst" }], adjudicator: { agent: "debrief" }, rounds: 1 },
		},
		{ recon: "the case for A", analyst: "the case for B", debrief: "DECISION: A" },
	);
	const spans = await readRunSpans(stubDir);
	const verdict = eventsNamed(spans, "debate.judge_verdict")[0];
	assert.ok(verdict, "the adjudicated decision is recorded");
	assert.equal(attr(verdict, "flow.event_kind"), "validation");
	assert.equal("flow.event_minted" in verdict.attributes!, false);
	assert.equal(verdict.status?.code, "OK");
	assert.equal(attr(verdict, "flow.verdict.adjudicator"), "debrief");
	assert.equal(attr(verdict, "flow.verdict.rounds"), 1);
	assert.equal(attr(verdict, "flow.verdict.advocate_count"), 2);
	assert.equal(attr(verdict, "flow.unit_key"), "adjudicator.verdict");
	assert.equal(attr(verdict, "flow.depends_on"), "adjudicator");
	assert.equal(attr(rootOf(spans), "flow.trace.owed_event_kinds"), "validation");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("vote records its tally depending only on the ballots actually cast", async () => {
	const { stubDir } = await runFlow(
		{ task: "is this regex safe?", traceFile: TRACE, vote: { voters: [{ agent: "recon" }, { agent: "overwatch" }], debrief: { agent: "debrief" } } },
		{ recon: "YES", overwatch: "YES", debrief: "CONSENSUS_YES" },
	);
	const spans = await readRunSpans(stubDir);
	const tally = eventsNamed(spans, "vote.tally")[0];
	assert.ok(tally, "the tally is recorded at its one decision point");
	assert.equal(attr(tally, "flow.event_kind"), "validation");
	assert.equal("flow.event_minted" in tally.attributes!, false);
	assert.equal(tally.status?.code, "OK");
	assert.equal(attr(tally, "flow.verdict.voter_count"), 2);
	assert.equal(attr(tally, "flow.verdict.ballots_cast"), 2);
	assert.equal(attr(tally, "flow.verdict.failed_voters"), 0);
	assert.equal(attr(tally, "flow.unit_key"), "tally");
	assert.equal(attr(tally, "flow.depends_on"), "voter-1,voter-2");
	assert.equal(attr(rootOf(spans), "flow.trace.owed_event_kinds"), "validation");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("search records each round's parsed scores before the beam reorders them", async () => {
	const { stubDir } = await runFlow(
		{
			task: "pick a cache strategy",
			traceFile: TRACE,
			search: { generator: { agent: "recon" }, scorer: { agent: "debrief" }, debrief: { agent: "debrief" }, candidates: 2, beamWidth: 1, maxRounds: 1 },
			concurrency: 1,
		},
		{ recon: ["CANDIDATE_LOW", "CANDIDATE_HIGH"], debrief: ["SCORE: 20\nweak", "no score in this reply", "FINAL"] },
	);
	const spans = await readRunSpans(stubDir);
	const scores = eventsNamed(spans, "search.scores")[0];
	assert.ok(scores, "the round's scores are recorded where selection happens");
	assert.equal(attr(scores, "flow.event_kind"), "validation");
	assert.equal("flow.event_minted" in scores.attributes!, false);
	assert.equal(scores.status?.code, "OK", "one score parsed, so the round decided on evidence");
	assert.equal(attr(scores, "flow.verdict.round"), 1);
	// Candidate order, not beam order — aligned with the scorer keys it names —
	// and the unparseable scorer scored its candidate 0 and is counted as a
	// fallback.
	assert.equal(attr(scores, "flow.verdict.scores"), "20,0");
	assert.equal(attr(scores, "flow.verdict.fallback_count"), 1);
	assert.equal(attr(scores, "flow.verdict.beam_width"), 1);
	assert.equal(attr(scores, "flow.unit_key"), "round-1.scores");
	assert.equal(attr(scores, "flow.depends_on"), "round-1.score-1,round-1.score-2");
	// The event sits in the score stage beside the scorers it aggregates.
	const scoreStage = spans.find((span) => attr(span, "flow.stage_key") === "round-1.score")!;
	assert.equal(scores.parent_span_id, scoreStage.span_id);
	assert.equal(attr(rootOf(spans), "flow.trace.owed_event_kinds"), "validation");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});
