// Reading a trace back: does this file hold together well enough to gate a
// release on?
//
// Structural validation and the strict gate, exercised against traces a real run
// wrote and then corrupted in one specific way each. Every case asserts both
// halves of the gate's job — that the corruption is refused, and that the
// counters which would normally notice were left looking healthy, so the check
// under test is the one doing the work.
//
// What a span says about itself lives in trace-evidence.test.ts; the span tree
// it hangs on lives in trace-topology.test.ts.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatTraceReport, makeTraceSink, parseTraceJsonl, summarizeTraceSpans, traceReportIsComplete, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";
import { constraintIdentifiers, promptVersion } from "../extensions/pi-flows/trace-attributes.ts";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { discoverFlowAgents } from "../extensions/pi-flows/agents.ts";
import type { DelegationContract } from "../extensions/pi-flows/types.ts";
import { freshDir, runFlow } from "./stub-harness.ts";

const TRACE = "flow-trace.jsonl";

async function readSpans(stubDir: string): Promise<TraceSpanRecord[]> {
	const text = await readFile(path.join(stubDir, TRACE), "utf8");
	return parseTraceJsonl(text).spans;
}

const role = (span: TraceSpanRecord) => span.attributes?.["flow.span_role"];
const byRole = (spans: TraceSpanRecord[], want: string) => spans.filter((span) => role(span) === want);
const unit = (spans: TraceSpanRecord[], key: string) => spans.find((span) => span.attributes?.["flow.unit_key"] === key);
const attr = (span: TraceSpanRecord | undefined, key: string) => span?.attributes?.[key];

const contract: DelegationContract = {
	objective: "Return a bounded finding.",
	constraints: ["Do not write files.", "Cite every claim."],
	nonGoals: ["Refactoring"],
	dependencies: [],
	authority: { may: ["read repository files"], mustNot: ["push to a remote"], requiresApproval: ["install packages"] },
	sideEffectClass: "read-only",
	budget: { maxCostUsd: 0.5 },
	acceptanceChecks: ["Answer names a file path."],
	returnSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false },
	owner: "parent",
};

const envelope = (data: unknown = { answer: "package.json" }, overrides: Record<string, unknown> = {}) => JSON.stringify({
	schemaVersion: "pi-flows.return-envelope.v1",
	contractId: delegationContractId(contract),
	status: "completed",
	summary: "Found it.",
	evidence: [{ claim: "answer is in package.json", source: "package.json" }],
	artifactReferences: [],
	digests: [],
	changedState: [],
	unresolvedQuestions: [],
	retry: { retryable: false },
	data,
	...overrides,
});test("trace health counts expected against observed spans and the report surfaces the gap", async () => {
	const { stubDir, result } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const link = result.details.trace!;
	assert.equal(link.health, "recorded");
	const spans = await readSpans(stubDir);
	assert.equal(link.spans!.expectedSpans, spans.length);
	assert.equal(link.spans!.observedSpans, spans.length);
	assert.equal(link.spans!.droppedSpans, 0);

	const clean = summarizeTraceSpans(spans, 0, TRACE);
	assert.equal(clean.incompleteTraces, 0);
	assert.equal(traceReportIsComplete(clean), true);
	assert.match(formatTraceReport(clean), /Trace health: \d+\/\d+ spans observed/);

	// Loss after the write still shows up: the root span declares how many rows
	// the run exported, so a truncated file cannot read as a complete one.
	const truncated = summarizeTraceSpans(spans.filter((span) => role(span) !== "event"), 0, TRACE);
	assert.ok(truncated.droppedSpans > 0, "dropping rows must register as dropped spans");
	assert.equal(truncated.incompleteTraces, 1);
	assert.equal(traceReportIsComplete(truncated), false);
});

