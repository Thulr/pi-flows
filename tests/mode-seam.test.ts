// The child-run seam (ModeDeps.runChild): mode coordination logic runs against
// an in-process fake with no subprocess, no stub pi, and no argv rewiring.
// Also covers the FlowDetails contract that error paths keep completed runs.
import { strict as assert } from "node:assert";
import test from "node:test";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import { handleGraph } from "../extensions/pi-flows/modes/graph.ts";
import { handleParallel } from "../extensions/pi-flows/modes/parallel.ts";
import { handleSingle } from "../extensions/pi-flows/modes/single.ts";
import { emptyUsage, type FlowDiscovery, type FlowRunResult, type ModeDeps, type RunChildOptions } from "../extensions/pi-flows/types.ts";

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
	return {
		params,
		discovery,
		policy: { recordContent: true, redactSecrets: true },
		agentScope: "user",
		defaultCwd: "/tmp",
		makeDetails: catalog.makeDetails,
		runChild,
		concurrency: 4,
	};
}

test("parallel coordination runs in-process through the runChild seam", async () => {
	const calls: RunChildOptions[] = [];
	const deps = makeDeps(
		{ tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }] },
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
	assert.deepEqual(calls[0].contractBudget, {
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
