// Workflow content identity (#144): the canonical digest that names persisted
// workflow state, the order-sensitive legacy digest it replaces, and the resume
// paths that carry state files and Approval receipts across the transition.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { approvalBindingDigest, approvalReceiptDigest, type ApprovalBinding, type ApprovalReceipt } from "../extensions/pi-flows/approval.ts";
import { legacyWorkflowDigest, workflowDigest } from "../extensions/pi-flows/modes/workflow-state.ts";
import { byAgent, freshDir, runFlow } from "./stub-harness.ts";

// A spec whose objects carry nested structure at every level the digest walks:
// phase fields, an approval object, a contract, and a debrief.
const contract = {
	objective: "Scan the release.",
	constraints: ["Read only."],
	authority: { may: ["Read files."], mustNot: ["Write files."], requiresApproval: [] },
};
const spec = {
	phases: [
		{ id: "scan", agent: "recon", task: "Scan {task}", contract },
		{ id: "gate", approval: { message: "Approve the scan" } },
	],
	debrief: { agent: "debrief", tier: "deep" },
};
// The same content with object keys reordered at every nesting level.
const reordered = {
	debrief: { tier: "deep", agent: "debrief" },
	phases: [
		{ contract: { authority: { requiresApproval: [], mustNot: ["Write files."], may: ["Read files."] }, constraints: ["Read only."], objective: "Scan the release." }, task: "Scan {task}", agent: "recon", id: "scan" },
		{ approval: { message: "Approve the scan" }, id: "gate" },
	],
};

test("the workflow digest identifies content, not authoring order", () => {
	const canonical = workflowDigest("prepare the release", spec);
	assert.match(canonical, /^[0-9a-f]{16}$/, "the digest stays a filename-safe 16-hex short form");
	assert.equal(workflowDigest("prepare the release", reordered), canonical, "reordering object keys at any nesting level must not read as different work");
});

test("every meaning-bearing field changes the workflow digest", () => {
	const base = workflowDigest("prepare the release", spec);
	const variants: Array<[string, string, any]> = [
		["task text", "prepare the hotfix", spec],
		["phase order", "prepare the release", { ...spec, phases: [...spec.phases].reverse() }],
		["phase task value", "prepare the release", { ...spec, phases: [{ ...spec.phases[0], task: "Scan everything" }, spec.phases[1]] }],
		["approval meaning", "prepare the release", { ...spec, phases: [spec.phases[0], { id: "gate", approval: { message: "Approve the rollout" } }] }],
		["debrief meaning", "prepare the release", { ...spec, debrief: { agent: "debrief", tier: "fast" } }],
		["debrief removed", "prepare the release", { phases: spec.phases }],
	];
	for (const [field, task, changed] of variants) {
		assert.notEqual(workflowDigest(task, changed), base, `changing ${field} must produce a different identity`);
	}
});

// --- The legacy state-file transition ---------------------------------------

const workParams = {
	task: "prepare the release",
	workflow: {
		phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release" },
			{ id: "plan", agent: "strategist", task: "Plan from {phase.analyze}" },
		],
	},
};
const stateDir = (cwd: string) => path.join(cwd, ".pi", "flow-workflows");
const canonicalPath = (cwd: string, params: any = workParams) => path.join(stateDir(cwd), `${workflowDigest(params.task, params.workflow)}.json`);
const legacyPath = (cwd: string, params: any = workParams) => path.join(stateDir(cwd), `${legacyWorkflowDigest(params.task, params.workflow)}.json`);

/** Rewrite a current state file into the v4-era record the old release would have left behind: version 4, named and stamped by the order-sensitive digest. */
async function plantLegacyState(cwd: string, params: any = workParams, edit: (state: any) => void = () => {}): Promise<void> {
	const state = JSON.parse(await readFile(canonicalPath(cwd, params), "utf8"));
	state.version = 4;
	state.digest = legacyWorkflowDigest(params.task, params.workflow);
	edit(state);
	await writeFile(legacyPath(cwd, params), `${JSON.stringify(state, null, 2)}\n`);
	await rm(canonicalPath(cwd, params));
}

