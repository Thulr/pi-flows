import { MAX_PARALLEL_TASKS, flowError, formatFlowError, type DelegationContract, type FlowTaskInput, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { validateSharedWriteCwd } from "../validate.ts";
import { runAgentFanout } from "../runner.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { acceptIntegrationResults, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";

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
		(done, total) => `Flow parallel: ${done}/${total} done`,
		{ key: "tasks", name: "parallel tasks" },
	);
	// Validated, but no boundary: these outputs go into the response the caller
	// reads, and parallel spawns nothing that consumes them.
	const handoffError = acceptIntegrationResults(deps, plans, results, undefined, { consumed: false });
	if (handoffError) {
		return { content: [{ type: "text", text: formatFlowError(handoffError) }], details: makeDetails("parallel")(results, handoffError) };
	}

	const success = results.filter((result) => !isFailed(result)).length;
	const summaries = results.map((result) => {
		const status = isFailed(result) ? `failed${result.stopReason ? ` (${result.stopReason})` : ""}` : "completed";
		return `### ${result.agent} — ${status}\n\n${sanitizeText(capModelVisibleText(resultText(result)), policy)}`;
	});
	return {
		content: [{ type: "text", text: `Flow parallel: ${success}/${results.length} succeeded.${incompleteHandoffSummary(results)}\n\n${summaries.join("\n\n---\n\n")}` }],
		details: makeDetails("parallel")(results),
	};
}
