import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ApprovalAuthorization, approvalBindingDigest, approvalReceiptDigest, type ApprovalBinding, type ApprovalReceipt } from "../extensions/pi-flows/approval.ts";
import { freshDir, runFlow, STUB_REGISTRY } from "./stub-harness.ts";

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

function historicalV3Binding(digest: string, profile: { model?: string; thinking?: string } = {}): ApprovalBinding {
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
				model: profile.model ?? "test-provider/strong-model",
				thinking: profile.thinking ?? "high",
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

async function historicalState(cwd: string, child: unknown, workflowParams: any = params) {
	const resumedParams = { ...workflowParams, workflow: { ...workflowParams.workflow, resume: true } };
	await runFlow(workflowParams, {}, { cwd });
	await runFlow(resumedParams, { strategist: child }, { cwd, hasUI: true });
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

test("a partially spent v2 approval cannot be reopened over completed work", async () => {
	const cwd = await freshDir();
	const partialParams = {
		...params,
		workflow: {
			...params.workflow,
			phases: [
				params.workflow.phases[0],
				{ id: "first", agent: "strategist", task: "Ship first" },
				{ id: "second", agent: "strategist", task: "Ship second" },
			],
		},
	};
	await runFlow(partialParams, {}, { cwd });
	await runFlow({ ...partialParams, workflow: { ...partialParams.workflow, resume: true } }, { strategist: ["FIRST", { reply: "boom", exitCode: 1 }] }, { cwd, hasUI: true });
	const state = await readState(cwd);
	state.version = 2;
	state.outputs.approve = "APPROVED";
	delete state.receipts;
	await writeState(cwd, state);

	const resumed = await runFlow({ ...partialParams, workflow: { ...partialParams.workflow, resume: true } }, { strategist: "MUST NOT RUN" }, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error?.code, "WORKFLOW_STATE_INVALID");
	assert.match(resumed.result.details.error?.cause ?? "", /completed part of the gated action \(first\)/);
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, 2, "migration must refuse before remaining work runs");
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

test("an unspent v3 approval reopens when the next consecutive approval is incomplete", async () => {
	const cwd = await freshDir();
	const consecutiveParams = {
		task: "Approve both checkpoints.",
		agentScope: "user",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "first", approval: { message: "Approve first" } },
				{ id: "second", approval: { message: "Approve second" } },
			],
		},
	};
	let initialPrompts = 0;
	const denied = await runFlow(consecutiveParams, {}, { cwd, hasUI: true, ui: { confirm: async () => ++initialPrompts === 1 } });
	assert.equal(denied.result.details.error?.code, "WORKFLOW_APPROVAL_DENIED");
	const state = await readState(cwd);
	const historical: ApprovalBinding = {
		action: "workflow.phase:first",
		parameters: {
			approvalMessage: "Approve first",
			agentScope: "user",
			incompleteHandoffPolicy: "fail",
			handoffPolicy: { call: "warn", effective: "warn" },
			gatedPhases: [],
			debrief: null,
		},
		requestedBy: "flow:workflow",
		workflowDigest: state.digest,
		stateVersion: 3,
	};
	state.version = 3;
	state.receipts.first = asHistoricalReceipt(state.receipts.first, historical);
	await writeState(cwd, state);
	let resumedPrompts = 0;

	const resumed = await runFlow({ ...consecutiveParams, workflow: { ...consecutiveParams.workflow, resume: true } }, {}, { cwd, hasUI: true, ui: { confirm: async () => { resumedPrompts += 1; return true; } } });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumedPrompts, 2, "both the under-bound first consent and the incomplete second consent are asked again");
	assert.equal((await readState(cwd)).version, 4);
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

test("a completed v3 receipt migrates after its exact model leaves the current roster", async () => {
	const cwd = await freshDir();
	const pinnedParams = {
		...params,
		workflow: {
			...params.workflow,
			phases: [params.workflow.phases[0], { ...params.workflow.phases[1], model: "test-provider/strong-model" }],
		},
	};
	const { state } = await historicalState(cwd, "SHIPPED", pinnedParams);
	await writeState(cwd, state);
	const registry = { getAvailable: () => STUB_REGISTRY.getAvailable().filter((model) => model.id !== "strong-model") };

	const resumed = await runFlow({ ...pinnedParams, workflow: { ...pinnedParams.workflow, resume: true } }, {}, { cwd, registry });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].validation, "legacy-compatibility");
	assert.equal((await readState(cwd)).version, 4);
});

