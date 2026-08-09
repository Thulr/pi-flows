import { MAX_PARALLEL_TASKS, flowError, formatFlowError, type DelegationContract, type FlowTaskInput, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { validateSharedWriteCwd } from "../validate.ts";
import { runAgentFanout } from "../runner.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";

export async function handleParallel(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, makeDetails } = deps;
	const tasks = params.tasks as FlowTaskInput[];

	if (tasks.length > MAX_PARALLEL_TASKS) {
		const error = flowError(
			"TOO_MANY_TASKS",
			`Too many flow tasks (${tasks.length}).`,
			`Parallel mode supports at most ${MAX_PARALLEL_TASKS} tasks to prevent runaway subprocess fanout.`,
			`Split the work into batches of ${MAX_PARALLEL_TASKS} or fewer tasks.`,
		);
		return {
			content: [{ type: "text", text: formatFlowError(error) }],
			details: makeDetails("parallel")([], error),
		};
	}

	const { concurrency } = deps;
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, tasks, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) {
		return {
			content: [{ type: "text", text: formatFlowError(sharedWriteError) }],
			details: makeDetails("parallel")([], sharedWriteError),
		};
	}
	const plans: IntegrationRunPlan[] = [];
	for (const task of tasks) {
		const planned = integrationRunPlan(deps, task, task.task, {
			fallbackContract: params.contract as DelegationContract | undefined,
			returnContract: task.returnContract ?? params.returnContract,
			requireEvidence: task.requireEvidence ?? params.requireEvidence,
			placeholderTask: task.task,
		});
		if (planned.error) {
			return { content: [{ type: "text", text: formatFlowError(planned.error) }], details: makeDetails("parallel")([], planned.error) };
		}
		plans.push(planned.plan!);
	}
	const results = await runAgentFanout(
		deps,
		"parallel",
		plans,
		concurrency,
		[],
		(settled, total) => `Flow parallel: ${settled}/${total} settled`,
		{ key: "tasks", name: "parallel tasks" },
	);
	// Validated, but no boundary: these outputs go into the response the caller
	// reads, and parallel spawns nothing that consumes them. Incomplete envelopes
	// still fail closed — terminal recording changes the evidence, not the gate.
	const handoffs = deps.handoffs.consumeResults(results.flatMap((result, index) =>
		isFailed(result) ? [] : [{ plan: plans[index], result, completion: "terminal" as const, enforceCompletion: true }],
	));
	if (handoffs.error) {
		return { content: [{ type: "text", text: formatFlowError(handoffs.error) }], details: makeDetails("parallel")(results, handoffs.error) };
	}

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
	return {
		content: [{ type: "text", text: `Flow parallel: ${success}/${results.length} succeeded.${incompleteHandoffSummary(results)}\n\n${summaries.join("\n\n---\n\n")}` }],
		details: makeDetails("parallel")(results),
	};
}
