import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ApprovalAuthorization, approvalBindingDigest, approvalReceiptDigest, type ApprovalBinding, type ApprovalReceipt } from "../extensions/pi-flows/approval.ts";
import { freshDir, runFlow } from "./stub-harness.ts";

const params = {
	task: "Ship the release.",
	agentScope: "user",
	workflow: {
		stateFile: "workflow.json",
		phases: [
			{ id: "approve", approval: { message: "Approve the rollout" } },
			{ id: "ship", agent: "strategist", task: "Ship it" },
		],
	},
};

const resumeParams = { ...params, workflow: { ...params.workflow, resume: true } };

const readState = async (cwd: string) => JSON.parse(await readFile(path.join(cwd, "workflow.json"), "utf8"));
const writeState = async (cwd: string, state: unknown) => writeFile(path.join(cwd, "workflow.json"), `${JSON.stringify(state, null, 2)}\n`);

function historicalV3Binding(digest: string): ApprovalBinding {
	return {
		action: "workflow.phase:approve",
		parameters: {
			approvalMessage: "Approve the rollout",
			agentScope: "user",
			incompleteHandoffPolicy: "fail",
			handoffPolicy: { call: "warn", effective: "warn" },
			gatedPhases: [{
				id: "ship",
				agent: "strategist",
				task: "Ship it",
				cwd: null,
				tier: null,
				model: "test-provider/strong-model",
				thinking: "high",
				tools: null,
				checkCommand: null,
				contract: null,
				returnContract: null,
				requireEvidence: false,
			}],
			debrief: null,
		},
		requestedBy: "flow:workflow",
		workflowDigest: digest,
		stateVersion: 3,
	};
}

function asHistoricalReceipt(receipt: ApprovalReceipt, binding: ApprovalBinding, overrides: Partial<ApprovalReceipt> = {}): ApprovalReceipt {
	const unsealed = {
		...receipt,
		stateVersion: 3,
		bindingDigest: approvalBindingDigest(binding),
		...overrides,
	};
	return { ...unsealed, receiptDigest: approvalReceiptDigest(unsealed) };
}

async function historicalState(cwd: string, child: unknown) {
	await runFlow(params, {}, { cwd });
	await runFlow(resumeParams, { strategist: child }, { cwd, hasUI: true });
	const state = await readState(cwd);
	const binding = historicalV3Binding(state.digest);
	state.version = 3;
	state.receipts.approve = asHistoricalReceipt(state.receipts.approve, binding);
	const fixture = ApprovalAuthorization.verify(state.receipts.approve, binding, { consumer: binding.action });
	assert.equal(fixture.error, undefined, "the fixture must be a valid pre-profile receipt");
	return { state, binding };
}

test("a fully spent v2 approval migrates to audit-only evidence", async () => {
	const cwd = await freshDir();
	const { state } = await historicalState(cwd, "SHIPPED");
	state.version = 2;
	state.outputs.approve = "APPROVED";
	delete state.receipts;
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams, { strategist: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].validation, "legacy-compatibility");
	assert.equal(resumed.result.details.approvals?.[0].expiresAt, null);
	assert.equal(resumed.result.details.approvals?.[0].consumedBy, "workflow.phase:approve");
	assert.equal((await readState(cwd)).version, 4);
	const shipped = resumed.calls.filter((call) => call.agent === "strategist").length;

	const widened = await runFlow({ ...resumeParams, agentScope: "all", confirmProjectAgents: false }, { strategist: "MUST NOT RUN" }, { cwd, hasUI: true });
	assert.equal(widened.result.details.error, undefined);
	assert.match(widened.text, /already completed; no Child reran/);
	assert.equal(widened.calls.filter((call) => call.agent === "strategist").length, shipped);
	assert.equal(widened.result.details.approvals?.[0].validation, "legacy-compatibility");
});

test("an unspent historical receipt reopens before more work runs", async () => {
	const cwd = await freshDir();
	const { state } = await historicalState(cwd, { reply: "boom", exitCode: 1 });
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams, { strategist: "SHIPPED" }, { cwd });
	assert.equal(resumed.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, 1);
	assert.equal((await readState(cwd)).version, 4);
});

test("an unspent historical receipt consumed by another action remains a hard failure", async () => {
	const cwd = await freshDir();
	const { state, binding } = await historicalState(cwd, { reply: "boom", exitCode: 1 });
	state.receipts.approve = asHistoricalReceipt(state.receipts.approve, binding, {
		consumedAt: new Date().toISOString(),
		consumedBy: "workflow.phase:other",
	});
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams, { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error?.code, "APPROVAL_RECEIPT_CONSUMED");
});

