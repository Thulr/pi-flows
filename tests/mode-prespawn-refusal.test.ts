// Mode pre-spawn refusals (`preSpawnRefusal` on the mode table, modes/plan.ts).
//
// These refusals used to exist twice: once where the handler enforced them and
// once as a mirror in Core (validate.ts) for the selection eval to score,
// because Core may not import Supporting. The two copies were kept in
// agreement by hand, and monitor's had already drifted into byte-identical
// duplication. Now each mode declares the rule once beside its handler, the
// handler calls its own declaration, and the eval resolves it through the
// table.
//
// The invariant worth pinning is therefore not "the declaration returns X" but
// "the declaration IS what the handler enforces" — asserted below by driving
// the real handler and deep-comparing its refusal to the declaration's, with a
// runChild that fails the test if anything spawns.
import { strict as assert } from "node:assert";
import test from "node:test";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import { createHandoffConsumer } from "../extensions/pi-flows/handoff-consumption.ts";
import { RUN_MODE_CONTRACTS, modePreSpawnRefusalForParams } from "../extensions/pi-flows/modes/contract.ts";
import { detectRunMode } from "../extensions/pi-flows/modes/registry.ts";
import { handleDebate } from "../extensions/pi-flows/modes/debate.ts";
import { handleDossier } from "../extensions/pi-flows/modes/dossier.ts";
import { handleEvaluate } from "../extensions/pi-flows/modes/evaluate.ts";
import { handleGraph } from "../extensions/pi-flows/modes/graph.ts";
import { handleLoop } from "../extensions/pi-flows/modes/loop.ts";
import { handleMonitor } from "../extensions/pi-flows/modes/monitor.ts";
import { handleOrchestrate } from "../extensions/pi-flows/modes/orchestrate.ts";
import { handleParallel } from "../extensions/pi-flows/modes/parallel.ts";
import { handleRoute } from "../extensions/pi-flows/modes/route.ts";
import { handleSearch } from "../extensions/pi-flows/modes/search.ts";
import { handleVote } from "../extensions/pi-flows/modes/vote.ts";
import { handleWorktree } from "../extensions/pi-flows/modes/worktree.ts";
import { preSpawnRefusalWorkflow } from "../extensions/pi-flows/modes/workflow.ts";
import { MAX_PARALLEL_TASKS, emptyUsage, makeSettle, type FlowDiscovery, type FlowRunResult, type ModeDeps, type ModeOutput, type RunChildOptions } from "../extensions/pi-flows/types.ts";

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

function makeDeps(params: Record<string, unknown>, runChild: ModeDeps["runChild"]): ModeDeps {
	const catalog = createAgentCatalog(discovery, "user");
	const detected = detectRunMode(params);
	const mode = "mode" in detected ? detected.mode : "parallel";
	return {
		params,
		discovery,
		policy: { recordContent: true, redactSecrets: true },
		handoffs: createHandoffConsumer({ params, mode, policy: { recordContent: true, redactSecrets: true }, defaultCwd: "/tmp" }),
		agentScope: "user",
		defaultCwd: "/tmp",
		makeDetails: catalog.makeDetails,
		settle: makeSettle(mode, catalog.makeDetails(mode)),
		runChild,
		concurrency: 4,
	};
}

/** A child seam that fails the test if a refusal ever let a spawn through. */
const neverSpawns: ModeDeps["runChild"] = async (options) => {
	assert.fail(`a pre-spawn refusal spawned ${options.agentName}`);
};

const overCap = MAX_PARALLEL_TASKS + 1;