test("a report of zero runs is not evidence a strict gate can rest on", async () => {
	const { stubDir } = await runFlow({ agent: "recon", task: "inspect", traceFile: TRACE }, { recon: "done" });
	const real = summarizeTraceSpans(await readSpans(stubDir), 0, TRACE);
	assert.equal(traceReportIsComplete(real), true);

	// An empty file, and a file of well-formed rows that belong to no trace, both
	// have nothing incomplete in them precisely because they have nothing in them.
	for (const spans of [[], [{ name: "not-a-span" }, { attributes: { "flow.mode": "parallel" } }]]) {
		const empty = summarizeTraceSpans(spans as TraceSpanRecord[], 0, TRACE);
		assert.equal(empty.traces, 0);
		assert.equal(empty.incompleteTraces, 0);
		assert.equal(traceReportIsComplete(empty), false, "a release gate must not pass on an artifact nobody wrote");
	}
});

test("a malformed trace row is counted, not fatal", () => {
	// `null` parses fine and is not a span; pushing it made the summarizer
	// dereference it and take down the whole report.
	const parsed = parseTraceJsonl(`null\n[1,2]\n"text"\n{"trace_id":"a","parent_span_id":null,"attributes":{"flow.mode":"single"}}\nnot json\n`);
	assert.equal(parsed.spans.length, 1);
	assert.equal(parsed.parseErrors, 4);
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, TRACE);
	assert.equal(report.traces, 1);
	assert.equal(traceReportIsComplete(report), false, "parse errors leave the report incomplete");
});

test("a duplicated span cannot conceal a dropped one", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	assert.equal(summarizeTraceSpans(spans, 0, TRACE).incompleteTraces, 0);

	// Lose one row and duplicate another: the row count still matches what the
	// root said to expect, so a length-based check would call this trace whole.
	const children = spans.filter((span) => role(span) === "child");
	const corrupted = [...spans.filter((span) => span !== children[1]), children[0]];
	assert.equal(corrupted.length, spans.length, "the corruption is invisible to a row count");
	const report = summarizeTraceSpans(corrupted, 0, TRACE);
	assert.equal(report.duplicateSpans, 1);
	assert.ok(report.droppedSpans > 0, "the missing span must still register as dropped");
	assert.equal(report.incompleteTraces, 1);
	assert.equal(traceReportIsComplete(report), false);
	assert.match(formatTraceReport(report), /1 duplicated/);

	// The same substitution with an id-less row: it keeps the row count intact and
	// is unusable as evidence, so counting it would let it stand in for the span
	// that went missing.
	const stripped = [...spans.filter((span) => span !== children[1]), { trace_id: children[1].trace_id }];
	assert.equal(stripped.length, spans.length);
	const strippedReport = summarizeTraceSpans(stripped, 0, TRACE);
	assert.equal(strippedReport.malformedSpans, 1);
	assert.ok(strippedReport.droppedSpans > 0);
	assert.equal(traceReportIsComplete(strippedReport), false);
	assert.match(formatTraceReport(strippedReport), /1 unidentifiable/);
});

test("a row stripped of its trace id cannot vanish from the evidence gate", async () => {
	const { stubDir } = await runFlow({ agent: "recon", task: "inspect", traceFile: TRACE }, { recon: "done" });
	const spans = await readSpans(stubDir);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);

	// A second run whose ids were stripped used to disappear entirely, leaving the
	// surviving run to pass the gate on its own.
	const orphaned = [...spans, ...spans.map((span) => ({ ...span, trace_id: undefined }))];
	const report = summarizeTraceSpans(orphaned, 0, TRACE);
	assert.equal(report.traces, 1, "the stripped rows belong to no run");
	assert.equal(report.malformedSpans, spans.length);
	assert.equal(traceReportIsComplete(report), false, "unusable rows must not be silently discarded");
	assert.match(formatTraceReport(report), new RegExp(`${spans.length} unidentifiable`));
});

