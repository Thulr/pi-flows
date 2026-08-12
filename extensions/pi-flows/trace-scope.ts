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
	/**
	 * Enclosing stage, so stages nest (a search round holds its generate and
	 * score sub-stages). Carried as the stage itself rather than as a bare key so
	 * an ancestor is always creatable — a key alone could name a stage nothing
	 * had opened, and the span would silently reparent to the root.
	 */
	parent?: SpanStage;
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

/**
 * What reading the exported trace back proved about its shape. Deliberately not
 * folded into {@link FlowTraceHealthStatus}: health is export accounting the
 * writer knows while writing, and a file can be written completely and still
 * not be a span tree — a child parented to a stage nobody wrote, a root that
 * does not reach itself. Two questions, two answers, so neither can be reported
 * as the other.
 */
export interface FlowTraceStructure {
	valid: boolean;
	/** Why it is not a span tree. Absent when it is one. */
	issue?: string;
}

export interface FlowTraceLink {
	health: FlowTraceHealthStatus;
	traceFile: string;
	traceId: string;
	rootSpanId: string;
	context?: FlowTraceContext;
	spans?: FlowTraceHealth;
	error?: string;
	/**
	 * Present only when the caller asked for the export to be read back — today
	 * a strict run, which must not report evidence it never verified. Absent
	 * means unverified, never "verified fine".
	 */
	structure?: FlowTraceStructure;
}

/**
 * Escape a unit key for the comma-joined attribute lists.
 *
 * Graph node ids, workflow phase ids, and worktree task ids are author-supplied
 * and may legitimately contain a comma. Joining those raw would make a healthy
 * run's dependency list read as more keys than it has, so a reader — including
 * the strict gate — would reject evidence that is perfectly sound.
 */
export function encodeUnitKey(key: string): string {
	return key.replaceAll("%", "%25").replaceAll(",", "%2C");
}

/**
 * Escape an author-supplied identifier before it becomes part of a unit key.
 *
 * The framework derives keys by suffixing a dot — `<unit>.handoff`,
 * `<unit>.validation` (a terminal attestation, kept apart from the handoff
 * slot so a later boundary crossing stays uniquely addressable),
 * `<unit>.check`, `<phase>.approval`. A graph node, workflow phase, or worktree
 * task may legitimately be named `source.handoff`, and unescaped it would answer
 * to the same name as node `source`'s handoff event. A dependency on `source`
 * would then resolve to whichever registered first, and the gate would accept
 * the link because both spans advertise the key.
 *
 * Dots the framework writes stay literal; only the author's are escaped, so the
 * two namespaces cannot overlap.
 */
export function encodeAuthorKey(id: string): string {
	return id.replaceAll("%", "%25").replaceAll(".", "%2E");
}

export function emptyTraceHealth(): FlowTraceHealth {
	return { expectedSpans: 0, observedSpans: 0, droppedSpans: 0, redactedSpans: 0, failedExports: 0 };
}

/** The one place the health status is derived, so the sink and the report agree. */
export function traceHealthStatus(health: FlowTraceHealth, rootWritten: boolean): FlowTraceHealthStatus {
	if (!rootWritten || health.observedSpans === 0) return "missing";
	return health.droppedSpans > 0 || health.failedExports > 0 ? "degraded" : "recorded";
}
