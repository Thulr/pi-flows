// Offline tests for the admissibility vocabulary (issue #84, PR #87): every
// "would the flow tool have refused this call before any child spawned"
// verdict, each rule the tool's own predicate — the public schema, mode
// detection, dispatch gates, handler entry validation, contracts, budgets,
// and roster — plus the play-out policy that decides which refusals the live
// harness may let a model retry. Case-level sequence scoring lives in
// selection-sequence.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAdmissibilityFailure, letRefusalPlayOut, observationCap, scoreSelection } from "../evals/select.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";

const reviewCase = SELECTION_CASES.find((testCase: any) => testCase.name === "independent-review-safe-first-call");

/** A complete public-schema delegation contract; budget ceilings vary per test. */
function fullContract(budget: Record<string, number>): Record<string, unknown> {
	return {
		objective: "review the change set",
		constraints: ["read-only"],
		nonGoals: ["fixing findings"],
		dependencies: [],
		authority: { may: ["read repository files"], mustNot: ["edit files"], requiresApproval: [] },
		sideEffectClass: "read-only",
		budget,
		acceptanceChecks: ["coverage is complete"],
		returnSchema: { type: "object" },
		owner: "standards",
	};
}

const REFUSED_FANOUT = {
	why: "independent review of uncommitted changes",
	tasks: [
		{ agent: "overwatch", role: "standards", task: "Review the uncommitted changes for standards issues." },
		{ agent: "overwatch", role: "spec", task: "Review the uncommitted changes against intent." },
	],
};

function scored(flowCallArgs: Array<Record<string, unknown>>, testCase: any = reviewCase) {
	assert.ok(testCase, "selection case fixture missing — was independent-review-safe-first-call renamed?");
	return scoreSelection(testCase, { flowCalls: flowCallArgs.length, flowCallArgs, stoppedAfterFlowCall: true, answer: "" });
}

test("preset calls are scored on their expanded topology, exactly as the tool resolves them", () => {
	// The bundled code-review preset serializes its shell-capable reviewers
	// (concurrency:1), so the plain call is admissible…
	assert.equal(callAdmissibilityFailure({ preset: "code-review", task: "Review HEAD.", why: "independent review" }), null);
	// …but concurrency is a declared override: raising it re-creates exactly
	// the two-overwatch collision the guard exists for, and the tool refuses
	// the expanded call. Scoring raw preset args would credit that call.
	assert.equal(
		callAdmissibilityFailure({ preset: "code-review", task: "Review HEAD.", why: "independent review", concurrency: 2 })?.code,
		"SHARED_WRITE_CWD",
	);
	// Shape-visible resolution failures (unknown name, undeclared override
	// key) stay outside the vocabulary; the raw args stand and shape scoring
	// reports preset-unknown/preset-conflict.
	assert.equal(callAdmissibilityFailure({ preset: "no-such-preset", task: "t", why: "x" }), null);
	// A declared override key with an out-of-schema value is refused by pi's
	// own parameter validation before execute — and before resolution — so
	// the seam scores SCHEMA_INVALID rather than crediting a call no
	// reviewer ever starts.
	assert.equal(callAdmissibilityFailure({ preset: "code-review", task: "t", why: "x", concurrency: "one" })?.code, "SCHEMA_INVALID");
	const wordConcurrency = scored([{ preset: "code-review", task: "Review the uncommitted changes.", why: "independent review", concurrency: "one" }]);
	assert.equal(wordConcurrency.pass, false);
	assert.match(wordConcurrency.notes, /SCHEMA_INVALID/);
	// A known preset missing its required task is the same class.
	assert.equal(callAdmissibilityFailure({ preset: "code-review", why: "x" })?.code, "PRESET_TASK_REQUIRED");
});

test("a call activating several modes is refused with the tool's own exactly-one-mode rule", () => {
	// tasks + vote together: first-activator scoring would classify this as
	// parallel and could admit it, but detectRunMode refuses the call with
	// INVALID_MODE before any other gate — so must the seam.
	const multiMode = {
		why: "independent review of uncommitted changes",
		tasks: [{ agent: "recon", task: "Review the uncommitted changes." }, { agent: "analyst", task: "Review the uncommitted changes." }],
		vote: { agent: "recon", count: 2 },
	};
	assert.equal(callAdmissibilityFailure(multiMode)?.code, "INVALID_MODE");
	const result = scored([multiMode]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /INVALID_MODE/);
});

