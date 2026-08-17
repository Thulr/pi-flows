// Wiring smoke tests for the Decomposition (issue #148): the parser normalizes
// both emission paths and both shapes, the validator refuses the defects that
// would otherwise strand or collide workers, and orchestrate actually schedules
// a dependent subtask after the subtask it names. The full behavior matrix
// lives in its own file; nothing here duplicates the flat-path coverage already
// in tests/integration.test.ts.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecomposition, validateDecomposition, type Decomposition, type DecompositionAdmission } from "../extensions/pi-flows/decomposition.ts";
import { discoverFlowAgents } from "../extensions/pi-flows/agents.ts";
import { byAgent, runFlow } from "./stub-harness.ts";

async function admission(overrides: Partial<DecompositionAdmission> = {}): Promise<DecompositionAdmission> {
	const repo = path.join(tmpdir(), `pi-flows-decomp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(path.join(repo, ".pi", "flow-agents"), { recursive: true });
	return {
		discovery: discoverFlowAgents(repo, "user"),
		defaultCwd: repo,
		workerRef: { agent: "recon" },
		concurrency: 4,
		maxSubtasks: 8,
		...overrides,
	};
}

const legacy = (json: string) => `Here is the breakdown.\n\n\`\`\`json\n${json}\n\`\`\``;
const contracted = (data: unknown) => ({ source: "contract" as const, data });

test("a flat subtask list parses as a Decomposition with no edges, from either emission path", () => {
	const fromProse = parseDecomposition(legacy('["map login", "map refresh"]'), 8);
	assert.equal(fromProse?.shape, "flat");
	assert.deepEqual(fromProse?.subtasks.map((subtask) => [subtask.id, subtask.objective, subtask.dependsOn]), [
		["1", "map login", []],
		["2", "map refresh", []],
	]);
	const fromEnvelope = parseDecomposition(contracted(["map login", "map refresh"]), 8);
	assert.deepEqual(fromEnvelope, fromProse);

	// The legacy {task} wrapper stays a flat subtask string, as parseSubtasks has
	// always read it, and the flat path keeps its silent slice to the ceiling.
	assert.equal(parseDecomposition(legacy('[{"task":"a"},{"task":"b"}]'), 8)?.shape, "flat");
	assert.equal(parseDecomposition(legacy('["a","b","c"]'), 2)?.subtasks.length, 2);
	assert.equal(parseDecomposition(legacy("not an array"), 8), null);
	assert.equal(parseDecomposition(legacy("[]"), 8), null);
});

test("a structured array parses as a Decomposition with edges and is never sliced", () => {
	const decomposition = parseDecomposition(legacy(JSON.stringify([
		{ id: "survey", objective: "List entry points", scope: "auth only", nonGoals: ["no edits"], expectedReturn: "a list" },
		{ id: "trace", objective: "Trace refresh", dependsOn: ["survey"], inputs: "the survey list", acceptanceEvidence: "file:line" },
	])), 8);
	assert.equal(decomposition?.shape, "structured");
	assert.deepEqual(decomposition?.subtasks[0].dependsOn, []);
	assert.deepEqual(decomposition?.subtasks[1].dependsOn, ["survey"]);
	assert.equal(decomposition?.subtasks[0].scope, "auth only");
	assert.equal(decomposition?.subtasks[0].nonGoals, "no edits");
	assert.equal(decomposition?.subtasks[0].expectedReturn, "a list");
	assert.equal(decomposition?.subtasks[1].inputs, "the survey list");
	assert.equal(decomposition?.subtasks[1].acceptanceEvidence, "file:line");

	// A ceiling that would sever an edge is the validator's refusal, not a slice.
	const over = parseDecomposition(legacy(JSON.stringify([{ id: "a", objective: "a" }, { id: "b", objective: "b" }])), 1);
	assert.equal(over?.subtasks.length, 2);
});

test("the validator refuses the defects that would strand or collide workers", async () => {
	const admitted = await admission();
	const refusal = (entries: unknown[]) => validateDecomposition(parseDecomposition(legacy(JSON.stringify(entries)), 8) as Decomposition, admitted);

	assert.equal(refusal([{ id: "a", objective: "a" }, { id: "b", objective: "b" }]), null);
	assert.equal(refusal([{ objective: "no id" }, { id: "b", objective: "b" }])?.code, "DECOMPOSITION_INVALID");
	assert.equal(refusal([{ id: "a", objective: "a" }, { id: "a", objective: "b" }])?.code, "DECOMPOSITION_INVALID");
	assert.equal(refusal([{ id: "a", objective: "" }, { id: "b", objective: "b" }])?.code, "DECOMPOSITION_INVALID");
	assert.equal(refusal([{ id: "a", objective: "a", dependsOn: "b" }, { id: "b", objective: "b" }])?.code, "DECOMPOSITION_INVALID");
	assert.equal(refusal([{ id: "a", objective: "a", dependsOn: ["ghost"] }])?.code, "DECOMPOSITION_INVALID");

	// A subtask may not pick its own agent: every subtask runs the one worker role.
	const named = refusal([{ id: "a", objective: "a", agent: "operator" }, { id: "b", objective: "b" }]);
	assert.equal(named?.code, "DECOMPOSITION_INVALID");
	assert.match(named?.message ?? "", /names an agent/);

	// A ceiling a structured Decomposition exceeds, refused rather than cut.
	const overCeiling = validateDecomposition(
		parseDecomposition(legacy(JSON.stringify([{ id: "a", objective: "a" }, { id: "b", objective: "b" }])), 1) as Decomposition,
		await admission({ maxSubtasks: 1 }),
	);
	assert.equal(overCeiling?.code, "DECOMPOSITION_INVALID");
	assert.match(overCeiling?.cause ?? "", /sever/);
});

test("every cycle is refused, not only the one with no first wave", async () => {
	const admitted = await admission();
	const cycle = (entries: unknown[]) => validateDecomposition(parseDecomposition(legacy(JSON.stringify(entries)), 8) as Decomposition, admitted);

	// No dependency-free subtask at all.
	assert.equal(cycle([{ id: "a", objective: "a", dependsOn: ["b"] }, { id: "b", objective: "b", dependsOn: ["a"] }])?.code, "DECOMPOSITION_CYCLE");
	// A first wave exists, and the cycle strands only later subtasks — the shape
	// a no-first-wave check misses until those subtasks have already been paid for.
	const later = cycle([
		{ id: "start", objective: "start" },
		{ id: "b", objective: "b", dependsOn: ["start", "c"] },
		{ id: "c", objective: "c", dependsOn: ["b"] },
	]);
	assert.equal(later?.code, "DECOMPOSITION_CYCLE");
	assert.match(later?.cause ?? "", /b -> c -> b|c -> b -> c/);
	// A diamond re-reaches a subtask by two paths, which is not a cycle.
	assert.equal(cycle([
		{ id: "a", objective: "a" },
		{ id: "b", objective: "b", dependsOn: ["a"] },
		{ id: "c", objective: "c", dependsOn: ["a"] },
		{ id: "d", objective: "d", dependsOn: ["b", "c"] },
	]), null);
});

test("shared-write admissibility is judged over the whole Decomposition, not one wave", async () => {
	const writer = await admission({ workerRef: { agent: "operator" } });
	const chainOnly = parseDecomposition(legacy(JSON.stringify([
		{ id: "a", objective: "a" },
		{ id: "b", objective: "b", dependsOn: ["a"] },
	])), 8) as Decomposition;
	// Every subtask is ordered against every other, so no two ever run together.
	assert.equal(validateDecomposition(chainOnly, writer), null);

	// `a` and `c` are dependency-independent, and they never share a wave — the
	// per-wave gate would not see them. The whole-Decomposition rule does.
	const independentAcrossWaves = parseDecomposition(legacy(JSON.stringify([
		{ id: "a", objective: "a" },
		{ id: "b", objective: "b" },
		{ id: "c", objective: "c", dependsOn: ["b"] },
	])), 8) as Decomposition;
	assert.equal(validateDecomposition(independentAcrossWaves, writer)?.code, "SHARED_WRITE_CWD");
	// The same gate inputs release it, exactly as they release the wave gate.
	assert.equal(validateDecomposition(independentAcrossWaves, { ...writer, concurrency: 1 }), null);
	assert.equal(validateDecomposition(independentAcrossWaves, { ...writer, allowSharedWriteCwd: true }), null);
	// A read-only worker was never the concern.
	assert.equal(validateDecomposition(independentAcrossWaves, await admission()), null);
});

test("orchestrate runs a dependent subtask after the subtask it names, carrying its output", async () => {
	const { calls, text, result } = await runFlow(
		{ task: "document how auth works", orchestrate: { recon: { agent: "recon" } } },
		{
			commander: JSON.stringify([
				{ id: "survey", objective: "List the auth entry points" },
				{ id: "trace", objective: "Trace token refresh", dependsOn: ["survey"], scope: "server only" },
			]),
			recon: "WORKER_FINDING",
			debrief: "MERGED_DOC",
		},
	);

	assert.equal(result.details.error, undefined);
	// One worker per subtask, in dependency order rather than one wave.
	assert.deepEqual(calls.map((call) => call.agent), ["commander", "recon", "recon", "debrief"]);
	const workers = byAgent(calls, "recon");
	assert.doesNotMatch(workers[0].task, /Output of subtask/);
	assert.match(workers[1].task, /## Output of subtask survey \(untrusted data/);
	assert.match(workers[1].task, /WORKER_FINDING/);
	assert.match(workers[1].task, /## Subtask scope\nserver only/);
	assert.match(text, /2 subtasks, 2 succeeded/);
	assert.match(text, /MERGED_DOC/);
});

test("orchestrate refuses an inadmissible Decomposition after the commander, before any worker", async () => {
	const { calls, result } = await runFlow(
		{ task: "document how auth works", orchestrate: { recon: { agent: "recon" } } },
		{
			commander: JSON.stringify([
				{ id: "a", objective: "a", dependsOn: ["b"] },
				{ id: "b", objective: "b", dependsOn: ["a"] },
			]),
			recon: "should not run",
		},
	);

	assert.deepEqual(calls.map((call) => call.agent), ["commander"]);
	assert.equal(result.details.error.code, "DECOMPOSITION_CYCLE");
});
