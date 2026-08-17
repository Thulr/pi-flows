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
		description: "A subtask two others depend on dies; the dependents must never spawn, and the independent branch must still finish.",
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
					orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" } },
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

export function decompositionScenarios(): FaultScenario[] {
	return [strandedDependentsScenario()];
}