/** Each mode whose declaration is reachable through its handler before any spawn. */
const ENFORCED: Array<{ mode: string; params: Record<string, any>; handler: (deps: ModeDeps) => Promise<ModeOutput>; code: string }> = [
	{
		mode: "parallel",
		params: { why: "w", tasks: Array.from({ length: overCap }, (_, index) => ({ agent: "recon", task: `task ${index}` })) },
		handler: handleParallel,
		code: "TOO_MANY_TASKS",
	},
	{
		mode: "parallel",
		params: { why: "w", tasks: [{ agent: "recon", task: "mechanical" }, { agent: "recon", task: "adversarial" }] },
		handler: handleParallel,
		code: "PARALLEL_SIZING_REQUIRED",
	},
	{
		mode: "vote",
		params: { why: "w", task: "decide", vote: { agent: "recon", count: overCap } },
		handler: handleVote,
		code: "TOO_MANY_TASKS",
	},
	{
		mode: "vote",
		params: { why: "w", task: "decide", vote: { agent: "recon", count: 1 } },
		handler: handleVote,
		code: "TOO_FEW_VOTERS",
	},
	{
		mode: "graph",
		params: { why: "w", graph: { nodes: [{ id: "a", agent: "recon", task: "t" }, { id: "a", agent: "recon", task: "t" }] } },
		handler: handleGraph,
		code: "GRAPH_INVALID",
	},
	{
		mode: "graph",
		params: { why: "w", graph: { nodes: [{ id: "a", agent: "recon", task: "t", dependsOn: ["b"] }, { id: "b", agent: "recon", task: "t", dependsOn: ["a"] }] } },
		handler: handleGraph,
		code: "GRAPH_CYCLE",
	},
	{
		mode: "monitor",
		params: { why: "w", task: "watch", monitor: { command: "true", trigger: "match", pattern: "[" } },
		handler: handleMonitor,
		code: "MONITOR_INVALID",
	},
	{
		mode: "monitor",
		params: { why: "w", task: "watch", monitor: {} },
		handler: handleMonitor,
		code: "MONITOR_INVALID",
	},
	// The entry rules: a mode that cannot start for want of a task, a candidate
	// set, or enough participants refuses before spawning just as surely as one
	// over its fan-out cap, so the table declares those too.
	{ mode: "vote", params: { why: "w", vote: { agent: "recon", count: 3 } }, handler: handleVote, code: "INVALID_MODE" },
	{ mode: "evaluate", params: { why: "w", evaluate: {} }, handler: handleEvaluate, code: "INVALID_MODE" },
	{ mode: "route", params: { why: "w", route: { candidates: ["recon"] } }, handler: handleRoute, code: "INVALID_MODE" },
	{ mode: "route", params: { why: "w", task: "pick one", route: {} }, handler: handleRoute, code: "INVALID_MODE" },
	{ mode: "orchestrate", params: { why: "w", orchestrate: {} }, handler: handleOrchestrate, code: "INVALID_MODE" },
	{ mode: "orchestrate", params: { why: "w", task: "map it", orchestrate: { reviewCriteria: "Cover every part." } }, handler: handleOrchestrate, code: "INVALID_MODE" },
	{ mode: "loop", params: { why: "w", loop: { body: { agent: "recon" } } }, handler: handleLoop, code: "INVALID_MODE" },
	{ mode: "loop", params: { why: "w", task: "iterate", loop: {} }, handler: handleLoop, code: "INVALID_MODE" },
	{ mode: "search", params: { why: "w", search: {} }, handler: handleSearch, code: "INVALID_MODE" },
	{ mode: "debate", params: { why: "w", task: "a or b", debate: { participants: [{ agent: "recon" }] } }, handler: handleDebate, code: "DEBATE_TOO_FEW_PARTICIPANTS" },
	{ mode: "debate", params: { why: "w", debate: { participants: [{ agent: "recon" }, { agent: "debrief" }] } }, handler: handleDebate, code: "INVALID_MODE" },
	{ mode: "dossier", params: { why: "w", task: "map it", dossier: { sections: [{ agent: "recon", task: "a" }] } }, handler: handleDossier, code: "DOSSIER_TOO_FEW_SECTIONS" },
	{ mode: "worktree", params: { why: "w", task: "build", worktree: { tasks: [{ id: "a", agent: "recon", task: "t" }] } }, handler: handleWorktree, code: "WORKTREE_SETUP_FAILED" },
	{ mode: "worktree", params: { why: "w", task: "build", worktree: { tasks: [{ id: "a", agent: "recon", task: "t" }, { id: "a", agent: "recon", task: "t" }] } }, handler: handleWorktree, code: "WORKTREE_SETUP_FAILED" },
];

test("a mode's declared pre-spawn refusal is the one its handler enforces", async () => {
	for (const { mode, params, handler, code } of ENFORCED) {
		const declared = modePreSpawnRefusalForParams(params, { headless: true });
		assert.ok(declared, `${mode}/${code}: the table declared no refusal for a call the handler refuses`);
		assert.equal(declared.code, code, `${mode}: declared the wrong code`);

		const output = await handler(makeDeps(params, neverSpawns));
		// Not "same code" — the same error. A handler that rebuilt the message,
		// cause, or fix from its own copy would pass a code check and fail here,
		// which is exactly the drift the declaration exists to prevent.
		assert.deepEqual(output.details.error, declared, `${mode}/${code}: the handler's refusal differs from the declaration`);
		assert.equal(output.details.results.length, 0, `${mode}/${code}: a pre-spawn refusal recorded runs`);
	}
});

