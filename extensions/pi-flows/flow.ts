import * as path from "node:path";
import { createHandoffConsumer, type HandoffConsumer } from "./handoff-consumption.ts";
import { runFailed } from "./run.ts";
import { makeTraceSink, strictTraceConfigError, strictTraceError, traceHealthStatus, traceSummaryAttributes, type CriticalPathResolver, type TraceSink } from "./trace.ts";
import {
	Budget,
	DEFAULT_CONCURRENCY,
	MAX_FLOW_DEPTH,
	flowError,
	formatFlowError,
	type AgentScope,
	type CapturePolicy,
	type FlowDetails,
	type FlowDiscovery,
	type FlowError,
	type FlowMode,
	type FlowPreset,
	type ModeDeps,
	type ModeHandler,
	type ModeOutput,
	type ModelRoster,
	type RecordEvent,
	type RunChild,
	type RunMode,
	type Update,
} from "./types.ts";
import { currentFlowDepth, spawnJustificationMissing, validateConcurrency } from "./validate.ts";

/** The live-presence surface a flow reports itself to: started at dispatch, updated as runs settle, and settled on every path the aggregate controls — a handler failure settles it before propagating, and `settle()` settles it in its own finally. */
export interface FlowPresence {
	start: (mode: FlowMode, details: FlowDetails, redactSecrets: boolean, budget?: Budget) => void;
	update: (details: FlowDetails) => void;
	settle: (details: FlowDetails) => void;
}

/**
 * What one flow call resolved to — the single copy of the post-preset params,
 * capture policy, and preset selection. The aggregate constructs it (from the
 * call's own values, or from the {@link FlowPorts.resolvePreset} result) and
 * hands it to every port that needs post-preset state as an argument, so no
 * port has a reason to read resolved state back through a composition-root
 * closure.
 */
export interface ResolvedCall {
	params: Record<string, any>;
	policy: CapturePolicy;
	/** The preset the call named, once resolved. Absent for raw mode calls. */
	preset?: FlowPreset;
}

/** The details-builder shape mode handlers consume. The aggregate constructs exactly one per flow — from the resolved call, via the {@link FlowPorts.makeDetails} factory — and every later consumer receives that one. */
export type DetailsBuilder = ModeDeps["makeDetails"];

/**
 * Everything the composition root supplies to one flow: the call's data, and
 * the gates and collaborators the aggregate walks. Each pre-spawn gate is a
 * supplied predicate/approval object — the aggregate implements none of them —
 * but the ORDER they run in is the aggregate's own (see {@link Flow.admit}),
 * so a future edit cannot reorder two gates without editing the lifecycle
 * itself. Refusal *content* (preset lists, agent catalogs) is view formatting
 * and stays with the supplier; the refusal *rules* — what a refusal does to
 * the trace, what it may never reach — live here.
 */
