// Coordination-boundary tracing: span topology, identity/authority attributes,
// handoff accounting, coordination events, and trace-health enforcement.
//
// These run against the stub `pi` through the real dispatch path (see
// tests/stub-harness.ts), so the spans asserted here are the spans a real run
// writes — not a hand-built fixture.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { formatTraceReport, parseTraceJsonl, summarizeTraceSpans, traceReportIsComplete, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";
import { constraintIdentifiers, promptVersion } from "../extensions/pi-flows/trace-attributes.ts";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { discoverFlowAgents } from "../extensions/pi-flows/agents.ts";
import type { DelegationContract } from "../extensions/pi-flows/types.ts";
import { runFlow } from "./stub-harness.ts";

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
});

test("graph spans nest under their wave and link dependencies instead of flattening to the root", async () => {
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			graph: {
				nodes: [
					{ id: "alpha", agent: "recon", task: "start from {task}" },
					{ id: "beta", agent: "recon", task: "use {node.alpha}", dependsOn: ["alpha"] },
				],
				debrief: { agent: "debrief" },
			},
		},
		{ recon: "node output", debrief: "synthesis" },
	);
	const spans = await readSpans(stubDir);
	const root = spans.find((span) => span.parent_span_id === null)!;
	const stages = byRole(spans, "stage");
	assert.deepEqual(stages.map((stage) => attr(stage, "flow.stage_key")).sort(), ["wave-1", "wave-2"]);

	const alpha = unit(spans, "alpha")!;
	const beta = unit(spans, "beta")!;
	const wave1 = stages.find((stage) => attr(stage, "flow.stage_key") === "wave-1")!;
	const wave2 = stages.find((stage) => attr(stage, "flow.stage_key") === "wave-2")!;
	assert.equal(alpha.parent_span_id, wave1.span_id, "a wave-1 node hangs off its wave, not the root");
	assert.equal(beta.parent_span_id, wave2.span_id);
	assert.notEqual(beta.parent_span_id, root.span_id);
	assert.equal(wave1.parent_span_id, root.span_id, "stages hang off the root");

	// A dependency is a link, not parentage: beta consumed alpha but was not spawned by it.
	assert.equal(attr(beta, "flow.depends_on"), "alpha");
	assert.equal(attr(beta, "flow.depends_on_span_ids"), alpha.span_id);
	assert.equal(attr(unit(spans, "debrief"), "flow.depends_on"), "beta");
});

test("child spans identify prompt version, allowed tools, authority, contract, and delegation reason", async () => {
	const { stubDir } = await runFlow(
		{ agent: "recon", task: "find the version", contract, tools: "read", traceFile: TRACE, why: "independent scout with a typed contract" },
		{ recon: envelope() },
	);
	const spans = await readSpans(stubDir);
	const child = byRole(spans, "child")[0];

	assert.equal(attr(child, "flow.allowed_tools"), "read");
	assert.equal(attr(child, "flow.delegation_reason"), "independent scout with a typed contract");
	assert.equal(attr(child, "flow.side_effect_class"), "read-only");
	assert.equal(attr(child, "flow.authority_may"), "read repository files");
	assert.equal(attr(child, "flow.authority_must_not"), "push to a remote");
	assert.equal(attr(child, "flow.authority_requires_approval"), "install packages");
	assert.match(String(attr(child, "flow.contract_id")), /^sha256:[a-f0-9]{64}$/);
	assert.match(String(attr(child, "flow.return_schema_digest")), /^sha256:[a-f0-9]{64}$/);
	// Asserted against the contract's shape, not against the helper's own output:
	// one id per constraint plus one per acceptance check, each a content digest.
	const constraintIds = String(attr(child, "flow.constraint_ids")).split(",");
	assert.equal(constraintIds.length, contract.constraints.length + contract.acceptanceChecks.length);
	assert.match(constraintIds[0], /^constraint\.1:[a-f0-9]{12}$/);
	assert.match(constraintIds.at(-1)!, /^acceptance\.1:[a-f0-9]{12}$/);
	assert.equal(attr(child, "flow.constraint_ids"), constraintIdentifiers(contract).join(","));

	// The prompt version identifies the prompt that actually ran — compared against
	// the discovered agent's own system prompt, so a digest of the wrong string fails.
	const recon = discoverFlowAgents(process.cwd(), "user").agents.find((agent) => agent.name === "recon")!;
	assert.equal(attr(child, "flow.agent_prompt_version"), promptVersion(recon.systemPrompt));
	assert.notEqual(promptVersion(recon.systemPrompt), promptVersion(`${recon.systemPrompt}\nedited`));
});

