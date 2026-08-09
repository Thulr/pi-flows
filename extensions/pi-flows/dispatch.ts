/**
 * Fan-out and single-role dispatch: the plumbing every mode handler shares when
 * it puts work through the child-run seam (`ModeDeps.runChild`).
 *
 * Split out of runner.ts so the seam's production adapter and the coordination
 * plumbing around it stay separately reviewable. Handlers keep importing both
 * from runner.ts, which re-exports this module.
 */
import type { Budget, ChildSpanScope, DelegationContract, FlowAgentRefInput, FlowError, FlowMode, FlowRunResult, ModeDeps, ModeOutput, RunChildOptions, SpanStage } from "./types.ts";
import { makeEmptyRunResult, sanitizeText } from "./sanitize.ts";
import type { Settle } from "./settle.ts";
import { validateSharedWriteCwd } from "./validate.ts";

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
	contractBudget?: Budget;
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
		role: ref.role,
		task,
		cwd: ref.cwd,
		model: ref.model ?? deps.params.model,
		tier: ref.tier ?? deps.params.tier,
		// The role's own level and the flow-wide fallback travel separately rather
		// than being collapsed here. Filling one from the other loses which was
		// stated, and the resolver needs that: a role's `model:"id:high"` suffix is
		// a role-level statement and must outrank a flow-level `thinking`, which
		// the documentation calls a fallback.
		thinking: ref.thinking,
		flowThinking: deps.params.thinking,
		roster: deps.roster,
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

function emptyRun(ref: FlowAgentRefInput, task: string, deps: ModeDeps, error?: FlowRunResult["error"]): FlowRunResult {
	const result = makeEmptyRunResult(ref.agent, task, deps.policy, error);
	result.role = ref.role === undefined ? undefined : sanitizeText(ref.role, deps.policy, 4 * 1024);
	return result;
}

/**
 * The bare concurrent fan-out. Superseded by {@link runWave} as the
 * handler-facing entry point: this neither enforces the shared-write guard nor
 * feeds the settle, so every direct caller re-sequences both by hand — and a
 * new fan-out that forgets the guard call loses it silently. It stays exported
 * unchanged until the mode sweep migrates the remaining direct callers;
 * runWave wraps it, so there is still exactly one fan-out loop.
 */
export async function runAgentFanout(
	deps: ModeDeps,
	mode: FlowMode,
	items: AgentFanoutItem[],
	concurrency: number,
	priorResults: FlowRunResult[],
	statusText: (settled: number, total: number) => string,
	stage?: SpanStage,
): Promise<FlowRunResult[]> {
	if (deps.handoffs.blockingError) {
		return items.map((item) => emptyRun(item.ref, item.placeholderTask ?? item.task, deps, deps.handoffs.blockingError));
	}
	const liveResults: FlowRunResult[] = items.map((item) => emptyRun(item.ref, item.placeholderTask ?? item.task, deps));
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

export interface WaveRunOptions {
	/** Board text per settled count, exactly as the fan-out emits it. */
	statusText: (settled: number, total: number) => string;
	stage?: SpanStage;
}

/** How one wave settled: refused by the gate with zero children spawned, or run with its results (already tracked). */
export type WaveDispatch =
	| { status: "refused"; error: FlowError; output: ModeOutput }
	| { status: "ok"; results: FlowRunResult[] };

/**
 * Dispatch one concurrent wave through the gate that governs it. The
 * shared-write guard runs here, over the wave's own refs, BEFORE any spawn —
 * the fan-out is the one place that always holds the wave, the discovery, the
 * cwd, and the concurrency, so a new fan-out mode cannot forget the guard and
 * no caller fabricates a wave to feed it. There is deliberately no opt-out
 * parameter: `allowSharedWriteCwd` is the gate's own input, read from the
 * call's params like every other gate input.
 *
 * A refusal returns before anything spawns, shaped by the settle so the runs
 * that already ran stay visible. Otherwise the wave runs exactly as
 * {@link runAgentFanout} runs it — blocking-error pre-check, live emits over
 * the settle's prior results plus the wave's own, per-item scope merge, steps
 * continuing from the settle — and the whole wave is tracked here after it
 * settles. Callers must not track the returned results again.
 */
export async function runWave(deps: ModeDeps, settle: Settle, items: AgentFanoutItem[], options: WaveRunOptions): Promise<WaveDispatch> {
	const error = validateSharedWriteCwd(deps.discovery, deps.defaultCwd, items.map((item) => item.ref), deps.params.allowSharedWriteCwd, deps.concurrency);
	if (error) return { status: "refused", error, output: settle.refuse(error) };
	const results = await runAgentFanout(deps, settle.mode, items, deps.concurrency, [...settle.results], options.statusText, options.stage);
	settle.track(...results);
	return { status: "ok", results };
}

/** How one dispatch differs from the default: its contract-derived limits and where it sits in the span tree. */
export interface AgentRunPlacement {
	limits?: AgentRunLimits;
	scope?: ChildSpanScope;
}

/** Run one agent role with the standard param plumbing, emitting live updates appended to `priorResults`. */
export function runAgentRef(deps: ModeDeps, ref: FlowAgentRefInput, task: string, mode: FlowMode, step: number | undefined, priorResults: FlowRunResult[], placement: AgentRunPlacement = {}): Promise<FlowRunResult> {
	if (deps.handoffs.blockingError) return Promise.resolve(emptyRun(ref, task, deps, deps.handoffs.blockingError));
	return deps.runChild({
		...childRunOptions(deps, ref, task, mode, step, placement.limits ?? {}, placement.scope),
		onUpdate: (partial) => {
			const current = partial.details.results[0];
			deps.onUpdate?.({ content: partial.content, details: deps.makeDetails(mode)([...priorResults, ...(current ? [current] : [])]) });
		},
	});
}