export interface FlowPorts {
	params: Record<string, any>;
	policy: CapturePolicy;
	cwd: string;
	hasUI: boolean;
	/** Audit label recorded as the approving actor on approvals — an attribution for the trail, not an authenticated identity. */
	approvalActor: string;
	agentScope: AgentScope;
	discovery: FlowDiscovery;
	roster?: ModelRoster;
	signal?: AbortSignal;
	onUpdate?: Update;
	/** The child-run seam: the production subprocess adapter, or a test fake. */
	runChild: RunChild;
	/** Details-builder factory, a pure function of the resolution it is given. The aggregate calls it exactly once, after preset expansion, so every refusal, live row, and handler reads details built from the same resolved state. */
	makeDetails: (call: ResolvedCall) => DetailsBuilder;
	/** Render one answer-without-spawning surface (CONTEXT.md: Spawn gate — "surfaces that answer without spawning sit outside it"). What the answer says — catalogs, effective config — is the supplier's; WHERE it fires in the walk, and that list wins over config, is the aggregate's (see {@link Flow.admit}). Absent when the supplier offers no describe surfaces, in which case describe params fall through the walk. */
	describe?: (surface: "list" | "config") => ModeOutput;
	/** Expand a named preset into ordinary mode params, a tightened capture policy, and the preset itself. Pure: the returned resolution is the only copy. Absent when the call names none. */
	resolvePreset?: () => ResolvedCall | { refusal: ModeOutput };
	/** Which single mode the params activate; the refusal carries the mode-hint content, built with the aggregate-constructed builder. */
	detectMode: (params: Record<string, any>, makeDetails: DetailsBuilder) => { mode: RunMode } | { refusal: ModeOutput };
	/** Project-preset trust over the resolved call. On approval, `record` defers the approval event until the flow's own sink exists. */
	approvePresetTrust: (call: ResolvedCall, mode: RunMode, makeDetails: DetailsBuilder) => Promise<{ refusal: ModeOutput } | { record: (recordEvent?: RecordEvent) => void }>;
	/** Preset-owned run preparation. It shells out in preset-named directories, which is why the aggregate never calls it before the trust gate. `formatResult` is the preset-owned result formatter, constructed here from the same resolution so settle needs no preset state of its own. */
	preparePresetRun: (call: ResolvedCall, mode: RunMode) => { params: Record<string, any>; runDefaultCwd: string; formatResult?: (output: ModeOutput) => void };
	/** Project-agent trust, recording its decision on the trace. Null when approved or not applicable. */
	approveProjectAgents: (params: Record<string, any>, recordEvent: RecordEvent | undefined) => Promise<FlowError | null>;
	/** A human checkpoint (see CONTEXT.md), recorded on the trace like any other approval. Null when it does not gate this moment or was approved. */
	checkpoint: (params: Record<string, any>, mode: RunMode, when: "spawn" | "finalize", preview: string | undefined, recordEvent: RecordEvent | undefined) => Promise<FlowError | null>;
	handlerFor: (mode: RunMode) => ModeHandler | undefined;
	/** Interactive confirmation for mode-level approvals. Absent in headless contexts, where every approval resolves to "required". */
	confirm?: (title: string, message: string) => Promise<boolean>;
	presence: FlowPresence;
	/** Remove progress surfaces superseded by the live row. */
	clearUi?: () => void;
	/** Inject cross-run lessons into the top-level task before the handler runs, under the resolved capture policy. */
	resolveTask?: (params: Record<string, any>, policy: CapturePolicy) => Record<string, any>;
	/** Record a lesson from the final output under the resolved capture policy. The aggregate calls it only when at least one run happened. */
	recordLesson?: (params: Record<string, any>, mode: RunMode, text: string, policy: CapturePolicy) => Promise<void>;
	/** Decorate the root span's summary attributes (preset provenance and outcome). `deliverable` is false when a strict run cannot evidence the verdict it reached; `preset` is the resolved selection the aggregate carried. */
	decorateRootAttributes?: (attributes: Record<string, unknown>, details: FlowDetails, deliverable: boolean, preset?: FlowPreset) => Record<string, unknown>;
	/** The mode table's critical-path resolver, supplied from the composition root where the table is reachable — the aggregate passes it through to trace summaries and never reads mode topology itself. Absent (barebones tests), the metric reports unavailable. */
	criticalPath?: CriticalPathResolver;
	/** Append the durable session entry. The aggregate calls it last, so history can never record an outcome the caller was not told. */
	persist: (details: FlowDetails) => void;
}

/** Everything admission resolved, carried privately through dispatch and settle. */
interface AdmittedState {
	ports: FlowPorts;
	call: ResolvedCall;
	/** The one details builder for this flow, constructed from `call`. */
	makeDetails: DetailsBuilder;
	mode: RunMode;
	concurrency: number;
	runDefaultCwd: string;
	/** Preset-owned result formatting, returned by preparation. Absent when the call named no preset (or the preset formats nothing). */
	formatPresetResult?: (output: ModeOutput) => void;
	traceStrict: boolean;
	sink?: TraceSink;
	handoffs: HandoffConsumer;
	handler: ModeHandler;
	budget?: Budget;
}

/** Admission's three exits: answered without spawning (described), stopped by a gate (refused), or handed the dispatch capability (admitted). */
export type FlowAdmission = { described: ModeOutput } | { refused: ModeOutput } | { admitted: AdmittedFlow };

/**
 * Module-private construction token. flow.ts ships in the published package,
 * so TypeScript visibility alone would not stop a deep import from
 * constructing an AdmittedFlow with structurally matching state and walking
 * past every admission gate. The token's symbol identity cannot be forged
 * from outside this module, so admission stays the only source of the
 * capability at runtime, not just in the type system.
 */