test("a new-format trace with its expectation stripped is incomplete, not self-consistent", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);

	// Lose a child AND the counter that would have revealed it: the survivors are
	// perfectly self-consistent, which is exactly the state a gate must not accept.
	const child = spans.find((span) => role(span) === "child")!;
	const stripped = spans.filter((span) => span !== child).map((span) => {
		if (span.parent_span_id !== null) return span;
		const { "flow.trace.expected_spans": _lost, ...rest } = span.attributes!;
		return { ...span, attributes: rest };
	});
	const report = summarizeTraceSpans(stripped, 0, TRACE);
	assert.equal(report.droppedSpans, 0, "with the counter gone there is nothing left to compare against");
	assert.equal(report.incompleteTraces, 1, "a sink-written root always stamps its expectation, so a missing one is loss");
	assert.equal(traceReportIsComplete(report), false);

	// A trace written before span roles existed has no expectation to lose, so the
	// row-count fallback still applies and it is readable as before.
	const legacy = stripped.map(({ attributes, ...span }) => {
		const { "flow.span_role": _role, ...rest } = attributes!;
		return { ...span, attributes: rest };
	});
	assert.equal(summarizeTraceSpans(legacy, 0, TRACE).incompleteTraces, 0);
});

test("the strict gate validates its own inputs, not just the spans they describe", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	const withRoot = (expected: unknown) => spans.map((span) =>
		span.parent_span_id === null ? { ...span, attributes: { ...span.attributes, "flow.trace.expected_spans": expected } } : span);

	// A count that cannot be a count: zero would report nothing dropped no matter
	// how many spans the file holds, and the others are not counts at all.
	for (const corrupt of [0, -3, 2.5, "7"]) {
		const report = summarizeTraceSpans(withRoot(corrupt) as TraceSpanRecord[], 0, TRACE);
		assert.equal(traceReportIsComplete(report), false, `expected_spans ${JSON.stringify(corrupt)} must not pass the gate`);
	}
	assert.equal(traceReportIsComplete(summarizeTraceSpans(withRoot(spans.length) as TraceSpanRecord[], 0, TRACE)), true);

	// Two parentless rows: every number below is derived from whichever is read
	// first, so the shape is reported as corrupt rather than silently picked.
	const secondRoot = { ...spans[0], span_id: "second-root", parent_span_id: null, attributes: { "flow.mode": "parallel" } };
	const ambiguous = summarizeTraceSpans([secondRoot, ...spans] as TraceSpanRecord[], 0, TRACE);
	assert.equal(ambiguous.structurallyInvalidTraces, 1);
	assert.equal(traceReportIsComplete(ambiguous), false);
	assert.match(formatTraceReport(ambiguous), /1 structurally invalid/);
	// The declared root still wins for the metrics, so the report is diagnosable
	// rather than merely refused.
	assert.equal(ambiguous.executionSuccesses, 1);
});

test("a span whose parent was cut is a broken tree, not a complete one", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);

	// Every count still agrees — unique ids, expected row count, nothing dropped.
	// What is gone is the tree, which is the thing the topology exists to record.
	const repoint = (patch: (span: TraceSpanRecord) => TraceSpanRecord) =>
		spans.map((span) => (role(span) === "child" ? patch(span) : span));
	for (const [label, broken] of [
		["stripped", repoint((span) => ({ ...span, parent_span_id: undefined }))],
		["blank", repoint((span) => ({ ...span, parent_span_id: "  " }))],
		["unknown", repoint((span) => ({ ...span, parent_span_id: "no-such-span" }))],
	] as const) {
		const report = summarizeTraceSpans(broken, 0, TRACE);
		assert.equal(report.observedSpans, spans.length, `${label}: the counts are untouched`);
		assert.equal(report.droppedSpans, 0, `${label}: nothing looks missing`);
		assert.equal(report.structurallyInvalidTraces, 1, `${label}: the tree is broken`);
		assert.equal(traceReportIsComplete(report), false, `${label} must not pass the gate`);
	}

	// A root that acquired a parent is the same corruption from the other end.
	const rootedRoot = spans.map((span) => (span.parent_span_id === null ? { ...span, parent_span_id: "somewhere-else" } : span));
	assert.equal(traceReportIsComplete(summarizeTraceSpans(rootedRoot, 0, TRACE)), false);
});

