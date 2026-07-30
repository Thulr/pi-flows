import {
	createDelegationBudget,
	renderDelegationTask,
	validateDelegationContract,
} from "./delegation.ts";
import { runAgentRef, type AgentFanoutItem, type AgentRunLimits } from "./runner.ts";
import type {
	ChildSpanScope,
	DelegationContract,
	FlowAgentRefInput,
	FlowError,
	FlowMode,
	FlowRunResult,
	ModeDeps,
} from "./types.ts";
import { appendReturnRequirements, resolvedCwd } from "./validate.ts";

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
		contract,
	};
}

/**
 * Validate and render one child plan before dispatch. Handoff validation and
 * consumption happen later through ModeDeps.handoffs, after the child settles.
 */
export function integrationRunPlan(
	deps: ModeDeps,
	ref: FlowAgentRefInput,
	task: string,
	options: {
		fallbackContract?: DelegationContract;
		returnContract?: string;
		requireEvidence?: boolean;
		placeholderTask?: string;
		scope?: ChildSpanScope;
	} = {},
): { plan?: IntegrationRunPlan; error?: FlowError } {
	const contract = ref.contract ?? options.fallbackContract;
	const error = contract ? validateDelegationContract(contract, deps.policy) : null;
	if (error) return { error };
	const renderedTask = contract
		? renderDelegationTask(task, contract, options.returnContract, options.requireEvidence)
		: appendReturnRequirements(task, options.returnContract, options.requireEvidence);
	return {
		plan: {
			ref,
			task: renderedTask,
			placeholderTask: options.placeholderTask ?? task,
			limits: runLimits(contract),
			contract,
			cwd: resolvedCwd(deps.defaultCwd, ref.cwd),
			...(options.scope ? { scope: options.scope } : {}),
		},
	};
}

/** Dispatch a validated plan without unpacking its contract limits or span scope. */
export function runIntegrationPlan(
	deps: ModeDeps,
	plan: IntegrationRunPlan,
	mode: FlowMode,
	step: number | undefined,
	priorResults: FlowRunResult[],
): Promise<FlowRunResult> {
	return runAgentRef(deps, plan.ref, plan.task, mode, step, priorResults, {
		limits: plan.limits,
		scope: plan.scope,
	});
}
