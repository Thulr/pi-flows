// The mode-plan seam (architecture finding: a mode's topology was written five
// times; only two writings were checked). Each mode now declares its plan —
// ordered waves of FlowAgentRefInput-shaped refs — once, next to its handler,
// and the four readers (requested agents, the shared-write mirror, budget
// disclosure, the critical-path metric) derive from that declaration through
// the mode table.
//
// Every expectation below is the OLD hand-derived output, captured as a
// literal before the readers were rewired — not recomputed — so the plan seam
// is pinned to the behavior the five hand copies actually had. Requested-agent
// expectations compare as sorted sets: the only consumer is
// requestedAgentNamesForParams' Set union (agent-catalog.ts), so duplicates
// and order were never observable.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	RUN_MODE_CONTRACTS,
	criticalPathForMode,
	firstSpawnAgentRefs,
	planForMode,
	preSpawnSharedWriteWaves,
	requestedAgentNamesForParams,
} from "../extensions/pi-flows/modes/contract.ts";
import { collectBudgetCeilings } from "../extensions/pi-flows/budget-disclosure.ts";
import { RUN_MODE_NAMES, type RunMode } from "../extensions/pi-flows/types.ts";

function requestedNames(params: Record<string, unknown>): string[] {
	return [...requestedAgentNamesForParams(params)].sort();
}

// One representative schema-valid call per mode, exercising defaults where the
// old lambdas supplied them. Each activates exactly one mode, so the union
// across the table is that mode's own contribution.
const REPRESENTATIVE: Record<RunMode, Record<string, unknown>> = {
	single: { agent: "recon", task: "inspect", cwd: "sub", tools: "none" },
	parallel: { tier: "capable", tasks: [{ agent: "recon", task: "A", tools: "none" }, { agent: "operator", task: "B", cwd: "b" }] },
	chain: { chain: [{ agent: "recon", task: "A" }, { agent: "debrief", task: "B" }] },
	evaluate: { task: "t", evaluate: { operator: { agent: "op" }, redteam: [{ agent: "critic-a" }, { agent: "critic-b" }] } },
	vote: { task: "t", vote: { agent: "recon", count: 2, debrief: { agent: "debrief" } } },
	route: { task: "t", route: { controller: { agent: "controller" }, candidates: ["recon", "analyst"], fallback: "recon" } },
	orchestrate: { task: "t", orchestrate: { review: { agent: "reviewer" }, verify: { agent: "overwatch" } } },
	graph: { graph: { nodes: [{ id: "a", agent: "node-a", task: "A" }, { id: "b", agent: "node-b", task: "B", dependsOn: ["a"] }], debrief: { agent: "merge" } } },
	loop: { task: "t", loop: { body: { agent: "operator" }, judge: { agent: "redteam" } } },
	search: { task: "t", search: { candidates: 2, maxRounds: 2 } },
	workflow: { task: "t", workflow: { phases: [{ id: "gate", approval: { message: "ok?" } }, { id: "work", agent: "operator", task: "do" }], debrief: { agent: "debrief" } } },
	worktree: { task: "t", worktree: { tasks: [{ id: "a", agent: "writer-a", task: "A" }, { id: "b", agent: "writer-b", task: "B" }] } },
	debate: { task: "t", debate: { participants: [{ agent: "advocate-a" }, { agent: "advocate-b" }] } },
	dossier: { task: "t", dossier: { sections: [{ agent: "source-a", task: "A" }, { agent: "source-b", task: "B" }] } },
	monitor: { task: "t", monitor: { command: "probe", reactor: { agent: "analyst" } } },
};

test("every mode declares a plan and a critical path in the table", () => {
	for (const mode of RUN_MODE_NAMES) {
		const contract = RUN_MODE_CONTRACTS.find((candidate) => candidate.mode === mode);
		assert.ok(contract, `${mode} must be in the mode table`);
		assert.equal(typeof contract!.plan, "function", `${mode} must declare a plan`);
		assert.equal(typeof contract!.criticalPath, "function", `${mode} must declare a critical path`);
		const plan = planForMode(mode, REPRESENTATIVE[mode]);
		assert.ok(Array.isArray(plan.waves), `${mode} plan must carry waves`);
		assert.ok(Array.isArray(plan.opening), `${mode} plan must carry an opening`);
	}
});

