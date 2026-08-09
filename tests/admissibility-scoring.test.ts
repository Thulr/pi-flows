// Offline tests for shared-write admissibility in selection scoring (issue
// #84): "would the flow tool have refused this call before any child spawned"
// must be one uniform question across refusal codes, so the eval-side
// admissibility seam gains SHARED_WRITE_CWD next to WHY_REQUIRED from #83.
// The predicate reuses the tool's own guard (validateSharedWriteCwd) over
// waves mirrored from the mode handlers; each mirror is pinned here against
// the real handler through the fault adapter, so a handler edit that moves or
// reshapes a guard fails this file instead of silently drifting the score.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFaultAdapter, faultDeps, faultDiscovery } from "./fault-adapter.ts";
import { RUN_MODE_CONTRACTS, firstSpawnAgentRefs, preSpawnSharedWriteRefusal, preSpawnSharedWriteWaves } from "../extensions/pi-flows/modes/contract.ts";
import { runFlowAgent } from "../extensions/pi-flows/runner.ts";
import { DEFAULT_CONCURRENCY, type RunMode } from "../extensions/pi-flows/types.ts";

function workspace(): string {
	return mkdtempSync(path.join(tmpdir(), "pi-flow-admissibility-"));
}

async function handlerOutcome(mode: RunMode, params: Record<string, unknown>) {
	const adapter = makeFaultAdapter({ replies: {} });
	const cwd = workspace();
	const handler = RUN_MODE_CONTRACTS.find((contract) => contract.mode === mode)?.handler;
	assert.ok(handler, `${mode} must be in the mode table`);
	// The dispatch core resolves concurrency from params before handlers run;
	// mirror it here so a params-level concurrency release reaches the handler.
	const concurrency = (params.concurrency as number | undefined) ?? DEFAULT_CONCURRENCY;
	const output = await handler!(faultDeps(params, adapter, cwd, { concurrency }));
	return { errorCode: output.details.error?.code ?? null, cwd };
}

// One params shape per guard-bearing mode, with `refs(agent)` producing the
// concurrent roles. With the write-capable `operator` (pi-default tools) the
// handler must refuse pre-spawn; with the read-only `recon` it must not.
const GUARDED_MODES: Record<string, (agent: string) => Record<string, unknown>> = {
	parallel: (agent) => ({ tasks: [{ agent, task: "inspect A" }, { agent, task: "inspect B" }] }),
	evaluate: (agent) => ({ task: "draft and verify", evaluate: { redteam: [{ agent }, { agent }] } }),
	vote: (agent) => ({ task: "answer the question", vote: { agent, count: 2 } }),
	graph: (agent) => ({ graph: { nodes: [{ id: "a", agent, task: "A" }, { id: "b", agent, task: "B" }] } }),
	search: (agent) => ({ task: "explore designs", search: { generator: { agent }, scorer: { agent: "recon" }, candidates: 2, maxRounds: 1 } }),
	debate: (agent) => ({ task: "decide A or B", debate: { participants: [{ agent }, { agent }], adjudicator: { agent: "debrief" } } }),
	dossier: (agent) => ({ task: "collect evidence", dossier: { sections: [{ agent, task: "source A" }, { agent, task: "source B" }] } }),
};

test("the handler refuses SHARED_WRITE_CWD exactly when the call-level predicate says so, per guard-bearing mode", async () => {
	const discovery = faultDiscovery();
	for (const [mode, callFor] of Object.entries(GUARDED_MODES)) {
		const refused = callFor("operator");
		const { errorCode, cwd } = await handlerOutcome(mode as RunMode, refused);
		assert.equal(errorCode, "SHARED_WRITE_CWD", `${mode}: two concurrent write-capable refs in one cwd must refuse pre-spawn`);
		assert.equal(
			preSpawnSharedWriteRefusal(discovery, cwd, refused)?.code,
			"SHARED_WRITE_CWD",
			`${mode}: the scored predicate must agree with the handler's refusal`,
		);

		const admitted = callFor("recon");
		const admittedRun = await handlerOutcome(mode as RunMode, admitted);
		assert.notEqual(admittedRun.errorCode, "SHARED_WRITE_CWD", `${mode}: read-only refs must not trip the guard`);
		assert.equal(
			preSpawnSharedWriteRefusal(discovery, admittedRun.cwd, admitted),
			null,
			`${mode}: the scored predicate must admit what the handler admits`,
		);
	}
});

test("every guard release valve the tool honors is honored by the predicate", async () => {
	const discovery = faultDiscovery();
	const cwd = workspace();
	const base = GUARDED_MODES.parallel("operator");
	// concurrency:1 serializes the writers; allowSharedWriteCwd is the explicit
	// bypass; a distinct cwd per writer removes the collision.
	for (const release of [
		{ ...base, concurrency: 1 },
		{ ...base, allowSharedWriteCwd: true },
		{ tasks: [{ agent: "operator", task: "A", cwd: "left" }, { agent: "operator", task: "B", cwd: "right" }] },
	]) {
		assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, release), null);
		const { errorCode } = await handlerOutcome("parallel", release);
		assert.notEqual(errorCode, "SHARED_WRITE_CWD");
	}
});