test("a completed v3 receipt reconstructs clamped Thinking after model metadata changes", async () => {
	const cwd = await freshDir();
	const model = "test-provider/plain-model";
	const plainParams = {
		...params,
		workflow: {
			...params.workflow,
			phases: [params.workflow.phases[0], { ...params.workflow.phases[1], model, thinking: "high" }],
		},
	};
	const registry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			{ id: "plain-model", provider: "test-provider", reasoning: false, contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 2 } },
		],
	};
	await runFlow(plainParams, {}, { cwd, registry });
	await runFlow({ ...plainParams, workflow: { ...plainParams.workflow, resume: true } }, { strategist: "SHIPPED" }, { cwd, hasUI: true, registry });
	const state = await readState(cwd);
	const binding = historicalV3Binding(state.digest, { model, thinking: "off" });
	state.version = 3;
	state.receipts.approve = asHistoricalReceipt(state.receipts.approve, binding);
	await writeState(cwd, state);
	const changedRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			{ id: "plain-model", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 2 } },
		],
	};

	const resumed = await runFlow({ ...plainParams, workflow: { ...plainParams.workflow, resume: true } }, { strategist: "MUST NOT RUN" }, { cwd, registry: changedRegistry });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].validation, "legacy-compatibility");
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, 1);
	assert.equal((await readState(cwd)).version, 4);
});

test("a completed v3 receipt reconstructs distinct Role clamps after model metadata changes", async () => {
	const cwd = await freshDir();
	const model = "test-provider/shared-model";
	const dualParams = {
		...params,
		workflow: {
			...params.workflow,
			phases: [
				params.workflow.phases[0],
				{ id: "ship-high", agent: "strategist", task: "Ship high", model, thinking: "high" },
				{ id: "ship-max", agent: "strategist", task: "Ship max", model, thinking: "max" },
			],
		},
	};
	const oldRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			{ id: "shared-model", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 2 } },
		],
	};
	await runFlow(dualParams, {}, { cwd, registry: oldRegistry });
	await runFlow({ ...dualParams, workflow: { ...dualParams.workflow, resume: true } }, { strategist: "SHIPPED" }, { cwd, hasUI: true, registry: oldRegistry });
	const state = await readState(cwd);
	const historical = historicalV3Binding(state.digest, { model, thinking: "high" });
	const phase = (historical.parameters as any).gatedPhases[0];
	historical.parameters = {
		...(historical.parameters as any),
		gatedPhases: [
			{ ...phase, id: "ship-high", task: "Ship high", thinking: "high" },
			{ ...phase, id: "ship-max", task: "Ship max", thinking: "max" },
		],
	};
	state.version = 3;
	state.receipts.approve = asHistoricalReceipt(state.receipts.approve, historical);
	await writeState(cwd, state);
	const changedRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			{
				id: "shared-model",
				provider: "test-provider",
				reasoning: true,
				thinkingLevelMap: { high: null, xhigh: null, max: null },
				contextWindow: 200_000,
				maxTokens: 8192,
				cost: { input: 1, output: 2 },
			},
		],
	};
	const incoherent = await runFlow({
		...dualParams,
		workflow: {
			...dualParams.workflow,
			resume: true,
			historicalThinking: { phases: { "ship-high": "high", "ship-max": "off" } },
		},
	}, {}, { cwd, registry: changedRegistry });
	assert.equal(incoherent.result.details.error?.code, "WORKFLOW_STATE_INVALID");
	assert.match(incoherent.result.details.error?.cause ?? "", /cannot come from one capability profile/);

	const resumed = await runFlow({ ...dualParams, workflow: { ...dualParams.workflow, resume: true } }, {}, { cwd, registry: changedRegistry });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].validation, "legacy-compatibility");
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, 2, "completed work is not dispatched again");
	assert.equal((await readState(cwd)).version, 4);
});