const LIFECYCLE: unique symbol = Symbol("pi-flows.flow.lifecycle");

/**
 * The aggregate root for one bounded delegation (see CONTEXT.md: Flow). Its
 * lifecycle is an explicit progression — **refused → admitted → dispatched →
 * settled** — and the type system enforces the sequence: {@link Flow.admit} is
 * the only source of an {@link AdmittedFlow}, whose `dispatch` is the only
 * source of a {@link DispatchedFlow}, whose `settle` produces the final
 * output. Out-of-order transitions are uncompilable, and each transition
 * spends itself, so a replay is refused at runtime too. A describing call
 * (`list`, `showConfig`) exits at the walk's first gate with an answer
 * instead of entering the progression: a described flow is neither refused
 * nor admitted.
 */
export class Flow {
	/**
	 * Walk the pre-spawn gates in the aggregate's declared order: the describe
	 * surfaces (`list` wins over `showConfig`, and both answer before anything
	 * else — a describing call never resolves a preset and never reaches mode
	 * detection), preset expansion, mode detection, the spawn gate (`why`),
	 * delegation depth, concurrency bounds, preset trust, preset-owned
	 * preparation, strict-trace configuration, then — once the trace sink
	 * exists — project-agent trust, the spawn checkpoint, handler resolution,
	 * and budget construction.
	 *
	 * A refusal after the sink exists finalizes the trace with
	 * `flow.child_count: 0` and the refusal code, so a caller carrying a
	 * traceContext can correlate the refusal to the spans that describe it. A
	 * refusal before the sink exists reaches the caller with whatever trace its
	 * gate supplied (a refused project preset records onto the caller's own
	 * settings) — never with evidence borrowed from a run that did not happen.
	 */
	static async admit(ports: FlowPorts): Promise<FlowAdmission> {
		// Answers-without-spawning sit outside the spawn gate (CONTEXT.md), but
		// "outside" is a position in this walk, not an exemption from it: list,
		// then config, both before preset expansion — a `{ list, preset }` call
		// describes the installed surface without resolving the preset — and
		// before mode detection, so a describe param never counts as a second
		// mode. The supplier renders the answer; the aggregate owns only where,
		// and in which precedence, it fires.
		if (ports.describe) {
			if (ports.params.list) return { described: ports.describe("list") };
			if (ports.params.showConfig) return { described: ports.describe("config") };
		}
		let call: ResolvedCall = { params: ports.params, policy: ports.policy };
		if (ports.resolvePreset) {
			const resolved = ports.resolvePreset();
			if ("refusal" in resolved) return { refused: resolved.refusal };
			call = resolved;
		}
		// The one details builder for this flow, constructed after preset expansion
		// so nothing downstream can hold details built from pre-preset state.
		const makeDetails = ports.makeDetails(call);

		const detected = ports.detectMode(call.params, makeDetails);
		if ("refusal" in detected) return { refused: detected.refusal };
		const mode = detected.mode;
		const refusalOutput = (error: FlowError): ModeOutput => ({
			content: [{ type: "text", text: formatFlowError(error) }],
			details: makeDetails(mode)([], error),
		});
		const refuse = (error: FlowError): FlowAdmission => ({ refused: refusalOutput(error) });

		// Structural friction against reflexive delegation: a spawning call must
		// articulate why isolation beats doing the work in the parent context.
		if (spawnJustificationMissing(call.params.why)) {
			return refuse(flowError(
				"WHY_REQUIRED",
				"Flow call refused: `why` is required for any call that spawns agents.",
				`Mode "${mode}" spawns child agent processes, and the call did not say why delegation beats doing the work directly in the parent context.`,
				"Pass why:'<one sentence naming the explicit user request, the fan-out one context cannot hold, or the author-independent verification this needs>'. If no such reason exists, do the work directly instead of calling flow.",
			));
		}

		const flowDepth = currentFlowDepth();
		if (flowDepth >= MAX_FLOW_DEPTH) {
			return refuse(flowError(
				"FLOW_DEPTH_EXCEEDED",
				`Flow delegation depth limit reached (${flowDepth}/${MAX_FLOW_DEPTH}).`,
				"This flow agent is itself running inside a flow subprocess; spawning more children would risk runaway nested delegation.",
				"Flatten the delegation — do the work in this agent, or restructure so deep nesting is not required. The cap is intentional harness discipline.",
			));
		}

		// Fan-out bounding is aggregate policy: validated and resolved once here
		// for every mode, so no handler re-derives it and no new mode can forget it.
		const concurrencyError = validateConcurrency(call.params.concurrency);
		if (concurrencyError) return refuse(concurrencyError);
		const concurrency = call.params.concurrency ?? DEFAULT_CONCURRENCY;

		const trust = await ports.approvePresetTrust(call, mode, makeDetails);
		if ("refusal" in trust) return { refused: trust.refusal };
		const prepared = ports.preparePresetRun(call, mode);
		call = { ...call, params: prepared.params };

		// Trace evidence as a gate is opt-in. Ordinary user flows stay
		// best-effort; an eval or release run asks for strict, and then a run
		// that cannot prove what it did is a failed run, not a quiet pass.
		const traceStrict = call.params.traceStrict ?? /^(1|true|yes)$/i.test(process.env.PI_FLOWS_TRACE_STRICT?.trim() ?? "");
		const traceFileParam = call.params.traceFile ?? process.env.PI_FLOWS_TRACE_FILE;
		const traceConfigError = strictTraceConfigError(traceStrict, traceFileParam);
		if (traceConfigError) return refuse(traceConfigError);

		// A strict run asks the sink to read its own export back at finalize: it is
		// about to stake a verdict on this evidence, so it is the one caller that
		// must not take write-time accounting as proof the file is a span tree.
		const sink = traceFileParam ? makeTraceSink(path.resolve(ports.cwd, traceFileParam), mode, call.policy, { traceLabel: call.params.traceLabel, context: call.params.traceContext, verify: traceStrict }) : undefined;
		trust.record(sink?.event);
		const handoffs = createHandoffConsumer({ params: call.params, mode, policy: call.policy, defaultCwd: prepared.runDefaultCwd, recordEvent: sink?.event });
		// A refusal from here on has a trace of its own; without the link a caller
		// carrying a traceContext cannot correlate the refusal to its spans.
		const refuseTraced = async (error: FlowError): Promise<FlowAdmission> => {
			const refused = refusalOutput(error);
			const link = await sink?.finalize({ ok: false }, { "flow.child_count": 0, "flow.refused_before_spawn": error.code });
			if (link) refused.details.trace = link;
			return { refused };
		};

		const projectAgentsError = await ports.approveProjectAgents(call.params, sink?.event);
		if (projectAgentsError) return refuseTraced(projectAgentsError);

		const spawnCheckpointError = await ports.checkpoint(call.params, mode, "spawn", undefined, sink?.event);
		if (spawnCheckpointError) return refuseTraced(spawnCheckpointError);

		const handler = ports.handlerFor(mode);
		if (!handler) return refuseTraced(flowError("INVALID_MODE", "Unhandled flow mode.", "Execution fell through all mode handlers.", "Open a bug with the tool parameters that triggered this state."));

		// Cost ceiling: bounds the one "uncontrolled recursion" dimension that
		// iteration and time caps miss. Undefined when the call configured none.
		const budget = Budget.forFlow(call.params);
		return { admitted: AdmittedFlow.fromAdmission(LIFECYCLE, { ports, call, makeDetails, mode, concurrency, runDefaultCwd: prepared.runDefaultCwd, formatPresetResult: prepared.formatResult, traceStrict, sink, handoffs, handler, budget }) };
	}
}

