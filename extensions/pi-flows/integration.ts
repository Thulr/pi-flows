import { resolveDelegationContract } from "./contract-resolution.ts";
import { ResolvedDelegationContract } from "./delegation.ts";
import type { HandoffConsumption } from "./handoff-consumption.ts";
import { runAgentRef, type AgentFanoutItem, type AgentRunLimits } from "./runner.ts";
import { isFailed } from "./sanitize.ts";
import type { Settle } from "./settle.ts";
import type {
	Budget,
	ChildSpanScope,
	DelegationContract,
	FlowAgentRefInput,
	FlowError,
	FlowMode,
	FlowRunResult,
	IncompleteHandoffPolicy,
	ModeDeps,
	ModeOutput,
} from "./types.ts";
import { appendReturnRequirements, resolvedCwd } from "./validate.ts";

export interface IntegrationRunPlan extends AgentFanoutItem {
	contract?: ResolvedDelegationContract;
	cwd: string;
}

export interface IntegrationRunPlanOptions {
	fallbackContract?: DelegationContract;
	/**
	 * A contract the caller already resolved — fail-fast prevalidation of every
	 * step before the first spawn (chain), or one resolution reused across
	 * iterations (evaluate). Wins over ref/fallback resolution: the plan carries
	 * it as-is, so admissibility is never re-derived from raw data.
	 */
	resolvedContract?: ResolvedDelegationContract;
	/**
	 * Share one contract budget across several plans of the same contract, so
	 * an iterating mode accumulates spend against a single ceiling instead of
	 * minting a fresh budget per plan. Defaults to a budget minted from the
	 * resolved contract.
	 */
	contractBudget?: Budget;
	returnContract?: string;
	requireEvidence?: boolean;
	/**
	 * The task already carries its rendered contract sections and return
	 * requirements (a revision prompt embedding a previously rendered goal);
	 * dispatch it verbatim. Limits and consumption still come from the resolved
	 * contract — only the second rendering is skipped.
	 */
	prerendered?: boolean;
	placeholderTask?: string;
	scope?: ChildSpanScope;
}

function runLimits(contract: ResolvedDelegationContract | undefined, sharedBudget: Budget | undefined): AgentRunLimits | undefined {
	if (!contract) return undefined;
	return {
		captureRawOutput: true,
		timeoutMs: contract.timeoutMs,
		contractBudget: sharedBudget ?? contract.budget(),
		// Trace identity reads contract DATA, not the resolved object.
		contract: contract.contract,
	};
}

/**
 * Validate and render one child plan before dispatch. The contract crosses
 * into the plan only as a ResolvedDelegationContract, so downstream dispatch
 * and handoff consumption work against a contract that passed admissibility.
 * Handoff validation/consumption happen later through ModeDeps.handoffs.
 */
export function integrationRunPlan(
	deps: ModeDeps,
	ref: FlowAgentRefInput,
	task: string,
	options: IntegrationRunPlanOptions = {},
): { plan?: IntegrationRunPlan; error?: FlowError } {
	let contract = options.resolvedContract;
	if (!contract) {
		const rawContract = resolveDelegationContract(ref, options.fallbackContract);
		if (rawContract) {
			const resolution = ResolvedDelegationContract.resolve(rawContract, deps.policy);
			if (resolution.error) return { error: resolution.error };
			contract = resolution.resolved;
		}
	}
	const renderedTask = options.prerendered
		? task
		: contract
			? contract.renderTask(task, options.returnContract, options.requireEvidence)
			: appendReturnRequirements(task, options.returnContract, options.requireEvidence);
	return {
		plan: {
			ref,
			task: renderedTask,
			placeholderTask: options.placeholderTask ?? task,
			limits: runLimits(contract, options.contractBudget),
			contract,
			cwd: resolvedCwd(deps.defaultCwd, ref.cwd),
			...(options.scope ? { scope: options.scope } : {}),
		},
	};
}

/**
 * Dispatch a validated plan without unpacking its contract limits or span
 * scope. Private on purpose: {@link dispatchIntegrationPlan} is the
 * handler-facing entry point, and it owns the track/isFailed/consume ordering
 * a bare dispatch would hand back to the caller.
 */