test("plan-derived requested agents reproduce the old per-mode lambdas (as sets)", () => {
	// Old lambda outputs, captured as literals (sorted, deduplicated).
	const expected: Record<RunMode, string[]> = {
		single: ["recon"],
		parallel: ["operator", "recon"],
		chain: ["debrief", "recon"],
		evaluate: ["critic-a", "critic-b", "op"],
		vote: ["debrief", "recon"],
		route: ["analyst", "controller", "recon"],
		orchestrate: ["commander", "debrief", "overwatch", "recon", "reviewer"],
		graph: ["merge", "node-a", "node-b"],
		loop: ["operator", "redteam"],
		search: ["debrief", "redteam", "strategist"],
		workflow: ["debrief", "operator"],
		worktree: ["operator", "writer-a", "writer-b"],
		debate: ["advocate-a", "advocate-b", "analyst"],
		dossier: ["debrief", "source-a", "source-b"],
		monitor: ["analyst"],
	};
	for (const mode of RUN_MODE_NAMES) {
		assert.deepEqual(requestedNames(REPRESENTATIVE[mode]), expected[mode], `${mode}: plan flatten must reproduce the old requestedAgents lambda`);
	}
	// Defaults appear exactly when the old lambdas supplied them.
	assert.deepEqual(requestedNames({ task: "t", evaluate: {} }), ["operator", "redteam"]);
	assert.deepEqual(requestedNames({ task: "t", vote: { voters: [{ agent: "recon" }, { agent: "analyst" }] } }), ["analyst", "recon"]);
	// Inactive modes contribute nothing — a single call must not drag in search defaults.
	assert.deepEqual(requestedNames({ agent: "recon", task: "x" }), ["recon"]);
});

test("plan-derived shared-write waves reproduce the old hand-maintained mirror", () => {
	// Old preSpawnSharedWriteWaves outputs, captured as literals.
	assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE.parallel), [[{ agent: "recon", tools: "none" }, { agent: "operator", cwd: "b" }]]);
	assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE.evaluate), [[{ agent: "critic-a" }, { agent: "critic-b" }]]);
	assert.deepEqual(preSpawnSharedWriteWaves({ task: "t", evaluate: {} }), [[{ agent: "redteam" }]]);
	assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE.vote), [[{ agent: "recon" }, { agent: "recon" }]]);
	assert.deepEqual(preSpawnSharedWriteWaves({ task: "t", vote: { voters: [{ agent: "recon" }, { agent: "analyst" }] } }), [[{ agent: "recon" }, { agent: "analyst" }]]);
	assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE.graph), [[{ agent: "node-a" }]]);
	assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE.search), [
		[{ agent: "strategist" }, { agent: "strategist" }],
		[{ agent: "redteam", tools: "none" }, { agent: "redteam", tools: "none" }],
	]);
	assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE.debate).flat(), [{ agent: "advocate-a" }, { agent: "advocate-b" }]);
	assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE.dossier).flat(), [{ agent: "source-a" }, { agent: "source-b" }]);
	// Modes whose guard cannot fire pre-spawn contribute nothing.
	for (const mode of ["single", "chain", "route", "orchestrate", "loop", "workflow", "worktree", "monitor"] as const) {
		assert.deepEqual(preSpawnSharedWriteWaves(REPRESENTATIVE[mode]).flat(), [], `${mode}: no guard wave expected`);
	}
});

