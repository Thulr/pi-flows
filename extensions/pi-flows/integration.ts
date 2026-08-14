import { resolveDelegationContract } from "./contract-resolution.ts";
import { ResolvedDelegationContract } from "./delegation.ts";
import { runAgentRef, runWave, type AgentFanoutItem, type AgentRunLimits, type WaveRunOptions } from "./dispatch.ts";
import type { HandoffConsumption } from "./handoff-consumption.ts";
import { isFailed } from "./sanitize.ts";
import type { Settle } from "./settle.ts";
import type {
	Budget,
	ChildSpanScope,
	DelegationContract,
	FlowAgentRefInput,
	FlowError,
	FlowRunResult,
	IncompleteHandoffPolicy,
	ModeDeps,
	ModeOutput,
} from "./types.ts";
import { appendReturnRequirements, resolvedCwd } from "./validate.ts";

const INTEGRATION_RUN_PLAN = Symbol("pi-flows.integration-run-plan");
const CONTRACT_BUDGETS = new WeakMap<ModeDeps, Map<string, Budget | undefined>>();

/** Opaque capability for one admitted Child run; construct it through {@link integrationRunPlan}. */
export interface IntegrationRunPlan {
	readonly [INTEGRATION_RUN_PLAN]: true;
}

interface IntegrationRunState extends AgentFanoutItem {
	readonly contract?: ResolvedDelegationContract;
	readonly cwd: string;
}

interface IntegrationPlanState {
	readonly owner: ModeDeps;
	readonly run: IntegrationRunState;
	dispatched: boolean;
}

interface DispatchedIntegrationRun {
	readonly run: IntegrationRunState;
	readonly scope?: ChildSpanScope;
}

const RUN_PLANS = new WeakMap<IntegrationRunPlan, IntegrationPlanState>();
const DISPATCHED_RUNS = new WeakMap<FlowRunResult, DispatchedIntegrationRun>();

function admittedPlan(deps: ModeDeps, plan: IntegrationRunPlan): IntegrationPlanState {
	const state = RUN_PLANS.get(plan);
	if (!state) throw new TypeError("IntegrationRunPlan must come from integrationRunPlan().");
	if (state.owner !== deps) throw new TypeError("IntegrationRunPlan can run only in the flow that admitted it.");
	return state;
}

function admittedRun(deps: ModeDeps, plan: IntegrationRunPlan): IntegrationRunState {
	return admittedPlan(deps, plan).run;
}

function spendPlan(state: IntegrationPlanState): void {
	if (state.dispatched) throw new TypeError("IntegrationRunPlan has already been dispatched.");
	state.dispatched = true;
}

function bindResult(result: FlowRunResult, run: IntegrationRunState, scope: ChildSpanScope | undefined): void {
	const existing = DISPATCHED_RUNS.get(result);
	if (existing && existing.run !== run) throw new TypeError("A Child Result cannot belong to two integration plans.");
	DISPATCHED_RUNS.set(result, { run, scope });
}

export interface IntegrationRunPlanOptions {
	fallbackContract?: DelegationContract;
	/** Set false only when an equal contract governs a distinct delegation, as with separate chain steps. The ceiling always comes from the resolved contract. */
	shareContractBudget?: boolean;
	returnContract?: string;
	requireEvidence?: boolean;
	placeholderTask?: string;
	scope?: ChildSpanScope;
}

function contractBudget(deps: ModeDeps, contract: ResolvedDelegationContract): Budget | undefined {
	let budgets = CONTRACT_BUDGETS.get(deps);
	if (!budgets) CONTRACT_BUDGETS.set(deps, budgets = new Map());
	if (!budgets.has(contract.id)) budgets.set(contract.id, contract.budget());
	return budgets.get(contract.id);
}

function runLimits(deps: ModeDeps, contract: ResolvedDelegationContract | undefined, shareContractBudget: boolean): AgentRunLimits | undefined {
	if (!contract) return undefined;
	return {
		captureRawOutput: true,
		timeoutMs: contract.timeoutMs,
		contractBudget: shareContractBudget ? contractBudget(deps, contract) : contract.budget(),
		contract: contract.contract,
	};
}

