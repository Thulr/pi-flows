import {
	createDelegationBudget,
	canonicalHandoff,
	prepareIntegrationHandoff,
	renderDelegationTask,
	validateDelegationContract,
} from "./delegation.ts";
import { capModelVisibleText, resultText } from "./sanitize.ts";
import { scanForInjection } from "./sanitize.ts";
import { artifactAttributes, handoffAttributes } from "./trace-attributes.ts";
import { runAgentRef, type AgentFanoutItem, type AgentRunLimits } from "./runner.ts";
import type {
	ChildSpanScope,
	DelegationContract,
	FlowAgentRefInput,
	FlowError,
	FlowMode,
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
		contract,
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
		scope?: ChildSpanScope;
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
			...(options.scope ? { scope: options.scope } : {}),
		},
	};
}

/**
 * Run a planned child. The plan already carries the ref, the rendered task, the
 * contract-derived limits, and the span scope, so callers pass the plan whole
 * instead of unpacking the same four fields at every dispatch site.
 */
export function runIntegrationPlan(deps: ModeDeps, plan: IntegrationRunPlan, mode: FlowMode, step: number | undefined, priorResults: FlowRunResult[]): Promise<FlowRunResult> {
	return runAgentRef(deps, plan.ref, plan.task, mode, step, priorResults, { limits: plan.limits, scope: plan.scope });
}

/**
 * Attribute one handoff boundary. The event records what crossed — filtering,
 * size, injection warnings, preserved constraint ids, acceptance status, and
 * artifact references — plus one artifact event per referenced file, so a
 * corrupted or unverifiable artifact is attributable to the hop that carried it
 * rather than to the synthesis that later used it.
 */
function recordHandoffEvidence(deps: ModeDeps, plan: IntegrationRunPlan, result: FlowRunResult, rejection?: FlowError): void {
	const record = deps.recordEvent;
	if (!record) return;
	const handoff = result.handoff;
	// The handoff is its own unit, not the child again: it nests in the same stage
	// and depends on the child that produced it. Reusing the child's key would
	// make both spans answer to one name, and whichever registered last would win
	// every dependency link pointed at that child.
	const unit = plan.scope?.key;
	const scope: ChildSpanScope | undefined = plan.scope
		? { stage: plan.scope.stage, ...(unit ? { key: `${unit}.handoff`, dependsOn: [unit] } : {}) }
		: undefined;
	if (!handoff) {
		record({
			kind: "validation",
			name: "handoff.rejected",
			ok: false,
			scope,
			attributes: {
				"flow.handoff.from_agent": result.agent,
				"flow.handoff.acceptance": `rejected:${rejection?.code ?? "unknown"}`,
				"flow.error_code": rejection?.code,
				"flow.handoff.retryable": rejection?.retryable ?? false,
			},
		});
		return;
	}
	const raw = capModelVisibleText(resultText(result));
	const carried = canonicalHandoff(handoff);
	record({
		kind: "handoff",
		name: rejection ? "handoff.rejected" : "handoff.accepted",
		ok: !rejection,
		scope,
		attributes: handoffAttributes(handoff, {
			accepted: !rejection,
			rejection,
			rawBytes: Buffer.byteLength(raw, "utf8"),
			carriedBytes: Buffer.byteLength(carried, "utf8"),
			warnings: scanForInjection(raw),
			contract: plan.contract,
			policy: deps.policy,
		}),
	});
	for (const [index, reference] of handoff.artifactReferences.entries()) {
		record({
			kind: "artifact",
			name: "artifact.referenced",
			scope: scope && unit ? { stage: scope.stage, key: `${unit}.artifact-${index + 1}`, dependsOn: [`${unit}.handoff`] } : scope,
			attributes: artifactAttributes(handoff, reference.path, deps.policy),
		});
	}
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
	recordHandoffEvidence(deps, plan, result, prepared.error);
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