test("an oversized fan-out is refused with the tool's own TOO_MANY_TASKS, not admitted", () => {
	// The public schema has no maxItems, so nine serialized review tasks are a
	// schema-valid live input; the handler refuses TOO_MANY_TASKS before its
	// guard, and admitting the call would let minTasks record a false pass.
	const nineTasks = {
		why: "independent review of uncommitted changes",
		concurrency: 1,
		tasks: Array.from({ length: 9 }, (_, index) => ({ agent: "recon", task: `Review the uncommitted changes, part ${index + 1}.` })),
	};
	assert.equal(callAdmissibilityFailure(nineTasks)?.code, "TOO_MANY_TASKS");
	const result = scored([nineTasks]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /TOO_MANY_TASKS/);
	// The schema itself caps vote.count at the fan-out limit, so an over-cap
	// count is refused a layer earlier than the handler's bound.
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", vote: { agent: "recon", count: 9 } })?.code, "SCHEMA_INVALID");
});

test("a first call whose every reviewer is an invented agent is refused, not admitted", () => {
	// The runner refuses each unknown agent at spawn (UNKNOWN_AGENT); with no
	// known ref among the first-spawn roles, no child can do work, so the
	// seam refuses the call instead of letting the case record a pass for a
	// review nothing performed.
	const invented = {
		why: "independent review of uncommitted changes",
		tasks: [
			{ agent: "standards-reviewer", task: "Review the uncommitted changes." },
			{ agent: "spec-reviewer", task: "Review the uncommitted changes." },
		],
	};
	assert.equal(callAdmissibilityFailure(invented)?.code, "UNKNOWN_AGENT");
	const result = scored([invented]);
	assert.equal(result.pass, false);
	// knownAgentsOnly reports it as a shape mismatch before the admissibility
	// rider would name UNKNOWN_AGENT; both describe the same defect.
	assert.match(result.notes, /not bundled flow agents/);
	// One known ref means real children spawn: the call is admitted, and the
	// harness must terminate rather than let live children run to completion.
	const mixed = {
		why: "independent review of uncommitted changes",
		concurrency: 1,
		tasks: [{ agent: "recon", task: "Review the uncommitted changes." }, { agent: "spec-reviewer", task: "Review the uncommitted changes." }],
	};
	assert.equal(callAdmissibilityFailure(mixed), null);
	// …but admitted is not correct: the runner refuses the invented sibling,
	// so only one independent review can run, and knownAgentsOnly fails the
	// shape instead.
	const mixedScore = scored([mixed]);
	assert.equal(mixedScore.pass, false);
	assert.match(mixedScore.notes, /spec-reviewer are not bundled flow agents/);
	// Sequential openers are covered too: a single-mode call to an invented
	// agent spawns nothing.
	assert.equal(callAdmissibilityFailure({ why: "x", agent: "made-up-agent", task: "t" })?.code, "UNKNOWN_AGENT");
	// Worktree and workflow are deliberately outside the rule: handleWorktree
	// creates every branch and worktree before any agent resolves, and
	// handleWorkflow persists fresh state — to a possibly model-supplied
	// stateFile — first, so unknown-agent refusals there happen after real
	// state exists. Such calls are admitted and the harness terminates before
	// that work begins.
	assert.equal(callAdmissibilityFailure({
		why: "x",
		task: "t",
		worktree: { tasks: [{ id: "a", agent: "made-up", task: "A" }, { id: "b", agent: "also-made-up", task: "B" }] },
	}), null);
	assert.equal(callAdmissibilityFailure({
		why: "x",
		task: "t",
		workflow: { phases: [{ id: "a", agent: "made-up", task: "A" }], stateFile: "package.json" },
	}), null);
	// Spawn order per mode: orchestrate's commander decomposes before any
	// recon worker, so an invented recon with the default commander is
	// admitted, while an invented commander is refused before any child runs.
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", orchestrate: { recon: { agent: "made-up" } } }), null);
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", orchestrate: { commander: { agent: "made-up" } } })?.code, "UNKNOWN_AGENT");
	// Search runs every generator before any scorer; an invented generator
	// yields SEARCH_NO_CANDIDATES with no child work even when the scorer is
	// bundled, so the bundled scorer must not admit the call. (The scorer is
	// read-only here because a write-capable scorer wave legitimately trips
	// the shared-write guard first, exactly as the handler checks it.)
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", search: { generator: { agent: "made-up" }, scorer: { agent: "analyst" } } })?.code, "UNKNOWN_AGENT");
});