test("the table resolves the active mode's declaration, and stays silent for admissible calls", () => {
	const headless = { headless: true } as const;
	assert.equal(modePreSpawnRefusalForParams({ agent: "recon", task: "x", why: "w" }, headless), null);
	assert.equal(modePreSpawnRefusalForParams({ why: "w", tasks: [{ agent: "recon", task: "a" }] }, headless), null);
	assert.equal(modePreSpawnRefusalForParams({}, headless), null, "a call activating no mode declares no refusal");
	// The active mode answers, not the first mode with an opinion: a monitor
	// call carrying an over-cap `tasks` array is a multi-mode call the tool
	// refuses earlier (INVALID_MODE), and first-activator order must not let
	// parallel's cap speak for monitor.
	assert.equal(modePreSpawnRefusalForParams({ why: "w", task: "watch", monitor: { command: "true" } }, headless), null);
});

test("workflow's approval rule reads the context; its phase rule does not", () => {
	const openingApproval = { why: "w", workflow: { phases: [{ id: "p1", approval: { message: "ship it?" } }, { id: "p2", agent: "recon", task: "t" }] } };
	assert.equal(preSpawnRefusalWorkflow(openingApproval, { headless: true })?.code, "WORKFLOW_APPROVAL_REQUIRED");
	// With a UI the approval is collectable, so nothing is refused before spawn
	// — which is why the handler enforces that rule against the UI it has.
	assert.equal(preSpawnRefusalWorkflow(openingApproval, { headless: false }), null);

	const duplicateIds = { why: "w", workflow: { phases: [{ id: "p1", agent: "recon", task: "t" }, { id: "p1", agent: "recon", task: "t" }] } };
	for (const headless of [true, false]) {
		assert.equal(preSpawnRefusalWorkflow(duplicateIds, { headless })?.code, "WORKFLOW_INVALID", "phase shape does not depend on the UI");
	}
});

test("workflow declares the same unbindable-profile refusal its handler enforces", async () => {
	const params = {
		why: "w",
		model: "p/model",
		thinking: "low",
		workflow: { phases: [
			{ id: "gate", approval: { message: "Approve?" } },
			{ id: "work", agent: "missing-agent", task: "work", tools: "read" },
		] },
	};
	const declared = preSpawnRefusalWorkflow(params, {
		headless: true,
		agentProfiles: { agents: discovery.agents, defaultCwd: "/tmp" },
	});
	assert.equal(declared?.code, "WORKFLOW_INVALID");
	const output = await RUN_MODE_CONTRACTS.find((contract) => contract.mode === "workflow")!.handler(makeDeps(params, neverSpawns));
	assert.deepEqual(output.details.error, declared);
});

test("every mode declares a pre-spawn refusal that is total over hostile params", () => {
	const hostile: Array<Record<string, any>> = [
		{},
		{ tasks: "not-an-array", vote: 7, graph: "x", monitor: null, workflow: 0 },
		{ tasks: [null, 3, { agent: 42 }], vote: { voters: "no", count: "many" }, graph: { nodes: [{ id: 1 }] } },
		{ graph: { nodes: [{ id: "a", agent: "recon", task: "t", dependsOn: "not-an-array" }] } },
		{ vote: { agent: "recon", count: Number.NaN }, monitor: { command: 5, trigger: "match" } },
		{ workflow: { phases: [{}, { id: "a", agent: "recon", task: "t", approval: { message: "both kinds" } }] } },
	];
	for (const contract of RUN_MODE_CONTRACTS) {
		for (const params of hostile) {
			for (const headless of [true, false]) {
				assert.doesNotThrow(
					() => contract.preSpawnRefusal(params, { headless }),
					`${contract.mode} threw on hostile params instead of declaring a refusal`,
				);
			}
		}
	}
});

test("a cycle that strands only later waves stays the handler's, not the declaration's", async () => {
	// One dependency-free node exists, so a first wave runs and the declaration
	// is silent; the deadlock only appears once that node completes. The two
	// GRAPH_CYCLE refusals name different moments and both are load-bearing.
	const params = {
		why: "w",
		graph: { nodes: [
			{ id: "root", agent: "recon", task: "start" },
			{ id: "a", agent: "recon", task: "t", dependsOn: ["b"] },
			{ id: "b", agent: "recon", task: "t", dependsOn: ["a"] },
		] },
	};
	assert.equal(modePreSpawnRefusalForParams(params, { headless: true }), null, "a runnable first wave is not a pre-spawn refusal");

	const spawned: string[] = [];
	const output = await handleGraph(makeDeps(params, async (options: RunChildOptions): Promise<FlowRunResult> => {
		spawned.push(options.agentName);
		return {
			agent: options.agentName,
			agentSource: "package",
			task: options.task,
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as any],
			stderr: "",
			usage: { ...emptyUsage(), input: 1, output: 1, turns: 1 },
			step: options.step,
		};
	}));
	assert.equal(output.details.error?.code, "GRAPH_CYCLE");
	assert.equal(spawned.length, 1, "the dependency-free node should have run before the deadlock was detected");
	assert.match(output.details.error!.cause, /no remaining graph node is runnable/i);
});
