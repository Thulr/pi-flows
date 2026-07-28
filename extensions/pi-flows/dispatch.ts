/**
 * Fan-out and single-role dispatch: the plumbing every mode handler shares when
 * it puts work through the child-run seam (`ModeDeps.runChild`).
 *
 * Split out of runner.ts so the seam's production adapter and the coordination
 * plumbing around it stay separately reviewable. Handlers keep importing both
 * from runner.ts, which re-exports this module.
 */
import type { ChildSpanScope, DelegationContract, FlowAgentRefInput, FlowBudget, FlowMode, FlowRunResult, ModeDeps, RunChildOptions, SpanStage } from "./types.ts";
import { makeEmptyRunResult } from "./sanitize.ts";

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});

	await Promise.all(workers);
	return results;
}

export interface AgentFanoutItem {
	ref: FlowAgentRefInput;
	task: string;
	placeholderTask?: string;
	limits?: AgentRunLimits;
	/** Per-item span placement: its own key and the units it consumed. The stage comes from the fan-out call. */
	scope?: ChildSpanScope;
}

export interface AgentRunLimits {
	captureRawOutput?: boolean;
	timeoutMs?: number;
	contractBudget?: FlowBudget;
	/** Carried for trace identity only; the enforced ceiling is `contractBudget`. */
	contract?: DelegationContract;
}

function tighterTimeout(flowTimeoutMs: number | undefined, contractTimeoutMs: number | undefined): number | undefined {
	if (contractTimeoutMs === undefined) return flowTimeoutMs;
	const boundedContractTimeout = Math.max(1, Math.floor(contractTimeoutMs));
	return flowTimeoutMs === undefined ? boundedContractTimeout : Math.min(flowTimeoutMs, boundedContractTimeout);
}

/** The standard per-run plumbing (everything except onUpdate), built in exactly one place. */
function childRunOptions(deps: ModeDeps, ref: FlowAgentRefInput, task: string, mode: FlowMode, step: number | undefined, limits: AgentRunLimits = {}, scope?: ChildSpanScope): Omit<RunChildOptions, "onUpdate"> {
	return {
		defaultCwd: deps.defaultCwd,
		agents: deps.discovery.agents,
		agentName: ref.agent,
		task,
		cwd: ref.cwd,
		model: ref.model ?? deps.params.model,
		tier: ref.tier ?? deps.params.tier,
		tools: ref.tools,
		timeoutMs: tighterTimeout(deps.params.timeoutMs, limits.timeoutMs),
		recordContent: deps.params.recordContent,
		redactSecrets: deps.params.redactSecrets,
		captureRawOutput: limits.captureRawOutput,
		contractBudget: limits.contractBudget,
		contract: limits.contract ?? ref.contract,
		delegationReason: typeof deps.params.why === "string" ? deps.params.why : undefined,
		scope,
		step,
		signal: deps.signal,
		budget: deps.budget,
		recordSpan: deps.recordSpan,
		recordEvent: deps.recordEvent,
		makeDetails: deps.makeDetails(mode),
	};
}

/** Merge the fan-out's stage into each item's own key/dependency scope. */
function fanoutScope(stage: SpanStage | undefined, item: AgentFanoutItem, index: number): ChildSpanScope | undefined {
	if (!stage && !item.scope) return undefined;
	return { ...(item.scope ?? {}), ...(stage ? { stage } : {}), key: item.scope?.key ?? (stage ? `${stage.key}.${index + 1}` : undefined) };
}

export async function runAgentFanout(
	deps: ModeDeps,
	mode: FlowMode,
	items: AgentFanoutItem[],
	concurrency: number,
	priorResults: FlowRunResult[],
	statusText: (done: number, total: number) => string,
	stage?: SpanStage,
): Promise<FlowRunResult[]> {
	if (deps.handoffGuard.blockingError) {
		return items.map((item) => makeEmptyRunResult(item.ref.agent, item.placeholderTask ?? item.task, deps.policy, deps.handoffGuard.blockingError));
	}
	const liveResults: FlowRunResult[] = items.map((item) => makeEmptyRunResult(item.ref.agent, item.placeholderTask ?? item.task, deps.policy));
	const completed = new Set<number>();
	const emit = () => {
		deps.onUpdate?.({
			content: [{ type: "text", text: statusText(completed.size, liveResults.length) }],
			details: deps.makeDetails(mode)([...priorResults, ...liveResults]),
		});
	};
	const baseStep = priorResults.length;
	return mapWithConcurrency(items, concurrency, async (item, index) => {
		// One placement per unit. The merged scope is written back onto the item
		// because the item outlives this call: acceptance reads its scope later to
		// place the handoff and artifact events, and a scope only `runChild` saw
		// would leave those events stageless, or unkeyed and linked to nothing.
		item.scope = fanoutScope(stage, item, index);
		const result = await deps.runChild({
			...childRunOptions(deps, item.ref, item.task, mode, baseStep + index + 1, item.limits, item.scope),
			onUpdate: (partial) => {
				const current = partial.details.results[0];
				if (current) liveResults[index] = current;
				emit();
			},
		});
		liveResults[index] = result;
		completed.add(index);
		emit();
		return result;
	});
}

/** How one dispatch differs from the default: its contract-derived limits and where it sits in the span tree. */
export interface AgentRunPlacement {
	limits?: AgentRunLimits;
	scope?: ChildSpanScope;
}

/** Run one agent role with the standard param plumbing, emitting live updates appended to `priorResults`. */
export function runAgentRef(deps: ModeDeps, ref: FlowAgentRefInput, task: string, mode: FlowMode, step: number | undefined, priorResults: FlowRunResult[], placement: AgentRunPlacement = {}): Promise<FlowRunResult> {
	if (deps.handoffGuard.blockingError) return Promise.resolve(makeEmptyRunResult(ref.agent, task, deps.policy, deps.handoffGuard.blockingError));
	return deps.runChild({
		...childRunOptions(deps, ref, task, mode, step, placement.limits ?? {}, placement.scope),
		onUpdate: (partial) => {
			const current = partial.details.results[0];
			deps.onUpdate?.({ content: partial.content, details: deps.makeDetails(mode)([...priorResults, ...(current ? [current] : [])]) });
		},
	});
}
