import { resolveDelegationContract } from "./contract-resolution.ts";
import { ResolvedDelegationContract } from "./delegation.ts";
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
	contract?: ResolvedDelegationContract;
	cwd: string;
}

function runLimits(contract?: ResolvedDelegationContract): AgentRunLimits | undefined {
	if (!contract) return undefined;
	return {
		captureRawOutput: true,
		timeoutMs: contract.timeoutMs,
		contractBudget: contract.budget(),
		// Trace identity reads contract DATA; the resolved object stays the transition currency.
		contract: contract.contract,
	};
}

/**
 * Validate and render one child plan before dispatch. The contract crosses
 * into the plan only as a ResolvedDelegationContract, so everything dispatch
 * and handoff consumption do with it downstream is against a contract that
 * provably passed admissibility. Handoff validation and consumption happen
 * later through ModeDeps.handoffs, after the child settles.
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
	const rawContract = resolveDelegationContract(ref, options.fallbackContract);
	let contract: ResolvedDelegationContract | undefined;
	if (rawContract) {
		const resolution = ResolvedDelegationContract.resolve(rawContract, deps.policy);
		if (resolution.error) return { error: resolution.error };
		contract = resolution.resolved;
	}
	const renderedTask = contract
		? contract.renderTask(task, options.returnContract, options.requireEvidence)
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