test("only writeless, vocabulary-named refusals play out in the live harness", () => {
	const budgeted = { expectFlow: true, maxRefusedCalls: 1 };
	// A plain scored refusal plays out…
	assert.equal(letRefusalPlayOut(REFUSED_FANOUT, 1, budgeted), true);
	// …but the extension creates and finalizes a trace sink at a
	// caller-controlled traceFile even for refused calls, so a refusal
	// carrying one could append spans to any writable path — terminate it.
	assert.equal(letRefusalPlayOut({ ...REFUSED_FANOUT, traceFile: "package.json" }, 1, budgeted), false);
	// Admitted calls, unparseable args, and the cap all terminate too.
	assert.equal(letRefusalPlayOut({ ...REFUSED_FANOUT, concurrency: 1 }, 1, budgeted), false);
	assert.equal(letRefusalPlayOut({ __unparsed: "{" }, 1, budgeted), false);
	assert.equal(letRefusalPlayOut(REFUSED_FANOUT, observationCap(budgeted), budgeted), false);
	// The sink path falls back to PI_FLOWS_TRACE_FILE, which the subject
	// inherits from this process — an environment-supplied destination makes
	// every refusal a writer just as an explicit traceFile does.
	const previousTraceFile = process.env.PI_FLOWS_TRACE_FILE;
	process.env.PI_FLOWS_TRACE_FILE = "trace.jsonl";
	try {
		assert.equal(letRefusalPlayOut(REFUSED_FANOUT, 1, budgeted), false);
	} finally {
		if (previousTraceFile === undefined) delete process.env.PI_FLOWS_TRACE_FILE;
		else process.env.PI_FLOWS_TRACE_FILE = previousTraceFile;
	}
});

test("the observation cap always sits above the case's refused-call budget", () => {
	// A cap at the budget would terminate the run with exactly budget-many
	// refusals observed, so the budget could never be exceeded and a
	// budget-only case would pass without one admitted call.
	assert.equal(observationCap({}), 5);
	assert.equal(observationCap({ maxRefusedCalls: 1 }), 5);
	assert.equal(observationCap({ maxRefusedCalls: 5 }), 7);
	assert.equal(observationCap({ maxRefusedCalls: 9 }), 11);
	for (const budget of [0, 1, 4, 5, 9]) {
		assert.ok(observationCap({ maxRefusedCalls: budget }) > budget + 1, `cap must allow observing a breach of budget ${budget}`);
	}
});

