import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import {
	canonicalHandoff,
	delegationContractId,
	prepareIntegrationHandoff,
	renderDelegationTask,
} from "../extensions/pi-flows/delegation.ts";
import { FlowParams } from "../extensions/pi-flows/schema.ts";
import { emptyUsage, type DelegationContract, type FlowRunResult } from "../extensions/pi-flows/types.ts";
import { freshDir, runFlow } from "./stub-harness.ts";

const contract: DelegationContract = {
	objective: "Return the exact answer.",
	constraints: ["Read only."],
	nonGoals: [],
	dependencies: [],
	authority: { may: ["Read files."], mustNot: [], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget: {},
	acceptanceChecks: ["Return answer 42."],
	returnSchema: {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "number" } },
		additionalProperties: false,
	},
	owner: "parent",
};

const policy = { recordContent: true, redactSecrets: true };

function result(text: string): FlowRunResult {
	return {
		agent: "recon",
		agentSource: "package",
		task: "find the answer",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
		stderr: "",
		usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01, turns: 1 },
		step: 2,
	};
}

function typedEnvelope(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract),
		status: "completed",
		summary: "Found it.",
		evidence: [{ claim: "The answer is 42.", source: "answer.txt:1" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { answer: 42 },
		...overrides,
	});
}

test("typed prompts carry a stable contract identity", () => {
	const id = delegationContractId(contract);
	assert.equal(id, delegationContractId(structuredClone(contract)));
	assert.match(id, /^sha256:[a-f0-9]{64}$/);
	assert.match(renderDelegationTask(undefined, contract), new RegExp(id));
});

test("integration handoffs reject missing and stale contract identities", () => {
	const missing = prepareIntegrationHandoff(result(typedEnvelope({ contractId: undefined })), {
		contract,
		cwd: "/tmp",
		policy,
	});
	assert.equal(missing.error?.code, "RETURN_CONTRACT_MISMATCH");

	const stale = prepareIntegrationHandoff(result(typedEnvelope({ contractId: "sha256:".concat("0".repeat(64)) })), {
		contract,
		cwd: "/tmp",
		policy,
	});
	assert.equal(stale.error?.code, "RETURN_CONTRACT_MISMATCH");
});

test("partial and blocked typed handoffs fail closed unless inclusion is explicit", () => {
	for (const status of ["partial", "blocked"] as const) {
		const rejected = prepareIntegrationHandoff(result(typedEnvelope({ status })), {
			contract,
			cwd: "/tmp",
			policy,
		});
		assert.equal(rejected.error?.code, "RETURN_ENVELOPE_INCOMPLETE");

		const included = prepareIntegrationHandoff(result(typedEnvelope({ status })), {
			contract,
			cwd: "/tmp",
			policy,
			incompletePolicy: "include",
		});
		assert.equal(included.error, undefined);
		assert.equal(included.handoff?.status, status);
		assert.match(canonicalHandoff(included.handoff!), new RegExp(`"status":"${status}"`));
	}
});

test("legacy prose is preserved through a provenance-bearing compatibility envelope", () => {
	const legacy = result("ordinary prose with evidence at README.md:1");
	const prepared = prepareIntegrationHandoff(legacy, { cwd: "/tmp", policy });
	assert.equal(prepared.error, undefined);
	assert.equal(prepared.handoff?.compatibility, "legacy-prose");
	assert.equal(prepared.handoff?.contractId, null);
	assert.equal(prepared.handoff?.provenance.agent, "recon");
	assert.equal(prepared.handoff?.provenance.step, 2);
	assert.match(canonicalHandoff(prepared.handoff!), /ordinary prose/);
});

test("public integration-mode schemas accept role-specific contracts and an explicit incomplete policy", () => {
	assert.ok(FlowParams.properties.incompleteHandoffPolicy);
	assert.ok(FlowParams.properties.tasks.items.properties.contract);
	assert.ok(FlowParams.properties.graph.properties.nodes.items.properties.contract);
	assert.ok(FlowParams.properties.workflow.properties.phases.items.properties.contract);
	assert.ok(FlowParams.properties.worktree.properties.tasks.items.properties.contract);
	assert.ok(FlowParams.properties.vote.properties.voters.items.properties.contract);
	assert.ok(FlowParams.properties.debate.properties.participants.items.properties.contract);
	assert.ok(FlowParams.properties.dossier.properties.sections.items.properties.contract);
});

test("parallel validates typed returns and exposes compatibility provenance for legacy returns", async () => {
	const { result: output, calls } = await runFlow(
		{
			tasks: [
				{ agent: "recon", task: "typed", contract },
				{ agent: "analyst", task: "legacy" },
			],
		},
		{
			recon: typedEnvelope(),
			analyst: "legacy finding",
		},
	);
	assert.equal(output.details.error, undefined);
	assert.equal(calls.length, 2);
	assert.equal(output.details.results[0].handoff?.contractId, delegationContractId(contract));
	assert.equal(output.details.results[1].handoff?.compatibility, "legacy-prose");
});