test("a v3 Thinking witness soundly reduces a search beyond the candidate bound", async () => {
	const cwd = await freshDir();
	const work = Array.from({ length: 7 }, (_, index) => ({
		id: `ship-${index + 1}`,
		agent: "strategist",
		task: `Ship part ${index + 1}`,
		model: `test-provider/historical-${index + 1}`,
		thinking: "max",
	}));
	const manyParams = {
		...params,
		workflow: { ...params.workflow, phases: [params.workflow.phases[0], ...work] },
	};
	const oldRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			...work.map((_, index) => ({
				id: `historical-${index + 1}`,
				provider: "test-provider",
				reasoning: true,
				thinkingLevelMap: { max: null },
				contextWindow: 200_000,
				maxTokens: 8192,
				cost: { input: 1, output: 2 },
			})),
		],
	};
	await runFlow(manyParams, {}, { cwd, registry: oldRegistry });
	await runFlow({ ...manyParams, workflow: { ...manyParams.workflow, resume: true } }, { strategist: "SHIPPED" }, { cwd, hasUI: true, registry: oldRegistry });
	const state = await readState(cwd);
	const historical: ApprovalBinding = {
		action: "workflow.phase:approve",
		parameters: {
			approvalMessage: "Approve the rollout",
			agentScope: "user",
			incompleteHandoffPolicy: "fail",
			handoffPolicy: { call: "warn", effective: "warn" },
			gatedPhases: work.map((phase) => ({
				...phase,
				cwd: null,
				tier: null,
				thinking: "xhigh",
				tools: null,
				checkCommand: null,
				contract: null,
				returnContract: null,
				requireEvidence: false,
			})),
			debrief: null,
		},
		requestedBy: "flow:workflow",
		workflowDigest: state.digest,
		stateVersion: 3,
	};
	state.version = 3;
	state.receipts.approve = asHistoricalReceipt(state.receipts.approve, historical);
	await writeState(cwd, state);
	const changedRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			...work.map((_, index) => ({ id: `historical-${index + 1}`, provider: "test-provider", reasoning: false, contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 2 } })),
		],
	};
	const bounded = await runFlow({ ...manyParams, workflow: { ...manyParams.workflow, resume: true } }, {}, { cwd, registry: changedRegistry });
	assert.equal(bounded.result.details.error?.code, "WORKFLOW_STATE_INVALID");
	assert.match(bounded.result.details.error?.cause ?? "", /823,543 coherent model-clamp candidates.*150,000 without declaring the receipt stale/);
	assert.equal((await readState(cwd)).version, 3, "a bounded search must leave the historical receipt retryable");
	const wrongWitness = await runFlow({
		...manyParams,
		workflow: {
			...manyParams.workflow,
			resume: true,
			historicalThinking: { phases: Object.fromEntries(work.map((phase) => [phase.id, "off"])) },
		},
	}, {}, { cwd, registry: changedRegistry });
	assert.equal(wrongWitness.result.details.error?.code, "APPROVAL_RECEIPT_STALE", "a witness that cannot reproduce the digest grants no compatibility");
	const hinted = {
		...manyParams,
		workflow: {
			...manyParams.workflow,
			resume: true,
			historicalThinking: { phases: { "ship-1": "xhigh" } },
		},
	};

	const resumed = await runFlow(hinted, {}, { cwd, registry: changedRegistry });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].validation, "legacy-compatibility");
	assert.equal(resumed.calls.filter((call) => call.agent === "strategist").length, 7, "completed work is not dispatched again");
	assert.equal((await readState(cwd)).version, 4);
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

