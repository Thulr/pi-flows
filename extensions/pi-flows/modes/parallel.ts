import { MAX_PARALLEL_TASKS, flowError, modeSettle, type DelegationContract, type FlowRunResult, type FlowTaskInput, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runWave } from "../runner.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { maxRunDuration, plannedRefs, withinFanoutCap, type ModePlan } from "./plan.ts";

/**
 * Parallel's plan: one concurrent wave of every task, guarded — unless the
 * fan-out is over the cap, where the handler refuses TOO_MANY_TASKS before its
 * guard, so the wave stays declared (requested agents, disclosure) while the
 * admissibility mirror stays silent behind the earlier refusal and no opening
 * is certain.
 */
export function planParallel(params: any): ModePlan {
	if (!Array.isArray(params.tasks) || params.tasks.length === 0) return { waves: [], opening: [] };
	const refs = plannedRefs(params.tasks);
	const guarded = withinFanoutCap(params.tasks);
	return { waves: [{ refs, guarded, contracts: "resolved" }], opening: guarded ? refs : [] };
}

/** One wave, fully concurrent: the slowest task bounds the flow. */
export function criticalPathParallel(_params: any, results: FlowRunResult[]): number | undefined {
	return maxRunDuration(results);
}

export async function handleParallel(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	const tasks = params.tasks as FlowTaskInput[];

	if (tasks.length > MAX_PARALLEL_TASKS) {
		return settle.refuse(flowError(
			"TOO_MANY_TASKS",
			`Too many flow tasks (${tasks.length}).`,
			`Parallel mode supports at most ${MAX_PARALLEL_TASKS} tasks to prevent runaway subprocess fanout.`,
			`Split the work into batches of ${MAX_PARALLEL_TASKS} or fewer tasks.`,
		));
	}

	const plans: IntegrationRunPlan[] = [];
	for (const task of tasks) {
		const planned = integrationRunPlan(deps, task, task.task, {
			fallbackContract: params.contract as DelegationContract | undefined,
			returnContract: task.returnContract ?? params.returnContract,
			requireEvidence: task.requireEvidence ?? params.requireEvidence,
			placeholderTask: task.task,
		});
		if (planned.error) return settle.refuse(planned.error);
		plans.push(planned.plan!);
	}
	const wave = await runWave(deps, settle, plans, {
		statusText: (settled, total) => `Flow parallel: ${settled}/${total} settled`,
		stage: { key: "tasks", name: "parallel tasks" },
	});
	if (wave.status === "refused") return wave.output;
	const results = wave.results;
	// Validated, but no boundary: these outputs go into the response the caller
	// reads, and parallel spawns nothing that consumes them. Incomplete envelopes
	// still fail closed — terminal recording changes the evidence, not the gate.
	const handoffs = deps.handoffs.consumeResults(results.flatMap((result, index) =>
		isFailed(result) ? [] : [{ plan: plans[index], result, completion: "terminal" as const, enforceCompletion: true }],
	));
	if (handoffs.error) return settle.refuse(handoffs.error);

	const success = results.filter((result) => !isFailed(result)).length;
	const summaries = results.map((result) => {
		const status = isFailed(result) ? `failed${result.stopReason ? ` (${result.stopReason})` : ""}` : "completed";
		const label = result.role ? `${result.role} (${result.agent})` : result.agent;
		// This response is the terminal consumer for ordinary parallel mode.
		// Preserve the complete contracted envelope; preset-specific formatters
		// may compact it after the mode returns.
		const text = resultText(result);
		return `### ${label} — ${status}\n\n${sanitizeText(capModelVisibleText(text), policy)}`;
	});
	return settle.complete(`Flow parallel: ${success}/${results.length} succeeded.${incompleteHandoffSummary(results)}\n\n${summaries.join("\n\n---\n\n")}`);
}