test("handoff events record filtering, size, constraint ids, and acceptance without the payload", async () => {
	const { stubDir } = await runFlow(
		{
			task: "collect findings",
			contract,
			traceFile: TRACE,
			tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }],
		},
		{ recon: envelope() },
	);
	const spans = await readSpans(stubDir);
	const handoffs = spans.filter((span) => attr(span, "flow.event_kind") === "handoff");
	assert.equal(handoffs.length, 2);
	const handoff = handoffs[0];
	assert.equal(attr(handoff, "flow.handoff.acceptance"), "accepted");
	assert.equal(attr(handoff, "flow.handoff.compatibility"), "typed");
	assert.equal(attr(handoff, "flow.handoff.status"), "completed");
	assert.equal(attr(handoff, "flow.handoff.evidence_count"), 1);
	assert.equal(attr(handoff, "flow.handoff.preserved_constraint_ids"), constraintIdentifiers(contract).join(","));
	assert.equal(typeof attr(handoff, "flow.handoff.raw_bytes"), "number");
	assert.equal(typeof attr(handoff, "flow.handoff.carried_bytes"), "number");
	assert.equal(attr(handoff, "flow.handoff.content_recorded"), true);

	// Shapes, sizes, and identifiers only: the summary prose and the `data` body
	// stay in the envelope, so the trace is not a second copy of the payload.
	const serialized = JSON.stringify(handoff);
	assert.doesNotMatch(serialized, /Found it\./);
	assert.doesNotMatch(serialized, /package\.json/);
});

test("a rejected handoff is attributable to the hop that carried it", async () => {
	const { stubDir, result } = await runFlow(
		{
			task: "collect findings",
			contract,
			traceFile: TRACE,
			tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }],
		},
		{ recon: [envelope(), envelope({ wrong: true })] },
	);
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	const spans = await readSpans(stubDir);
	const rejected = spans.find((span) => attr(span, "flow.event_name") === "handoff.rejected")!;
	assert.equal(rejected.status?.code, "ERROR");
	assert.equal(attr(rejected, "flow.handoff.acceptance"), "rejected:RETURN_ENVELOPE_INVALID");
	assert.equal(attr(rejected, "flow.error_code"), "RETURN_ENVELOPE_INVALID");
});