test("inherited flow depth and initially exhausted budgets are refused, not credited", () => {
	// The subject inherits PI_FLOWS_DEPTH; at the cap every spawning call is
	// refused, so scoring must not credit selections that can never run.
	const admissible = { ...REFUSED_FANOUT, concurrency: 1 };
	const previousDepth = process.env.PI_FLOWS_DEPTH;
	process.env.PI_FLOWS_DEPTH = "2";
	try {
		assert.equal(callAdmissibilityFailure(admissible)?.code, "FLOW_DEPTH_EXCEEDED");
	} finally {
		if (previousDepth === undefined) delete process.env.PI_FLOWS_DEPTH;
		else process.env.PI_FLOWS_DEPTH = previousDepth;
	}
	assert.equal(callAdmissibilityFailure(admissible), null);
	// A zero ceiling starts the flow budget exhausted; the runner refuses the
	// first spawn with BUDGET_EXCEEDED before any child runs.
	assert.equal(callAdmissibilityFailure({ ...admissible, maxCostUsd: 0 })?.code, "BUDGET_EXCEEDED");
	assert.equal(callAdmissibilityFailure({ ...admissible, maxTokens: 0 })?.code, "BUDGET_EXCEEDED");
	// A real, positive ceiling is not a refusal.
	assert.equal(callAdmissibilityFailure({ ...admissible, maxCostUsd: 5 }), null);
	// Contract budgets refuse the same way: when every first-spawn role's
	// contract starts exhausted, no child can spawn — one funded role admits.
	// The fixture is a complete public-schema contract; a partial one is
	// refused SCHEMA_INVALID before any budget is consulted.
	const zeroBudgetContract = fullContract({ timeoutMs: 60_000, maxTokens: 0, maxGeneratedTokens: 100 });
	assert.equal(callAdmissibilityFailure({
		...admissible,
		tasks: admissible.tasks.map((task) => ({ ...task, contract: zeroBudgetContract })),
	})?.code, "BUDGET_EXCEEDED");
	assert.equal(callAdmissibilityFailure({ ...admissible, contract: zeroBudgetContract })?.code, "BUDGET_EXCEEDED");
	assert.equal(callAdmissibilityFailure({
		...admissible,
		tasks: [{ ...admissible.tasks[0], contract: zeroBudgetContract }, admissible.tasks[1]],
	}), null);
	// Runner-level refusals play out only where the runner's gate is the
	// first thing that acts: monitor runs its probe command, workflow
	// persists state, and worktree creates branches first, so those (and raw
	// preset references, whose expanded shape this layer cannot see)
	// terminate — while a stateless serialized fan-out may reach its retry.
	const budgeted = { expectFlow: true, maxRefusedCalls: 1 };
	assert.equal(letRefusalPlayOut({ why: "x", task: "t", maxCostUsd: 0, monitor: { command: "./probe", trigger: "match", pattern: "DOWN" } }, 1, budgeted), false);
	assert.equal(letRefusalPlayOut({ why: "x", task: "t", maxCostUsd: 0, workflow: { phases: [{ id: "a", agent: "recon", task: "A" }] } }, 1, budgeted), false);
	assert.equal(letRefusalPlayOut({ ...admissible, maxCostUsd: 0 }, 1, budgeted), true);
});

test("contracts count only where the opener consumes them", () => {
	// handleRoute runs its controller with no contract limits; search and
	// loop likewise — neither the top-level fallback nor a role contract
	// reaches those openers, so claiming a refusal would let the play-out
	// branch execute a call the tool admits and spawn a live child.
	const zeroBudgetContract = fullContract({ timeoutMs: 60_000, maxTokens: 0, maxGeneratedTokens: 100 });
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", contract: zeroBudgetContract, route: { candidates: ["recon", "analyst"] } }), null);
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", contract: zeroBudgetContract, search: {} }), null);
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", route: { candidates: ["recon", "analyst"], controller: { agent: "controller", contract: zeroBudgetContract } } }), null);
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", search: { generator: { agent: "strategist", contract: zeroBudgetContract } } }), null);
	// Graph nodes run through integrationRunPlan, which resolves each ref's
	// own contract — a first wave of exhausted nodes is a real refusal.
	assert.equal(callAdmissibilityFailure({
		why: "x",
		graph: { nodes: [{ id: "a", agent: "recon", task: "A", contract: zeroBudgetContract }] },
	})?.code, "BUDGET_EXCEEDED");
});

test("an approval-first workflow is refused in the headless subject, and never plays out", () => {
	const approvalFirst = {
		why: "x",
		task: "Run the migration through gated phases.",
		workflow: { phases: [{ id: "approve", approval: { message: "Approve the plan" } }, { id: "apply", agent: "recon", task: "Apply." }] },
	};
	assert.equal(callAdmissibilityFailure(approvalFirst)?.code, "WORKFLOW_APPROVAL_REQUIRED");
	// State is persisted before the refusal, so the stateful-mode rule keeps
	// it out of the play-out branch.
	assert.equal(letRefusalPlayOut(approvalFirst, 1, { expectFlow: true, maxRefusedCalls: 1 }), false);
	// A work-first workflow spawns its first child and stays admitted.
	assert.equal(callAdmissibilityFailure({
		why: "x",
		task: "t",
		workflow: { phases: [{ id: "scan", agent: "recon", task: "Scan." }, { id: "approve", approval: { message: "Approve" } }] },
	}), null);
});

