// Offline tests for work-phase topology scoring in the selection eval
// (issue #88): the phase-gated workflow case must prove work phases were
// actually assigned. The old shape stopped at {mode, taskPattern}, so any
// workflow carrying "release migration" in its top-level task satisfied it
// regardless of what its phases assigned. The literal approval-only exploit
// was already refused headless by #87's WORKFLOW_APPROVAL_REQUIRED
// admissibility check, but a single trivial work phase ahead of the approval
// still passed, and an invalid phase list the tool refuses whole
// (WORKFLOW_INVALID) could lend its valid siblings to the count. minTasks,
// everyTaskPattern, and the agents predicates now read the handler's own
// work phases via the imported isWorkflowWorkPhase/workflowPhasesRefusal
// predicates, so the scored rules cannot drift from the enforced ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAdmissibilityFailure, flowCallMatchesExpectation, scoreSelection } from "../evals/select.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";

/** Every direct case dereference goes through this, so a renamed case fails with a named error, not a TypeError. */
function theWorkflowCase(): any {
	const testCase = SELECTION_CASES.find((candidate: any) => candidate.name === "implicit-phase-gated-work-uses-workflow");
	assert.ok(testCase, "selection case fixture missing — was implicit-phase-gated-work-uses-workflow renamed?");
	return testCase;
}

function scored(flowCallArgs: Array<Record<string, unknown>>) {
	return scoreSelection(theWorkflowCase(), { flowCalls: flowCallArgs.length, flowCallArgs, stoppedAfterFlowCall: true, answer: "" });
}

const MIGRATION_TASK = "Run this release migration as explicit analyze, plan, implement, verify, and approval phases.";

test("workflow minTasks is a work-phase minimum: approval-only phases do not count", () => {
	const phases = [
		{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
		{ id: "approve", approval: { message: "Approve the migration plan." } },
	];
	const call = { arguments: { why: "gated phases", task: "Release migration", workflow: { phases } } };
	assert.equal(flowCallMatchesExpectation(call, { mode: "workflow", minTasks: 1 }).pass, true);
	const two = flowCallMatchesExpectation(call, { mode: "workflow", minTasks: 2 });
	assert.equal(two.pass, false);
	assert.match(two.notes, /expected at least 2 workflow task\(s\), saw 1/);
});

test("an approval-only workflow fails the case on topology, before the admissibility rider", () => {
	// The shape check must name the missing work phases itself rather than
	// lean on WORKFLOW_APPROVAL_REQUIRED, which only covers the headless
	// approval-first arrangement, not the topology gap (#88).
	const approvalOnly = {
		why: "gated release migration",
		task: MIGRATION_TASK,
		workflow: { phases: [{ id: "approve", approval: { message: "Approve migration" } }] },
	};
	const result = scored([approvalOnly]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /expected at least \d+ workflow task\(s\), saw 0/);
});

test("a single work phase ahead of the approval fails the case — the gap #87 left open", () => {
	const singleWorkPhase = {
		why: "gated release migration",
		task: MIGRATION_TASK,
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
			{ id: "approve", approval: { message: "Approve migration" } },
		] },
	};
	const result = scored([singleWorkPhase]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /expected at least \d+ workflow task\(s\), saw 1/);
});

test("an off-topic work phase cannot ride the migration workflow's top-level task", () => {
	// Both the count and the run-wide alternation are satisfied; only the
	// role-by-role binding sees that the second phase assigns unrelated work.
	const offTopicSibling = {
		why: "gated release migration",
		task: "Run this release migration through analyze, verify, and approval phases.",
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
			{ id: "drift", agent: "operator", task: "Rewrite the README badges." },
			{ id: "approve", approval: { message: "Approve migration" } },
		] },
	};
	const result = scored([offTopicSibling]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /role task 2 did not match/);
});

test("a work phase naming an invented agent fails the case via knownAgentsOnly", () => {
	// Workflow persists state before the runner's roster check, so the
	// runner's UNKNOWN_AGENT refusal is outside the admissibility vocabulary
	// here; the case's knownAgentsOnly is what refuses the invented sibling.
	const inventedAgent = {
		why: "gated release migration",
		task: MIGRATION_TASK,
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
			{ id: "verify", agent: "made-up-verifier", task: "Verify the release migration." },
			{ id: "approve", approval: { message: "Approve migration" } },
		] },
	};
	const result = scored([inventedAgent]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /made-up-verifier.*not bundled flow agents/);
});

test("an agentless task phase is not a work phase, and its call is refused whole", () => {
	// handleWorkflow requires agent AND task per work phase; the predicate is
	// imported from the extension, so the two cannot drift. With no valid
	// work phase at all, the shape mismatch names the missing work.
	const agentless = flowCallMatchesExpectation({ arguments: {
		why: "gated phases",
		task: "Release migration",
		workflow: { phases: [
			{ id: "analyze", task: "Analyze the release migration." },
			{ id: "verify", task: "Verify the release migration." },
			{ id: "approve", approval: { message: "Approve migration" } },
		] },
	} }, { mode: "workflow", minTasks: 2 });
	assert.equal(agentless.pass, false);
	assert.match(agentless.notes, /expected at least 2 workflow task\(s\), saw 0/);
});

