// Coordination-trace topology: span roles, stage nesting, and the dependency
// links between units.
//
// These run against the stub `pi` through the real dispatch path (see
// tests/stub-harness.ts), so the spans asserted here are the spans a real run
// writes — not a hand-built fixture. What a span *says* about itself — identity,
// redaction, handoff accounting, trace health — lives in trace-evidence.test.ts.
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
	assert.equal(attr(beta, "flow.depends_on"), "alpha.handoff", "beta consumed alpha's validated handoff, not its raw output");
	assert.equal(attr(beta, "flow.depends_on_span_ids"), spans.find((span) => attr(span, "flow.unit_key") === "alpha.handoff")!.span_id);
	assert.equal(attr(unit(spans, "debrief"), "flow.depends_on"), "beta.handoff");
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
	// The debrief reads the prepared handoff text, so it links the handoff event,
	// which in turn depends on the child that produced it.
	const phaseHandoff = unit(workflowSpans, "phase-build.work.handoff")!;
	assert.equal(attr(unit(workflowSpans, "debrief"), "flow.depends_on_span_ids"), phaseHandoff.span_id);
	assert.equal(attr(phaseHandoff, "flow.depends_on_span_ids"), phaseChild.span_id);
});

test("a validation failure and a budget refusal are attributable without a child span", async () => {
	const gated = await runFlow(
		{ task: "build it", traceFile: TRACE, evaluate: { checkCommand: "node -e \"process.exit(1)\"", maxIterations: 1 } },
		{ operator: "draft", redteam: "VERDICT: PASS" },
	);
	const gatedSpans = await readSpans(gated.stubDir);
	const check = gatedSpans.find((span) => attr(span, "flow.event_name") === "evaluate.check_command")!;
	assert.equal(attr(check, "flow.event_kind"), "validation");
	assert.equal(attr(check, "flow.check.passed"), false);
	assert.equal(check.status?.code, "ERROR");

	const capped = await runFlow(
		{
			task: "two scouts, one budget",
			traceFile: TRACE,
			maxTokens: 4,
			concurrency: 1,
			tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }],
		},
		{ recon: "finding" },
	);
	const cappedSpans = await readSpans(capped.stubDir);
	// The refusal's own attributes are pinned in tests/flow-budget.test.ts; what
	// matters here is the topology: only the child that ran has a child span,
	// which is exactly why the refusal needs an event of its own.
	const budget = cappedSpans.find((span) => attr(span, "flow.event_kind") === "budget")!;
	assert.equal(attr(budget, "flow.event_name"), "child.refused");
	assert.equal(byRole(cappedSpans, "child").length, 1);
});

test("an approval-gated phase links to the approval that let it run", async () => {
	const { stubDir } = await runFlow(
		{
			task: "ship it",
			traceFile: TRACE,
			workflow: {
				stateFile: ".pi/flow-workflows/approval-edge.json",
				phases: [
					{ id: "gate", approval: { message: "Ship?" } },
					{ id: "release", agent: "operator", task: "release {task}" },
				],
			},
		},
		{ operator: "released" },
		{ hasUI: true },
	);
	const spans = await readSpans(stubDir);
	const approval = spans.find((span) => attr(span, "flow.event_name") === "workflow.approval.issued")!;
	const work = unit(spans, "phase-release.work")!;
	// An approval spawns no child, so the gated phase's dependency has to name the
	// approval event — and that edge has to actually resolve, not just be declared.
	assert.equal(attr(work, "flow.depends_on"), "phase-gate.approval");
	assert.equal(attr(work, "flow.depends_on_span_ids"), approval.span_id);
});

