import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { freshDir, runFlow, STUB_REGISTRY, type Call } from "./stub-harness.ts";

const workflowParams = (agent = "strategist") => ({
	task: "Ship the release.",
	agentScope: "project",
	confirmProjectAgents: false,
	workflow: {
		stateFile: "workflow.json",
		phases: [
			{ id: "approve", approval: { message: "Approve the rollout" } },
			{ id: "ship", agent, task: "Ship it" },
		],
	},
});

const resume = (params: ReturnType<typeof workflowParams>) => ({
	...params,
	workflow: { ...params.workflow, resume: true },
});

const callsByAgent = (calls: Call[], agent: string) => calls.filter((call) => call.agent === agent).length;

async function installProjectAgent(cwd: string, options: { name: string; prompt: string; tools?: string | null; model?: string; thinking?: string | null }) {
	const projectAgents = path.join(cwd, ".pi", "flow-agents");
	await mkdir(projectAgents, { recursive: true });
	await writeFile(path.join(projectAgents, `${options.name}.md`), [
		"---",
		`name: ${options.name}`,
		"description: Approval profile fixture.",
		...(options.tools === null ? [] : [`tools: ${options.tools ?? "read"}`]),
		`model: ${options.model ?? "test-provider/session-model"}`,
		...(options.thinking === null ? [] : [`thinking: ${options.thinking ?? "low"}`]),
		"---",
		"",
		options.prompt,
		"",
	].join("\n"), "utf8");
}

