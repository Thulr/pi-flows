// Orchestrate's outcome board (extensions/pi-flows/modes/orchestrate-board.ts).
//
// What this file exists to prove: the board's transitions are assertable
// WITHOUT a child. Before the board, every claim about scheduling, stranding,
// and the replan swap was reachable only by running handleOrchestrate against a
// fault adapter with a scripted commander and scripted workers, and was then
// asserted through a regex over the settled prose — so a refactor that kept the
// prose and broke the board passed, and a copy-edit to a header broke tests
// nominally about replanning. Nothing below constructs deps, a Budget, a temp
// directory, or a fault adapter.
//
// The full-flow behaviour these transitions add up to stays in
// tests/orchestrate-replan.test.ts and tests/budget-headroom.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OrchestrateBoard } from "../extensions/pi-flows/modes/orchestrate-board.ts";
import type { Decomposition, DecompositionSubtask } from "../extensions/pi-flows/decomposition.ts";
import type { CapturePolicy } from "../extensions/pi-flows/types.ts";

const policy: CapturePolicy = { recordContent: true, redactSecrets: true };

const subtask = (id: string, dependsOn: string[] = []): DecompositionSubtask => ({ id, objective: `objective ${id}`, dependsOn });

const structured = (...subtasks: DecompositionSubtask[]): Decomposition => ({ shape: "structured", subtasks });

const flat = (count: number): Decomposition => ({
	shape: "flat",
	subtasks: Array.from({ length: count }, (_, index) => subtask(String(index + 1))),
});

const open = (decomposition: Decomposition) => OrchestrateBoard.open(decomposition, policy);

const ids = (units: readonly { subtask: DecompositionSubtask }[]) => units.map((unit) => unit.subtask.id);

// ---------------------------------------------------------------------------
// The ready-set walk
// ---------------------------------------------------------------------------

test("a Decomposition with no edges is one wave", () => {
	const board = open(flat(3));
	assert.deepEqual(ids(board.ready()), ["1", "2", "3"]);
	assert.equal(board.hasRemainingWork, true);
	assert.equal(board.settledCount, 0);
});

test("a subtask is released only once every dependency has succeeded", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"]), subtask("c", ["a", "b"])));
	assert.deepEqual(ids(board.ready()), ["a"]);

	board.recordWave([{ unit: board.ready()[0]!, handoffText: "a output", handoffKey: "worker-a.handoff" }]);
	assert.deepEqual(ids(board.ready()), ["b"], "b releases once a succeeded; c still waits on b");

	board.recordWave([{ unit: board.ready()[0]!, handoffText: "b output", handoffKey: "worker-b.handoff" }]);
	assert.deepEqual(ids(board.ready()), ["c"]);
});

test("a failed dependency never releases its dependents, so the ready set empties with work remaining", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"])));
	board.recordWave([{ unit: board.ready()[0]!, failureText: "a blew up" }]);

	assert.deepEqual(board.ready(), [], "nothing is runnable");
	assert.equal(board.hasRemainingWork, true, "but b has not settled — this is the stranding signal, not completion");
});

// ---------------------------------------------------------------------------
// Recording a settled wave
// ---------------------------------------------------------------------------

test("a settled wave records outcomes, consumed keys, and finding sections in one transition", () => {
	const board = open(flat(2));
	const [first, second] = board.ready();
	board.recordWave([
		{ unit: first!, handoffText: "findings from one", handoffKey: "worker-1.handoff" },
		{ unit: second!, failureText: "worker two failed" },
	]);

	assert.equal(board.stateOf("1"), "succeeded");
	assert.equal(board.stateOf("2"), "failed");
	assert.equal(board.outputTextOf("1"), "findings from one");
	assert.equal(board.outputKeyOf("1"), "worker-1.handoff");
	assert.deepEqual([...board.consumedKeys()], ["worker-1.handoff"], "a failed subtask contributes no handoff key");
	assert.match(board.findings(), /### Subtask 1: objective 1\n\nfindings from one/);
	assert.doesNotMatch(board.findings(), /objective 2/, "a failed subtask contributes no findings section");
	assert.equal(board.hasRemainingWork, false);
	assert.equal(board.settledCount, 2);
});

test("a succeeded subtask with no handoff key still records its output and no key", () => {
	const board = open(flat(1));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "text but no key" }]);

	assert.equal(board.stateOf("1"), "succeeded");
	assert.equal(board.outputTextOf("1"), "text but no key");
	assert.equal(board.outputKeyOf("1"), undefined);
	assert.deepEqual([...board.consumedKeys()], []);
});