/** Resolve the role contract and bind its Task, limits, cwd, and later Return validation. */
export function integrationRunPlan(
	deps: ModeDeps,
	ref: FlowAgentRefInput,
	task: string,
	options: IntegrationRunPlanOptions = {},
): { plan?: IntegrationRunPlan; error?: FlowError } {
	let contract: ResolvedDelegationContract | undefined;
	const rawContract = resolveDelegationContract(ref, options.fallbackContract);
	if (rawContract) {
		const resolution = ResolvedDelegationContract.resolve(rawContract, deps.policy);
		if (resolution.error) return { error: resolution.error };
		contract = resolution.resolved;
	}
	const renderedTask = contract
		? contract.renderTask(task, options.returnContract, options.requireEvidence)
		: appendReturnRequirements(task, options.returnContract, options.requireEvidence);
	const dispatchRef = Object.freeze(withoutContract(ref));
	const limits = runLimits(deps, contract, options.shareContractBudget !== false);
	if (limits) Object.freeze(limits);
	const scope = options.scope ? Object.freeze({ ...options.scope }) : undefined;
	const state = Object.freeze({
		ref: dispatchRef,
		task: renderedTask,
		placeholderTask: options.placeholderTask ?? task,
		limits,
		contract,
		cwd: resolvedCwd(deps.defaultCwd, ref.cwd),
		...(scope ? { scope } : {}),
	});
	const plan = Object.freeze({ [INTEGRATION_RUN_PLAN]: true as const });
	RUN_PLANS.set(plan, { owner: deps, run: state, dispatched: false });
	return {
		plan,
	};
}

function withoutContract({ contract: _contract, ...ref }: FlowAgentRefInput): Omit<FlowAgentRefInput, "contract"> {
	return ref;
}

/** Whether another role consumes the dispatched result — see ConsumeResultOptions.completion. */
export type IntegrationCompletion = "integrate" | "terminal";

export interface IntegrationDispatchOptions<C extends IntegrationCompletion> {
	completion?: C;
	enforceCompletion?: boolean;
	incompletePolicy?: IncompleteHandoffPolicy;
	payload?: "handoff" | "source";
	noticeLabel?: string;
	scope?: ChildSpanScope;
}

export type IntegrationWaveConsumption = IntegrationDispatchOptions<IntegrationCompletion> & { completion: IntegrationCompletion };

/** Wave policy is explicit so successful Returns cannot escape validation. */
export interface IntegrationWaveOptions extends WaveRunOptions {
	consume: IntegrationWaveConsumption | ((index: number) => IntegrationWaveConsumption);
}

export type IntegrationWaveDispatch =
	| { status: "refused"; error: FlowError; output: ModeOutput }
	| { status: "ok"; results: FlowRunResult[]; consumptions: Array<HandoffConsumption | undefined> };

/** Dispatch admitted plans, then validate every successful Return before exposing the wave. */
export async function dispatchIntegrationWave(
	deps: ModeDeps,
	settle: Settle,
	plans: IntegrationRunPlan[],
	options: IntegrationWaveOptions,
): Promise<IntegrationWaveDispatch> {
	const { consume, ...runOptions } = options;
	const admitted = plans.map((plan) => admittedPlan(deps, plan));
	if (new Set(admitted).size !== admitted.length) throw new TypeError("An IntegrationRunPlan can appear only once in a wave.");
	if (admitted.some((state) => state.dispatched)) throw new TypeError("IntegrationRunPlan has already been dispatched.");
	admitted.forEach((state) => { state.dispatched = true; });
	const states = admitted.map((state) => state.run);
	const wave = await runWave(deps, settle, states, runOptions);
	if (wave.status === "refused") {
		admitted.forEach((state) => { state.dispatched = false; });
		return wave;
	}
	wave.results.forEach((result, index) => bindResult(result, states[index], wave.scopes[index]));
	const indexes = wave.results.flatMap((result, index) => isFailed(result) ? [] : [index]);
	const accepted = deps.handoffs.consumeResults(indexes.map((index) => {
		const policy = typeof consume === "function" ? consume(index) : consume;
		return {
			completion: policy.completion,
			enforceCompletion: policy.enforceCompletion,
			incompletePolicy: policy.incompletePolicy,
			payload: policy.payload,
			noticeLabel: policy.noticeLabel,
			result: wave.results[index],
			plan: states[index],
			scope: policy.scope ?? wave.scopes[index],
		};
	}));
	if (accepted.error) return { status: "refused", error: accepted.error, output: settle.refuse(accepted.error) };
	let consumed = 0;
	return { status: "ok", results: wave.results, consumptions: wave.results.map((result) => isFailed(result) ? undefined : accepted.items[consumed++]) };
}