test("a resolvable link is not a tree: cycles and unreachable spans are corruption", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);

	// Two children pointed at each other: every parent id resolves, nothing is
	// missing or duplicated, and neither span hangs off the root any more.
	const children = spans.filter((span) => role(span) === "child");
	const cycled = spans.map((span) =>
		span === children[0] ? { ...span, parent_span_id: children[1].span_id }
			: span === children[1] ? { ...span, parent_span_id: children[0].span_id }
				: span);
	const cycleReport = summarizeTraceSpans(cycled, 0, TRACE);
	assert.equal(cycleReport.droppedSpans, 0, "every reference still resolves");
	assert.equal(cycleReport.structurallyInvalidTraces, 1);
	assert.equal(traceReportIsComplete(cycleReport), false);

	// A root that parents itself: no parentless row is left for anything to reach.
	const selfRooted = spans.map((span) => (span.parent_span_id === null ? { ...span, parent_span_id: span.span_id } : span));
	assert.equal(traceReportIsComplete(summarizeTraceSpans(selfRooted, 0, TRACE)), false);
});

test("a broken attribution chain is refused even when every span survives", async () => {
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			graph: { nodes: [{ id: "alpha", agent: "recon", task: "start" }, { id: "beta", agent: "recon", task: "use {node.alpha}", dependsOn: ["alpha"] }] },
		},
		{ recon: "node output" },
	);
	const spans = await readSpans(stubDir);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);

	const beta = spans.find((span) => attr(span, "flow.unit_key") === "beta")!;
	const rewrite = (patch: Record<string, unknown>) =>
		spans.map((span) => (span === beta ? { ...span, attributes: { ...span.attributes, ...patch } } : span));

	// Repointed at a span the trace does not contain, and stripped of its resolved
	// ids while still declaring the dependency: the rows are all intact either way,
	// and the causal chain the links exist to carry is not.
	for (const [label, patched] of [
		["unknown target", rewrite({ "flow.depends_on_span_ids": "no-such-span" })],
		["resolution removed", rewrite({ "flow.depends_on_span_ids": undefined })],
	] as const) {
		const report = summarizeTraceSpans(patched, 0, TRACE);
		assert.equal(report.observedSpans, spans.length, `${label}: every span survives`);
		assert.equal(report.structurallyInvalidTraces, 1, label);
		assert.equal(traceReportIsComplete(report), false, `${label} must not pass the gate`);
	}
});

