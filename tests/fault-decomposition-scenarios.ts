// Coordination faults inside a dispatched Decomposition (#148): what a failed
// subtask does to the subtasks that named it.
//
// The fault is a child that dies mid-Decomposition, and containment here is not
// a refusal. The dependents of a failed subtask must never spawn — running them
// without the input they declared would buy findings built on missing evidence —
// while the independent branch must still finish and still be synthesized. Both
// halves are the case: a run that strands everything has over-contained, and a
// run that spawns a dependent anyway has not contained at all.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleOrchestrate } from "../extensions/pi-flows/modes/orchestrate.ts";
import { Budget } from "../extensions/pi-flows/types.ts";
import { faultDeps, makeFaultAdapter, type FaultRule } from "./fault-adapter.ts";
import { FAULT_SUITE, observe, type FaultScenario } from "./fault-scenarios.ts";

const SURVEY = "List the auth entry points";
const LINT = "Check the lint rules";
const TRACE = "Trace token refresh";
const WRITEUP = "Write the refresh summary";

/** The commander's Decomposition: `lint` is independent, `trace` needs `survey`, and `writeup` needs `trace`. */
const DECOMPOSITION = [
	"Here is the breakdown.",
	"",
	"```json",
	JSON.stringify([
		{ id: "survey", objective: SURVEY },
		{ id: "lint", objective: LINT },
		{ id: "trace", objective: TRACE, dependsOn: ["survey"] },
		{ id: "writeup", objective: WRITEUP, dependsOn: ["trace"] },
	]),
	"```",
].join("\n");

function strandedDependentsScenario(): FaultScenario {
	// The first worker dispatched is `survey`, the head of the two-subtask chain.
	const faults: FaultRule[] = [{ kind: "failure", agent: "recon", occurrence: 1, errorCode: "CHILD_EXIT_NONZERO" }];
	return {
		id: "failed-subtask-strands-its-dependents",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "failure",
		description: "With replan:false, a subtask two others depend on dies; the dependents must never spawn, and the independent branch must still finish.",
		attackOpportunities: 1,
		// The clean deliveries the fault must leave alone: the Decomposition
		// itself, the independent subtask, and the synthesis over what survived.
		benignOpportunities: 3,
		expected: {
			// Stranding is containment without a refusal: the caller gets the
			// answer the surviving branch supports, counted honestly.
			outcome: { errorCode: null },
			// Four dispatches, not six: commander, the failed `survey`, the
			// independent `lint`, and the synthesizer. `trace` and `writeup` were
			// never reached at all, so they are not refusals either.
			process: { dispatched: 4, refused: 0, unreached: [] },
			policy: { contained: true, falselyBlocked: false },
			// The commander's Decomposition and the surviving finding are banked;
			// the dead subtask banks nothing, and the terminal synthesis exposes no
			// Handoff (issue #142).
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-decomposition-fault-"));
			const adapter = makeFaultAdapter({
				replies: { commander: DECOMPOSITION, recon: "LINT_OUTPUT", debrief: "MERGED_DOC" },
				faults,
			});
			const output = await handleOrchestrate(faultDeps(
				{
					task: "document how auth works",
					orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" }, replan: false },
				},
				adapter,
				cwd,
			));

			// The fault has to land on the head of the chain, or the case measures
			// something else entirely: a failed leaf strands nobody.
			const workerTasks = adapter.ledger.dispatches.filter((dispatch) => dispatch.agent === "recon").map((dispatch) => dispatch.task);
			if (!workerTasks[0]?.includes(SURVEY)) throw new Error("the injected failure did not land on the subtask the chain depends on");
			for (const stranded of [TRACE, WRITEUP]) {
				if (workerTasks.some((task) => task.includes(stranded))) throw new Error(`a stranded subtask was spawned anyway: ${stranded}`);
			}

			// Stranded work stays visible by name. A merged answer that quietly
			// omits it reads exactly like a complete one, which is what the
			// manifest and the header exist to prevent.
			const synthesis = adapter.ledger.dispatches.find((dispatch) => dispatch.agent === "debrief")?.task ?? "";
			if (!/## Subtasks not completed \(3\)/.test(synthesis)) throw new Error("the synthesizer was not told what is missing");
			if (!synthesis.includes(`- trace: ${TRACE} — stranded on subtask survey`)) throw new Error("the manifest does not name what the stranded subtask waits on");
			if (!synthesis.includes(`- writeup: ${WRITEUP} — stranded on subtask trace`)) throw new Error("the transitively stranded subtask is missing from the manifest");
			const text = output.content[0].text;
			if (!/4 subtasks, 1 succeeded, 1 failed, 2 stranded/.test(text)) throw new Error(`the header does not count the outcome: ${text.split("\n")[0]}`);

			return observe(output, adapter.ledger, [], { attack: true });
		},
	};
}

function failedReviewScenario(): FaultScenario {
	const faults: FaultRule[] = [{ kind: "failure", agent: "overwatch", occurrence: 1, errorCode: "CHILD_EXIT_NONZERO" }];
	return {
		id: "failed-decomposition-review-stops-workers",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "failure",
		description: "The Decomposition reviewer dies before a verdict, so no worker can run.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: "DECOMPOSITION_REVIEW_FAILED" },
			process: { dispatched: 2, refused: 0, unreached: ["recon", "debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-decomposition-review-fault-"));
			const adapter = makeFaultAdapter({ replies: { commander: DECOMPOSITION, overwatch: "MUST NOT ARRIVE", recon: "MUST NOT RUN" }, faults });
			const output = await handleOrchestrate(faultDeps(
				{
					task: "document how auth works",
					orchestrate: {
						commander: { agent: "commander" }, review: { agent: "overwatch" }, reviewMaxIterations: 2,
						recon: { agent: "recon" }, debrief: { agent: "debrief" },
					},
				},
				adapter,
				cwd,
			));
			return observe(output, adapter.ledger, ["recon", "debrief"], { attack: true });
		},
	};
}