/** An integrating consumption always mints an addressable dependency key. */
export interface IntegrationHandoff extends HandoffConsumption {
	dependencyKey: string;
}

export type DispatchedHandoff<C extends IntegrationCompletion> = "terminal" extends C ? HandoffConsumption : IntegrationHandoff;

/** A failed Run, a uniform consumption refusal, or a consumed result. */
export type IntegrationDispatch<H extends HandoffConsumption = HandoffConsumption> =
	| { status: "failed"; result: FlowRunResult }
	| { status: "refused"; error: FlowError; output: ModeOutput }
	| { status: "ok"; result: FlowRunResult; handoff: H };

/** Re-consume a validated result through its opaque admitted plan. */
export function consumeIntegrationResult(
	deps: ModeDeps,
	plan: IntegrationRunPlan,
	result: FlowRunResult,
	options: IntegrationDispatchOptions<IntegrationCompletion> = {},
): HandoffConsumption {
	const admitted = admittedRun(deps, plan);
	const dispatched = DISPATCHED_RUNS.get(result);
	if (dispatched?.run !== admitted) throw new TypeError("IntegrationRunPlan did not dispatch this Result.");
	const completion = options.completion ?? "integrate";
	const scope = options.scope ?? dispatched.scope;
	if (completion === "integrate" && !scope?.key) {
		throw new Error("consumeIntegrationResult: integrating consumption requires a keyed span scope.");
	}
	return deps.handoffs.consumeResult({
		plan: admitted,
		result,
		completion,
		enforceCompletion: options.enforceCompletion,
		incompletePolicy: options.incompletePolicy,
		payload: options.payload,
		noticeLabel: options.noticeLabel,
		...(scope ? { scope } : {}),
	});
}

/**
 * Dispatch, track before every return, then consume. Integrating plans require
 * a keyed scope so their handoff can be referenced.
 */
export async function dispatchIntegrationPlan<C extends IntegrationCompletion = "integrate">(
	deps: ModeDeps,
	plan: IntegrationRunPlan,
	settle: Settle,
	options: IntegrationDispatchOptions<C> = {},
): Promise<IntegrationDispatch<DispatchedHandoff<C>>> {
	const state = admittedPlan(deps, plan);
	const admitted = state.run;
	const completion: IntegrationCompletion = options.completion ?? "integrate";
	if (completion === "integrate" && !(options.scope ?? admitted.scope)?.key) {
		throw new Error("dispatchIntegrationPlan: integrating consumption requires a keyed span scope.");
	}
	spendPlan(state);
	const result = await runAgentRef(deps, admitted.ref, admitted.task, settle.mode, settle.nextStep, [...settle.results], { limits: admitted.limits, scope: admitted.scope });
	bindResult(result, admitted, admitted.scope);
	settle.track(result);
	if (isFailed(result)) return { status: "failed", result };
	const handoff = consumeIntegrationResult(deps, plan, result, { ...options, completion });
	if (handoff.error) return { status: "refused", error: handoff.error, output: settle.refuse(handoff.error) };
	return { status: "ok", result, handoff: handoff as DispatchedHandoff<C> };
}