test("dossier sections and the orchestrate commander consume their own contracts", () => {
	const exhausted = fullContract({ timeoutMs: 60_000, maxTokens: 0, maxGeneratedTokens: 100 });
	// Every section exhausted: nothing can start.
	assert.equal(callAdmissibilityFailure({
		why: "x",
		task: "t",
		dossier: { sections: [{ agent: "recon", task: "A", contract: exhausted }, { agent: "analyst", task: "B", contract: exhausted }] },
	})?.code, "BUDGET_EXCEEDED");
	// The commander's own contract is validated at plan construction.
	const badContract = { ...fullContract({ timeoutMs: 60_000, maxTokens: 1000, maxGeneratedTokens: 100 }), returnSchema: { type: "string", pattern: "(" } };
	assert.equal(callAdmissibilityFailure({
		why: "x",
		task: "t",
		orchestrate: { commander: { agent: "commander", contract: badContract } },
	})?.code, "INVALID_DELEGATION_CONTRACT");
});

test("an invalid consumed contract refuses the whole call at plan construction", () => {
	// integrationRunPlan validates each consumed contract while building
	// plans, before any fanout starts — a returnSchema with a malformed
	// regex pattern fails there, so one bad contract among the roles refuses
	// the call rather than being admitted into a terminated pass.
	const badContract = { ...fullContract({ timeoutMs: 60_000, maxTokens: 1000, maxGeneratedTokens: 100 }), returnSchema: { type: "string", pattern: "(" } };
	const refusal = callAdmissibilityFailure({
		why: "independent review of uncommitted changes",
		concurrency: 1,
		tasks: [
			{ agent: "recon", task: "Review the uncommitted changes.", contract: badContract },
			{ agent: "recon", task: "Review the uncommitted changes." },
		],
	});
	assert.equal(refusal?.code, "INVALID_DELEGATION_CONTRACT");
	// Dossier's top-level fallback goes to its synthesizer, not its sections:
	// an exhausted top-level contract with uncontracted sections stays
	// admitted, exactly as handleDossier builds its section plans.
	assert.equal(callAdmissibilityFailure({
		why: "x",
		task: "t",
		contract: fullContract({ timeoutMs: 60_000, maxTokens: 0, maxGeneratedTokens: 100 }),
		dossier: { sections: [{ agent: "recon", task: "Source A" }, { agent: "analyst", task: "Source B" }] },
	}), null);
});

test("mixed per-role refusal causes combine: a wave nobody can start is refused", () => {
	// One reviewer is outside the roster, the other's contract starts
	// exhausted — neither cause alone covers every role, but no child can
	// spawn, so admission would credit a call that does nothing.
	const mixedCauses = {
		why: "independent review of uncommitted changes",
		concurrency: 1,
		tasks: [
			{ agent: "invented-reviewer", task: "Review the uncommitted changes." },
			{ agent: "recon", task: "Review the uncommitted changes.", contract: fullContract({ timeoutMs: 60_000, maxTokens: 0, maxGeneratedTokens: 100 }) },
		],
	};
	const refusal = callAdmissibilityFailure(mixedCauses);
	assert.ok(refusal, "a wave nobody can start must be refused");
	assert.match(refusal.reason, /no first-spawn role can start \(.*\+.*\)/);
	// One startable role still admits the call.
	assert.equal(callAdmissibilityFailure({
		...mixedCauses,
		tasks: [mixedCauses.tasks[0], { agent: "recon", task: "Review the uncommitted changes." }],
	}), null);
});