test("a nested stage that runs late widens its whole ancestry", async () => {
	const { stubDir } = await runFlow(
		{ task: "find an approach", traceFile: TRACE, search: { candidates: 2, maxRounds: 1 } },
		{ strategist: "candidate", redteam: "SCORE: 8", debrief: "final" },
	);
	const spans = await readSpans(stubDir);
	const stage = (key: string) => byRole(spans, "stage").find((span) => attr(span, "flow.stage_key") === key)!;
	// The count stays a count of direct placements, not of everything underneath.
	assert.equal(attr(stage("round-1"), "flow.stage_span_count"), 0);
	// Two generators and the handoff each produced: the boundary belongs with the
	// generation it came from, not with the round above it.
	assert.equal(attr(stage("round-1.generate"), "flow.stage_span_count"), 4);

	// Bounds are checked against controlled durations rather than against a live
	// run: through the stub, every span lands inside the same millisecond, so a
	// round that never widened would still look like it covered its children.
	const dir = await freshDir();
	const sink = makeTraceSink(path.join(dir, TRACE), "search", { recordContent: false, redactSecrets: true });
	const round = { key: "round-1", name: "round 1" };
	const generate = { key: "round-1.generate", name: "round 1 generate", parent: round };
	const child = (durationMs: number) => ({
		agent: "strategist", agentSource: "package" as const, task: "t", exitCode: 0, messages: [], stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, durationMs,
	});
	sink.record(child(10), { scope: { stage: generate, key: "gen-1" } });
	// The second placement finds the stage already open, which is the path that
	// used to widen only the stage itself and leave its ancestry behind.
	sink.record(child(5_000), { scope: { stage: generate, key: "gen-2" } });
	await sink.finalize({ ok: true });
	const direct = await readSpans(dir);
	const roundSpan = direct.find((span) => attr(span, "flow.stage_key") === "round-1")!;
	const generateSpan = direct.find((span) => attr(span, "flow.stage_key") === "round-1.generate")!;
	assert.ok(roundSpan.start_time_unix_ms! <= generateSpan.start_time_unix_ms!, "a round must not start after its own sub-stage");
	assert.ok(roundSpan.end_time_unix_ms! >= generateSpan.end_time_unix_ms!, "a round must not end before its own sub-stage");
});

test("an approved top-level checkpoint leaves evidence it was asked for", async () => {
	const approved = await runFlow(
		{ agent: "recon", task: "inspect", traceFile: TRACE, checkpoint: { before: "spawn", message: "Run it?" } },
		{ recon: "done" },
		{ hasUI: true },
	);
	assert.equal(approved.result.details.error, undefined);
	const approvedEvent = (await readSpans(approved.stubDir)).find((span) => attr(span, "flow.event_name") === "checkpoint.spawn")!;
	assert.equal(attr(approvedEvent, "flow.approval.decision"), "approved");
	assert.equal(attr(approvedEvent, "flow.event_kind"), "approval");

	// A refusal is recorded too — and its trace is still complete, because the
	// refusal path finalizes the sink instead of orphaning the event.
	const refused = await runFlow(
		{ agent: "recon", task: "inspect", traceFile: TRACE, checkpoint: { before: "spawn", message: "Run it?" } },
		{ recon: "done" },
		{ hasUI: false },
	);
	assert.equal(refused.result.details.error?.code, "CHECKPOINT_APPROVAL_REQUIRED");
	assert.equal(refused.calls.length, 0);
	const refusedSpans = await readSpans(refused.stubDir);
	assert.equal(attr(refusedSpans.find((span) => attr(span, "flow.event_name") === "checkpoint.spawn"), "flow.approval.decision"), "required");
	const root = refusedSpans.find((span) => span.parent_span_id === null)!;
	assert.equal(attr(root, "flow.refused_before_spawn"), "CHECKPOINT_APPROVAL_REQUIRED");
	assert.equal(summarizeTraceSpans(refusedSpans, 0, TRACE).incompleteTraces, 0, "a refusal must still export a complete trace");
});

test("the workflow debrief links every phase, including those that ran no child", async () => {
	const { stubDir } = await runFlow(
		{
			task: "ship it",
			traceFile: TRACE,
			workflow: {
				stateFile: ".pi/flow-workflows/debrief-links.json",
				phases: [
					{ id: "build", agent: "operator", task: "build {task}" },
					{ id: "gate", approval: { message: "Ship?" } },
					{ id: "release", agent: "operator", task: "release" },
				],
				debrief: { agent: "debrief" },
			},
		},
		{ operator: "built", debrief: "summary" },
		{ hasUI: true },
	);
	const spans = await readSpans(stubDir);
	const debrief = unit(spans, "debrief")!;
	// The approval phase produced no work span, so a link built from work keys
	// would name a unit that never existed. Work phases link their handoff, since
	// that is the text the debrief actually reads.
	assert.equal(attr(debrief, "flow.depends_on"), "phase-build.work.handoff,phase-gate.approval,phase-release.work.handoff");
	assert.equal(String(attr(debrief, "flow.depends_on_span_ids")).split(",").length, 3, "every declared debrief link must resolve");
});