test("graph rejects a stale node envelope before a dependent node is dispatched", async () => {
	const { result: output, calls } = await runFlow(
		{
			graph: {
				nodes: [
					{ id: "source", agent: "recon", task: "typed source", contract },
					{ id: "consumer", agent: "analyst", task: "consume {node.source}", dependsOn: ["source"] },
				],
			},
		},
		{
			recon: typedEnvelope({ contractId: `sha256:${"0".repeat(64)}` }),
			analyst: "must not run",
		},
	);
	assert.equal(output.details.error?.code, "RETURN_CONTRACT_MISMATCH");
	assert.deepEqual(calls.map((call) => call.agent), ["recon"]);
});

test("vote requires an explicit policy before aggregating partial typed ballots", async () => {
	const params = {
		task: "Return the answer.",
		contract,
		vote: { agent: "recon", count: 2 },
	};
	const plan = { recon: [typedEnvelope({ status: "partial" }), typedEnvelope({ status: "partial" })] };
	const rejected = await runFlow(params, plan);
	assert.equal(rejected.result.details.error?.code, "RETURN_ENVELOPE_INCOMPLETE");

	const included = await runFlow({ ...params, incompleteHandoffPolicy: "include" }, plan);
	assert.equal(included.result.details.error, undefined);
	assert.match(included.text, /Included incomplete handoffs by explicit policy/);
});

test("orchestrate rejects an invalid typed worker before synthesis", async () => {
	const { result: output, calls } = await runFlow(
		{
			task: "Answer from two findings.",
			orchestrate: {
				commander: { agent: "commander" },
				recon: { agent: "recon", contract },
				debrief: { agent: "debrief" },
				maxSubtasks: 2,
			},
		},
		{
			commander: '["first", "second"]',
			recon: [typedEnvelope(), typedEnvelope({ data: { wrong: true } })],
			debrief: "must not synthesize",
		},
	);
	assert.equal(output.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.deepEqual(calls.map((call) => call.agent).sort(), ["commander", "recon", "recon"].sort());
});

test("dossier rejects invalid typed evidence before debrief", async () => {
	const { result: output, calls } = await runFlow(
		{
			task: "Build a dossier.",
			dossier: {
				sections: [
					{ agent: "recon", task: "source one", contract },
					{ agent: "analyst", task: "source two", contract },
				],
				debrief: { agent: "debrief" },
			},
		},
		{
			recon: typedEnvelope(),
			analyst: typedEnvelope({ data: null }),
			debrief: "must not synthesize",
		},
	);
	assert.equal(output.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.equal(calls.some((call) => call.agent === "debrief"), false);
});

test("workflow persists a validated typed phase handoff", async () => {
	const cwd = await freshDir();
	const { result: output } = await runFlow(
		{
			task: "Run one phase.",
			workflow: {
				stateFile: "workflow.json",
				phases: [{ id: "inspect", agent: "recon", task: "return 42", contract }],
			},
		},
		{ recon: typedEnvelope() },
		{ cwd },
	);
	assert.equal(output.details.error, undefined);
	assert.equal(output.details.results[0].handoff?.compatibility, "typed");
	assert.equal(output.details.results[0].handoff?.contractId, delegationContractId(contract));
});

test("debate preserves typed advocate and adjudicator provenance", async () => {
	const { result: output } = await runFlow(
		{
			task: "Choose the answer.",
			contract,
			debate: {
				participants: [{ agent: "recon" }, { agent: "analyst" }],
				adjudicator: { agent: "debrief" },
				rounds: 1,
			},
		},
		{
			recon: typedEnvelope({ summary: "Advocate one." }),
			analyst: typedEnvelope({ summary: "Advocate two." }),
			debrief: typedEnvelope({ summary: "Decision." }),
		},
	);
	assert.equal(output.details.error, undefined);
	assert.equal(output.details.results.length, 3);
	assert.ok(output.details.results.every((run) => run.handoff?.compatibility === "typed"));
	assert.deepEqual(output.details.results.map((run) => run.handoff?.provenance.agent), ["recon", "analyst", "debrief"]);
});

test("worktree validates typed worker envelopes before integration", async () => {
	const cwd = await freshDir();
	await writeFile(`${cwd}/a.txt`, "old a\n");
	await writeFile(`${cwd}/b.txt`, "old b\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd });

	const { result: output } = await runFlow(
		{
			task: "Update both files.",
			worktree: {
				tasks: [
					{ id: "a", agent: "operator", task: "update a.txt", contract },
					{ id: "b", agent: "operator", task: "update b.txt", contract },
				],
				integrator: { agent: "debrief" },
			},
		},
		{
			operator: [
				{ whenTaskIncludes: "assignment (a)", reply: typedEnvelope(), writes: { "a.txt": "new a\n" } },
				{ whenTaskIncludes: "assignment (b)", reply: typedEnvelope(), writes: { "b.txt": "new b\n" } },
			],
			debrief: "integration reviewed",
		},
		{ cwd },
	);
	assert.equal(output.details.error, undefined);
	const workers = output.details.results.filter((run) => run.agent === "operator");
	assert.equal(workers.length, 2);
	assert.ok(workers.every((run) => run.handoff?.contractId === delegationContractId(contract)));
});