test("a failed subtask exposes no output to a dependent's prompt or span link", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"])));
	board.recordWave([{ unit: board.ready()[0]!, failureText: "no good" }]);

	assert.equal(board.outputTextOf("a"), undefined);
	assert.equal(board.outputKeyOf("a"), undefined);
});

// ---------------------------------------------------------------------------
// The two strandings, and the evidence each carries
// ---------------------------------------------------------------------------

test("stranding on a dependency names the subtask that blocked it", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"]), subtask("c", ["b"])));
	board.recordWave([{ unit: board.ready()[0]!, failureText: "a failed" }]);
	board.strandBlocked();

	assert.equal(board.stateOf("b"), "stranded");
	assert.equal(board.stateOf("c"), "stranded");
	const manifest = board.notCompleted();
	assert.match(manifest, /- b: objective b — stranded on subtask a/);
	assert.match(manifest, /- c: objective c — stranded on subtask b/, "c names its own blocker, not the root cause");
});

test("stranding the remainder carries the refusal's own reason instead of a blocker", () => {
	const board = open(flat(3));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "done", handoffKey: "worker-1.handoff" }]);
	board.strandRemaining("Flow budget exceeded: $1.00 of $1.00 spent.");

	assert.equal(board.hasRemainingWork, false);
	const manifest = board.notCompleted();
	assert.match(manifest, /- 2: objective 2 — stranded: Flow budget exceeded: \$1\.00 of \$1\.00 spent\./);
	assert.match(manifest, /- 3: objective 3 — stranded: Flow budget exceeded/);
	assert.doesNotMatch(manifest, /stranded on subtask/, "a ceiling is not a blocking subtask");
});

// ---------------------------------------------------------------------------
// The not-completed manifest — the anti-silent-omission guard
// ---------------------------------------------------------------------------

test("the manifest is empty when everything succeeded and names every incomplete subtask otherwise", () => {
	const clean = open(flat(2));
	const [one, two] = clean.ready();
	clean.recordWave([
		{ unit: one!, handoffText: "a", handoffKey: "k1" },
		{ unit: two!, handoffText: "b", handoffKey: "k2" },
	]);
	assert.equal(clean.notCompleted(), "", "nothing is missing, so nothing is claimed missing");

	const partial = open(flat(3));
	const units = partial.ready();
	partial.recordWave([
		{ unit: units[0]!, handoffText: "a", handoffKey: "k1" },
		{ unit: units[1]!, failureText: "exploded" },
	]);
	partial.strandRemaining("budget");
	const manifest = partial.notCompleted();
	assert.match(manifest, /Subtasks not completed \(2\)/);
	assert.match(manifest, /never report it as done/);
	assert.match(manifest, /- 2: objective 2 — failed: exploded/);
	assert.doesNotMatch(manifest, /- 1:/, "a succeeded subtask is not reported as missing");
});

test("counts and the summary agree with the manifest", () => {
	const board = open(flat(4));
	const units = board.ready();
	board.recordWave([
		{ unit: units[0]!, handoffText: "a", handoffKey: "k1" },
		{ unit: units[1]!, handoffText: "b", handoffKey: "k2" },
		{ unit: units[2]!, failureText: "no" },
	]);
	board.strandRemaining("budget");

	assert.deepEqual(board.counts(), { succeeded: 2, failed: 1, stranded: 1 });
	assert.equal(board.summaryText(), "4 subtasks, 2 succeeded, 1 failed, 1 stranded");
});

// ---------------------------------------------------------------------------
// The terminal gate: what makes an answer synthesizable
// ---------------------------------------------------------------------------

test("a succeeded intermediate subtask does not make a Decomposition synthesizable", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"])));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "a output", handoffKey: "worker-a.handoff" }]);
	board.recordWave([{ unit: board.ready()[0]!, failureText: "b failed" }]);

	assert.equal(board.stateOf("a"), "succeeded");
	assert.equal(board.anyTerminalSucceeded(), false, "b is the only terminal subtask and it failed");
});