test("modes whose guard cannot fire before the first spawn contribute no pre-spawn waves", () => {
	// single/chain/route/loop/workflow/monitor never run concurrent same-cwd
	// children; worktree isolates each writer by construction; orchestrate's
	// guard fires only after its recon child has already run. A refusal claimed
	// for any of these would score a mid-run or nonexistent refusal as
	// pre-dispatch, so the predicate must stay silent.
	const shapes: Array<Record<string, unknown>> = [
		{ agent: "operator", task: "solo work" },
		{ chain: [{ agent: "operator", task: "A" }, { agent: "operator", task: "B" }] },
		{ task: "route it", route: { candidates: ["operator", "recon"] } },
		{ task: "iterate", loop: { body: { agent: "operator" } } },
		{ task: "migrate", workflow: { phases: [{ id: "a", agent: "operator", task: "A" }, { id: "b", agent: "operator", task: "B" }] } },
		{ task: "watch", monitor: { command: "./check", trigger: "match", pattern: "DOWN", reactor: { agent: "operator" } } },
		{ task: "fix both", worktree: { tasks: [{ id: "a", agent: "operator", task: "A" }, { id: "b", agent: "operator", task: "B" }] } },
		{ task: "map it", orchestrate: { worker: { agent: "operator" } } },
	];
	for (const params of shapes) {
		assert.deepEqual(preSpawnSharedWriteWaves(params).flat(), [], `no pre-spawn wave expected for ${Object.keys(params).join(",")}`);
		assert.equal(preSpawnSharedWriteRefusal(faultDiscovery(), "/tmp", params), null);
	}
});

test("workflow's roster refusal agrees with the handler: pre-spawn, but after the state write", async () => {
	// The roster rule lives in the production child-run adapter (runFlowAgent,
	// runner.ts), which the fault adapter deliberately does not re-state — so
	// this pin wires the real adapter into the handler. The unknown opener is
	// refused UNKNOWN_AGENT before any subprocess spawns, keeping the test
	// offline while pinning the enforced gate, not a re-statement of it.
	const adapter = makeFaultAdapter({ replies: {} });
	const cwd = workspace();
	const handler = RUN_MODE_CONTRACTS.find((contract) => contract.mode === "workflow")?.handler;
	assert.ok(handler, "workflow must be in the mode table");
	const params = { task: "migrate", workflow: { phases: [{ id: "a", agent: "made-up", task: "A" }] } };
	const output = await handler!(faultDeps(params, adapter, cwd, { runChild: runFlowAgent }));
	assert.equal(output.details.results[0]?.error?.code, "UNKNOWN_AGENT");
	// …so the derivation feeds the seam exactly that opening role (#91) and
	// the scored verdict cannot drift from the handler's refusal.
	assert.deepEqual(firstSpawnAgentRefs(params), [{ agent: "made-up" }]);
	// But fresh state already exists — at a possibly model-supplied stateFile —
	// which is why the harness terminates this refusal instead of letting it
	// play out (actsBeforeRunner, evals/select.mjs).
	assert.ok(existsSync(path.join(cwd, ".pi", "flow-workflows")), "state must be persisted before the roster refusal");
	// Approval phases spawn nothing: the first WORK phase is the opening role.
	assert.deepEqual(
		firstSpawnAgentRefs({ workflow: { phases: [{ id: "gate", approval: { message: "ok?" } }, { id: "b", agent: "operator", task: "B" }] } }),
		[{ agent: "operator" }],
	);
	// A resume derives nothing: which phase spawns first lives in persisted
	// state this static mirror cannot read, and an invalid phase list is
	// refused WORKFLOW_INVALID before any roster check.
	assert.deepEqual(firstSpawnAgentRefs({ workflow: { resume: true, phases: [{ id: "a", agent: "made-up", task: "A" }] } }), []);
	assert.deepEqual(firstSpawnAgentRefs({ workflow: { phases: [] } }), []);
});