test("monitor calls the tool would refuse before probing are refused here too", () => {
	// A match trigger without a pattern (or with an uncompilable one) and a
	// blank command are all refused MONITOR_INVALID before the probe runs;
	// the pre-existing monitor case must not credit them.
	assert.equal(callAdmissibilityFailure({ why: "x", task: "Diagnose DEGRADED", monitor: { command: "./health-check", trigger: "match" } })?.code, "MONITOR_INVALID");
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", monitor: { command: "./health-check", trigger: "match", pattern: "(" } })?.code, "MONITOR_INVALID");
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", monitor: { command: "   " } })?.code, "MONITOR_INVALID");
	// An unknown trigger never reaches the handler's normalization: the
	// public schema enumerates the allowed values and pi refuses the call.
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", monitor: { command: "./health-check", trigger: "sometimes" } })?.code, "SCHEMA_INVALID");
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", monitor: { command: "./health-check", trigger: "match", pattern: "DEGRADED", reactor: { agent: "analyst" } } }), null);
});

test("oversized debate and dossier role lists are schema-refused, never guard-mislabeled", () => {
	// The schema caps both lists at the fan-out limit, so pi refuses the call
	// before the handler or its guard runs; the wave mirror stays silent for
	// the same shapes so the guard can never claim them.
	const many = Array.from({ length: 9 }, (_, index) => ({ agent: "overwatch", task: `part ${index}` }));
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", debate: { participants: many } })?.code, "SCHEMA_INVALID");
	assert.equal(callAdmissibilityFailure({ why: "x", task: "t", dossier: { sections: many } })?.code, "SCHEMA_INVALID");
});

test("a rootless graph is refused with the tool's own GRAPH_CYCLE, not admitted", () => {
	// Every node depends on another, so no first wave can ever run;
	// handleGraph refuses GRAPH_CYCLE before any child spawns, and admitting
	// it would credit delegation that never occurred.
	const cyclic = {
		why: "x",
		graph: { nodes: [
			{ id: "a", agent: "recon", task: "A", dependsOn: ["b"] },
			{ id: "b", agent: "recon", task: "B", dependsOn: ["a"] },
		] },
	};
	assert.equal(callAdmissibilityFailure(cyclic)?.code, "GRAPH_CYCLE");
	// A rooted graph stays admitted, and a structurally invalid one stays
	// silent (GRAPH_INVALID is refused earlier, outside the vocabulary).
	assert.equal(callAdmissibilityFailure({
		why: "x",
		graph: { nodes: [{ id: "a", agent: "recon", task: "A" }, { id: "b", agent: "recon", task: "B", dependsOn: ["a"] }] },
	}), null);
	assert.equal(callAdmissibilityFailure({ why: "x", graph: { nodes: [{ id: "a", agent: "recon", task: "A", dependsOn: ["missing"] }] } }), null);
});

test("a spawn checkpoint and a destination-less strict trace are refused in the headless subject", () => {
	// checkpoint gates "spawn" by default and the JSON-mode subject has no UI,
	// so the tool refuses CHECKPOINT_APPROVAL_REQUIRED before the handler runs.
	assert.equal(callAdmissibilityFailure({ ...REFUSED_FANOUT, concurrency: 1, checkpoint: {} })?.code, "CHECKPOINT_APPROVAL_REQUIRED");
	assert.equal(callAdmissibilityFailure({ ...REFUSED_FANOUT, concurrency: 1, checkpoint: { before: "spawn" } })?.code, "CHECKPOINT_APPROVAL_REQUIRED");
	// A finalize checkpoint does not gate the spawn; the call is admitted.
	assert.equal(callAdmissibilityFailure({ ...REFUSED_FANOUT, concurrency: 1, checkpoint: { before: "finalize" } }), null);
	// Strict tracing with no trace destination is refused pre-dispatch.
	assert.equal(callAdmissibilityFailure({ ...REFUSED_FANOUT, concurrency: 1, traceStrict: true })?.code, "TRACE_INCOMPLETE");
	// The environment supplies the same inputs the subject inherits.
	const previousStrict = process.env.PI_FLOWS_TRACE_STRICT;
	process.env.PI_FLOWS_TRACE_STRICT = "1";
	try {
		assert.equal(callAdmissibilityFailure({ ...REFUSED_FANOUT, concurrency: 1 })?.code, "TRACE_INCOMPLETE");
	} finally {
		if (previousStrict === undefined) delete process.env.PI_FLOWS_TRACE_STRICT;
		else process.env.PI_FLOWS_TRACE_STRICT = previousStrict;
	}
});

test("an invalid concurrency is scored as the tool's own INVALID_CONCURRENCY, not as the guard behind it", () => {
	// The dispatch core refuses these before any handler guard runs; claiming
	// SHARED_WRITE_CWD (or admitting them) would mis-count refusal budgets.
	// concurrency:0 is below the schema's own minimum, so pi refuses it a
	// layer before the dispatch core would; 2.5 passes the schema and is the
	// dispatch core's non-integer refusal.
	assert.equal(callAdmissibilityFailure({ ...REFUSED_FANOUT, concurrency: 0 })?.code, "SCHEMA_INVALID");
	assert.equal(callAdmissibilityFailure({ ...REFUSED_FANOUT, concurrency: 2.5 })?.code, "INVALID_CONCURRENCY");
	// The same sub-minimum value on a preset call is equally schema-refused
	// on the raw args, before resolution ever runs.
	assert.equal(callAdmissibilityFailure({ preset: "code-review", task: "t", why: "x", concurrency: 0.5 })?.code, "SCHEMA_INVALID");
});