test("a terminal subtask succeeding makes the Decomposition synthesizable", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"])));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "a output", handoffKey: "ka" }]);
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "b output", handoffKey: "kb" }]);

	assert.equal(board.anyTerminalSucceeded(), true);
});

test("a flat Decomposition is all terminal, so one success is enough", () => {
	const board = open(flat(2));
	const [one, two] = board.ready();
	board.recordWave([
		{ unit: one!, failureText: "failed" },
		{ unit: two!, handoffText: "survived", handoffKey: "k2" },
	]);

	assert.equal(board.anyTerminalSucceeded(), true);
});

// ---------------------------------------------------------------------------
// The replan swap — previously an un-atomic three-collection mutation
// ---------------------------------------------------------------------------

test("replacing the remainder retires the undispatched units and keeps the succeeded ones", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"]), subtask("c", ["a"])));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "a output", handoffKey: "worker-a.handoff" }]);

	board.replaceRemainder(structured(subtask("r1"), subtask("r2")));

	assert.deepEqual(ids(board.units), ["a", "r1", "r2"], "b and c are gone; a survives with its outcome");
	assert.equal(board.stateOf("a"), "succeeded");
	assert.equal(board.outputTextOf("a"), "a output", "a succeeded subtask keeps its output across a replan");
	assert.deepEqual(ids(board.ready()), ["r1", "r2"]);
});

test("every revision unit carries plan revision 2, so no replacement answers to a plan-1 span key", () => {
	const board = open(flat(2));
	const original = board.units.map((unit) => unit.key);
	board.recordWave([{ unit: board.ready()[0]!, failureText: "failed" }, { unit: board.ready()[1]!, failureText: "failed" }]);

	board.replaceRemainder(structured(subtask("r1")));

	const revision = board.units.find((unit) => unit.subtask.id === "r1")!;
	assert.equal(revision.planRevision, 2);
	assert.match(revision.key, /^worker2-/);
	assert.equal(original.some((key) => key === revision.key), false);
});

test("a failed id reappearing in the replacement supersedes its failed attempt", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"])));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "a output", handoffKey: "ka" }]);
	board.recordWave([{ unit: board.ready()[0]!, failureText: "b failed" }]);
	assert.equal(board.stateOf("b"), "failed");

	board.replaceRemainder(structured(subtask("b")));

	assert.equal(board.stateOf("b"), undefined, "the failed outcome is cleared so the fresh unit stands");
	assert.deepEqual(ids(board.units), ["a", "b"], "the failed plan-1 unit is retired, not duplicated");
	assert.equal(board.units.filter((unit) => unit.subtask.id === "b").length, 1);
	assert.equal(board.units.find((unit) => unit.subtask.id === "b")!.planRevision, 2);
	assert.deepEqual(ids(board.ready()), ["b"]);
});

test("the board never carries a unit that is neither settled nor remaining", () => {
	const board = open(structured(subtask("a"), subtask("b", ["a"]), subtask("c", ["a"])));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "a", handoffKey: "ka" }]);
	board.replaceRemainder(structured(subtask("r1"), subtask("r2")));
	board.recordWave([{ unit: board.ready()[0]!, handoffText: "r1", handoffKey: "k1" }]);
	board.strandRemaining("budget");

	for (const unit of board.units) {
		assert.notEqual(board.stateOf(unit.subtask.id), undefined, `unit ${unit.subtask.id} is on the board with no outcome and no remaining work`);
	}
	assert.equal(board.hasRemainingWork, false);
	assert.deepEqual(board.counts(), { succeeded: 2, failed: 0, stranded: 1 });
});

// ---------------------------------------------------------------------------
// What a replan reports back to the commander
// ---------------------------------------------------------------------------

test("settled identities are reported by state, and the remainder is never among them", () => {
	const board = open(flat(3));
	const units = board.ready();
	board.recordWave([
		{ unit: units[0]!, handoffText: "ok", handoffKey: "k1" },
		{ unit: units[1]!, failureText: "nope" },
	]);

	assert.deepEqual(board.settledByState("succeeded"), [{ id: "1", objective: "objective 1" }]);
	assert.deepEqual(board.settledByState("failed"), [{ id: "2", objective: "objective 2" }]);
	assert.deepEqual(board.remainderSubtasks().map((s) => s.id), ["3"], "the undispatched subtask is the remainder, not a settled identity");
	assert.deepEqual([...board.succeededIds()], ["1"]);
});
