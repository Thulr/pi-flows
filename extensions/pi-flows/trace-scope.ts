/**
 * The coordination-trace vocabulary: where a unit of work sits in the span tree,
 * what non-span coordination facts a mode can attribute, and how complete the
 * export turned out to be.
 *
 * This module is deliberately dependency-free so `types.ts` can re-export it
 * without an import cycle. Nothing here executes; it is the contract that
 * `trace-sink.ts` implements and that mode handlers describe their topology in.
 */

/**
 * A grouping span. Fan-outs, waves, rounds, iterations, and workflow phases are
 * stages: without them every child hangs directly off the root and a reader
 * cannot tell which critic belonged to which revision.
 */
export interface SpanStage {
	/** Stable key for the stage inside one flow call, e.g. `wave-2`. */
	key: string;
	/** Human-readable stage name; becomes the span name suffix. */
	name: string;
	/** Enclosing stage key, so stages nest (search round -> generate/score). */
	parent?: string;
}

/** Where one child run (or coordination event) belongs in the span tree. */
export interface ChildSpanScope {
	/** Stable key for this unit; other units reference it from `dependsOn`. */
	key?: string;
	/** Enclosing stage. The span is parented to the stage instead of the root. */
	stage?: SpanStage;
	/**
	 * Keys of units whose output this unit consumed. Recorded as dependency
	 * links rather than parentage: a graph node that reads another node's output
	 * was not *spawned* by it, so flattening the two into a parent/child pair
	 * would misreport the topology.
	 */
	dependsOn?: string[];
}

/**
 * The coordination facts that are not themselves child runs. Each becomes an
 * attributable zero-duration span so a failure can be pinned to the boundary it
 * crossed rather than to "the flow".
 */
export type CoordinationEventKind =
	| "artifact"
	| "state"
	| "retry"
	| "approval"
	| "budget"
	| "validation"
	| "handoff";

export interface CoordinationEvent {
	kind: CoordinationEventKind;
	/** Dotted event name, e.g. `workflow.phase.completed`. */
	name: string;
	scope?: ChildSpanScope;
	attributes?: Record<string, unknown>;
	/** Defaults to true. False records the event span with ERROR status. */
	ok?: boolean;
}

/** Records one coordination boundary crossing. See makeTraceSink. */
export type RecordEvent = (event: CoordinationEvent) => void;

/**
 * Stable identity shared by an eval row and the runtime trace that produced it.
 * Identifiers only — never task content.
 */
export interface FlowTraceContext {
	runId: string;
	caseId: string;
	trialId: string;
	trialIndex?: number;
	arm?: string;
	attempt?: number;
}

/**
 * Expected-vs-observed span accounting for one flow call. `expectedSpans` is
 * what the run tried to export; `observedSpans` is what reached the file. A gap
 * is evidence about the exporter, not about the agent — which is exactly why it
 * is reported separately from execution success.
 */
export interface FlowTraceHealth {
	expectedSpans: number;
	observedSpans: number;
	droppedSpans: number;
	/** Spans whose content was withheld or rewritten by the capture policy. */
	redactedSpans: number;
	failedExports: number;
}

/**
 * `recorded` — every expected span reached the file.
 * `degraded` — the trace exists but is provably incomplete.
 * `missing` — no usable trace was written.
 */
export type FlowTraceHealthStatus = "recorded" | "degraded" | "missing";

export interface FlowTraceLink {
	health: FlowTraceHealthStatus;
	traceFile: string;
	traceId: string;
	rootSpanId: string;
	context?: FlowTraceContext;
	spans?: FlowTraceHealth;
	error?: string;
}

export function emptyTraceHealth(): FlowTraceHealth {
	return { expectedSpans: 0, observedSpans: 0, droppedSpans: 0, redactedSpans: 0, failedExports: 0 };
}

/** The one place the health status is derived, so the sink and the report agree. */
export function traceHealthStatus(health: FlowTraceHealth, rootWritten: boolean): FlowTraceHealthStatus {
	if (!rootWritten || health.observedSpans === 0) return "missing";
	return health.droppedSpans > 0 || health.failedExports > 0 ? "degraded" : "recorded";
}
