import { decompositionEffortWeight, mapDecompositionProse, parseDecomposition, unusableDecompositionError, validateDecomposition, type Decomposition, type DecompositionAdmission, type DecompositionShape, type DecompositionSubtask } from "../decomposition.ts";
import { decompositionRevisionTask, midFlowReplanCritique } from "../decomposition-review.ts";
import { integrationControl } from "../delegation.ts";
import { dispatchIntegrationPlan, integrationRunPlan } from "../integration.ts";
import type { Settle } from "../settle.ts";
import { emptyUsage, type Budget, type FlowAgentRefInput, type FlowError, type ModeDeps, type ModeOutput, type UsageStats } from "../types.ts";
import type { OrchestrateBoard } from "./orchestrate-board.ts";

/**
 * Orchestrate's bounded mid-flow replan (#165): the one revision a flow may
 * ask of its commander once dispatch is under way, plus the between-wave
 * budget headroom re-projection that is its second trigger. Split from
 * orchestrate.ts on size; the handler keeps the wave loop and decides *when*
 * to consult these answers, this module owns *what* a replan is — the revision
 * request, its admission (same parser, same validator with the succeeded ids
 * as satisfied, same headroom projection as the initial Decomposition), and
 * the board bookkeeping that swaps the remainder for the replacement.
 */

/** The replan commander's unit key, kept apart from the initial `decompose` and the review loop's `decompose-<n>` revisions. */
export const REPLAN_KEY = "decompose-replan";

/**
 * A flat revision keeps parseDecomposition's positional ids, which would
 * collide with a flat initial plan's ("1", "2", …) and read as redefinitions.
 * Remap before validation, so the admitted ids are the dispatched ids. A flat
 * list has no edges, so the remap severs nothing.
 */
function remapFlatRevisionIds(decomposition: Decomposition): Decomposition {
	if (decomposition.shape !== "flat") return decomposition;
	return { ...decomposition, subtasks: decomposition.subtasks.map((subtask, index) => ({ ...subtask, id: `r2-${index + 1}` })) };
}

export interface MidFlowReplanContext {
	deps: ModeDeps;
	settle: Settle;
	goal: string;
	returnRequirements?: string;
	workerReturnRequirements?: string;
	requireEvidence?: boolean;
	commanderRef: FlowAgentRefInput;
	/** The initial commander's settled spend — the projection proxy until a worker settles. */
	commanderUsage: UsageStats;
	dispatchShape: DecompositionShape;
	maxSubtasks: number;
	admission: DecompositionAdmission;
	/** The budgets every worker draws down, projected by the between-wave gate. */
	workerBudgets: readonly Budget[];
	/** `orchestrate.replan` — false restores the flat strand-and-report path. */
	enabled: boolean;
	/** The commander handoff key(s) every worker span depends on, replaced by the revision's on a successful replan. */
	initialDependencyKeys: readonly string[];
	/** The flow's outcome board. The replanner reaches every collection through it rather than holding the collections themselves. */
	board: OrchestrateBoard;
}

export type ReplanTrigger = "stranded_dependents" | "budget_headroom";
export type ReplanOutcome = { status: "replanned" | "stranded" } | { status: "refused"; output: ModeOutput };

export interface MidFlowReplanner {
	readonly enabled: boolean;
	/** True once the one replan has been attempted, admitted or not. */
	spent(): boolean;
	/** "Decomposition replanned once mid-flow. " after a successful replan, else "". */
	note(): string;
	/** The keys every worker span's dependsOn opens with — the plan that governs it. */
	dependencyKeys(): readonly string[];
	/** Feed one settled worker into the empirical observation — failed included: its spend was real, and its weight was the estimate that spend is judged against. */
	recordSettled(subtask: DecompositionSubtask, usage: UsageStats): void;
	/** The between-wave projection over the current remainder. Null while no worker has settled — admission already projected the commander proxy. Not Budget.headroomRefusal: this asks every worker budget about the remainder, at this moment's observation. */
	remainderHeadroomRefusal(): FlowError | null;
	/** Mark the whole remainder stranded with one reason, and clear it. */
	strandRemaining(reason: string): void;
	/** Run the one replan. "stranded" means the remainder was stranded here with the refusal as the reason. */
	replan(trigger: ReplanTrigger, reason: string): Promise<ReplanOutcome>;
}