test("an id containing the list delimiter does not turn a healthy run into a refusal", async () => {
	// Graph node ids are author-supplied and may contain a comma. Joining those raw
	// made a sound dependency list read as more keys than it had, so the gate this
	// PR adds would reject evidence from a run that did nothing wrong.
	const { stubDir, result } = await runFlow(
		{
			task: "map it",
			traceFile: TRACE,
			graph: {
				nodes: [
					{ id: "build,linux", agent: "recon", task: "build" },
					{ id: "test", agent: "recon", task: "use {node.build,linux}", dependsOn: ["build,linux"] },
				],
			},
		},
		{ recon: "node output" },
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);
	const dependent = spans.find((span) => attr(span, "flow.unit_key") === "test")!;
	assert.equal(attr(dependent, "flow.depends_on"), "build%2Clinux.handoff", "the delimiter is escaped, not lost");
	assert.equal(String(attr(dependent, "flow.depends_on_span_ids")).split(",").length, 1);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("a row that claims to be the root while hanging off a parent is corruption", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	const child = spans.find((span) => role(span) === "child")!;
	const relabel = (patch: Record<string, unknown>) =>
		spans.map((span) => (span === child ? { ...span, attributes: { ...span.attributes, ...patch } } : span));

	// It keeps its parent, so it is never a root candidate — and it silently leaves
	// the child metrics, because those count declared children.
	const second = summarizeTraceSpans(relabel({ "flow.span_role": "root" }), 0, TRACE);
	assert.equal(second.structurallyInvalidTraces, 1);
	assert.equal(traceReportIsComplete(second), false);

	// A role nothing in the vocabulary defines is the same problem: the row is
	// excluded from every bucket while looking perfectly well-formed.
	assert.equal(traceReportIsComplete(summarizeTraceSpans(relabel({ "flow.span_role": "sidecar" }), 0, TRACE)), false);
});

test("long author-supplied ids do not truncate a valid chain into a broken one", async () => {
	// Phase ids are author-supplied and unbounded. Six long ones overflow the
	// per-attribute cap, and a check that inferred the key count from the joined
	// string would then read the elision as a missing link — the gate failing a run
	// that did nothing wrong, which is the worse of its two failure modes.
	const phases = Array.from({ length: 6 }, (_unused, index) => ({
		id: `phase-${String(index + 1).padStart(2, "0")}-${"x".repeat(200)}`,
		agent: "operator",
		task: "work",
	}));
	const { stubDir, result } = await runFlow(
		{ task: "ship it", traceFile: TRACE, workflow: { stateFile: ".pi/flow-workflows/long-ids.json", phases, debrief: { agent: "debrief" } } },
		{ operator: "done", debrief: "summary" },
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);
	const debrief = unit(spans, "debrief")!;
	assert.ok(String(attr(debrief, "flow.depends_on")).length > 1024, "the joined list is past the ordinary attribute cap");
	assert.equal(attr(debrief, "flow.depends_on_count"), 6);
	assert.equal(String(attr(debrief, "flow.depends_on_span_ids")).split(",").length, 6);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("a modern trace cannot demote a row out of the checks by dropping its role", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	const child = spans.find((span) => role(span) === "child")!;

	// Stripping the role used to exclude the row from every structural check while
	// leaving the counts intact — corruption hiding by opting out of inspection.
	const roleless = spans.map((span) => {
		if (span !== child) return span;
		const { "flow.span_role": _dropped, ...rest } = span.attributes!;
		return { ...span, attributes: rest };
	});
	assert.equal(traceReportIsComplete(summarizeTraceSpans(roleless, 0, TRACE)), false);
});

test("spans the exporter never claimed to have written are not evidence either", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	const child = spans.find((span) => role(span) === "child")!;

	// Correctly parented, uniquely identified, and one more than the root declared.
	// Clamping the difference to zero made a surplus invisible; loss in the other
	// direction is still loss of the trace's integrity.
	const extra = [...spans, { ...child, span_id: "inserted-span" }];
	const report = summarizeTraceSpans(extra, 0, TRACE);
	assert.equal(report.duplicateSpans, 0, "the inserted row is not a duplicate");
	assert.equal(traceReportIsComplete(report), false);
});

test("a dependency must point at the unit it names, not merely at something real", async () => {
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			graph: {
				nodes: [
					{ id: "alpha", agent: "recon", task: "start" },
					{ id: "beta", agent: "recon", task: "use {node.alpha}", dependsOn: ["alpha"] },
				],
				debrief: { agent: "debrief" },
			},
		},
		{ recon: "node output", debrief: "synthesis" },
	);
	const spans = await readSpans(stubDir);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);

	// Repointed at a span that exists and is the wrong one: membership holds, and
	// the causal claim the link makes is now false.
	const beta = spans.find((span) => attr(span, "flow.unit_key") === "beta")!;
	const wrongTarget = spans.find((span) => attr(span, "flow.unit_key") === "debrief")!.span_id;
	const rewired = spans.map((span) =>
		span === beta ? { ...span, attributes: { ...span.attributes, "flow.depends_on_span_ids": wrongTarget } } : span);
	const report = summarizeTraceSpans(rewired, 0, TRACE);
	assert.equal(report.observedSpans, spans.length, "every span still present and unique");
	assert.equal(report.structurallyInvalidTraces, 1);
	assert.equal(traceReportIsComplete(report), false);
});