test("artifact references and digests get their own attributable events", async () => {
	const { stubDir, result } = await runFlow(
		{ task: "write the note", traceFile: TRACE, contract, tasks: [{ agent: "operator", task: "write the note" }] },
		{
			operator: {
				writes: { "note.txt": "hello\n" },
				reply: envelope({ answer: "note.txt" }, {
					artifactReferences: [{ path: "note.txt" }],
					digests: [{ artifact: "note.txt", algorithm: "sha256", value: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03" }],
					changedState: ["note.txt"],
				}),
			},
		},
	);
	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);
	const artifact = spans.find((span) => attr(span, "flow.event_kind") === "artifact")!;
	assert.equal(attr(artifact, "flow.artifact.path"), "note.txt");
	assert.equal(attr(artifact, "flow.artifact.digest_declared"), true);
	assert.match(String(attr(artifact, "flow.artifact.digest")), /^sha256:5891b5b5/);
	assert.equal(attr(spans.find((span) => attr(span, "flow.event_kind") === "handoff"), "flow.handoff.artifact_refs"), "note.txt");
});

test("retries, state transitions, and approvals are attributable events", async () => {
	const { stubDir } = await runFlow(
		{ task: "build the thing", traceFile: TRACE, evaluate: { maxIterations: 2 } },
		{ operator: ["first attempt", "second attempt"], redteam: ["VERDICT: REVISE\nmissing tests", "VERDICT: PASS"] },
	);
	const spans = await readSpans(stubDir);
	const retry = spans.find((span) => attr(span, "flow.event_kind") === "retry")!;
	assert.equal(attr(retry, "flow.event_name"), "evaluate.revise");
	assert.equal(attr(retry, "flow.retry.attempt"), 2);
	assert.equal(attr(retry, "flow.retry.reason"), "critic_revise");

	const verdicts = spans.filter((span) => attr(span, "flow.event_name") === "evaluate.panel_verdict");
	assert.deepEqual(verdicts.map((span) => attr(span, "flow.verdict.pass")), [false, true]);
	// The retry belongs to the iteration that ran it, not to the flow as a whole.
	const iterations = byRole(spans, "stage").map((stage) => attr(stage, "flow.stage_key")).sort();
	assert.deepEqual(iterations, ["iteration-1", "iteration-2"]);
});

test("workflow phase state transitions and approval receipts reach the trace", async () => {
	const { stubDir } = await runFlow(
		{
			task: "ship it",
			traceFile: TRACE,
			workflow: {
				stateFile: ".pi/flow-workflows/trace-test.json",
				phases: [
					{ id: "build", agent: "operator", task: "build {task}" },
					{ id: "gate", approval: { message: "Ship?" } },
					{ id: "release", agent: "operator", task: "release {previous}" },
				],
			},
		},
		{ operator: "phase output" },
		{ hasUI: true },
	);
	const spans = await readSpans(stubDir);
	const states = spans.filter((span) => attr(span, "flow.event_kind") === "state").map((span) => attr(span, "flow.event_name"));
	assert.ok(states.includes("workflow.phase.started"), `expected a phase.started event, saw ${states.join(", ")}`);
	assert.ok(states.includes("workflow.phase.completed"));
	assert.ok(states.includes("workflow.approval.granted"));

	const approval = spans.find((span) => attr(span, "flow.event_name") === "workflow.approval.issued")!;
	assert.match(String(attr(approval, "flow.approval.receipt_id")), /^[a-f0-9]{16}$/);
	assert.equal(attr(approval, "flow.approval.validation"), "typed");
	// Receipt identity, never what it authorized.
	assert.doesNotMatch(JSON.stringify(approval), /ship it/);
});

test("trace health counts expected against observed spans and the report surfaces the gap", async () => {
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

test("content-omitting runs are reported as redacted rather than complete evidence", async () => {
	const { result } = await runFlow(
		{ agent: "recon", task: "inspect", traceFile: TRACE, recordContent: false },
		{ recon: "done" },
	);
	assert.equal(result.details.trace!.spans!.redactedSpans, 1);
	assert.equal(result.details.trace!.health, "recorded", "withheld content is still a complete export");
});

test("recordContent:false withholds authority prose but keeps the identity that makes a span attributable", async () => {
	const { stubDir } = await runFlow(
		{
			task: "collect findings",
			contract,
			traceFile: TRACE,
			recordContent: false,
			why: "a reason the operator did not want recorded",
			tasks: [{ agent: "recon", task: "inspect A" }],
		},
		{ recon: envelope() },
	);
	const spans = await readSpans(stubDir);
	const child = byRole(spans, "child")[0];
	// Free text is content and follows the content policy.
	assert.equal(attr(child, "flow.delegation_reason"), undefined);
	assert.equal(attr(child, "flow.authority_may"), undefined);
	assert.equal(attr(child, "flow.contract_owner"), undefined);
	// Structure is what makes the span attributable and carries no payload.
	assert.equal(attr(child, "flow.contract_id"), delegationContractId(contract));
	assert.equal(attr(child, "flow.side_effect_class"), "read-only");
	assert.equal(attr(child, "flow.authority_may_count"), 1);
	assert.equal(attr(child, "flow.constraint_ids"), constraintIdentifiers(contract).join(","));
	assert.doesNotMatch(JSON.stringify(spans), /a reason the operator did not want recorded/);
	assert.doesNotMatch(JSON.stringify(spans), /push to a remote/);
});

test("stages nest, and a unit key never overwrites the stage that shares its name", async () => {
	const search = await runFlow(
		{ task: "find an approach", traceFile: TRACE, search: { candidates: 2, maxRounds: 1 } },
		{ strategist: "candidate", redteam: "SCORE: 8", debrief: "final" },
	);
	const searchSpans = await readSpans(search.stubDir);
	const stageByKey = (spans: TraceSpanRecord[], key: string) => byRole(spans, "stage").find((stage) => attr(stage, "flow.stage_key") === key)!;
	const round = stageByKey(searchSpans, "round-1");
	const generate = stageByKey(searchSpans, "round-1.generate");
	const score = stageByKey(searchSpans, "round-1.score");
	assert.equal(generate.parent_span_id, round.span_id, "generate nests inside its round");
	assert.equal(score.parent_span_id, round.span_id);
	assert.equal(round.parent_span_id, searchSpans.find((span) => span.parent_span_id === null)!.span_id);

	// A workflow phase is both a stage and the child that runs it. The two keys
	// live in separate namespaces, so the stage span survives its own child.
	const workflow = await runFlow(
		{
			task: "ship it",
			traceFile: TRACE,
			workflow: {
				stateFile: ".pi/flow-workflows/nesting.json",
				phases: [{ id: "build", agent: "operator", task: "build {task}" }],
				debrief: { agent: "debrief" },
			},
		},
		{ operator: "built", debrief: "summary" },
	);
	const workflowSpans = await readSpans(workflow.stubDir);
	const phaseStage = stageByKey(workflowSpans, "phase-build");
	const phaseChild = unit(workflowSpans, "phase-build.work")!;
	assert.equal(phaseChild.parent_span_id, phaseStage.span_id);
	assert.equal(attr(unit(workflowSpans, "debrief"), "flow.depends_on_span_ids"), phaseChild.span_id);
});

test("strict tracing refuses a run with no trace file and passes an intact one", async () => {
	const refused = await runFlow({ agent: "recon", task: "inspect", traceStrict: true }, { recon: "done" });
	assert.equal(refused.result.details.error?.code, "TRACE_INCOMPLETE");
	assert.equal(refused.calls.length, 0, "strict mode refuses before spending tokens");
	assert.match(refused.text, /no trace file is configured/);

	const allowed = await runFlow({ agent: "recon", task: "inspect", traceStrict: true, traceFile: TRACE }, { recon: "done" });
	assert.equal(allowed.result.details.error, undefined);
	assert.equal(allowed.result.details.trace?.health, "recorded");
});

test("strict tracing fails a run whose export could not be written, without blaming the agents", async () => {
	const { result, calls } = await runFlow(
		{ agent: "recon", task: "inspect", traceStrict: true, traceFile: "nested/missing-dir/trace.jsonl" },
		{ recon: "done" },
	);
	assert.equal(calls.length, 1, "the child still ran; only the evidence is missing");
	assert.equal(result.details.error?.code, "TRACE_INCOMPLETE");
	assert.equal(result.details.trace?.health, "missing");
	assert.match(result.content[0].text, /is missing/);
	// The child itself is still recorded as a clean run — the refusal is about
	// evidence, not about the agent.
	assert.equal(result.details.results.every((child) => child.exitCode === 0), true);
});

test("best-effort tracing stays the default and never fails a flow", async () => {
	const { result } = await runFlow({ agent: "recon", task: "inspect", traceFile: "nested/missing-dir/trace.jsonl" }, { recon: "done" });
	assert.equal(result.details.error, undefined, "an unwritable trace must not fail an ordinary flow");
	assert.equal(result.details.trace?.health, "missing");
	assert.equal(result.details.trace?.spans?.failedExports, 2);
});