/**
 * The capability admission returns: the only way to dispatch a flow, and
 * therefore proof that every pre-spawn gate passed in order. Spends itself on
 * use — a replayed dispatch is refused rather than double-spawning.
 */
export class AdmittedFlow {
	#state: AdmittedState | undefined;
	/** The live details shared with the presence surface, kept for the settle-on-failure path. */
	#liveDetails: FlowDetails;

	private constructor(key: typeof LIFECYCLE, state: AdmittedState) {
		// TS `private` is erased at runtime; the key keeps construction
		// runtime-private, so no capability exists without admission passing.
		if (key !== LIFECYCLE) throw new TypeError("An AdmittedFlow is produced only by Flow.admit: the dispatch capability cannot be constructed directly.");
		this.#state = state;
		this.#liveDetails = state.makeDetails(state.mode)([]);
		// Freezing blocks own-property shadowing of `dispatch`; the #state latch is unaffected.
		Object.freeze(this);
	}

	/** Only {@link Flow.admit} holds the token, so only admission reaches the private constructor. */
	static fromAdmission(key: typeof LIFECYCLE, state: AdmittedState): AdmittedFlow {
		return new AdmittedFlow(key, state);
	}

	/**
	 * Run the mode handler. The flow becomes live (presence) before the handler
	 * runs, cross-run lessons are injected into the task at this seam so every
	 * mode gets them without per-handler wiring, and a handler failure settles
	 * the flow's presence before it propagates — a dead flow never lingers in
	 * the live-flow registry.
	 */
	async dispatch(): Promise<DispatchedFlow> {
		const state = this.#state;
		if (!state) throw new Error("A flow dispatches once: this admission capability is already spent.");
		this.#state = undefined;
		const { ports, mode } = state;
		const { policy } = state.call;

		ports.presence.start(mode, this.#liveDetails, policy.redactSecrets, state.budget);
		ports.clearUi?.();
		const liveUpdate: Update = (partial) => {
			this.#liveDetails = partial.details;
			ports.presence.update(this.#liveDetails);
			ports.onUpdate?.(partial);
		};
		const paramsForRun = ports.resolveTask ? ports.resolveTask(state.call.params, policy) : state.call.params;

		try {
			const output = await state.handler({
				params: paramsForRun,
				discovery: ports.discovery,
				policy,
				handoffs: state.handoffs,
				agentScope: ports.agentScope,
				defaultCwd: state.runDefaultCwd,
				roster: ports.roster,
				signal: ports.signal,
				onUpdate: liveUpdate,
				budget: state.budget,
				recordSpan: state.sink?.record,
				recordEvent: state.sink?.event,
				requestApproval: async (title, message) => {
					// Interactivity requires both a UI and a confirm port: recording
					// `hasUI` alone could claim an approval was interactive when no
					// confirm function existed to ask it.
					const confirm = ports.hasUI ? ports.confirm : undefined;
					const interactive = confirm !== undefined;
					const decision = confirm === undefined ? "required" : (await confirm(title, message) ? "approved" : "denied");
					state.sink?.event({
						kind: "approval",
						name: "mode.approval",
						ok: decision === "approved",
						attributes: { "flow.approval.decision": decision, "flow.approval.actor": ports.approvalActor, "flow.approval.interactive": interactive },
					});
					return decision;
				},
				approvalActor: ports.approvalActor,
				makeDetails: state.makeDetails,
				runChild: ports.runChild,
				concurrency: state.concurrency,
			});
			return DispatchedFlow.fromDispatch(LIFECYCLE, state, output, (details) => { this.#liveDetails = details; });
		} catch (error) {
			// `finalize` is the only writer of stage spans and the root, so a
			// thrown handler must still reach it: without this the export is an
			// unrootable fragment — child spans parented to stage ids never
			// written, no root, no expectation for health to count against.
			// ok:false, summarized from the last live details the handler shared;
			// settle's success-path finalize is untouched because a throwing
			// handler never constructs the DispatchedFlow that would run it.
			try {
				await state.sink?.finalize({ ok: false }, traceSummaryAttributes(mode, state.call.params, { content: [], details: this.#liveDetails }, ports.criticalPath));
			} catch {
				// Deliberate: the handler's error is the flow's failure, and a
				// failing sink must not replace it on the way out.
			} finally {
				ports.presence.settle(this.#liveDetails);
			}
			throw error;
		}
	}
}

/**
 * A flow whose handler has returned: the only thing that can settle. The
 * settle sequence is the aggregate's second ordered walk — blocking handoffs,
 * preset formatting, the reflexion lesson, the finalize checkpoint, trace
 * finalization, the strict-trace refusal, and durable persistence last, so
 * the history cannot record a run as ok that the caller was told failed.
 */
export class DispatchedFlow {
	#state: AdmittedState | undefined;
	readonly #output: ModeOutput;
	readonly #shareLiveDetails: (details: FlowDetails) => void;

	private constructor(key: typeof LIFECYCLE, state: AdmittedState, output: ModeOutput, shareLiveDetails: (details: FlowDetails) => void) {
		// Same runtime privacy as AdmittedFlow: TS `private` erases, the key does not.
		if (key !== LIFECYCLE) throw new TypeError("A DispatchedFlow is produced only by dispatch: the settle capability cannot be constructed directly.");
		this.#state = state;
		this.#output = output;
		this.#shareLiveDetails = shareLiveDetails;
		// Freezing blocks own-property shadowing of `settle`; the #state latch is unaffected.
		Object.freeze(this);
	}

	/** Only {@link AdmittedFlow.dispatch} holds the token, so only a dispatch reaches the private constructor. */
	static fromDispatch(key: typeof LIFECYCLE, state: AdmittedState, output: ModeOutput, shareLiveDetails: (details: FlowDetails) => void): DispatchedFlow {
		return new DispatchedFlow(key, state, output, shareLiveDetails);
	}

	async settle(): Promise<ModeOutput> {
		const state = this.#state;
		if (!state) throw new Error("A flow settles once: this dispatch is already settled.");
		this.#state = undefined;
		const { ports, mode } = state;
		const { params, policy } = state.call;
		const output = this.#output;
		let liveDetails = output.details;
		const shareLive = (details: FlowDetails) => {
			liveDetails = details;
			this.#shareLiveDetails(details);
			ports.presence.update(details);
		};
		try {
			if (state.handoffs.blockingError && !output.details.error) {
				output.details.error = state.handoffs.blockingError;
				output.content = [{ type: "text", text: formatFlowError(state.handoffs.blockingError) }];
			}
			state.formatPresetResult?.(output);
			// A lesson is recorded only when at least one run happened — pre-spawn
			// refusals (validation errors, approvals) are not lessons about the task.
			if (output.details.results.length > 0) {
				await ports.recordLesson?.(params, mode, output.content[0]?.text ?? "", policy);
			}
			const finalCheckpointError = await ports.checkpoint(params, mode, "finalize", output.content[0]?.text, state.sink?.event);
			if (finalCheckpointError) {
				output.details.error = finalCheckpointError;
				output.content = [{ type: "text", text: formatFlowError(finalCheckpointError) }];
			}
			shareLive(output.details);
			if (state.sink) {
				const ok = !output.details.error && !output.details.results.some(runFailed);
				// A strict run whose own evidence is degraded is about to be refused,
				// so the root must not claim a verified outcome it never delivered.
				output.details.trace = await state.sink.finalize({ ok }, (health) => {
					const attributes = traceSummaryAttributes(mode, params, output, ports.criticalPath);
					const deliverable = !state.traceStrict || traceHealthStatus(health, true) === "recorded";
					return ports.decorateRootAttributes ? ports.decorateRootAttributes(attributes, output.details, deliverable, state.call.preset) : attributes;
				});
			}
			// Strict runs refuse to report a result they cannot evidence. An
			// already-failed run keeps its own error: the incomplete trace is a
			// second problem, not a better explanation of the first.
			const traceError = strictTraceError(output.details.trace, state.traceStrict);
			if (traceError && !output.details.error) {
				output.details.error = traceError;
				output.content = [{ type: "text", text: `${formatFlowError(traceError)}\n\n${output.content[0]?.text ?? ""}`.trimEnd() }];
				shareLive(output.details);
			}
			// Persisted last, so the durable history cannot record a run as `ok`
			// that the caller was told failed — and so it carries the trace link.
			ports.persist(output.details);
			return output;
		} finally {
			ports.presence.settle(liveDetails);
		}
	}
}

// Frozen against method substitution, like IntegrationValidation: a patched
// prototype must not be able to turn a spent transition back into a live one.
Object.freeze(Flow.prototype);
Object.freeze(Flow);
Object.freeze(AdmittedFlow.prototype);
Object.freeze(AdmittedFlow);
Object.freeze(DispatchedFlow.prototype);
Object.freeze(DispatchedFlow);
