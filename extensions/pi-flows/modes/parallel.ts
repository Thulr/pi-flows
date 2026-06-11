import { DEFAULT_CONCURRENCY, MAX_PARALLEL_TASKS, flowError, formatFlowError, type FlowRunResult, type FlowTaskInput, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, makeEmptyRunResult, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract, validateConcurrency, validateSharedWriteCwd } from "../validate.ts";
import { toolErrorDetails } from "../agents.ts";
import { mapWithConcurrency, runFlowAgent } from "../runner.ts";

export async function handleParallel(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, signal, onUpdate, makeDetails } = deps;
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
	const liveResults: FlowRunResult[] = tasks.map((task) => makeEmptyRunResult(task.agent, task.task, policy));

	const emitParallel = () => {
		const done = liveResults.filter((result) => result.exitCode !== -1).length;
		onUpdate?.({
			content: [{ type: "text", text: `Flow parallel: ${done}/${liveResults.length} done` }],
			details: makeDetails("parallel")([...liveResults]),
		});
	};

	const results = await mapWithConcurrency(tasks, concurrency, async (task, index) => {
		const result = await runFlowAgent({
			defaultCwd,
			agents: discovery.agents,
			agentName: task.agent,
			task: appendReturnContract(task.task, task.returnContract ?? params.returnContract, task.requireEvidence ?? params.requireEvidence),
			cwd: task.cwd,
			model: task.model,
			tools: task.tools,
			timeoutMs: params.timeoutMs,
			recordContent: params.recordContent,
			redactSecrets: params.redactSecrets,
			signal,
			budget: deps.budget,
			recordSpan: deps.recordSpan,
			onUpdate: (partial) => {
				const current = partial.details.results[0];
				if (current) liveResults[index] = current;
				emitParallel();
			},
			makeDetails: makeDetails("parallel"),
		});
		liveResults[index] = result;
		emitParallel();
		return result;
	});

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