test("plan-derived first-spawn refs reproduce the old opening derivations", () => {
	// Old firstSpawnAgentRefs outputs, captured as literals. Single's ref has
	// always carried only the agent name — params.cwd/tools are handler concerns.
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.single), [{ agent: "recon" }]);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.parallel), [{ agent: "recon", tools: "none" }, { agent: "operator", cwd: "b" }]);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.chain), [{ agent: "recon" }]);
	// Evaluate's generator spawns before its critic panel.
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.evaluate), [{ agent: "op" }]);
	assert.deepEqual(firstSpawnAgentRefs({ task: "t", evaluate: {} }), [{ agent: "operator" }]);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.vote), [{ agent: "recon" }, { agent: "recon" }]);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.route), [{ agent: "controller" }]);
	// Orchestrate's commander decomposes before any recon worker runs.
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.orchestrate), [{ agent: "commander" }]);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.graph), [{ agent: "node-a" }]);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.loop), [{ agent: "operator" }]);
	// Search scores all generators before any scorer runs.
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.search), [{ agent: "strategist" }, { agent: "strategist" }]);
	// Workflow's opener is its first WORK phase; approval phases spawn nothing.
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.workflow), [{ agent: "operator" }]);
	// A resume derives nothing: which phase spawns first lives in persisted state.
	assert.deepEqual(firstSpawnAgentRefs({ workflow: { resume: true, phases: [{ id: "work", agent: "operator", task: "do" }] } }), []);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.debate), [{ agent: "advocate-a" }, { agent: "advocate-b" }]);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.dossier), [{ agent: "source-a" }, { agent: "source-b" }]);
	// Monitor's reactor and worktree's writers are not statically certain to spawn.
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.monitor), []);
	assert.deepEqual(firstSpawnAgentRefs(REPRESENTATIVE.worktree), []);
});

// One place the plan's contract markers meet the old switch's disclosure
// output: the contracts hanging off the planned refs, per mode.
test("plan-derived budget disclosure matches enforced contract roles across all 15 modes", () => {
	const contract = (budget: Record<string, number>) => ({
		objective: "Inspect the assigned area",
		constraints: [],
		nonGoals: [],
		dependencies: [],
		authority: { may: [], mustNot: [], requiresApproval: [] },
		sideEffectClass: "read-only",
		budget,
		acceptanceChecks: [],
		returnSchema: { type: "object" },
		owner: "parent",
	});
	const fallback = contract({ maxTokens: 9000 });
	const own = contract({ maxGeneratedTokens: 2000 });
	const OWN = { authority: "contract", maxGeneratedTokens: 2000 };
	const FALLBACK = { authority: "contract", maxTokens: 9000 };

	// Literal outputs of each mode's declared own/resolved contract rules.
	const cases: Array<{ mode: RunMode; params: Record<string, unknown>; expected: unknown[] }> = [
		{ mode: "single", params: { agent: "recon", task: "t", contract: fallback }, expected: [FALLBACK] },
		{ mode: "parallel", params: { contract: fallback, tasks: [{ agent: "recon", task: "A", contract: own }, { agent: "recon", task: "B" }] }, expected: [OWN, FALLBACK] },
		{ mode: "chain", params: { contract: fallback, chain: [{ agent: "recon", task: "A" }, { agent: "debrief", task: "B", contract: own }] }, expected: [FALLBACK, OWN] },
		{ mode: "evaluate", params: { task: "t", contract: fallback, evaluate: { redteam: [{ agent: "critic", contract: own }] } }, expected: [FALLBACK, OWN] },
		{ mode: "vote", params: { task: "t", contract: fallback, vote: { voters: [{ agent: "recon", contract: own }, { agent: "analyst" }], debrief: { agent: "debrief" } } }, expected: [OWN, FALLBACK] },
		{ mode: "route", params: { task: "t", contract: fallback, route: { controller: { agent: "controller", contract: own }, candidates: ["recon"] } }, expected: [OWN] },
		{ mode: "orchestrate", params: { task: "t", contract: fallback, orchestrate: { commander: { agent: "commander", contract: own } } }, expected: [OWN, FALLBACK] },
		{ mode: "graph", params: { contract: fallback, graph: { nodes: [{ id: "a", agent: "node-a", task: "A", contract: own }], debrief: { agent: "merge" } } }, expected: [OWN, FALLBACK] },
		{ mode: "loop", params: { task: "t", contract: fallback, loop: { body: { agent: "operator", contract: own } } }, expected: [OWN] },
		{ mode: "search", params: { task: "t", contract: fallback, search: { generator: { agent: "strategist", contract: own } } }, expected: [OWN] },
		{ mode: "workflow", params: { contract: fallback, workflow: { phases: [{ id: "w", agent: "operator", task: "do", contract: own }], debrief: { agent: "debrief" } } }, expected: [OWN, FALLBACK] },
		{ mode: "worktree", params: { task: "t", contract: fallback, worktree: { tasks: [{ id: "a", agent: "w1", task: "A", contract: own }, { id: "b", agent: "w2", task: "B" }] } }, expected: [OWN, FALLBACK] },
		{ mode: "debate", params: { task: "t", contract: fallback, debate: { participants: [{ agent: "a1", contract: own }, { agent: "a2" }] } }, expected: [OWN, FALLBACK] },
		// Dossier sections carry only their own contracts; the fallback goes to the synthesizer.
		{ mode: "dossier", params: { task: "t", contract: fallback, dossier: { sections: [{ agent: "s1", task: "A", contract: own }, { agent: "s2", task: "B" }] } }, expected: [OWN, FALLBACK] },
		{ mode: "monitor", params: { task: "t", contract: fallback, monitor: { command: "probe", reactor: { agent: "analyst", contract: own } } }, expected: [OWN] },
	];
	for (const { mode, params, expected } of cases) {
		assert.deepEqual(collectBudgetCeilings(params), expected, `${mode}: disclosure must equal the old switch output`);
	}
});