test("iterative modes link each revision to the feedback that caused it", async () => {
	const evaluated = await runFlow(
		{ task: "build the thing", traceFile: TRACE, evaluate: { maxIterations: 2 } },
		{ operator: ["first draft", "revised draft"], redteam: ["VERDICT: REVISE\nmissing tests", "VERDICT: PASS"] },
	);
	const evaluateSpans = await readSpans(evaluated.stubDir);
	const secondDraft = unit(evaluateSpans, "iteration-2.generator")!;
	const feedback = evaluateSpans.find((span) => attr(span, "flow.unit_key") === "iteration-1.feedback")!;
	// Through the feedback boundary: what the revision reads is the aggregated,
	// capped, scanned critique, and the verdict is what produced it — alongside
	// the artifact handoff it revises in place.
	assert.equal(attr(secondDraft, "flow.depends_on"), "iteration-1.generator.handoff,iteration-1.feedback");
	assert.equal(String(attr(secondDraft, "flow.depends_on_span_ids")).split(",")[1], feedback.span_id);
	assert.equal(attr(feedback, "flow.depends_on"), "iteration-1.panel");

	const looped = await runFlow(
		{ task: "converge", traceFile: TRACE, loop: { body: { agent: "operator" }, judge: { agent: "redteam" }, maxIterations: 2 } },
		{ operator: ["draft", "revision"], redteam: ["VERDICT: REVISE\nnot yet", "VERDICT: PASS"] },
	);
	const loopSpans = await readSpans(looped.stubDir);
	const secondBody = unit(loopSpans, "iteration-2.body")!;
	assert.equal(attr(secondBody, "flow.depends_on"), "iteration-1.judge.handoff");
	assert.equal(attr(secondBody, "flow.depends_on_span_ids"), unit(loopSpans, "iteration-1.judge.handoff")!.span_id);

	const searched = await runFlow(
		{ task: "find an approach", traceFile: TRACE, search: { candidates: 1, maxRounds: 2, beamWidth: 1 } },
		{ strategist: "candidate", redteam: "SCORE: 8", debrief: "final" },
	);
	const searchSpans = await readSpans(searched.stubDir);
	const secondRoundGenerator = unit(searchSpans, "round-2.gen-1")!;
	// A round refines a specific beam, so the link names the score that selected
	// it rather than the round as a whole.
	assert.equal(attr(secondRoundGenerator, "flow.depends_on"), "round-1.score-1");
	assert.equal(attr(secondRoundGenerator, "flow.depends_on_span_ids"), unit(searchSpans, "round-1.score-1")!.span_id);
	// And the scorer reads the prepared candidate, not the generator's raw output.
	assert.equal(attr(unit(searchSpans, "round-1.score-1"), "flow.depends_on"), "round-1.gen-1.handoff");
});

test("the monitor reactor links to the observation it is diagnosing", async () => {
	const { stubDir } = await runFlow(
		{ task: "watch the file", traceFile: TRACE, monitor: { command: "echo tripped", trigger: "match", pattern: "tripped", maxChecks: 2 } },
		{ analyst: "diagnosis" },
	);
	const spans = await readSpans(stubDir);
	const trigger = spans.find((span) => attr(span, "flow.event_name") === "monitor.triggered")!;
	const reactor = unit(spans, "reactor")!;
	assert.equal(attr(reactor, "flow.depends_on"), "trigger");
	assert.equal(attr(reactor, "flow.depends_on_span_ids"), trigger.span_id);
});

test("dossier synthesis links only the sections it actually read", async () => {
	const { stubDir, result } = await runFlow(
		{
			task: "reconcile the sources",
			traceFile: TRACE,
			concurrency: 1,
			dossier: {
				sections: [{ agent: "recon", task: "source A" }, { agent: "recon", task: "source B" }, { agent: "recon", task: "source C" }],
				debrief: { agent: "debrief" },
			},
		},
		{ recon: ["finding A", "finding B", { reply: "boom", exitCode: 1 }], debrief: "dossier" },
	);
	assert.equal(result.details.error, undefined, "two good sections are enough to synthesize");
	const spans = await readSpans(stubDir);
	// The failed section was filtered out of the synthesis prompt, so claiming the
	// debrief consumed it would misreport what the answer rests on.
	assert.equal(attr(unit(spans, "debrief"), "flow.depends_on"), "section-1.handoff,section-2.handoff");
});

