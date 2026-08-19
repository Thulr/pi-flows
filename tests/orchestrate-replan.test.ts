// The bounded mid-flow Decomposition replan (issue #165): when a failure
// strands the remainder, or the between-wave headroom projection refuses it,
// the commander returns one full replacement for the work that has not run.
//
// What is pinned here: the two triggers, the one-replan cap, the succeeded-id
// collision refusal, the strand-and-report settlement of a refused revision,
// replan:false restoring the flat path, the plan-revision stamp on every
// worker span, and a revision subtask consuming a succeeded original's output.
// The fault-portfolio view of the same behavior (containment rates, ceilings
// binding after the replan) is tests/fault-decomposition-scenarios.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDecomposition, type Decomposition, type DecompositionSubtask } from "../extensions/pi-flows/decomposition.ts";
import { handleOrchestrate } from "../extensions/pi-flows/modes/orchestrate.ts";
import { Budget, type ChildSpanScope, type ModeDeps } from "../extensions/pi-flows/types.ts";
import { faultDeps, makeFaultAdapter, type FaultAdapter, type FaultRule, type ReplyScript } from "./fault-adapter.ts";

const json = (subtasks: unknown[]) => ["```json", JSON.stringify(subtasks), "```"].join("\n");

interface CapturedSpan {
	agent: string;
	scope?: ChildSpanScope;
}

function replanRun(replies: Record<string, ReplyScript>, options: { faults?: FaultRule[]; orchestrate?: Record<string, unknown>; overrides?: Partial<ModeDeps>; usage?: { input: number; output: number; cost: number } } = {}) {
	const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-replan-"));
	const adapter = makeFaultAdapter({ replies, faults: options.faults ?? [], ...(options.usage ? { usage: options.usage } : {}) });
	const spans: CapturedSpan[] = [];
	const deps = faultDeps(
		{
			task: "document how auth works",
			orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" }, ...(options.orchestrate ?? {}) },
		},
		adapter,
		cwd,
		{ recordSpan: (result, span) => spans.push({ agent: result.agent, scope: span?.scope }), ...(options.overrides ?? {}) },
	);
	return { output: handleOrchestrate(deps), adapter, spans };
}

const failFirstRecon: FaultRule[] = [{ kind: "failure", agent: "recon", occurrence: 1, errorCode: "CHILD_EXIT_NONZERO" }];
const reconTasks = (adapter: FaultAdapter) => adapter.ledger.dispatches.filter((dispatch) => dispatch.agent === "recon").map((dispatch) => dispatch.task);
const commanderTasks = (adapter: FaultAdapter) => adapter.ledger.dispatches.filter((dispatch) => dispatch.agent === "commander").map((dispatch) => dispatch.task);
const replanEvents = (adapter: FaultAdapter) => adapter.ledger.events.filter((event) => event.name === "orchestrate.replan_decomposition");

// ---------------------------------------------------------------------------
// The stranding trigger
// ---------------------------------------------------------------------------