test("plan-declared critical paths reproduce the old per-mode arithmetic across all 15 modes", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const result = (agent: string, durationMs: number) => ({ agent, agentSource: "package", task: agent, exitCode: 0, messages: [], stderr: "", usage, durationMs }) as any;
	const two = [result("a", 100), result("b", 50)];
	const fanout = [result("a", 100), result("b", 200), result("tail", 30)];

	// Old criticalPathForMode outputs, captured as literals.
	const cases: Array<{ mode: RunMode; params: Record<string, unknown>; results: any[]; expected: number | undefined }> = [
		{ mode: "single", params: REPRESENTATIVE.single, results: two, expected: 150 },
		{ mode: "parallel", params: REPRESENTATIVE.parallel, results: two, expected: 100 },
		{ mode: "chain", params: REPRESENTATIVE.chain, results: two, expected: 150 },
		{ mode: "evaluate", params: { task: "t", evaluate: {} }, results: two, expected: 150 },
		{ mode: "evaluate", params: { task: "t", evaluate: { checkCommand: "npm test" } }, results: two, expected: undefined },
		{ mode: "evaluate", params: REPRESENTATIVE.evaluate, results: two, expected: undefined },
		{ mode: "vote", params: REPRESENTATIVE.vote, results: fanout, expected: 230 },
		{ mode: "route", params: REPRESENTATIVE.route, results: two, expected: 150 },
		// Orchestrate and monitor now declare "unavailable" instead of falling through.
		{ mode: "orchestrate", params: REPRESENTATIVE.orchestrate, results: two, expected: undefined },
		{ mode: "graph", params: REPRESENTATIVE.graph, results: two, expected: 150 },
		{ mode: "loop", params: REPRESENTATIVE.loop, results: two, expected: 150 },
		{
			mode: "search",
			params: { task: "t", search: { candidates: 2, maxRounds: 1 } },
			results: [result("gen", 100), result("gen", 200), result("score", 30), result("score", 40), result("debrief", 25)],
			expected: 265,
		},
		{ mode: "workflow", params: REPRESENTATIVE.workflow, results: two, expected: 150 },
		{ mode: "worktree", params: REPRESENTATIVE.worktree, results: fanout, expected: 230 },
		{ mode: "debate", params: { task: "t", debate: { participants: [{ agent: "a1" }, { agent: "a2" }], rounds: 1 } }, results: fanout, expected: 230 },
		{ mode: "dossier", params: REPRESENTATIVE.dossier, results: fanout, expected: 230 },
		{ mode: "monitor", params: REPRESENTATIVE.monitor, results: [result("analyst", 100)], expected: undefined },
	];
	for (const { mode, params, results, expected } of cases) {
		assert.equal(criticalPathForMode(mode, params, results), expected, `${mode}: critical path must equal the old arithmetic`);
	}
	// No results, and the non-run modes, stay unavailable.
	for (const mode of RUN_MODE_NAMES) {
		assert.equal(criticalPathForMode(mode, REPRESENTATIVE[mode], []), undefined, `${mode}: zero results has no critical path`);
	}
	assert.equal(criticalPathForMode("list", {}, [result("a", 1)]), undefined);
	assert.equal(criticalPathForMode("config", {}, [result("a", 1)]), undefined);
});