test("an invalid sibling phase cannot lend its valid siblings to the topology", () => {
	// Two on-topic work phases plus one agentless phase: the counts and
	// bindings over the valid siblings all hold, but handleWorkflow refuses
	// the call WHOLE (WORKFLOW_INVALID) before any state write — the
	// admissibility rider must catch what the per-phase filter cannot.
	const invalidSibling = {
		why: "gated release migration",
		task: MIGRATION_TASK,
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
			{ id: "verify", agent: "operator", task: "Verify the release migration." },
			{ id: "plan", task: "Plan migration" },
			{ id: "approve", approval: { message: "Approve migration" } },
		] },
	};
	assert.equal(callAdmissibilityFailure(invalidSibling)?.code, "WORKFLOW_INVALID");
	const result = scored([invalidSibling]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /matches the expected shape, but the tool would refuse it .*WORKFLOW_INVALID/);
	// Duplicate ids and a both-kinds phase are the same refusal.
	const duplicateIds = { ...invalidSibling, workflow: { phases: [
		{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
		{ id: "analyze", agent: "operator", task: "Verify the release migration." },
	] } };
	assert.equal(callAdmissibilityFailure(duplicateIds)?.code, "WORKFLOW_INVALID");
	const bothKinds = { ...invalidSibling, workflow: { phases: [
		{ id: "analyze", agent: "recon", task: "Analyze the release migration.", approval: { message: "Approve" } },
		{ id: "verify", agent: "operator", task: "Verify the release migration." },
	] } };
	assert.equal(callAdmissibilityFailure(bothKinds)?.code, "WORKFLOW_INVALID");
});

test("a work-only workflow fails the case: the gate itself is part of the topology", () => {
	// Two on-topic work phases with bundled agents and NO approval phase:
	// minTasks, everyTaskPattern, and knownAgentsOnly all hold, and the
	// run-wide taskPattern is satisfied by the top-level task's own
	// "approval" wording — only minApprovalPhases sees that this workflow
	// never pauses or persists a resumable approval point.
	const workOnly = {
		why: "gated release migration",
		task: MIGRATION_TASK,
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
			{ id: "verify", agent: "operator", task: "Verify the release migration." },
		] },
	};
	assert.equal(callAdmissibilityFailure(workOnly), null);
	const result = scored([workOnly]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /expected at least 1 workflow approval phase\(s\), saw 0/);
});

test("minApprovalPhases counts the handler's approval kind, in workflow calls only", () => {
	// A messageless approval object is not an approval phase (the handler's
	// discriminator is approval.message), and a non-workflow mode has no
	// approval phases at all — the predicate must not be satisfiable there.
	const messageless = flowCallMatchesExpectation({ arguments: {
		why: "gated phases",
		task: "Release migration",
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
			{ id: "approve", approval: {} },
		] },
	} }, { mode: "workflow", minApprovalPhases: 1 });
	assert.equal(messageless.pass, false);
	assert.match(messageless.notes, /expected at least 1 workflow approval phase\(s\), saw 0/);
	const notWorkflow = flowCallMatchesExpectation({ arguments: {
		why: "review",
		tasks: [{ agent: "recon", task: "Review the release migration." }],
	} }, { minApprovalPhases: 1 });
	assert.equal(notWorkflow.pass, false);
	assert.match(notWorkflow.notes, /saw 0/);
});

test("a stray agent field on an approval phase does not poison the agents predicates", () => {
	// The handler validates approval XOR work on approval.message vs
	// agent+task, so an approval phase carrying an agent field is
	// schema-valid and runs — the allowlist and knownAgentsOnly must read
	// work phases only, or this admitted call scores as a false negative.
	const strayAgent = {
		why: "gated release migration",
		task: MIGRATION_TASK,
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release migration." },
			{ id: "verify", agent: "operator", task: "Verify the release migration." },
			{ id: "gate", approval: { message: "Approve migration" }, agent: "release-manager" },
		] },
	};
	assert.equal(callAdmissibilityFailure(strayAgent), null);
	const result = scored([strayAgent]);
	assert.equal(result.pass, true, result.notes);
});

test("a schema-invalid phase field is already refused by the SCHEMA_INVALID rider", () => {
	// The public schema types phase tasks as strings and pi refuses the call
	// at parameter validation, before every gate — so the handler-mirroring
	// truthiness of isWorkflowWorkPhase cannot false-green a malformed phase.
	const malformedTask = {
		why: "gated release migration",
		task: MIGRATION_TASK,
		workflow: { phases: [
			{ id: "analyze", agent: "recon", task: 123 },
			{ id: "verify", agent: "operator", task: "Verify the release migration." },
			{ id: "approve", approval: { message: "Approve migration" } },
		] },
	};
	assert.equal(callAdmissibilityFailure(malformedTask)?.code, "SCHEMA_INVALID");
	const result = scored([malformedTask]);
	assert.equal(result.pass, false);
});

test("the phase-gated case's dry-run mock passes the same scorer a live run gets", () => {
	const testCase = theWorkflowCase();
	const result = scoreSelection(testCase, {
		flowCalls: testCase.mock.flowCalls,
		flowCallArgs: testCase.mock.flowCallArgs ?? [],
		answer: testCase.mock.answer,
	});
	assert.equal(result.pass, true, result.notes);
});