test("a historical Thinking witness must identify a bound Role and reproduce the receipt", async () => {
	const cwd = await freshDir();
	const explicitParams = {
		...params,
		workflow: {
			...params.workflow,
			phases: [params.workflow.phases[0], { ...params.workflow.phases[1], model: "test-provider/strong-model", thinking: "high" }],
		},
	};
	const { state } = await historicalState(cwd, "SHIPPED", explicitParams);
	await writeState(cwd, state);
	const resume = { ...explicitParams, workflow: { ...explicitParams.workflow, resume: true } };
	const privateWitnessKey = path.join(homedir(), "historical-witness");
	const unknown = await runFlow({ ...resume, workflow: { ...resume.workflow, historicalThinking: { phases: { [privateWitnessKey]: "high" } } } }, {}, { cwd });
	assert.equal(unknown.result.details.error?.code, "WORKFLOW_STATE_INVALID");
	assert.equal(JSON.stringify(unknown.result.details.error).includes(homedir()), false, "witness keys are sanitized before they reach structured errors");

	const contradicted = await runFlow({ ...resume, workflow: { ...resume.workflow, historicalThinking: { phases: { ship: "off" } } } }, {}, { cwd });
	assert.equal(contradicted.result.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.equal((await readState(cwd)).version, 3, "an incorrect witness must not migrate the receipt");
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

test("a consumed v3 receipt resumes its interrupted debrief", async () => {
	const cwd = await freshDir();
	const model = "test-provider/plain-model";
	const debriefParams = {
		task: "Analyze and summarize.",
		agentScope: "user",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Approve synthesis" } },
			],
			debrief: { agent: "debrief", model, thinking: "high" },
		},
	};
	const oldRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			{ id: "plain-model", provider: "test-provider", reasoning: false, contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 2 } },
		],
	};
	await runFlow(debriefParams, { recon: "ANALYSIS", debrief: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true, registry: oldRegistry });
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
			debrief: { contract: null, returnContract: null, requireEvidence: false, tier: null, model, thinking: "off" },
		},
		requestedBy: "flow:workflow",
		workflowDigest: state.digest,
		stateVersion: 3,
	};
	state.version = 3;
	state.receipts.signoff = asHistoricalReceipt(state.receipts.signoff, historical);
	await writeState(cwd, state);

	const changedRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			{ id: "plain-model", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 2 } },
		],
	};
	const resumed = await runFlow({ ...debriefParams, workflow: { ...debriefParams.workflow, resume: true } }, { debrief: "SUMMARY" }, { cwd, registry: changedRegistry });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.calls.filter((call) => call.agent === "debrief").length, 2);
	const migrated = await readState(cwd);
	assert.equal(migrated.version, 4);
	assert.equal(migrated.status, "completed");
	assert.equal(migrated.receipts.signoff.validation, "legacy-compatibility");
	assert.equal(migrated.receipts.signoff.receiptId, original.receiptId);
	assert.equal(migrated.receipts.signoff.consumedAt, original.consumedAt);
});

test("a completed historical debrief receipt migrates after its exact model leaves the roster", async () => {
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
			debrief: { agent: "debrief", model: "test-provider/session-model" },
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

	const registry = { getAvailable: () => STUB_REGISTRY.getAvailable().filter((model) => model.id !== "session-model") };
	const resumed = await runFlow({ ...debriefParams, workflow: { ...debriefParams.workflow, resume: true } }, { debrief: "MUST NOT RUN" }, { cwd, registry });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.calls.filter((call) => call.agent === "debrief").length, 1);
	const migrated = (await readState(cwd)).receipts.signoff;
	assert.equal(migrated.validation, "legacy-compatibility");
	assert.equal(migrated.receiptId, original.receiptId);
	assert.equal(migrated.approvedBy, original.approvedBy);
	assert.equal(migrated.consumedAt, original.consumedAt);
});