test("a corrupt dependency count cannot vouch for an emptied link list", async () => {
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			graph: { nodes: [{ id: "alpha", agent: "recon", task: "start" }, { id: "beta", agent: "recon", task: "use {node.alpha}", dependsOn: ["alpha"] }] },
		},
		{ recon: "node output" },
	);
	const spans = await readSpans(stubDir);
	const beta = spans.find((span) => attr(span, "flow.unit_key") === "beta")!;
	const rewrite = (patch: Record<string, unknown>) =>
		spans.map((span) => (span === beta ? { ...span, attributes: { ...span.attributes, ...patch } } : span));

	// The count is the thing the check trusts when the joined list may have been
	// shortened, so a corrupted count must not be able to agree with an emptied id
	// list and wave the dependency through.
	for (const [label, patched] of [
		["zeroed count", rewrite({ "flow.depends_on_count": 0, "flow.depends_on_span_ids": undefined })],
		["fractional count", rewrite({ "flow.depends_on_count": 1.5 })],
		["count below the keys present", rewrite({ "flow.depends_on_count": 0.5 })],
		// A rewritten count reads as absent to a typed accessor, so the fallback
		// would rebuild the very number that was corrupted out of the keys and
		// find everything in agreement. Presence is the question, not readability.
		["count rewritten to a string", rewrite({ "flow.depends_on_count": "1" })],
		["count rewritten to null", rewrite({ "flow.depends_on_count": null })],
	] as const) {
		assert.equal(traceReportIsComplete(summarizeTraceSpans(patched, 0, TRACE)), false, label);
	}

	// And the same substitution on a span that declares no dependencies at all:
	// the row still proves a count was written, so its keys did not simply never
	// exist — they were removed.
	const alpha = spans.find((span) => attr(span, "flow.unit_key") === "alpha")!;
	const alphaCounted = spans.map((span) =>
		span === alpha ? { ...span, attributes: { ...span.attributes, "flow.depends_on_count": "0" } } : span);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(alphaCounted, 0, TRACE)), false);
});

test("a stated expectation nothing can read does not exempt the trace from the checks", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);

	// Strip every role *and* corrupt the expectation. Each on its own is caught;
	// together they used to read as a legacy trace — a format that predates all of
	// these attributes — and a legacy trace is exempt from every check below.
	for (const expectation of ["3", 0, -1, null, {}] as const) {
		const demoted = spans.map((span) => {
			const { "flow.span_role": _role, ...rest } = span.attributes!;
			return {
				...span,
				attributes: span.parent_span_id === null ? { ...rest, "flow.trace.expected_spans": expectation } : rest,
			};
		});
		assert.equal(
			traceReportIsComplete(summarizeTraceSpans(demoted, 0, TRACE)),
			false,
			`expectation ${JSON.stringify(expectation)} must not demote a modern trace to legacy`,
		);
	}

	// A genuine legacy trace — one that never carried any of these attributes —
	// still passes, so the signal is the claim itself and not its absence.
	const legacy = spans.map((span) => {
		const { "flow.span_role": _role, "flow.trace.expected_spans": _expected, ...rest } = span.attributes!;
		return { ...span, attributes: rest };
	});
	assert.equal(traceReportIsComplete(summarizeTraceSpans(legacy, 0, TRACE)), true);
});

test("a key long enough to be capped stays matchable on both sides", async () => {
	// Node ids are author-supplied and unbounded. If the key is capped where it is
	// declared but not where it is referenced, the two can no longer be matched to
	// each other and a healthy run fails the gate.
	const longId = `alpha-${"y".repeat(1400)}`;
	const { stubDir, result } = await runFlow(
		{
			task: "map it",
			traceFile: TRACE,
			graph: { nodes: [{ id: longId, agent: "recon", task: "start" }, { id: "beta", agent: "recon", task: "next", dependsOn: [longId] }] },
		},
		{ recon: "node output" },
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);
	assert.equal(attr(spans.find((span) => attr(span, "flow.unit_key") === "beta"), "flow.depends_on"), `${longId}.handoff`);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("dependency metadata is refused in pieces, not just when it points nowhere", async () => {
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			graph: { nodes: [{ id: "alpha", agent: "recon", task: "start" }, { id: "beta", agent: "recon", task: "use {node.alpha}", dependsOn: ["alpha"] }] },
		},
		{ recon: "node output" },
	);
	const spans = await readSpans(stubDir);
	const beta = spans.find((span) => attr(span, "flow.unit_key") === "beta")!;
	const without = (...dropped: string[]) =>
		spans.map((span) => {
			if (span !== beta) return span;
			const attributes = { ...span.attributes };
			for (const key of dropped) delete attributes[key];
			return { ...span, attributes };
		});

	// Removing the keys while the count and resolved ids remain leaves a row that
	// still proves it declared dependencies — corruption wearing the shape of a
	// unit that never depended on anything.
	assert.equal(traceReportIsComplete(summarizeTraceSpans(without("flow.depends_on"), 0, TRACE)), false);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(without("flow.depends_on", "flow.depends_on_span_ids"), 0, TRACE)), false);
	// Removing all of it is a unit that genuinely declared none, which is fine —
	// alpha is such a unit in this very trace.
	assert.equal(
		traceReportIsComplete(summarizeTraceSpans(without("flow.depends_on", "flow.depends_on_count", "flow.depends_on_span_ids"), 0, TRACE)),
		true,
	);
});