export function createMidFlowReplanner(context: MidFlowReplanContext): MidFlowReplanner {
	const { deps, settle, board } = context;
	let dependencyKeys = [...context.initialDependencyKeys];
	let replanSpent = false;
	let note = "";
	const settledSpend = emptyUsage();
	let settledWeight = 0;

	// What settled workers actually spent, per unit of effort weight — the
	// empirical observation the between-wave projection scales. Until a worker
	// settles, the commander's spend stays the proxy.
	const observation = (): UsageStats => settledWeight > 0
		? {
			...emptyUsage(),
			input: settledSpend.input / settledWeight,
			output: settledSpend.output / settledWeight,
			cost: settledSpend.cost / settledWeight,
		}
		: context.commanderUsage;

	const projectionRefusal = (weight: number): FlowError | null => {
		for (const budget of context.workerBudgets) {
			const refusal = budget.headroomRefusal(weight, observation());
			if (refusal) return refusal;
		}
		return null;
	};

	const strandRemaining = (reason: string) => board.strandRemaining(reason);

	/**
	 * The one bounded mid-flow replan: ask the commander for a full replacement
	 * of the remainder, admit it, then swap it in. A replacement that fails any
	 * check strands the remainder with that refusal as the reason — there is no
	 * replan of a replan.
	 */
	const replan = async (trigger: ReplanTrigger, reason: string): Promise<ReplanOutcome> => {
		replanSpent = true;
		deps.recordEvent?.({
			kind: "retry",
			name: "orchestrate.replan_decomposition",
			scope: { key: `${REPLAN_KEY}.retry`, dependsOn: [...dependencyKeys] },
			attributes: { "flow.retry.attempt": 1, "flow.retry.max_attempts": 1, "flow.retry.reason": trigger },
		});
		const byState = (state: Parameters<OrchestrateBoard["settledByState"]>[0]) => board.settledByState(state);
		const replanTask = decompositionRevisionTask({
			goal: context.goal,
			returnRequirements: context.returnRequirements,
			workerReturnRequirements: context.workerReturnRequirements,
			requireEvidence: context.requireEvidence,
			decomposition: { shape: context.dispatchShape, subtasks: board.remainderSubtasks() },
			critique: midFlowReplanCritique({ reason, succeeded: byState("succeeded"), failed: byState("failed") }),
			maxSubtasks: context.maxSubtasks,
			contracted: Boolean(context.commanderRef.contract),
		});
		const replanPlan = integrationRunPlan(deps, context.commanderRef, replanTask, { scope: { key: REPLAN_KEY, dependsOn: [...dependencyKeys] } });
		if (replanPlan.error) return { status: "refused", output: settle.refuse(replanPlan.error) };
		const dispatched = await dispatchIntegrationPlan(deps, replanPlan.plan!, settle);
		if (dispatched.status === "refused") {
			// A refused consumption (a rejected Return, a handoff-policy stop) is
			// the replacement failing a check, and the contract for that is
			// strand-and-report: the withheld payload never crosses, and the work
			// already paid for still reaches synthesis with the refusal named.
			strandRemaining(`Decomposition replan refused: ${dispatched.error.message}`);
			return { status: "stranded" };
		}
		if (dispatched.status === "failed") {
			strandRemaining(`Decomposition replan failed: commander "${context.commanderRef.agent}" did not settle with a replacement.`);
			return { status: "stranded" };
		}
		const replacement = parseDecomposition(integrationControl(dispatched.result), context.maxSubtasks);
		if (!replacement) {
			strandRemaining(`Decomposition replan refused: ${unusableDecompositionError("replacement").message}`);
			return { status: "stranded" };
		}
		const remapped = remapFlatRevisionIds(replacement);
		const inadmissible = validateDecomposition(remapped, { ...context.admission, satisfiedIds: board.succeededIds() });
		if (inadmissible) {
			strandRemaining(`Decomposition replan refused: ${inadmissible.message}`);
			return { status: "stranded" };
		}
		// The same ceilings bind the revision: its projection runs against what
		// remains after the replan commander's own spend, with the settled-worker
		// observation as the floor.
		const unaffordable = projectionRefusal(decompositionEffortWeight(remapped.subtasks));
		if (unaffordable) {
			strandRemaining(`Decomposition replan refused: ${unaffordable.message}`);
			return { status: "stranded" };
		}
		const prepared = mapDecompositionProse(remapped, (text) => deps.handoffs.prepareText(text).text);
		// The revision replaces the remainder in full, and a failed id that
		// reappears supersedes the failed attempt — its fresh outcome stands, and
		// the trace keeps the failed plan-1 span as the record of the first try.
		board.replaceRemainder(prepared);
		dependencyKeys = [dispatched.handoff.dependencyKey];
		note = "Decomposition replanned once mid-flow. ";
		return { status: "replanned" };
	};

	return {
		enabled: context.enabled,
		spent: () => replanSpent,
		note: () => note,
		dependencyKeys: () => dependencyKeys,
		recordSettled: (subtask, usage) => {
			settledSpend.input += usage.input;
			settledSpend.output += usage.output;
			settledSpend.cost += usage.cost;
			settledWeight += subtask.effortWeight ?? 1;
		},
		remainderHeadroomRefusal: () => settledWeight > 0
			? projectionRefusal(decompositionEffortWeight(board.remainderSubtasks()))
			: null,
		strandRemaining,
		replan,
	};
}