test("the predicate is total over malformed model-emitted args — smaller waves, never a throw", () => {
	// The eval feeds the predicate raw model JSON before any schema validation,
	// and one malformed call must not crash a live run. The tool refuses these
	// shapes at its schema layer — a refusal outside this seam's vocabulary —
	// so the predicate's only obligation is to stay total and truthful about
	// the refs it can see.
	const discovery = faultDiscovery();
	const malformed: Array<Record<string, unknown>> = [
		{ debate: { participants: "a,b" } },
		{ dossier: { sections: "runbook, incident" } },
		{ graph: { nodes: "a->b" } },
		{ tasks: [null, "recon", { agent: "operator", task: "A" }] },
		{ vote: { voters: [null, 42] } },
		{ vote: { agent: "operator", count: -5 } },
		{ vote: { agent: { name: "operator" }, count: 3 } },
		{ graph: { nodes: [{ id: "a", agent: "operator", task: "A", dependsOn: 42 }] } },
		{ graph: { nodes: [{ id: "a", agent: "operator", task: "A", dependsOn: { on: "b" } }] } },
		{ workflow: { phases: "analyze,then,apply" } },
		{ tasks: [{ agent: "operator", task: "A", tools: {} }, { agent: "operator", task: "B", cwd: 123 }] },
		{ evaluate: { redteam: [{ agent: "operator", tools: 7 }, { agent: "operator", cwd: ["x"] }] } },
		{ evaluate: { redteam: Array.from({ length: 9 }, () => ({ agent: "operator" })) } },
		{ evaluate: { redteam: "operator" } },
		{ search: { generator: "operator" } },
		{ vote: {} },
		{ debate: {} },
	];
	for (const params of malformed) {
		assert.doesNotThrow(() => preSpawnSharedWriteRefusal(discovery, "/tmp", { why: "x", ...params }), `must not throw for ${JSON.stringify(params)}`);
	}
	// A hostile replication count never allocates — and because the handler
	// refuses TOO_MANY_TASKS before its guard, the mirror stays silent behind
	// that earlier refusal instead of mislabeling it SHARED_WRITE_CWD.
	assert.equal(preSpawnSharedWriteRefusal(discovery, "/tmp", { why: "x", vote: { agent: "operator", count: 1e9 } }), null);
	// Behind an invalid concurrency the dispatch core refuses first
	// (INVALID_CONCURRENCY), so the guard stays silent rather than mislabeling
	// the refusal; the admissibility seam scores the concurrency bound itself.
	assert.equal(preSpawnSharedWriteRefusal(discovery, "/tmp", { why: "x", concurrency: 0, tasks: [{ agent: "operator", task: "A" }, { agent: "operator", task: "B" }] }), null);
	// handleGraph refuses GRAPH_INVALID for a node count outside
	// 1..MAX_GRAPH_NODES before its guard; the mirror stays silent behind it
	// and never iterates the oversized list.
	assert.equal(preSpawnSharedWriteRefusal(discovery, "/tmp", {
		why: "x",
		graph: { nodes: Array.from({ length: 17 }, (_, index) => ({ id: `n${index}`, agent: "operator", task: "A" })) },
	}), null);
	// A garbage search ref falls back to the handler default instead of
	// emitting a non-ref wave element — verdict-neutral either way.
	assert.equal(preSpawnSharedWriteRefusal(discovery, "/tmp", { why: "x", search: { generator: "operator" } }), null);
	// Garbage elements shrink the wave but honest refs still count: one null
	// plus two write-capable tasks is still a collision.
	assert.equal(
		preSpawnSharedWriteRefusal(discovery, "/tmp", { why: "x", tasks: [null, { agent: "operator", task: "A" }, { agent: "operator", task: "B" }] })?.code,
		"SHARED_WRITE_CWD",
	);
});

test("the mirror stays silent behind TOO_MANY_TASKS, agreeing with the handler's refusal order", async () => {
	const discovery = faultDiscovery();
	const oversized = {
		tasks: Array.from({ length: 9 }, (_, index) => ({ agent: "operator", task: `write ${index}` })),
	};
	// The handler refuses TOO_MANY_TASKS before validateSharedWriteCwd runs…
	const { errorCode, cwd } = await handlerOutcome("parallel", oversized);
	assert.equal(errorCode, "TOO_MANY_TASKS");
	// …so the mirror yields no wave rather than claiming the guard fired.
	assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, { why: "x", ...oversized }), null);
	assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, {
		why: "x",
		vote: { voters: Array.from({ length: 9 }, () => ({ agent: "operator" })) },
	}), null);
});

test("wave derivations mirror handler defaults, not just explicit refs", () => {
	const discovery = faultDiscovery();
	const cwd = workspace();
	// evaluate defaults its critic panel to one redteam; one ref can never
	// collide, so the default-shape call stays admissible.
	assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, { task: "t", evaluate: {} }), null);
	// vote replicates one agent `count` times: the replication itself is what
	// makes a write-capable voter collide.
	assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, { task: "t", vote: { agent: "operator", count: 3 } })?.code, "SHARED_WRITE_CWD");
	assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, { task: "t", vote: { agent: "recon", count: 3 } }), null);
	// search replicates its generator across candidates the same way.
	assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, { task: "t", search: { generator: { agent: "operator" } } })?.code, "SHARED_WRITE_CWD");
	// graph counts only the dependency-free first wave: a write-capable second
	// wave is a mid-run concern, not a pre-spawn refusal.
	const staggered = {
		graph: { nodes: [
			{ id: "a", agent: "operator", task: "A" },
			{ id: "b", agent: "operator", task: "B", dependsOn: ["a"] },
		] },
	};
	assert.equal(preSpawnSharedWriteRefusal(discovery, cwd, staggered), null);
});
