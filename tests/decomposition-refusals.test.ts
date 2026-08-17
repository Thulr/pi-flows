// What the Decomposition validator refuses, and — just as load-bearing — what
// it admits (issue #148).
//
// The validator is the one gate between a settled commander and the first
// worker spawn, so both halves matter: a defect it misses strands or collides
// workers that have already been paid for, and a shape it wrongly refuses costs
// the commander run for nothing. The smoke cases (duplicate id, empty
// objective, unknown reference, cycles, the shared-write topology) are pinned
// in tests/decomposition.test.ts; this file covers the rest of the matrix and
// every admission the design commits to.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecomposition, validateDecomposition, type Decomposition, type DecompositionAdmission } from "../extensions/pi-flows/decomposition.ts";
import { discoverFlowAgents } from "../extensions/pi-flows/agents.ts";
import { byAgent, runFlow } from "./stub-harness.ts";

async function admission(overrides: Partial<DecompositionAdmission> = {}): Promise<DecompositionAdmission> {
	const repo = path.join(tmpdir(), `pi-flows-decomp-refusal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(path.join(repo, ".pi", "flow-agents"), { recursive: true });
	return {
		discovery: discoverFlowAgents(repo, "user"),
		defaultCwd: repo,
		// `recon` is read-only; `operator` runs pi defaults and is write-capable.
		workerRef: { agent: "recon" },
		concurrency: 4,
		maxSubtasks: 8,
		...overrides,
	};
}

const decompose = (entries: unknown[], maxSubtasks = 8) =>
	parseDecomposition(`\`\`\`json\n${JSON.stringify(entries)}\n\`\`\``, maxSubtasks) as Decomposition;

// ---------------------------------------------------------------------------
// Defects the validator names
// ---------------------------------------------------------------------------

test("an array mixing subtask strings and subtask objects is refused, naming the offending entry", async () => {
	const admitted = await admission();
	const trailing = validateDecomposition(decompose([{ id: "survey", objective: "List entry points" }, "trace the refresh"]), admitted);
	assert.equal(trailing?.code, "DECOMPOSITION_INVALID");
	assert.match(trailing?.message ?? "", /entry 2 is not a subtask/, "the position of the bare string is stated");
	assert.match(trailing?.cause ?? "", /Do not mix subtask strings and subtask objects/);

	// The mix in the other order names the other position, so the number is read
	// off the entry rather than assumed to be the last one.
	const leading = validateDecomposition(decompose(["survey the entry points", { id: "trace", objective: "Trace the refresh" }]), admitted);
	assert.match(leading?.message ?? "", /entry 1 is not a subtask/);
});

test("an id that is not a string is refused as a missing id, not coerced into a key", async () => {
	// Dependency edges and span keys are addressed by the id, so a number that
	// happens to stringify is still not a key the commander declared.
	const refusal = validateDecomposition(decompose([{ id: 7, objective: "count the callers" }]), await admission());
	assert.equal(refusal?.code, "DECOMPOSITION_INVALID");
	assert.match(refusal?.message ?? "", /entry 1 has no "id"/);
	assert.match(refusal?.fix ?? "", /unique id/);
});

test("a structured Decomposition over the ceiling is refused where the flat list of the same length is cut", async () => {
	// The one place the two shapes deliberately part: slicing a flat list loses
	// entries, slicing a structured one severs declared edges.
	const structured = validateDecomposition(
		decompose([{ id: "a", objective: "a" }, { id: "b", objective: "b" }, { id: "c", objective: "c" }], 2),
		await admission({ maxSubtasks: 2 }),
	);
	assert.equal(structured?.code, "DECOMPOSITION_INVALID");
	assert.match(structured?.message ?? "", /declares 3 subtasks, above the ceiling of 2/);
	assert.match(structured?.fix ?? "", /maxSubtasks/);

	const flat = parseDecomposition('```json\n["a","b","c"]\n```', 2) as Decomposition;
	assert.equal(flat.subtasks.length, 2, "the flat list was already cut by the parser");
	assert.equal(validateDecomposition(flat, await admission({ maxSubtasks: 2 })), null, "so there is nothing left for the validator to refuse");
});

// ---------------------------------------------------------------------------
// Topologies the validator admits
// ---------------------------------------------------------------------------

test("a sequential chain is admitted, and stays admitted for a write-capable worker", async () => {
	// A -> B -> C: every pair is dependency-ordered, so no two subtasks can ever
	// hold the shared cwd at the same time. This is the fourth release of the
	// shared-write gate, alongside allowSharedWriteCwd, concurrency 1, and a
	// read-only worker.
	const chain = decompose([
		{ id: "a", objective: "survey" },
		{ id: "b", objective: "trace", dependsOn: ["a"] },
		{ id: "c", objective: "write it up", dependsOn: ["b"] },
	]);
	assert.equal(validateDecomposition(chain, await admission()), null);
	assert.equal(validateDecomposition(chain, await admission({ workerRef: { agent: "operator" } })), null, "a pure chain never shares the cwd concurrently");
});

test("independent and dependent subtasks in one Decomposition are admitted together", async () => {
	// The mixed shape the wave scheduler exists for: `lint` is independent of the
	// survey/trace chain, so it runs in wave 1 while `trace` waits.
	const mixed = decompose([
		{ id: "survey", objective: "List entry points" },
		{ id: "lint", objective: "Check the lint rules" },
		{ id: "trace", objective: "Trace token refresh", dependsOn: ["survey"] },
	]);
	assert.equal(validateDecomposition(mixed, await admission()), null);
	// Two of them are dependency-independent, so a write-capable worker is the
	// case the whole-Decomposition shared-write rule refuses.
	assert.equal(validateDecomposition(mixed, await admission({ workerRef: { agent: "operator" } }))?.code, "SHARED_WRITE_CWD");
});

test("a worker whose tools override removes write capability releases the shared-write refusal", async () => {
	// The refusal is about effective tools, not the agent's name: the same
	// write-capable agent, restricted to read tools, is no longer a collision.
	const independent = decompose([{ id: "a", objective: "a" }, { id: "b", objective: "b" }]);
	const writing = await admission({ workerRef: { agent: "operator" } });
	const refusal = validateDecomposition(independent, writing);
	assert.equal(refusal?.code, "SHARED_WRITE_CWD");
	assert.match(refusal?.cause ?? "", /operator \(effective tools are pi defaults/, "the refusal blames the toolset, not the agent name");

	assert.equal(
		validateDecomposition(independent, { ...writing, workerRef: { agent: "operator", tools: "read,grep,ls" } }),
		null,
		"read-only effective tools cannot collide on the shared cwd",
	);
});

test("a Decomposition that leaves the goal partly uncovered is admitted", async () => {
	// Coverage is not decidable without reading the goal, so a deterministic gate
	// that guessed at it would refuse good decompositions. Deferred to #160 —
	// this test is what fails first if a coverage check lands here by accident.
	const gap = decompose([
		{ id: "login", objective: "Document the login flow" },
		{ id: "logout", objective: "Document the logout flow" },
	]);
	assert.equal(validateDecomposition(gap, await admission()), null, "token refresh going undocumented is not the validator's refusal");

	// The narrowest form of the same thing: one subtask for a broad goal.
	assert.equal(validateDecomposition(decompose([{ id: "only", objective: "Document one corner" }]), await admission()), null);
});

test("subtasks whose scopes overlap are admitted", async () => {
	// Two subtasks may legitimately read the same files, and prose scope is not
	// something a deterministic gate can compare. Also deferred to #160.
	const overlapping = decompose([
		{ id: "auth-read", objective: "Document the auth module", scope: "src/auth" },
		{ id: "auth-write", objective: "Document the session writer", scope: "src/auth" },
	]);
	assert.equal(validateDecomposition(overlapping, await admission()), null);

	// Even two subtasks stating the identical objective are admitted: duplicate
	// work is waste, not an inadmissible topology.
	assert.equal(
		validateDecomposition(decompose([{ id: "a", objective: "Document the auth module" }, { id: "b", objective: "Document the auth module" }]), await admission()),
		null,
	);
});

// ---------------------------------------------------------------------------
// The same gate, reached through a real flow
// ---------------------------------------------------------------------------

test("a structured Decomposition with an inadmissible shared-write topology is refused after the commander and before any worker", async () => {
	// The end-to-end half of the whole-Decomposition rule: the commander has
	// already been paid for, so the refusal must land before the first worker
	// spawns rather than inside the wave that would collide.
	const inadmissible = JSON.stringify([
		{ id: "auth", objective: "Edit the auth module" },
		{ id: "billing", objective: "Edit the billing module" },
	]);
	const refused = await runFlow(
		{ task: "make two edits", orchestrate: { recon: { agent: "operator" } } },
		{ commander: inadmissible, operator: "SHOULD NOT RUN", debrief: "SHOULD NOT RUN" },
	);

	assert.deepEqual(refused.calls.map((call) => call.agent), ["commander"], "no worker was spawned");
	assert.equal(refused.result.details.error.code, "SHARED_WRITE_CWD");

	// The gate's own releases carry through the handler unchanged.
	const allowed = await runFlow(
		{ task: "make two edits", allowSharedWriteCwd: true, orchestrate: { recon: { agent: "operator" } } },
		{ commander: inadmissible, operator: "EDIT_DONE", debrief: "MERGED_EDITS" },
	);
	assert.equal(allowed.result.details.error, undefined);
	assert.equal(byAgent(allowed.calls, "operator").length, 2);
	assert.match(allowed.text, /2 subtasks, 2 succeeded/);

	// A chain of the same two edits is admitted without any release, because the
	// edge already orders them.
	const chained = await runFlow(
		{ task: "make two edits", orchestrate: { recon: { agent: "operator" } } },
		{
			commander: JSON.stringify([
				{ id: "auth", objective: "Edit the auth module" },
				{ id: "billing", objective: "Edit the billing module", dependsOn: ["auth"] },
			]),
			operator: "EDIT_DONE",
			debrief: "MERGED_EDITS",
		},
	);
	assert.equal(chained.result.details.error, undefined);
	assert.deepEqual(chained.calls.map((call) => call.agent), ["commander", "operator", "operator", "debrief"]);
});
