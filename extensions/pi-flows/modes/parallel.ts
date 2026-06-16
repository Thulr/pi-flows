import { DEFAULT_CONCURRENCY, MAX_PARALLEL_TASKS, flowError, formatFlowError, type FlowTaskInput, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract, validateConcurrency, validateSharedWriteCwd } from "../validate.ts";
import { toolErrorDetails } from "../agent-catalog.ts";
import { runAgentFanout } from "../runner.ts";

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
			details: toolErrorDetails(discovery, "parallel", agentScope, error),
		};
	}

	const concurrencyError = validateConcurrency(params.concurrency);
	if (concurrencyError) {
		return {
			content: [{ type: "text", text: formatFlowError(concurrencyError) }],
			details: toolErrorDetails(discovery, "parallel", agentScope, concurrencyError),
		};
	}
	const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, tasks, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) {
		return {
			content: [{ type: "text", text: formatFlowError(sharedWriteError) }],
			details: toolErrorDetails(discovery, "parallel", agentScope, sharedWriteError),
		};
	}
	const results = await runAgentFanout(
		deps,
		"parallel",
		tasks.map((task) => ({
			ref: task,
			task: appendReturnContract(task.task, task.returnContract ?? params.returnContract, task.requireEvidence ?? params.requireEvidence),
			placeholderTask: task.task,
		})),
		concurrency,
		[],
		(done, total) => `Flow parallel: ${done}/${total} done`,
	);

	const success = results.filter((result) => !isFailed(result)).length;
	const summaries = results.map((result) => {
		const status = isFailed(result) ? `failed${result.stopReason ? ` (${result.stopReason})` : ""}` : "completed";
		return `### ${result.agent} — ${status}\n\n${sanitizeText(capModelVisibleText(resultText(result)), policy)}`;
	});
	return {
		content: [{ type: "text", text: `Flow parallel: ${success}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
		details: makeDetails("parallel")(results),
	};
}