test("a span tree that could not have happened is refused", async () => {
	const { stubDir } = await runFlow(
		{ task: "two scouts", traceFile: TRACE, tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
		{ recon: "done" },
	);
	const spans = await readSpans(stubDir);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
	const child = spans.find((span) => role(span) === "child")!;
	const retime = (patch: Partial<TraceSpanRecord>) =>
		spans.map((span) => (span === child ? { ...span, ...patch } : span));

	// Ids stay unique, parents stay reachable, dependencies stay resolvable — and
	// the tree describes a child running outside the flow that spawned it.
	for (const [label, patched] of [
		["ends before it starts", retime({ start_time_unix_ms: child.end_time_unix_ms! + 1_000 })],
		["outside its parent", retime({ start_time_unix_ms: 1, end_time_unix_ms: 2 })],
		["no timestamps", retime({ start_time_unix_ms: undefined, end_time_unix_ms: undefined })],
	] as const) {
		const report = summarizeTraceSpans(patched, 0, TRACE);
		assert.equal(report.observedSpans, spans.length, `${label}: every span still present`);
		assert.equal(report.structurallyInvalidTraces, 1, label);
		assert.equal(traceReportIsComplete(report), false, `${label} must not pass the gate`);
	}
});

test("keys removed from a dependency list are erasure unless the writer says otherwise", async () => {
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			graph: {
				nodes: [
					{ id: "alpha", agent: "recon", task: "start" },
					{ id: "beta", agent: "recon", task: "also start" },
					{ id: "gamma", agent: "recon", task: "use {node.alpha} and {node.beta}", dependsOn: ["alpha", "beta"] },
				],
			},
		},
		{ recon: "node output" },
	);
	const spans = await readSpans(stubDir);
	const gamma = spans.find((span) => attr(span, "flow.unit_key") === "gamma")!;
	assert.equal(attr(gamma, "flow.depends_on"), "alpha.handoff,beta.handoff");
	assert.equal(attr(gamma, "flow.depends_on_truncated"), undefined, "a list that fits is not truncated");
	const rewrite = (patch: Record<string, unknown>) =>
		spans.map((span) => (span === gamma ? { ...span, attributes: { ...span.attributes, ...patch } } : span));

	// Dropping a trailing key while leaving the count and the ids intact used to
	// read as capping, and capping skipped every key-to-id check below it.
	assert.equal(traceReportIsComplete(summarizeTraceSpans(rewrite({ "flow.depends_on": "alpha.handoff" }), 0, TRACE)), false);
	// Claiming truncation on a list that is whole is the mirror image, and equally
	// impossible: capping is the only thing that shortens it.
	assert.equal(traceReportIsComplete(summarizeTraceSpans(rewrite({ "flow.depends_on_truncated": true }), 0, TRACE)), false);
	// A genuinely capped list stays acceptable, and the keys that survived are
	// still matched to their ids: swapping them fails even under truncation.
	assert.equal(traceReportIsComplete(summarizeTraceSpans(rewrite({ "flow.depends_on": "alpha.handoff", "flow.depends_on_truncated": true }), 0, TRACE)), true);
	assert.equal(
		traceReportIsComplete(summarizeTraceSpans(rewrite({ "flow.depends_on": "beta.handoff,alpha.handoff" }), 0, TRACE)),
		false,
		"reordered keys no longer match their ids positionally",
	);
	assert.equal(String(attr(gamma, "flow.depends_on_span_ids")).split(",").length, 2);
});