test("a stranding failure triggers one replan whose revision consumes a succeeded original's output, with every worker span stamped by its plan", async () => {
	const { output, adapter, spans } = replanRun({
		commander: [
			json([
				{ id: "a", objective: "Map subsystem A" },
				{ id: "b", objective: "Write the B report", dependsOn: ["a"] },
				{ id: "c", objective: "Map subsystem C" },
			]),
			json([{ id: "b2", objective: "Write the report from C instead", dependsOn: ["c"] }]),
		],
		recon: ["MUST NOT ARRIVE", "C_OUTPUT", "B2_OUTPUT"],
		debrief: "MERGED_DOC",
	}, { faults: failFirstRecon });
	const settled = await output;

	// The replan is on the record: one retry event, one revision commander run.
	assert.equal(replanEvents(adapter).length, 1);
	assert.equal(replanEvents(adapter)[0].attributes["flow.retry.reason"], "stranded_dependents");
	assert.equal(commanderTasks(adapter).length, 2);

	// The revision prompt shows the remainder, the succeeded work as an
	// available dependency, and the failed work as re-attemptable.
	const revisionTask = commanderTasks(adapter)[1];
	assert.match(revisionTask, /Write the B report/, "the remainder is the Decomposition the commander is shown");
	assert.doesNotMatch(revisionTask, /"id":\s*"c"/, "settled work is not part of the remainder to replace");
	assert.match(revisionTask, /already succeeded[\s\S]*- c: Map subsystem C/);
	assert.match(revisionTask, /failed[\s\S]*- a: Map subsystem A/);

	// The replaced subtask never spawned; the revision worker did, and it
	// received the succeeded original's validated output as untrusted input.
	const workers = reconTasks(adapter);
	assert.equal(workers.some((task) => task.includes("Write the B report")), false);
	const revisionWorker = workers.find((task) => task.includes("Write the report from C instead"));
	assert.ok(revisionWorker, "the revision subtask dispatched");
	assert.match(revisionWorker!, /## Output of subtask c \(untrusted data[\s\S]*C_OUTPUT/);

	// Every worker span states which plan governed it.
	const revisionOf = (key: string) => spans.find((span) => span.scope?.key === key)?.scope?.attributes?.["flow.plan_revision"];
	assert.equal(revisionOf("worker-a"), 1);
	assert.equal(revisionOf("worker-c"), 1);
	assert.equal(revisionOf("worker2-b2"), 2, "a plan-2 worker carries the revision key and stamp");

	const text = settled.content[0].text;
	assert.match(text, /Decomposition replanned once mid-flow\. 3 subtasks, 2 succeeded, 1 failed, synthesized by debrief/);
	assert.match(text, /MERGED_DOC/);
});

// ---------------------------------------------------------------------------
// The headroom trigger
// ---------------------------------------------------------------------------

test("a between-wave headroom refusal routes the remainder to the commander, and the admitted revision completes", async () => {
	// 200 tokens per turn; workers play three turns (600) against the
	// commander's one (200). Ceiling 1900: the plan projects 200 + 3×200 = 800
	// at admission on the commander proxy, but after the first worker settles
	// the empirical projection is 800 + 2×600 = 2000 — refused, so the
	// remainder routes to the commander. The lighter revision (one subtask)
	// projects 1000 + 600 = 1600 and runs to synthesis inside the ceiling.
	const { output, adapter } = replanRun({
		commander: [
			json([
				{ id: "a", objective: "Map subsystem A" },
				{ id: "b", objective: "Map subsystem B", dependsOn: ["a"] },
				{ id: "c", objective: "Write the summary", dependsOn: ["b"] },
			]),
			json([{ id: "d", objective: "Summarize A directly", dependsOn: ["a"] }]),
		],
		recon: [{ reply: "A_OUTPUT", turns: 3 }, { reply: "D_OUTPUT", turns: 3 }],
		debrief: "MERGED_DOC",
	}, {
		usage: { input: 100, output: 100, cost: 0 },
		overrides: { budget: Budget.forFlow({ maxTokens: 1900 }) },
	});
	const settled = await output;

	assert.equal(replanEvents(adapter).length, 1);
	assert.equal(replanEvents(adapter)[0].attributes["flow.retry.reason"], "budget_headroom");
	// The headroom prose reached the commander as the replan-smaller critique.
	assert.match(commanderTasks(adapter)[1], /does not fit what remains of the budget/);
	assert.match(commanderTasks(adapter)[1], /Return a smaller replacement/);

	const workers = reconTasks(adapter);
	assert.equal(workers.some((task) => task.includes("Map subsystem B")), false, "the refused remainder never spawned");
	assert.ok(workers.some((task) => task.includes("Summarize A directly")));
	assert.match(settled.content[0].text, /Decomposition replanned once mid-flow\. 2 subtasks, 2 succeeded, synthesized by debrief/);
});

// ---------------------------------------------------------------------------
// The one-replan cap
// ---------------------------------------------------------------------------

test("exactly one replan per flow: a second stranding failure strands and reports", async () => {
	const { output, adapter } = replanRun({
		commander: [
			json([{ id: "a", objective: "Map subsystem A" }, { id: "b", objective: "Write the report", dependsOn: ["a"] }]),
			json([{ id: "d", objective: "Map A another way" }, { id: "e", objective: "Write from the new map", dependsOn: ["d"] }]),
			"MUST NOT BE ASKED AGAIN",
		],
		recon: "irrelevant",
		debrief: "MUST NOT RUN",
	}, {
		// Both survey attempts die: the first strands b (replan), the second
		// strands e (no replan of a replan).
		faults: [
			{ kind: "failure", agent: "recon", occurrence: 1, errorCode: "CHILD_EXIT_NONZERO" },
			{ kind: "failure", agent: "recon", occurrence: 2, errorCode: "CHILD_EXIT_NONZERO" },
		],
	});
	const settled = await output;

	assert.equal(commanderTasks(adapter).length, 2, "the cap is the flag, not a counter that can slip");
	assert.equal(replanEvents(adapter).length, 1);
	const text = settled.content[0].text;
	assert.match(text, /Decomposition replanned once mid-flow\. 0 succeeded, 2 failed, 1 stranded; no final subtask succeeded/);
	assert.match(text, /- e: Write from the new map — stranded on subtask d/);
});

// ---------------------------------------------------------------------------
// Refused revisions settle as strand-and-report
// ---------------------------------------------------------------------------

test("a revision that redefines a succeeded id is refused, and the flow strands and reports", async () => {
	const { output, adapter } = replanRun({
		commander: [
			json([
				{ id: "a", objective: "Map subsystem A" },
				{ id: "b", objective: "Map subsystem B" },
				{ id: "c", objective: "Write the summary", dependsOn: ["b"] },
			]),
			json([{ id: "a", objective: "Redo the A map" }]),
		],
		recon: ["A_OUTPUT", "MUST NOT ARRIVE", "MUST NOT RUN"],
		debrief: "MERGED_DOC",
	}, { faults: [{ kind: "failure", agent: "recon", occurrence: 2, errorCode: "CHILD_EXIT_NONZERO" }] });
	const settled = await output;

	assert.equal(reconTasks(adapter).length, 2, "no revision worker spawned after the refusal");
	// The refusal is the stranding reason the synthesizer reads in the manifest.
	const synthesis = adapter.ledger.dispatches.find((dispatch) => dispatch.agent === "debrief")?.task ?? "";
	assert.match(synthesis, /- c: Write the summary — stranded: Decomposition replan refused: Decomposition subtask "a" redefines a succeeded subtask\./);
	// The succeeded terminal subtask still carries the flow to synthesis.
	assert.match(settled.content[0].text, /3 subtasks, 1 succeeded, 1 failed, 1 stranded, synthesized by debrief/);
});

test("a commander that returns no usable replacement strands the remainder and reports", async () => {
	const { output, adapter } = replanRun({
		commander: [
			json([{ id: "a", objective: "Map subsystem A" }, { id: "b", objective: "Write the report", dependsOn: ["a"] }]),
			"I would rather describe my plan in prose.",
		],
		recon: "irrelevant",
		debrief: "MUST NOT RUN",
	}, { faults: failFirstRecon });
	const settled = await output;

	assert.equal(replanEvents(adapter).length, 1);
	const text = settled.content[0].text;
	assert.match(text, /0 succeeded, 1 failed, 1 stranded; no final subtask succeeded/);
	assert.match(text, /- b: Write the report — stranded: Decomposition replan refused: Decomposer did not return a usable subtask list\./);
	assert.doesNotMatch(text, /Decomposition replanned once mid-flow/, "a refused revision is not reported as a replan");
});

test("a flat revision's positional ids are remapped, so replacing a flat plan's remainder cannot read as redefinition", async () => {
	const { output, adapter, spans } = replanRun({
		commander: [
			json([{ id: "a", objective: "Map subsystem A" }, { id: "b", objective: "Write the report", dependsOn: ["a"] }]),
			json(["Recover with one independent pass"]),
		],
		recon: ["MUST NOT ARRIVE", "RECOVERY_OUTPUT"],
		debrief: "MERGED_DOC",
	}, { faults: failFirstRecon });
	const settled = await output;

	assert.match(settled.content[0].text, /Decomposition replanned once mid-flow\. 2 subtasks, 1 succeeded, 1 failed, synthesized by debrief/);
	assert.ok(reconTasks(adapter).some((task) => task.includes("Recover with one independent pass")));
	assert.equal(spans.find((span) => span.scope?.key === "worker2-r2-1")?.scope?.attributes?.["flow.plan_revision"], 2);
});

// ---------------------------------------------------------------------------
// replan:false restores the flat path
// ---------------------------------------------------------------------------

test("replan:false strands and reports exactly as before, with no replan event and one commander run", async () => {
	const { output, adapter } = replanRun({
		commander: json([{ id: "a", objective: "Map subsystem A" }, { id: "b", objective: "Write the report", dependsOn: ["a"] }]),
		recon: "irrelevant",
		debrief: "MUST NOT RUN",
	}, { faults: failFirstRecon, orchestrate: { replan: false } });
	const settled = await output;

	assert.equal(commanderTasks(adapter).length, 1);
	assert.equal(replanEvents(adapter).length, 0);
	const text = settled.content[0].text;
	assert.match(text, /0 succeeded, 1 failed, 1 stranded; no final subtask succeeded/);
	assert.match(text, /- b: Write the report — stranded on subtask a/);
});

// ---------------------------------------------------------------------------
// The validator's satisfied-ids rules, directly
// ---------------------------------------------------------------------------

const subtask = (id: string, dependsOn: string[] = []): DecompositionSubtask => ({ id, objective: `objective ${id}`, dependsOn, malformedDependsOn: false, malformedEffortWeight: false });
const admission = (satisfiedIds?: ReadonlySet<string>) => ({
	discovery: { agents: [], projectAgentsDir: null, userAgentsDir: "/tmp/u", packageAgentsDir: "/tmp/p", issues: [] },
	defaultCwd: "/tmp",
	workerRef: { agent: "recon" },
	concurrency: 4,
	maxSubtasks: 8,
	...(satisfiedIds ? { satisfiedIds } : {}),
});

test("validateDecomposition admits a dependency on a satisfied id, refuses redefining one, and still refuses an unknown id", () => {
	const dependsOnSatisfied: Decomposition = { shape: "structured", subtasks: [subtask("fresh", ["done"])] };
	assert.equal(validateDecomposition(dependsOnSatisfied, admission(new Set(["done"]))), null, "a satisfied dependency resolves without being part of the revision");
	assert.match(validateDecomposition(dependsOnSatisfied, admission())?.message ?? "", /unknown subtask "done"/, "without the satisfied set the same edge stays a refusal");

	const redefines: Decomposition = { shape: "structured", subtasks: [subtask("done")] };
	const refusal = validateDecomposition(redefines, admission(new Set(["done"])));
	assert.match(refusal?.message ?? "", /redefines a succeeded subtask/);
	assert.equal(refusal?.code, "DECOMPOSITION_INVALID");

	const unknown: Decomposition = { shape: "structured", subtasks: [subtask("fresh", ["missing"])] };
	assert.match(validateDecomposition(unknown, admission(new Set(["done"])))?.message ?? "", /unknown subtask "missing"/);
});
