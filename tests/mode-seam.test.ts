// The child-run seam (ModeDeps.runChild): mode coordination logic runs against
// an in-process fake with no subprocess, no stub pi, and no argv rewiring.
// Also covers the FlowDetails contract that error paths keep completed runs.
import { strict as assert } from "node:assert";
import test from "node:test";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import { createHandoffConsumer } from "../extensions/pi-flows/handoff-consumption.ts";
import { handleGraph } from "../extensions/pi-flows/modes/graph.ts";
import { handleOrchestrate } from "../extensions/pi-flows/modes/orchestrate.ts";
import { handleParallel } from "../extensions/pi-flows/modes/parallel.ts";
import { handleSingle } from "../extensions/pi-flows/modes/single.ts";
import { detectRunMode } from "../extensions/pi-flows/modes/registry.ts";
import { MODEL_VISIBLE_OUTPUT_CAP, emptyUsage, makeSettle, type FlowDiscovery, type FlowRunResult, type ModeDeps, type RunChildOptions } from "../extensions/pi-flows/types.ts";

const discovery: FlowDiscovery = {
	agents: [
		{ name: "recon", description: "read-only scout", tools: ["read"], systemPrompt: "", source: "package", filePath: "/pkg/recon.md" },
		{ name: "debrief", description: "synthesizer", tools: ["read"], systemPrompt: "", source: "package", filePath: "/pkg/debrief.md" },
	],
	projectAgentsDir: null,
	userAgentsDir: "/tmp/user-agents",
	packageAgentsDir: "/tmp/package-agents",
	issues: [],
};

function fakeResult(options: RunChildOptions, text: string): FlowRunResult {
	return {
		agent: options.agentName,
		agentSource: "package",
		task: options.task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
		stderr: "",
		usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01, turns: 1 },
		step: options.step,
	};
}

function makeDeps(params: Record<string, unknown>, runChild: ModeDeps["runChild"]): ModeDeps {
	const catalog = createAgentCatalog(discovery, "user");
	// The settle is built exactly as the registry builds it — from the detected
	// mode's own details builder — so this fake cannot drift from production.
	const detected = detectRunMode(params);
	const mode = "mode" in detected ? detected.mode : "parallel";
	return {
		params,
		discovery,
		policy: { recordContent: true, redactSecrets: true },
		handoffs: createHandoffConsumer({
			params,
			mode: "parallel",
			policy: { recordContent: true, redactSecrets: true },
			defaultCwd: "/tmp",
		}),
		agentScope: "user",
		defaultCwd: "/tmp",
		makeDetails: catalog.makeDetails,
		settle: makeSettle(mode, catalog.makeDetails(mode)),
		runChild,
		concurrency: 4,
	};
}

test("parallel coordination runs in-process through the runChild seam", async () => {
	const calls: RunChildOptions[] = [];
	const deps = makeDeps(
		{ tier: "capable", tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }] },
		async (options) => {
			calls.push(options);
			return fakeResult(options, `done: ${options.task}`);
		},
	);
	const output = await handleParallel(deps);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => call.task).sort(), ["inspect A", "inspect B"]);
	assert.equal(output.details.results.length, 2);
	assert.equal(output.details.error, undefined);
	assert.match(output.content[0].text, /done: inspect A/);
});