test("a default-named legacy state file is found, migrated, and retired under the canonical name", async () => {
	const cwd = await freshDir();
	await runFlow(workParams, { recon: "ANALYSIS", strategist: { reply: "boom", exitCode: 1 } }, { cwd });
	await plantLegacyState(cwd);

	const resumed = await runFlow({ ...workParams, workflow: { ...workParams.workflow, resume: true } }, { strategist: "PLAN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(byAgent(resumed.calls, "recon").length, 1, "completed work is not dispatched again");
	assert.match(byAgent(resumed.calls, "strategist").at(-1)?.task ?? "", /ANALYSIS/, "migrated phase outputs still feed later phases");
	const migrated = JSON.parse(await readFile(canonicalPath(cwd), "utf8"));
	assert.equal(migrated.version, 5);
	assert.equal(migrated.digest, workflowDigest(workParams.task, workParams.workflow));
	assert.equal(existsSync(legacyPath(cwd)), false, "the legacy-named file is retired so no later lookup sees two candidates");
});

test("a resume whose spec reorders object keys still finds and matches its state", async () => {
	const cwd = await freshDir();
	await runFlow(workParams, { recon: "ANALYSIS", strategist: { reply: "boom", exitCode: 1 } }, { cwd });
	const shuffled = {
		task: workParams.task,
		workflow: {
			resume: true,
			phases: [
				{ task: "Analyze the release", agent: "recon", id: "analyze" },
				{ task: "Plan from {phase.analyze}", agent: "strategist", id: "plan" },
			],
		},
	};

	const resumed = await runFlow(shuffled, { strategist: "PLAN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined, "reordered keys must not read as different work");
	assert.equal(byAgent(resumed.calls, "recon").length, 1);
});

test("an explicit legacy state path migrates in place", async () => {
	const cwd = await freshDir();
	const explicit = { ...workParams, workflow: { ...workParams.workflow, stateFile: "workflow.json" } };
	await runFlow(explicit, { recon: "ANALYSIS", strategist: { reply: "boom", exitCode: 1 } }, { cwd });
	const file = path.join(cwd, "workflow.json");
	const state = JSON.parse(await readFile(file, "utf8"));
	state.version = 4;
	state.digest = legacyWorkflowDigest(explicit.task, explicit.workflow);
	await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);

	const resumed = await runFlow({ ...explicit, workflow: { ...explicit.workflow, resume: true } }, { strategist: "PLAN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	const migrated = JSON.parse(await readFile(file, "utf8"));
	assert.equal(migrated.version, 5);
	assert.equal(migrated.digest, workflowDigest(explicit.task, explicit.workflow));
});

test("when both digest-named files exist, the canonical one is selected and the legacy one is left alone", async () => {
	const cwd = await freshDir();
	await runFlow(workParams, { recon: "ANALYSIS", strategist: "PLAN" }, { cwd });
	await writeFile(legacyPath(cwd), `${JSON.stringify({ version: 4, digest: legacyWorkflowDigest(workParams.task, workParams.workflow), status: "running", completedPhaseIds: [], outputs: {}, handoffs: {}, attestations: {}, receipts: {}, updatedAt: new Date().toISOString() }, null, 2)}\n`);

	const resumed = await runFlow({ ...workParams, workflow: { ...workParams.workflow, resume: true } }, { recon: "MUST NOT RUN", strategist: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.match(resumed.text, /already completed; no Child reran/);
	assert.equal(existsSync(legacyPath(cwd)), true, "an unselected legacy file is never deleted");
});

test("a legacy state that matches neither digest fails with the migration error, never as fresh work", async () => {
	const cwd = await freshDir();
	await runFlow(workParams, { recon: "ANALYSIS", strategist: { reply: "boom", exitCode: 1 } }, { cwd });
	await plantLegacyState(cwd, workParams, (state) => {
		state.digest = "0123456789abcdef";
	});

	const resumed = await runFlow({ ...workParams, workflow: { ...workParams.workflow, resume: true } }, { recon: "MUST NOT RUN", strategist: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error?.code, "WORKFLOW_STATE_INVALID");
	assert.equal(byAgent(resumed.calls, "strategist").length, 1, "no phase runs against unmatched state");
});

// --- Approval receipts across the identity transition ------------------------

/** The v4 encoding of an approval that gates no Role profiles — every field is knowable by hand, exactly like the v3 fixtures in approval-profile-migration.test.ts. */
function v4Binding(action: string, message: string, legacyDigest: string): ApprovalBinding {
	return {
		action,
		parameters: {
			approvalMessage: message,
			agentScope: "user",
			incompleteHandoffPolicy: "fail",
			handoffPolicy: { call: "warn", effective: "warn" },
			gatedPhases: [],
			debrief: null,
		},
		requestedBy: "flow:workflow",
		workflowDigest: legacyDigest,
		stateVersion: 4,
	};
}

/** Rewrite one live receipt into the record the v4 release would have persisted for the same consent. */
function asV4Receipt(receipt: ApprovalReceipt, binding: ApprovalBinding): ApprovalReceipt {
	const unsealed = { ...receipt, stateVersion: 4, workflowDigest: binding.workflowDigest, bindingDigest: approvalBindingDigest(binding) };
	return { ...unsealed, receiptDigest: approvalReceiptDigest(unsealed) };
}

const approvalParams = {
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

test("an unspent v4 receipt is rebound on resume instead of re-asking for granted consent", async () => {
	const cwd = await freshDir();
	let prompts = 0;
	const denied = await runFlow(approvalParams, {}, { cwd, hasUI: true, ui: { confirm: async () => ++prompts === 1 } });
	assert.equal(denied.result.details.error?.code, "WORKFLOW_APPROVAL_DENIED");
	const file = path.join(cwd, "workflow.json");
	const state = JSON.parse(await readFile(file, "utf8"));
	const legacyDigest = legacyWorkflowDigest(approvalParams.task, approvalParams.workflow);
	const original = { ...state.receipts.first };
	state.version = 4;
	state.digest = legacyDigest;
	state.receipts.first = asV4Receipt(state.receipts.first, v4Binding("workflow.phase:first", "Approve first", legacyDigest));
	await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
	let resumedPrompts = 0;

	const resumed = await runFlow({ ...approvalParams, workflow: { ...approvalParams.workflow, resume: true } }, {}, { cwd, hasUI: true, ui: { confirm: async () => { resumedPrompts += 1; return true; } } });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumedPrompts, 1, "only the never-granted second consent is asked; the first is rebound, not re-asked");
	const migrated = JSON.parse(await readFile(file, "utf8"));
	assert.equal(migrated.version, 5);
	assert.equal(migrated.receipts.first.receiptId, original.receiptId);
	assert.equal(migrated.receipts.first.validation, "typed", "a rebinding that re-encodes the same fully bound action is not weaker evidence");
	assert.equal(migrated.receipts.first.workflowDigest, workflowDigest(approvalParams.task, approvalParams.workflow));
	assert.equal(migrated.receipts.first.stateVersion, 5);
});

const trailingParams = {
	task: "Ship then sign off.",
	agentScope: "user",
	workflow: {
		stateFile: "workflow.json",
		phases: [
			{ id: "ship", agent: "recon", task: "Ship it" },
			{ id: "signoff", approval: { message: "Approve completion" } },
		],
	},
};

/** A completed trailing-approval workflow rewritten into its v4-era record. */
async function completedV4State(cwd: string): Promise<{ file: string; original: ApprovalReceipt }> {
	const completed = await runFlow(trailingParams, { recon: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(completed.result.details.error, undefined);
	const file = path.join(cwd, "workflow.json");
	const state = JSON.parse(await readFile(file, "utf8"));
	const legacyDigest = legacyWorkflowDigest(trailingParams.task, trailingParams.workflow);
	const original = { ...state.receipts.signoff };
	state.version = 4;
	state.digest = legacyDigest;
	state.receipts.signoff = asV4Receipt(state.receipts.signoff, v4Binding("workflow.phase:signoff", "Approve completion", legacyDigest));
	await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
	return { file, original };
}

test("a spent v4 receipt migrates with its consumption record intact and reruns nothing", async () => {
	const cwd = await freshDir();
	const { file, original } = await completedV4State(cwd);

	const resumed = await runFlow({ ...trailingParams, workflow: { ...trailingParams.workflow, resume: true } }, { recon: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.match(resumed.text, /already completed; no Child reran/);
	assert.equal(byAgent(resumed.calls, "recon").length, 1);
	const migrated = JSON.parse(await readFile(file, "utf8"));
	assert.equal(migrated.version, 5);
	assert.equal(migrated.receipts.signoff.receiptId, original.receiptId);
	assert.equal(migrated.receipts.signoff.consumedAt, original.consumedAt);
	assert.equal(migrated.receipts.signoff.consumedBy, original.consumedBy);
	assert.equal(migrated.receipts.signoff.approvedBy, original.approvedBy);
	assert.equal(migrated.receipts.signoff.validation, "typed");
});

test("a spent v4 receipt whose approved conditions drifted fails migration and stays retryable", async () => {
	const cwd = await freshDir();
	const { file } = await completedV4State(cwd);

	const drifted = await runFlow({ ...trailingParams, incompleteHandoffPolicy: "include", workflow: { ...trailingParams.workflow, resume: true } }, { recon: "MUST NOT RUN" }, { cwd });
	assert.equal(drifted.result.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.equal(JSON.parse(await readFile(file, "utf8")).version, 4, "a failed migration must not strand the legacy receipt under v5 semantics");

	const restored = await runFlow({ ...trailingParams, workflow: { ...trailingParams.workflow, resume: true } }, { recon: "MUST NOT RUN" }, { cwd });
	assert.equal(restored.result.details.error, undefined);
	assert.equal(JSON.parse(await readFile(file, "utf8")).version, 5);
	assert.equal(byAgent(restored.calls, "recon").length, 1);
});

test("the legacy digest reproduces the order-sensitive v4 identity, and never collides with the canonical one", () => {
	const legacySpec = { phases: [{ id: "one", agent: "recon", task: "Scan {task}" }] };
	// Golden value computed by the pre-#144 algorithm for exactly this input.
	assert.equal(legacyWorkflowDigest("prepare the release", legacySpec), "610e8df181ec7c05", "legacy state files must keep resolving to their original digest");
	assert.notEqual(workflowDigest("prepare the release", legacySpec), legacyWorkflowDigest("prepare the release", legacySpec), "the two identities must never name the same default state file");
});