test("synthesis and verdict spans link only the units they actually aggregate", async () => {
	const orchestrated = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			concurrency: 1,
			orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" }, maxSubtasks: 2 },
		},
		{ commander: '["first", "second"]', recon: ["finding one", { reply: "boom", exitCode: 1 }], debrief: "synthesis" },
	);
	const orchestrateSpans = await readSpans(orchestrated.stubDir);
	// Worker 2 failed, so its output never reached the synthesis prompt.
	assert.equal(attr(unit(orchestrateSpans, "synthesis-1"), "flow.depends_on"), "worker-1.handoff");

	const evaluated = await runFlow(
		// concurrency 1: two write-capable critics sharing a cwd is refused outright,
		// and the guard is right to do it — serialize them instead.
		{ task: "build it", traceFile: TRACE, concurrency: 1, evaluate: { maxIterations: 1, redteam: [{ agent: "redteam" }, { agent: "overwatch" }] } },
		{ operator: "draft", redteam: "VERDICT: PASS", overwatch: "VERDICT: PASS" },
	);
	const evaluateSpans = await readSpans(evaluated.stubDir);
	const panel = evaluateSpans.find((span) => attr(span, "flow.unit_key") === "iteration-1.panel")!;
	// A revision links to the panel, so a panel that links to nothing would break
	// the attribution chain in the middle.
	assert.equal(attr(panel, "flow.depends_on"), "iteration-1.critic-1,iteration-1.critic-2");
	assert.equal(String(attr(panel, "flow.depends_on_span_ids")).split(",").length, 2);
});

test("aggregators across every fan-out mode link only what reached their prompt", async () => {
	// The same defect recurred in four modes, so it is checked as one family
	// rather than one mode at a time: a failed contributor is filtered out of the
	// prompt, and a link to it would claim the answer rests on work never read.
	const voted = await runFlow(
		{ task: "agree", traceFile: TRACE, concurrency: 1, vote: { agent: "recon", count: 3, debrief: { agent: "debrief" } } },
		{ recon: ["yes", "yes", { reply: "boom", exitCode: 1 }], debrief: "consensus" },
	);
	assert.equal(attr(unit(await readSpans(voted.stubDir), "aggregator"), "flow.depends_on"), "voter-1.handoff,voter-2.handoff");

	const debated = await runFlow(
		{
			task: "choose",
			traceFile: TRACE,
			concurrency: 1,
			debate: { participants: [{ agent: "recon" }, { agent: "analyst" }, { agent: "strategist" }], rounds: 1, adjudicator: { agent: "debrief" } },
		},
		{ recon: "for", analyst: "against", strategist: { reply: "boom", exitCode: 1 }, debrief: "decision" },
	);
	const debateSpans = await readSpans(debated.stubDir);
	assert.equal(attr(unit(debateSpans, "adjudicator"), "flow.depends_on"), "round-1.advocate-1.handoff,round-1.advocate-2.handoff");
	assert.equal(String(attr(unit(debateSpans, "adjudicator"), "flow.depends_on_span_ids")).split(",").length, 2);
});

test("a failed gate links back to the draft that failed it", async () => {
	const { stubDir } = await runFlow(
		{ task: "build it", traceFile: TRACE, evaluate: { maxIterations: 2, checkCommand: "node -e \"process.exit(process.env.PI_STUB_DIR ? 1 : 0)\"" } },
		{ operator: ["first draft", "second draft"], redteam: "VERDICT: PASS" },
	);
	const spans = await readSpans(stubDir);
	const check = spans.find((span) => attr(span, "flow.unit_key") === "iteration-1.check")!;
	// revision -> check -> draft: the chain has to reach the artifact that failed,
	// not stop at the verdict about it.
	assert.equal(attr(check, "flow.depends_on"), "iteration-1.generator");
	assert.equal(attr(check, "flow.depends_on_span_ids"), unit(spans, "iteration-1.generator")!.span_id);
	// The revision reads the *prepared* check output, so it links the handoff that
	// carried it, which in turn links the check that produced it.
	// The revision reads both the artifact it revises and the feedback that sent
	// it back, so both are declared.
	assert.equal(attr(unit(spans, "iteration-2.generator"), "flow.depends_on"), "iteration-1.generator.handoff,iteration-1.check.handoff");
	assert.equal(attr(unit(spans, "iteration-1.check.handoff"), "flow.depends_on"), "iteration-1.check");
});