async function issueUnspentReceipt(cwd: string, params: ReturnType<typeof workflowParams>, agent: string) {
	const paused = await runFlow(params, {}, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	const failed = await runFlow(resume(params), { [agent]: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });
	assert.equal(failed.result.details.approvals?.[0].status, "issued");
	return failed;
}

test("a same-name Agent selected from a different source reopens approval", async () => {
	const cwd = await freshDir();
	const params = workflowParams();
	const failed = await issueUnspentReceipt(cwd, params, "strategist");
	const callsBeforeDrift = callsByAgent(failed.calls, "strategist");

	const projectAgents = path.join(cwd, ".pi", "flow-agents");
	await mkdir(projectAgents, { recursive: true });
	const packageAgent = await readFile(path.resolve("agents/strategist.md"), "utf8");
	await writeFile(path.join(projectAgents, "strategist.md"), packageAgent, "utf8");

	const drifted = await runFlow(resume(params), { strategist: "SHIPPED" }, { cwd });
	assert.equal(drifted.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.equal(callsByAgent(drifted.calls, "strategist"), callsBeforeDrift, "source drift must be caught before another Child runs");
});

test("editing the selected Agent prompt reopens approval without persisting prompt text", async () => {
	const cwd = await freshDir();
	const name = "profile-agent";
	const originalPrompt = "ORIGINAL_PROFILE_PROMPT_SENTINEL";
	const changedPrompt = "CHANGED_PROFILE_PROMPT_SENTINEL";
	await installProjectAgent(cwd, { name, prompt: originalPrompt });
	const params = workflowParams(name);
	const failed = await issueUnspentReceipt(cwd, params, name);
	const callsBeforeDrift = callsByAgent(failed.calls, name);

	await installProjectAgent(cwd, { name, prompt: changedPrompt });
	const drifted = await runFlow(resume(params), { [name]: "SHIPPED" }, { cwd });
	assert.equal(drifted.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.equal(callsByAgent(drifted.calls, name), callsBeforeDrift);

	const persisted = await readFile(path.join(cwd, "workflow.json"), "utf8");
	assert.doesNotMatch(persisted, new RegExp(`${originalPrompt}|${changedPrompt}`), "receipts persist prompt identity, never prompt text");
});

test("expanding inherited Agent tools reopens approval", async () => {
	const cwd = await freshDir();
	const name = "tool-profile-agent";
	await installProjectAgent(cwd, { name, prompt: "Keep the prompt stable.", tools: "read" });
	const params = workflowParams(name);
	const failed = await issueUnspentReceipt(cwd, params, name);
	const callsBeforeDrift = callsByAgent(failed.calls, name);

	await installProjectAgent(cwd, { name, prompt: "Keep the prompt stable.", tools: "read,write" });
	const drifted = await runFlow(resume(params), { [name]: "SHIPPED" }, { cwd });
	assert.equal(drifted.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.equal(callsByAgent(drifted.calls, name), callsBeforeDrift, "expanded authority must be approved before dispatch");
});

test("an unchanged effective tool override resumes on the original receipt", async () => {
	const cwd = await freshDir();
	const name = "overridden-tool-agent";
	await installProjectAgent(cwd, { name, prompt: "Keep the prompt stable.", tools: "read" });
	const base = workflowParams(name);
	const params = {
		...base,
		workflow: {
			...base.workflow,
			phases: [base.workflow.phases[0], { ...base.workflow.phases[1], tools: "none" }],
		},
	};
	await issueUnspentReceipt(cwd, params, name);
	const receiptId = JSON.parse(await readFile(path.join(cwd, "workflow.json"), "utf8")).receipts.approve.receiptId;

	await installProjectAgent(cwd, { name, prompt: "Keep the prompt stable.", tools: "read,write" });
	const resumed = await runFlow(resume(params), { [name]: "SHIPPED" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].receiptId, receiptId, "unchanged effective authority keeps the original consent");
});

test("changing the default working directory reopens approval", async () => {
	const approvedCwd = await freshDir();
	const resumedCwd = await freshDir();
	const base = workflowParams();
	const params = {
		...base,
		workflow: { ...base.workflow, stateFile: path.join(approvedCwd, "workflow.json") },
	};
	await issueUnspentReceipt(approvedCwd, params, "strategist");

	const drifted = await runFlow(resume(params), { strategist: "SHIPPED" }, { cwd: resumedCwd });
	assert.equal(drifted.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.equal(callsByAgent(drifted.calls, "strategist"), 0, "the Role must not run in a working directory that was not approved");
});

test("an approved exact model disappearing from the registry fails closed before fuzzy retargeting", async () => {
	const cwd = await freshDir();
	const name = "vanishing-model-agent";
	await installProjectAgent(cwd, { name, prompt: "Stable profile.", model: "test-provider/session-model" });
	const params = workflowParams(name);
	const failed = await issueUnspentReceipt(cwd, params, name);
	const callsBeforeDrift = callsByAgent(failed.calls, name);
	const replacementRegistry = {
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable().filter((model) => model.id !== "session-model"),
			{ id: "session-model-v2", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 3, output: 12 } },
		],
	};

	const resumed = await runFlow(resume(params), { [name]: "MUST NOT RUN" }, { cwd, registry: replacementRegistry });
	assert.equal(resumed.result.details.error?.code, "WORKFLOW_INVALID");
	assert.equal(callsByAgent(resumed.calls, name), callsBeforeDrift, "Pi must not fuzzy-retarget the vanished exact model");
});

test("editing a gated debrief after it began preserves the consumed receipt and refuses", async () => {
	const cwd = await freshDir();
	const name = "profile-debrief";
	await installProjectAgent(cwd, { name, prompt: "Original debrief profile." });
	const params = {
		task: "Analyze and summarize.",
		agentScope: "project",
		confirmProjectAgents: false,
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Approve synthesis" } },
			],
			debrief: { agent: name },
		},
	};
	const resumedParams = { ...params, workflow: { ...params.workflow, resume: true } };
	const paused = await runFlow(params, { recon: "ANALYSIS" }, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	const failed = await runFlow(resumedParams, { [name]: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });
	const callsBeforeDrift = callsByAgent(failed.calls, name);
	const receiptId = failed.result.details.approvals?.[0].receiptId;

	await installProjectAgent(cwd, { name, prompt: "Changed debrief profile." });
	const drifted = await runFlow(resumedParams, { [name]: "SUMMARY" }, { cwd });
	assert.equal(drifted.result.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.match(drifted.result.details.error?.cause ?? "", /gated debrief began/);
	assert.equal(drifted.result.details.approvals?.[0].receiptId, receiptId, "the consumed audit record must not be replaced");
	assert.equal(callsByAgent(drifted.calls, name), callsBeforeDrift, "the changed debrief must not run on consumed consent");

	await installProjectAgent(cwd, { name, prompt: "Original debrief profile." });
	const restored = await runFlow(resumedParams, { [name]: "SUMMARY" }, { cwd });
	assert.equal(restored.result.details.error, undefined);
	assert.ok(callsByAgent(restored.calls, name) > callsBeforeDrift, "restoring the consumed receipt's profile allows its debrief retry");
});

test("resuming a completed workflow is a no-op even after its debrief profile drifts", async () => {
	const cwd = await freshDir();
	const name = "completed-profile-debrief";
	await installProjectAgent(cwd, { name, prompt: "Original completed debrief." });
	const params = {
		task: "Analyze and summarize.",
		agentScope: "project",
		confirmProjectAgents: false,
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Approve synthesis" } },
			],
			debrief: { agent: name },
		},
	};
	const completed = await runFlow(params, { recon: "ANALYSIS", [name]: "SUMMARY" }, { cwd, hasUI: true });
	const debriefCalls = callsByAgent(completed.calls, name);
	await installProjectAgent(cwd, { name, prompt: "Changed after completion." });

	const resumed = await runFlow({ ...params, workflow: { ...params.workflow, resume: true } }, { [name]: "MUST NOT RUN" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.match(resumed.text, /already completed; no Child reran/);
	assert.equal(callsByAgent(resumed.calls, name), debriefCalls);
	assert.equal(JSON.parse(await readFile(path.join(cwd, "workflow.json"), "utf8")).status, "completed");
});

test("a gated debrief receipt is durably consumed before its Child starts", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Summarize.",
		thinking: "low",
		workflow: {
			stateFile: "workflow.json",
			phases: [{ id: "signoff", approval: { message: "Approve synthesis" } }],
			debrief: { agent: "debrief" },
		},
	};
	const running = runFlow(params, { debrief: { reply: "SUMMARY", delayBeforeReplyMs: 500 } }, { cwd, hasUI: true });
	try {
		let debriefStarted = false;
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const calls = await readFile(path.join(cwd, "calls.jsonl"), "utf8").catch(() => "");
			if (calls.includes('"agent":"debrief"')) {
				debriefStarted = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(debriefStarted, true, "the fixture must observe the live debrief");
		const liveState = JSON.parse(await readFile(path.join(cwd, "workflow.json"), "utf8"));
		assert.equal(typeof liveState.receipts.signoff.consumedAt, "string", "consumption must reach disk before debrief execution");
	} finally {
		await running;
	}
});

test("approval is refused before consent when the selected Agent profile is missing", async () => {
	const cwd = await freshDir();
	const base = workflowParams("missing-profile-agent");
	const params = {
		...base,
		model: "test-provider/session-model",
		thinking: "low",
		workflow: {
			...base.workflow,
			phases: [base.workflow.phases[0], { ...base.workflow.phases[1], tools: "read" }],
		},
	};
	let approvalPrompts = 0;
	const refused = await runFlow(params, {}, {
		cwd,
		hasUI: true,
		ui: { confirm: async () => { approvalPrompts += 1; return true; } },
	});
	assert.equal(refused.result.details.error?.code, "WORKFLOW_INVALID");
	assert.equal(approvalPrompts, 0, "the workflow must fail closed before asking for under-bound consent");
	assert.equal(refused.calls.length, 0);
});

test("an unbindable-profile refusal redacts and caps authored phase ids", async () => {
	const cwd = await freshDir();
	const base = workflowParams("missing-profile-agent");
	const homePhaseId = path.join(os.homedir(), "profile-phase");
	const params = {
		...base,
		model: "test-provider/session-model",
		thinking: "low",
		workflow: {
			...base.workflow,
			phases: [
				{ ...base.workflow.phases[0], id: "token=profile-refusal-secret" },
				{ ...base.workflow.phases[1], id: homePhaseId, tools: "read" },
			],
		},
	};
	const refused = await runFlow(params, {}, { cwd, hasUI: true });
	assert.equal(refused.result.details.error?.code, "WORKFLOW_INVALID");
	const error = JSON.stringify(refused.result.details.error);
	assert.doesNotMatch(error, /profile-refusal-secret/);
	assert.equal(error.includes(os.homedir()), false);
});

test("approval is refused before consent when tools or Thinking remain implicit", async () => {
	for (const fixture of [
		{ name: "implicit-tools-agent", tools: null, thinking: "low" },
		{ name: "implicit-thinking-agent", tools: "read", thinking: null },
		{ name: "pattern-model-agent", tools: "read", model: "test-provider/session", thinking: "low" },
	] as const) {
		const cwd = await freshDir();
		await installProjectAgent(cwd, { ...fixture, prompt: "Stable profile." });
		let approvalPrompts = 0;
		const refused = await runFlow(workflowParams(fixture.name), {}, {
			cwd,
			hasUI: true,
			ui: { confirm: async () => { approvalPrompts += 1; return true; } },
		});
		assert.equal(refused.result.details.error?.code, "WORKFLOW_INVALID", fixture.name);
		assert.equal(approvalPrompts, 0, fixture.name);
		assert.equal(refused.calls.length, 0, fixture.name);
	}
});