test("a malformed historical receipt remains a hard failure", async () => {
	const cwd = await freshDir();
	const { state, binding } = await historicalState(cwd, { reply: "boom", exitCode: 1 });
	state.receipts.approve = asHistoricalReceipt(state.receipts.approve, binding, { expiresAt: "not-a-timestamp" });
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams, { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error?.code, "APPROVAL_RECEIPT_INVALID");
	assert.equal(resumed.result.details.approvals?.[0].validation, "unverified");
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, 1);
});

test("a fully spent historical receipt migrates as audit evidence without authorizing more work", async () => {
	const cwd = await freshDir();
	const { state } = await historicalState(cwd, "SHIPPED");
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams, { strategist: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].validation, "legacy-compatibility");
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, 1, "completed work is not dispatched again");
});

test("a stale fully spent v3 receipt keeps its version so restoring conditions can retry migration", async () => {
	const cwd = await freshDir();
	const { state } = await historicalState(cwd, "SHIPPED");
	await writeState(cwd, state);

	const drifted = await runFlow({ ...resumeParams, thinking: "max" }, {}, { cwd });
	assert.equal(drifted.result.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.equal((await readState(cwd)).version, 3, "a failed migration must not strand the historical receipt under v4 semantics");

	const restored = await runFlow(resumeParams, {}, { cwd });
	assert.equal(restored.result.details.error, undefined);
	assert.equal((await readState(cwd)).version, 4);
});

test("an unspent v3 receipt cannot be rebound as completed audit evidence", async () => {
	const cwd = await freshDir();
	const { state, binding } = await historicalState(cwd, "SHIPPED");
	state.receipts.approve = asHistoricalReceipt(state.receipts.approve, binding, { consumedAt: null, consumedBy: null });
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams, {}, { cwd });
	assert.equal(resumed.result.details.error?.code, "APPROVAL_RECEIPT_INVALID");
	assert.equal((await readState(cwd)).version, 3);
});

test("a completed state missing one of its phases is refused instead of treated as a no-op", async () => {
	const cwd = await freshDir();
	await runFlow(params, {}, { cwd });
	const completed = await runFlow(resumeParams, { strategist: "SHIPPED" }, { cwd, hasUI: true });
	const state = await readState(cwd);
	state.completedPhaseIds = state.completedPhaseIds.filter((id: string) => id !== "ship");
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams, { strategist: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error?.code, "WORKFLOW_STATE_INVALID");
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, completed.calls.filter((call) => call.agent === "strategist").length);
});

test("a completed historical debrief receipt keeps its audit identity and cannot rerun the debrief", async () => {
	const cwd = await freshDir();
	const debriefParams = {
		task: "Analyze and summarize.",
		agentScope: "user",
		thinking: "low",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Approve synthesis" } },
			],
			debrief: { agent: "debrief" },
		},
	};
	await runFlow(debriefParams, { recon: "ANALYSIS", debrief: "SUMMARY" }, { cwd, hasUI: true });
	const state = await readState(cwd);
	const original = { ...state.receipts.signoff };
	const historical: ApprovalBinding = {
		action: "workflow.phase:signoff",
		parameters: {
			approvalMessage: "Approve synthesis",
			agentScope: "user",
			incompleteHandoffPolicy: "fail",
			handoffPolicy: { call: "warn", effective: "warn" },
			gatedPhases: [],
			debrief: { contract: null, returnContract: null, requireEvidence: false, tier: null, model: "test-provider/session-model", thinking: "low" },
		},
		requestedBy: "flow:workflow",
		workflowDigest: state.digest,
		stateVersion: 3,
	};
	state.version = 3;
	state.receipts.signoff = asHistoricalReceipt(state.receipts.signoff, historical);
	await writeState(cwd, state);

	const resumed = await runFlow({ ...debriefParams, workflow: { ...debriefParams.workflow, resume: true } }, { debrief: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.calls.filter((call) => call.agent === "debrief").length, 1);
	const migrated = (await readState(cwd)).receipts.signoff;
	assert.equal(migrated.validation, "legacy-compatibility");
	assert.equal(migrated.receiptId, original.receiptId);
	assert.equal(migrated.approvedBy, original.approvedBy);
	assert.equal(migrated.consumedAt, original.consumedAt);
});
