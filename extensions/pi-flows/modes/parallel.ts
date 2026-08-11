import { MAX_PARALLEL_TASKS, flowError, modeSettle, type DelegationContract, type FlowError, type FlowRunResult, type FlowTaskInput, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runWave } from "../runner.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { maxRunDuration, plannedRefs, type ModePlan } from "./plan.ts";

/**
 * Parallel's plan: one concurrent wave of every task, guarded unless the
 * mode's own declaration refuses first (fan-out cap or missing sizing). The
 * wave stays declared for requested agents and disclosure while the
 * shared-write mirror stays silent behind that earlier refusal.
 */
export function planParallel(params: any): ModePlan {
	if (!Array.isArray(params.tasks) || params.tasks.length === 0) return { waves: [], opening: [] };
	const refs = plannedRefs(params.tasks);
	const guarded = preSpawnRefusalParallel(params) === null;
	return { waves: [{ refs, guarded, contracts: "resolved" }], opening: guarded ? refs : [] };
}

/** One wave, fully concurrent: the slowest task bounds the flow. */
export function criticalPathParallel(_params: any, results: FlowRunResult[]): number | undefined {
	return maxRunDuration(results);
}

/**
 * Parallel's pre-spawn refusals (modes/contract.ts): a fan-out over the cap is
 * refused TOO_MANY_TASKS first; then a multi-task raw fan-out must make model
 * sizing explicit before the shared-write guard or any child spawn. Total over
 * raw model args — a non-array `tasks` never reaches here (the schema refuses
 * it) and yields no refusal rather than throwing.
 */
export function preSpawnRefusalParallel(params: any): FlowError | null {
	const tasks = params?.tasks;
	if (!Array.isArray(tasks)) return null;
	if (tasks.length > MAX_PARALLEL_TASKS) {
		return flowError(
			"TOO_MANY_TASKS",
			`Too many flow tasks (${tasks.length}).`,
			`Parallel mode supports at most ${MAX_PARALLEL_TASKS} tasks to prevent runaway subprocess fanout.`,
			`Split the work into batches of ${MAX_PARALLEL_TASKS} or fewer tasks.`,
		);
	}
	if (tasks.length < 2) return null;

	const namesModel = (value: unknown) => typeof value === "string" && value.trim().length > 0;
	const namesTier = (value: unknown) => typeof value === "string" && ["fast", "capable", "deep"].includes(value);
	if (namesModel(params?.model) || namesTier(params?.tier)) return null;

	const omitted = tasks.flatMap((task, index) => {
		if (!task || typeof task !== "object" || Array.isArray(task)) return [];
		return namesModel(task.model) || namesTier(task.tier) ? [] : [index + 1];
	});
	if (omitted.length === 0) return null;

	return flowError(
		"PARALLEL_SIZING_REQUIRED",
		"Parallel task sizing must be explicit before child spend begins.",
		`Task${omitted.length === 1 ? "" : "s"} ${omitted.join(", ")} ${omitted.length === 1 ? "omits" : "omit"} both model and tier, while the flow names no model or tier. Agent defaults can otherwise place a heterogeneous fan-out uniformly on the parent session model.`,
		"Set tier:'fast'|'capable'|'deep' (or an exact model) on every task. If uniform sizing is intentional, set one flow-wide tier or model as the explicit acknowledgement. A thinking level alone changes effort, not model capability.",
	);
}

export async function handleParallel(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	const tasks = params.tasks as FlowTaskInput[];

	const fanoutRefusal = preSpawnRefusalParallel(params);
	if (fanoutRefusal) return settle.refuse(fanoutRefusal);

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