test("typed single dispatch enforces every contract budget field", async () => {
	const calls: RunChildOptions[] = [];
	const contract = {
		objective: "Return a bounded result.",
		constraints: [],
		nonGoals: [],
		dependencies: [],
		authority: { may: [], mustNot: [], requiresApproval: [] },
		sideEffectClass: "read-only",
		budget: { timeoutMs: 1_200, maxCostUsd: 0.25, maxTokens: 300, maxGeneratedTokens: 100 },
		acceptanceChecks: [],
		returnSchema: { type: "object" },
		owner: "parent",
	};
	const deps = makeDeps({ agent: "recon", contract, timeoutMs: 5_000 }, async (options) => {
		calls.push(options);
		return fakeResult(options, JSON.stringify({
			schemaVersion: "pi-flows.return-envelope.v1",
			contractId: delegationContractId(contract as never),
			status: "completed",
			summary: "Done.",
			evidence: [],
			artifactReferences: [],
			digests: [],
			changedState: [],
			unresolvedQuestions: [],
			retry: { retryable: false },
			data: {},
		}));
	});
	const output = await handleSingle(deps);
	assert.equal(output.details.error, undefined);
	assert.equal(calls[0].timeoutMs, 1_200);
	assert.deepEqual(calls[0].contractBudget.snapshot(), {
		authority: "contract",
		maxCostUsd: 0.25,
		maxTokens: 300,
		maxGeneratedTokens: 100,
		spentCost: 0,
		spentTokens: 0,
		spentGeneratedTokens: 0,
	});
});

test("graph wave scheduler orders dependent nodes and renders node outputs", async () => {
	const calls: RunChildOptions[] = [];
	const deps = makeDeps(
		{
			task: "map the system",
			graph: {
				nodes: [
					{ id: "b", agent: "recon", task: "use {node.a} as input", dependsOn: ["a"] },
					{ id: "a", agent: "recon", task: "start from {task}" },
				],
			},
		},
		async (options) => {
			calls.push(options);
			return fakeResult(options, `output-of-${options.task.slice(0, 20)}`);
		},
	);
	const output = await handleGraph(deps);
	assert.equal(calls.length, 2);
	assert.match(calls[0].task, /start from map the system/);
	// Node b receives node a through the documented legacy compatibility envelope.
	assert.match(calls[1].task, /use \{"schemaVersion":"pi-flows\.handoff-envelope\.v1"/);
	assert.match(calls[1].task, /"compatibility":"legacy-prose"/);
	assert.match(calls[1].task, /"text":"output-of-start from map the s"/);
	assert.equal(output.details.results.length, 2);
});

test("graph cycle error keeps the runs that already completed", async () => {
	const deps = makeDeps(
		{
			graph: {
				nodes: [
					{ id: "a", agent: "recon", task: "wave one runs fine" },
					{ id: "b", agent: "recon", task: "blocked", dependsOn: ["c"] },
					{ id: "c", agent: "recon", task: "blocked too", dependsOn: ["b"] },
				],
			},
		},
		async (options) => fakeResult(options, "wave-one-output"),
	);
	const output = await handleGraph(deps);
	assert.equal(output.details.error?.code, "GRAPH_CYCLE");
	// The wave-1 run already spent tokens; the error path must not discard it.
	assert.equal(output.details.results.length, 1);
	assert.equal(output.details.results[0].usage.cost, 0.01);
});

test("orchestrate verification refusal is capped as a whole, formatted error included", async () => {
	const deps = makeDeps(
		{ task: "assess the system end to end", orchestrate: { verify: { agent: "recon" }, verifyPolicy: "fail" } },
		async (options) => {
			if (options.task.includes("JSON array")) return fakeResult(options, '["inspect the one subtask"]');
			if (options.task.includes("Assigned subtask")) return fakeResult(options, "worker findings");
			if (options.task.includes("Judge whether")) return fakeResult(options, "VERDICT: REVISE");
			// The synthesized answer alone overflows the model-visible cap, so an
			// uncapped prefix would push the refusal past it.
			return fakeResult(options, "S".repeat(MODEL_VISIBLE_OUTPUT_CAP + 10_000));
		},
	);
	const output = await handleOrchestrate(deps);
	assert.equal(output.details.error?.code, "ORCHESTRATE_VERIFY_FAILED");
	// The visibility cap applies over the complete refusal — formatted error
	// plus footer — exactly as the hand-assembled return capped it.
	assert.ok(
		output.content[0].text.length <= MODEL_VISIBLE_OUTPUT_CAP + 200,
		`refusal exceeds the model-visible cap: ${output.content[0].text.length}`,
	);
});