function runIntegrationPlan(
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

/** Whether another role consumes the dispatched result — see ConsumeResultOptions.completion. */
export type IntegrationCompletion = "integrate" | "terminal";

/**
 * An integrating consumption's handoff: another role consumes it, so a
 * dependency key was minted — typed present, ending the per-mode non-null
 * assertions. A terminal consumption crosses to the parent, mints no key, and
 * stays the plain {@link HandoffConsumption}.
 */
export interface IntegrationHandoff extends HandoffConsumption {
	dependencyKey: string;
}

/** The handoff shape a dispatch settles with, by its completion: only a statically integrating dispatch may rely on the key. */
export type DispatchedHandoff<C extends IntegrationCompletion> = "terminal" extends C ? HandoffConsumption : IntegrationHandoff;

/**
 * How one plan dispatch settled. `failed` hands the run back for the mode's
 * own failure prose (that text differs per mode and stays the handler's);
 * `refused` is the uniform consumption refusal, already shaped as the mode's
 * output; `ok` carries the settled run and its consumed handoff.
 */
export type IntegrationDispatch<H extends HandoffConsumption = HandoffConsumption> =
	| { status: "failed"; result: FlowRunResult }
	| { status: "refused"; error: FlowError; output: ModeOutput }
	| { status: "ok"; result: FlowRunResult; handoff: H };

/** Consumption options passed through to `ModeDeps.handoffs.consumeResult`; the plan supplies contract, cwd, and span scope. */
export interface IntegrationDispatchOptions<C extends IntegrationCompletion> {
	completion?: C;
	enforceCompletion?: boolean;
	incompletePolicy?: IncompleteHandoffPolicy;
	payload?: "handoff" | "source";
	noticeLabel?: string;
	/** Consume-time span override; defaults to the plan's own scope. */
	scope?: ChildSpanScope;
}

/**
 * Run one plan to completion: dispatch (step derived from the settle), track
 * the result before any return path, hand a failed run back untouched, and
 * consume a settled success through the flow's handoff consumer. The four
 * ordering constraints every ritual site sequenced by hand — push before
 * return, isFailed before consume, step arithmetic, dependency-key presence —
 * are owned here and are not re-orderable from a handler.
 *
 * An integrating dispatch requires an addressable plan (a keyed span scope),
 * or its handoff could mint no dependency key; that absence is a mode wiring
 * bug and throws before any spawn rather than surfacing as a FlowError the
 * model is asked to fix.
 */
export async function dispatchIntegrationPlan<C extends IntegrationCompletion = "integrate">(
	deps: ModeDeps,
	plan: IntegrationRunPlan,
	settle: Settle,
	options: IntegrationDispatchOptions<C> = {},
): Promise<IntegrationDispatch<DispatchedHandoff<C>>> {
	const completion: IntegrationCompletion = options.completion ?? "integrate";
	if (completion === "integrate" && !(options.scope ?? plan.scope)?.key) {
		throw new Error("dispatchIntegrationPlan: an integrating consumption needs a keyed span scope on the plan or the options — without one its handoff mints no dependency key. Key the plan's scope; this is mode wiring, not a child failure.");
	}
	const result = await runIntegrationPlan(deps, plan, settle.mode, settle.nextStep, [...settle.results]);
	settle.track(result);
	if (isFailed(result)) return { status: "failed", result };
	const handoff = deps.handoffs.consumeResult({
		plan,
		result,
		completion,
		enforceCompletion: options.enforceCompletion,
		incompletePolicy: options.incompletePolicy,
		payload: options.payload,
		noticeLabel: options.noticeLabel,
		...(options.scope ? { scope: options.scope } : {}),
	});
	if (handoff.error) return { status: "refused", error: handoff.error, output: settle.refuse(handoff.error) };
	// The integrate guard above pinned a keyed scope, so consumeResult minted the key.
	return { status: "ok", result, handoff: handoff as DispatchedHandoff<C> };
}