test("truncation exempts only the key the cap destroyed, not the ones it left", async () => {
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			concurrency: 1,
			graph: {
				nodes: [
					{ id: "alpha", agent: "recon", task: "a" },
					{ id: "beta", agent: "recon", task: "b" },
					{ id: "gamma", agent: "recon", task: "c" },
					{ id: "delta", agent: "recon", task: "use {node.alpha}{node.beta}{node.gamma}", dependsOn: ["alpha", "beta", "gamma"] },
				],
			},
		},
		{ recon: "node output" },
	);
	const spans = await readSpans(stubDir);
	const delta = spans.find((span) => attr(span, "flow.unit_key") === "delta")!;
	const rewrite = (patch: Record<string, unknown>) =>
		spans.map((span) => (span === delta ? { ...span, attributes: { ...span.attributes, ...patch } } : span));

	// Marked truncated, so the missing third key is excused and so is the last key
	// present — the cap can cut mid-key. The keys before it are still checked, and
	// here they are swapped against their ids.
	assert.equal(
		traceReportIsComplete(summarizeTraceSpans(rewrite({ "flow.depends_on": "beta.handoff,alpha.handoff", "flow.depends_on_truncated": true }), 0, TRACE)),
		false,
		"a surviving key must still match the id at its position",
	);
	// The same shape with the surviving keys in their real order is sound.
	assert.equal(
		traceReportIsComplete(summarizeTraceSpans(rewrite({ "flow.depends_on": "alpha.handoff,beta.handoff", "flow.depends_on_truncated": true }), 0, TRACE)),
		true,
	);
});

test("a dependency list past the structural cap is marked truncated and still passes", async () => {
	// The one case the truncation signal exists for: enough author-supplied keys
	// that the joined list exceeds the 8 KiB structural cap. A real run must not
	// fail the gate because its ids were long.
	const wide = Array.from({ length: 12 }, (_, index) => `node-${index}-${"z".repeat(900)}`);
	const { stubDir, result } = await runFlow(
		{
			task: "map it",
			traceFile: TRACE,
			concurrency: 2,
			graph: {
				nodes: [
					...wide.map((id) => ({ id, agent: "recon", task: "start" })),
					{ id: "sink", agent: "recon", task: "combine", dependsOn: wide },
				],
			},
		},
		{ recon: "node output" },
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);
	const sink = spans.find((span) => attr(span, "flow.unit_key") === "sink")!;
	assert.equal(attr(sink, "flow.depends_on_truncated"), true, "the writer must say the list was capped");
	assert.equal(attr(sink, "flow.depends_on_count"), wide.length);
	assert.ok(String(attr(sink, "flow.depends_on")).split(",").length < wide.length, "the list must actually be shorter");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("redaction that shortens a dependency list is not truncation", async () => {
	// A node id can be anything an author writes, including something
	// secret-shaped. Over the structural cap before redaction, well under it
	// after: a flag derived from the raw string would claim a truncation the
	// reader cannot see, and refuse a run that is entirely sound.
	// privacy-scan: allow
	const secretish = `token=${"z".repeat(9_000)}`;
	const { stubDir, result } = await runFlow(
		{
			task: "map it",
			traceFile: TRACE,
			graph: { nodes: [{ id: secretish, agent: "recon", task: "start" }, { id: "beta", agent: "recon", task: "next", dependsOn: [secretish] }] },
		},
		{ recon: "node output" },
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);
	const beta = spans.find((span) => attr(span, "flow.unit_key") === "beta")!;
	const declared = String(attr(beta, "flow.depends_on"));
	assert.match(declared, /REDACTED/, "the secret-shaped id is redacted on the way out");
	assert.ok(declared.length < 200, "redaction brought the list well under the cap");
	assert.equal(attr(beta, "flow.depends_on_truncated"), undefined, "a complete stored list is not truncated");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});