function failedRevisionScenario(): FaultScenario {
	const faults: FaultRule[] = [{ kind: "failure", agent: "commander", occurrence: 2, errorCode: "CHILD_EXIT_NONZERO" }];
	return {
		id: "failed-decomposition-revision-stops-workers",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "failure",
		description: "The commander dies while replacing a rejected Decomposition, so no worker can run.",
		attackOpportunities: 1,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: "DECOMPOSITION_REVIEW_FAILED" },
			process: { dispatched: 3, refused: 0, unreached: ["recon", "debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-decomposition-revision-fault-"));
			const adapter = makeFaultAdapter({
				replies: { commander: DECOMPOSITION, overwatch: "VERDICT: REVISE\nAdd the missing path.", recon: "MUST NOT RUN" },
				faults,
			});
			const output = await handleOrchestrate(faultDeps(
				{
					task: "document how auth works",
					orchestrate: {
						commander: { agent: "commander" }, review: { agent: "overwatch" }, reviewMaxIterations: 2,
						recon: { agent: "recon" }, debrief: { agent: "debrief" },
					},
				},
				adapter,
				cwd,
			));
			return observe(output, adapter.ledger, ["recon", "debrief"], { attack: true });
		},
	};
}

function midFlowExhaustionScenario(): FaultScenario {
	return {
		id: "mid-flow-exhaustion-strands-remainder",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// The fault is the spend itself: workers cost three turns where the
		// commander cost one, so the Decomposition passes the headroom projection
		// and the flow's total-token ceiling is only crossed after the first wave
		// settles.
		faults: [],
		faultKind: "none",
		description: "The flow budget exhausts between waves; the remainder is stranded once, with the refusal as the reason, instead of each child being refused one by one.",
		attackOpportunities: 1,
		// The clean deliveries the exhaustion must leave alone: the Decomposition
		// and both first-wave findings.
		benignOpportunities: 3,
		expected: {
			// Stranding is containment without a refusal; the run reports what the
			// surviving wave supports. The budget still surfaces on the one child it
			// legitimately refuses (the synthesizer), which is what `contained` reads.
			outcome: { errorCode: null },
			// Commander plus the two first-wave workers. The stranded `trace` and
			// `writeup` never spawn, so the only refused dispatch is the synthesizer.
			process: { dispatched: 3, refused: 1, unreached: [] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 3 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-decomposition-budget-fault-"));
			const adapter = makeFaultAdapter({
				// Each worker plays three charged turns against the commander's one:
				// 200 tokens per turn, so the commander settles at 200, the headroom
				// projection admits 200 + 4×200 = 1000 under the 1300 ceiling, and the
				// first wave's 1200 puts the budget past it only once both settle.
				replies: { commander: DECOMPOSITION, recon: { reply: "WAVE_ONE_FINDING", turns: 3 }, debrief: "MUST BE REFUSED, NOT RUN" },
				usage: { input: 100, output: 100, cost: 0 },
			});
			const output = await handleOrchestrate(faultDeps(
				{
					task: "document how auth works",
					orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" } },
				},
				adapter,
				cwd,
				{ budget: Budget.forFlow({ maxTokens: 1300 }) },
			));

			// The first wave ran; the dependent chain behind it never spawned and
			// was never dispatched-then-refused either — that per-child churn is
			// exactly what the wave gate exists to end.
			const reconDispatches = adapter.ledger.dispatches.filter((dispatch) => dispatch.agent === "recon");
			const workerTasks = reconDispatches.map((dispatch) => dispatch.task);
			if (!workerTasks.some((task) => task.includes(SURVEY)) || !workerTasks.some((task) => task.includes(LINT))) {
				throw new Error("the first wave did not run before the ceiling bit");
			}
			for (const stranded of [TRACE, WRITEUP]) {
				if (workerTasks.some((task) => task.includes(stranded))) throw new Error(`a budget-stranded subtask was spawned anyway: ${stranded}`);
			}
			if (reconDispatches.some((dispatch) => dispatch.delivery === "refused")) {
				throw new Error("a worker was dispatched into a spent budget instead of being stranded");
			}

			// The stranded remainder stays visible by name, carrying the budget
			// refusal as its reason rather than a subtask it never waited on.
			const synthesis = adapter.ledger.dispatches.find((dispatch) => dispatch.agent === "debrief")?.task ?? "";
			if (!/## Subtasks not completed \(2\)/.test(synthesis)) throw new Error("the synthesizer manifest does not carry the stranded remainder");
			if (!synthesis.includes(`- trace: ${TRACE} — stranded: Flow budget exhausted`)) throw new Error("the manifest does not name the budget refusal as the stranding reason");
			if (!synthesis.includes(`- writeup: ${WRITEUP} — stranded: Flow budget exhausted`)) throw new Error("the transitively stranded subtask is missing its budget reason");

			return observe(output, adapter.ledger, [], { attack: true });
		},
	};
}

function midFlowReplanScenario(): FaultScenario {
	// The head of the chain dies, stranding `trace` and `writeup`. With the
	// default replan enabled, the commander returns one replacement for the
	// remainder: a fresh survey, plus a writeup that depends on it and on the
	// succeeded `lint`. The same ceilings keep binding after the replan: once
	// the fresh survey settles, the between-wave headroom projection refuses
	// the revision's own dependent before it can spawn into the ceiling — and
	// with the one replan spent, that refusal strands instead of replanning.
	const SURVEY2 = "Redo the auth entry survey from the lint findings";
	const WRITEUP2 = "Write the summary from the fresh survey";
	const REVISION = [
		"Replacing the remainder.",
		"",
		"```json",
		JSON.stringify([
			{ id: "survey-2", objective: SURVEY2 },
			{ id: "writeup-2", objective: WRITEUP2, dependsOn: ["survey-2", "lint"] },
		]),
		"```",
	].join("\n");
	const faults: FaultRule[] = [{ kind: "failure", agent: "recon", occurrence: 1, errorCode: "CHILD_EXIT_NONZERO" }];
	return {
		id: "stranding-failure-replans-and-ceilings-still-bind",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "failure",
		description: "A failure strands the dependent chain; the one mid-flow replan dispatches a revision, and the budget ceilings still bind the revision's remainder.",
		attackOpportunities: 1,
		// The clean deliveries the fault must leave alone: both commander
		// Decompositions, the independent lint finding, and the fresh survey.
		benignOpportunities: 4,
		expected: {
			// Stranding is containment without a refusal, before and after a replan.
			outcome: { errorCode: null },
			// Commander twice (initial plan, replan), then survey, lint, and the
			// revision's fresh survey. writeup-2 is stranded by the headroom
			// projection before it spawns, so nothing is dispatched-then-refused.
			process: { dispatched: 5, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 4 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-decomposition-replan-fault-"));
			// 200 tokens per turn. Commander turns cost 200; each worker plays two
			// turns (400). Ceiling 1250: the initial plan projects 200 + 4×200 =
			// 1000 at admission and is admitted; the revision projects 800 + 2×400
			// = 1200 after the replan commander settles and is admitted; once the
			// fresh survey lands the remainder projects 1200 + 800/3 ≈ 1467 and is
			// refused — the ceiling binds the revision exactly as it bound the plan.
			const adapter = makeFaultAdapter({
				replies: {
					commander: [DECOMPOSITION, REVISION],
					recon: [{ reply: "MUST NOT ARRIVE", turns: 2 }, { reply: "LINT_OUTPUT", turns: 2 }, { reply: "SURVEY2_OUTPUT", turns: 2 }],
					debrief: "MUST NOT RUN",
				},
				faults,
				usage: { input: 100, output: 100, cost: 0 },
			});
			const output = await handleOrchestrate(faultDeps(
				{
					task: "document how auth works",
					orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" } },
				},
				adapter,
				cwd,
				{ budget: Budget.forFlow({ maxTokens: 1250 }) },
			));

			// The replan is on the record as the mode's own retry event.
			if (!adapter.ledger.eventNames("retry").includes("orchestrate.replan_decomposition")) {
				throw new Error("the replan left no orchestrate.replan_decomposition event behind");
			}
			if (adapter.ledger.dispatches.filter((dispatch) => dispatch.agent === "commander").length !== 2) {
				throw new Error("the replan did not dispatch exactly one revision commander");
			}
			// The revision dispatched; the stranded plan-1 subtasks never ran, and
			// neither did the revision subtask the ceiling refused.
			const workerTasks = adapter.ledger.dispatches.filter((dispatch) => dispatch.agent === "recon").map((dispatch) => dispatch.task);
			if (!workerTasks.some((task) => task.includes(SURVEY2))) throw new Error("the revision's fresh survey never dispatched");
			for (const neverSpawned of [TRACE, WRITEUP, WRITEUP2]) {
				if (workerTasks.some((task) => task.includes(neverSpawned))) throw new Error(`a replaced or headroom-stranded subtask was spawned anyway: ${neverSpawned}`);
			}
			// The refused remainder stays visible, with the headroom refusal named.
			// (That a revision subtask receives a succeeded original's output is
			// pinned in tests/orchestrate-replan.test.ts.)
			const text = output.content[0].text;
			if (!/Decomposition replanned once mid-flow/.test(text)) throw new Error(`the replan is not reported: ${text.split("\n")[0]}`);
			if (!/2 succeeded, 1 failed, 1 stranded/.test(text)) throw new Error(`the outcome counts are wrong: ${text.split("\n")[0]}`);
			if (!text.includes(`- writeup-2: ${WRITEUP2} — stranded: Flow budget headroom exceeded`)) {
				throw new Error("the manifest does not name the headroom refusal that stranded the revision's remainder");
			}
			return observe(output, adapter.ledger, ["debrief"], { attack: true });
		},
	};
}

export function decompositionScenarios(): FaultScenario[] {
	return [strandedDependentsScenario(), failedReviewScenario(), failedRevisionScenario(), midFlowExhaustionScenario(), midFlowReplanScenario()];
}
