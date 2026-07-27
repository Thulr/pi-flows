import {
	createDelegationBudget,
	prepareIntegrationHandoff,
	renderDelegationTask,
	validateDelegationContract,
} from "./delegation.ts";
import type { AgentFanoutItem, AgentRunLimits } from "./runner.ts";
import type {
	DelegationContract,
	FlowAgentRefInput,
	FlowError,
	FlowRunResult,
	IncompleteHandoffPolicy,
	ModeDeps,
} from "./types.ts";
import { appendReturnContract, resolvedCwd } from "./validate.ts";

export interface IntegrationRunPlan extends AgentFanoutItem {
	contract?: DelegationContract;
	cwd: string;
}

function runLimits(contract?: DelegationContract): AgentRunLimits | undefined {
	if (!contract) return undefined;
	return {
		captureRawOutput: true,
		timeoutMs: contract.budget.timeoutMs,
		contractBudget: createDelegationBudget(contract),
	};
}

export function integrationRunPlan(
	deps: ModeDeps,
	ref: FlowAgentRefInput,
	task: string,
	options: {
		fallbackContract?: DelegationContract;
		returnContract?: string;
		requireEvidence?: boolean;
		placeholderTask?: string;
	} = {},
): { plan?: IntegrationRunPlan; error?: FlowError } {
	const contract = ref.contract ?? options.fallbackContract;
	const error = contract ? validateDelegationContract(contract, deps.policy) : null;
	if (error) return { error };
	const renderedTask = contract
		? renderDelegationTask(task, contract, options.returnContract, options.requireEvidence)
		: appendReturnContract(task, options.returnContract, options.requireEvidence);
	return {
		plan: {
			ref,
			task: renderedTask,
			placeholderTask: options.placeholderTask ?? task,
			limits: runLimits(contract),
			contract,
			cwd: resolvedCwd(deps.defaultCwd, ref.cwd),
		},
	};
}

export function acceptIntegrationResult(
	deps: ModeDeps,
	plan: IntegrationRunPlan,
	result: FlowRunResult,
	incompletePolicy: IncompleteHandoffPolicy = deps.params.incompleteHandoffPolicy ?? "fail",
): FlowError | null {
	const prepared = prepareIntegrationHandoff(result, {
		contract: plan.contract,
		cwd: plan.cwd,
		policy: deps.policy,
		incompletePolicy,
	});
	return prepared.error ?? null;
}

export function acceptIntegrationResults(
	deps: ModeDeps,
	plans: IntegrationRunPlan[],
	results: FlowRunResult[],
	incompletePolicy: IncompleteHandoffPolicy = deps.params.incompleteHandoffPolicy ?? "fail",
): FlowError | null {
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		if (!result || result.error || result.exitCode !== 0) continue;
		const error = acceptIntegrationResult(deps, plans[index], result, incompletePolicy);
		if (error) return error;
	}
	return null;
}