test("route dispatch runs through the recorded selection, not around it", async () => {
	const { stubDir } = await runFlow(
		{ task: "fix the failing build", traceFile: TRACE, route: { candidates: ["recon", "strategist"] } },
		{ controller: "ROUTE: recon", recon: "investigated" },
	);
	const spans = await readSpans(stubDir);
	const selection = spans.find((span) => attr(span, "flow.event_name") === "route.selected")!;
	// classification -> selection -> dispatch: the decision is the boundary that
	// connects the two, so it must not sit beside the chain as an orphan.
	assert.equal(attr(selection, "flow.unit_key"), "selection");
	const routerHandoff = unit(spans, "router.handoff")!;
	assert.equal(attr(routerHandoff, "flow.depends_on"), "router");
	assert.equal(attr(routerHandoff, "flow.depends_on_span_ids"), unit(spans, "router")!.span_id);
	assert.equal(attr(selection, "flow.depends_on"), "router.handoff");
	assert.equal(attr(selection, "flow.depends_on_span_ids"), routerHandoff.span_id);
	assert.equal(attr(unit(spans, "specialist"), "flow.depends_on"), "selection");
	assert.equal(attr(unit(spans, "specialist"), "flow.depends_on_span_ids"), selection.span_id);
});

test("a chain step consumes the handoff, not the step that produced it", async () => {
	const { stubDir } = await runFlow(
		{
			task: "add caching",
			traceFile: TRACE,
			chain: [
				{ agent: "recon", task: "research {task}" },
				{ agent: "strategist", task: "plan from:\n{previous}" },
			],
		},
		{ recon: "RECON_FINDINGS", strategist: "STRATEGY" },
	);
	const spans = await readSpans(stubDir);
	const handoff = spans.find((span) => attr(span, "flow.unit_key") === "step-1.handoff")!;
	const second = unit(spans, "step-2")!;
	// What step 1 produced is not what step 2 received: validation, filtering, and
	// the injection scan sit between them. Depending on the child would route the
	// exported chain around the boundary that decided what was carried.
	assert.equal(attr(handoff, "flow.depends_on"), "step-1");
	assert.equal(attr(second, "flow.depends_on"), "step-1.handoff");
	assert.equal(attr(second, "flow.depends_on_span_ids"), handoff.span_id);
});

test("a fan-out handoff is attributable to the child that produced it", async () => {
	// Acceptance records the handoff after the fan-out returns, from the item's
	// own scope. If the merged placement never reached the item, these events land
	// at the root with no key and no producer.
	const { stubDir } = await runFlow(
		{
			task: "collect",
			traceFile: TRACE,
			concurrency: 1,
			dossier: { sections: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }], debrief: { agent: "debrief" } },
		},
		{ recon: "finding", debrief: "synthesis" },
	);
	const spans = await readSpans(stubDir);
	const stage = byRole(spans, "stage").find((span) => attr(span, "flow.stage_key") === "sections")!;
	for (const index of [1, 2]) {
		const child = unit(spans, `section-${index}`)!;
		const handoff = unit(spans, `section-${index}.handoff`);
		assert.ok(handoff, `section-${index} must record a keyed handoff`);
		assert.equal(handoff.parent_span_id, stage.span_id, "the handoff belongs to the fan-out stage, not the root");
		assert.equal(attr(handoff, "flow.depends_on_span_ids"), child.span_id);
	}
});

test("a revised synthesis links every handoff its prompt carries", async () => {
	// The revision prompt repeats the worker findings and the prior answer beside
	// the verifier critique. Naming only the critique would export a revision that
	// rests on a verdict alone.
	const { stubDir } = await runFlow(
		{
			task: "map the system",
			traceFile: TRACE,
			concurrency: 1,
			orchestrate: {
				commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" }, verify: { agent: "overwatch" },
				maxSubtasks: 1, verifyPolicy: "revise", verifyMaxIterations: 2,
			},
		},
		{ commander: '["only"]', recon: "finding", debrief: ["first pass", "revised"], overwatch: ["VERDICT: REVISE", "VERDICT: PASS"] },
	);
	const spans = await readSpans(stubDir);
	const revision = unit(spans, "synthesis-2")!;
	assert.equal(attr(revision, "flow.depends_on"), "worker-1.handoff,synthesis-1.handoff,verify-1.handoff");
	assert.equal(String(attr(revision, "flow.depends_on_span_ids")).split(",").length, 3, "every declared link must resolve");
});
