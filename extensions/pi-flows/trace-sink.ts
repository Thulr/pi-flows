import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
	CapturePolicy,
	ChildSpanScope,
	CoordinationEvent,
	FlowMode,
	FlowTraceContext,
	FlowTraceHealth,
	FlowTraceLink,
	RecordEvent,
	RecordSpan,
	SpanStage,
} from "./types.ts";
import { emptyTraceHealth, encodeUnitKey, traceHealthStatus } from "./trace-scope.ts";
import { capModelVisibleText, isFailed, resultText, safePath, sanitizeText } from "./sanitize.ts";
import { stableTraceIds } from "./trace-identity.mjs";

export { stableTraceIds } from "./trace-identity.mjs";

export interface TraceSink {
	record: RecordSpan;
	event: RecordEvent;
	finalize: (status: { ok: boolean }, attributes?: Record<string, unknown>) => Promise<FlowTraceLink>;
}

function storedTraceContext(context: FlowTraceContext, policy: CapturePolicy): FlowTraceContext {
	const identifier = (value: string) => sanitizeText(value, { ...policy, recordContent: true }, 256);
	return {
		runId: identifier(context.runId),
		caseId: identifier(context.caseId),
		trialId: identifier(context.trialId),
		...(context.trialIndex === undefined ? {} : { trialIndex: context.trialIndex }),
		...(context.arm === undefined ? {} : { arm: identifier(context.arm) }),
		...(context.attempt === undefined ? {} : { attempt: context.attempt }),
	};
}

function traceContextAttributes(context?: FlowTraceContext): Record<string, unknown> {
	if (!context) return {};
	return {
		"flow.run_id": context.runId,
		"flow.case_id": context.caseId,
		"flow.trial_id": context.trialId,
		"flow.trial_index": context.trialIndex,
		"flow.arm": context.arm,
		"flow.attempt": context.attempt,
	};
}

interface StageRecord {
	spanId: string;
	name: string;
	parentSpanId: string;
	startMs: number;
	endMs: number;
	spans: number;
}

const spanId = () => randomUUID().replace(/-/g, "");

/** Bound on any one span attribute. Attributes are identifiers and structure, not payloads. */
const ATTRIBUTE_CAP = 1024;

/**
 * Dependency lists get their own, larger bound. They are machine identifiers the
 * report parses to check the attribution chain, and a truncated list would read
 * as a broken one — a valid run failing the gate because its ids were long.
 */
const DEPENDENCY_CAP = 8 * 1024;
const DEPENDENCY_ATTRIBUTES = new Set(["flow.depends_on", "flow.depends_on_span_ids"]);

/**
 * Emit redacted OpenInference-shaped spans to JSONL: a root span, one span per
 * child run, lazily-created stage spans that keep waves/rounds/phases from
 * flattening into the root, and zero-duration coordination-event spans for the
 * boundaries that are not child runs at all (artifacts, state transitions,
 * retries, approvals, budget changes, validation results, handoffs).
 *
 * Export is best-effort by default and never throws into a flow. What it does
 * do is *account* for itself: every span it tries to write is counted, so the
 * returned link can say how much evidence actually landed and a strict caller
 * can refuse to treat an incomplete trace as proof.
 */
export function makeTraceSink(traceFile: string, mode: FlowMode, policy: CapturePolicy, traceLabel?: string, context?: FlowTraceContext): TraceSink {
	const ids = context ? stableTraceIds(context, mode) : { traceId: randomUUID().replace(/-/g, ""), rootSpanId: spanId() };
	const { traceId, rootSpanId } = ids;
	const storedContext = context ? storedTraceContext(context, policy) : undefined;
	const storedTraceLabel = traceLabel ? sanitizeText(traceLabel, { ...policy, recordContent: true }, 256) : undefined;
	const rootStart = Date.now();
	const health: FlowTraceHealth = emptyTraceHealth();
	const stages = new Map<string, StageRecord>();
	// Unit keys and stage keys live in separate namespaces. They collide in
	// practice — a workflow phase is both a stage and the child that runs it — and
	// one shared map let the child's span id overwrite its own stage's.
	const spanIdByKey = new Map<string, string>();
	const stageSpanIdByKey = new Map<string, string>();
	const pending: Array<Promise<void>> = [];
	let writeError: string | undefined;

	const storedLabel = (value: string) => sanitizeText(value, { ...policy, recordContent: true }, ATTRIBUTE_CAP);

	/**
	 * Redact and cap every string an attribute map carries.
	 *
	 * Attributes reach the sink from mode handlers, and several are operator- or
	 * repo-supplied: an approval actor from PI_FLOWS_APPROVAL_ACTOR, a workflow
	 * phase id, a graph node id, a branch name. They are identity rather than
	 * content, so `recordContent:false` does not withhold them — but there is no
	 * reason a configured actor of `token=…`, or a home path, should reach the
	 * file verbatim when the same string is redacted everywhere else.
	 */
	const storedAttributes = (attributes: Record<string, unknown> | undefined): Record<string, unknown> => {
		if (!attributes) return {};
		const stored: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(attributes)) {
			stored[key] = typeof value === "string"
				? sanitizeText(value, { ...policy, recordContent: true }, DEPENDENCY_ATTRIBUTES.has(key) ? DEPENDENCY_CAP : ATTRIBUTE_CAP)
				: value;
		}
		return stored;
	};

	const append = (obj: unknown): Promise<void> => {
		health.expectedSpans += 1;
		const write = withFileMutationQueue(traceFile, async () => {
			try {
				await fs.appendFile(traceFile, `${JSON.stringify(obj)}\n`, "utf8");
				health.observedSpans += 1;
			} catch (error) {
				health.failedExports += 1;
				health.droppedSpans += 1;
				writeError ??= error instanceof Error ? error.message : String(error);
			}
		});
		pending.push(write);
		return write;
	};

	/**
	 * Stage spans are created on first use and closed at finalize over the bounds
	 * of what ran inside them. Ancestors are created with their descendant, so a
	 * nested stage can never end up reparented to the root just because nothing
	 * had opened its parent yet.
	 */
	const ensureStage = (stage: SpanStage, startMs: number, endMs: number, counted = true): string => {
		const existing = stages.get(stage.key);
		if (existing) {
			existing.startMs = Math.min(existing.startMs, startMs);
			existing.endMs = Math.max(existing.endMs, endMs);
			if (counted) existing.spans += 1;
			// Widen ancestors too. A scorer that finishes after its round stage was
			// last touched would otherwise leave the round ending before its own
			// descendant — a span tree that cannot be true.
			if (stage.parent) ensureStage(stage.parent, startMs, endMs, false);
			return existing.spanId;
		}
		// `spans` counts what was placed directly in a stage, so an ancestor created
		// on a descendant's behalf is not credited with that descendant's placement.
		const parentSpanId = stage.parent ? ensureStage(stage.parent, startMs, endMs, false) : rootSpanId;
		const record: StageRecord = { spanId: spanId(), name: stage.name, parentSpanId, startMs, endMs, spans: counted ? 1 : 0 };
		stages.set(stage.key, record);
		stageSpanIdByKey.set(stage.key, record.spanId);
		return record.spanId;
	};

	const placement = (scope: ChildSpanScope | undefined, startMs: number, endMs: number) => {
		const parentSpanId = scope?.stage ? ensureStage(scope.stage, startMs, endMs) : rootSpanId;
		const dependsOn = scope?.dependsOn ?? [];
		const attributes: Record<string, unknown> = {};
		if (dependsOn.length) {
			// The authoritative count. A reader must not have to infer it from a
			// string that any cap or transform could have shortened.
			attributes["flow.depends_on_count"] = dependsOn.length;
			attributes["flow.depends_on"] = dependsOn.map(encodeUnitKey).join(",");
			// A dependency may name a unit or a whole stage ("this debrief consumed
			// round 2"), so both namespaces are searched, units first.
			const resolved = dependsOn.map((key) => spanIdByKey.get(key) ?? stageSpanIdByKey.get(key)).filter((value): value is string => Boolean(value));
			if (resolved.length) attributes["flow.depends_on_span_ids"] = resolved.join(",");
		}
		if (scope?.key) attributes["flow.unit_key"] = encodeUnitKey(scope.key);
		return { parentSpanId, attributes };
	};

	return {
		record(result, span) {
			const end = Date.now();
			const start = result.durationMs !== undefined ? end - result.durationMs : end;
			const { parentSpanId, attributes: placementAttributes } = placement(span?.scope, start, end);
			const id = spanId();
			if (span?.scope?.key) spanIdByKey.set(span.scope.key, id);
			const attributes: Record<string, unknown> = {
				"openinference.span.kind": "AGENT",
				"flow.span_role": "child",
				"flow.mode": mode,
				"flow.trace_label": storedTraceLabel,
				"flow.agent": result.agent,
				"flow.agent_source": result.agentSource,
				"flow.step": result.step,
				"flow.cost_usd": result.usage.cost,
				"flow.turns": result.usage.turns,
				"flow.duration_ms": result.durationMs,
				"flow.stop_reason": result.stopReason,
				"flow.error_code": result.error?.code,
				...storedAttributes(placementAttributes),
				...storedAttributes(span?.attributes),
				...traceContextAttributes(storedContext),
				"llm.model_name": result.model,
				"llm.token_count.prompt": result.usage.input,
				"llm.token_count.completion": result.usage.output,
				"llm.token_count.total": result.usage.contextTokens || result.usage.input + result.usage.output,
			};
			// A span that omits or rewrites content is still a usable span, but it is
			// not full evidence — trace health reports it so nobody mistakes a
			// redacted trace for a complete one.
			if (policy.recordContent) {
				const task = sanitizeText(result.task, policy);
				const output = sanitizeText(capModelVisibleText(resultText(result)), policy);
				attributes["input.value"] = task;
				attributes["output.value"] = output;
				if (task !== result.task || output !== capModelVisibleText(resultText(result))) health.redactedSpans += 1;
			} else {
				health.redactedSpans += 1;
			}
			attributes["flow.content_recorded"] = policy.recordContent;
			void append({
				trace_id: traceId,
				span_id: id,
				parent_span_id: parentSpanId,
				name: `flow.${mode}.${result.agent}`,
				start_time_unix_ms: start,
				end_time_unix_ms: end,
				status: { code: isFailed(result) ? "ERROR" : "OK", message: result.error?.code },
				attributes,
			});
		},
		event(coordination) {
			const now = Date.now();
			const { parentSpanId, attributes: placementAttributes } = placement(coordination.scope, now, now);
			const id = spanId();
			// Events are linkable units too: an approval is the thing a gated phase
			// actually depends on, and it spawns no child, so without registering its
			// key that edge resolves to nothing. A child's key always wins, though —
			// an event must never quietly rebind a name a run already answers to.
			const key = coordination.scope?.key;
			if (key && !spanIdByKey.has(key)) spanIdByKey.set(key, id);
			void append({
				trace_id: traceId,
				span_id: id,
				parent_span_id: parentSpanId,
				name: `flow.${mode}.event.${coordination.name}`,
				start_time_unix_ms: now,
				end_time_unix_ms: now,
				status: { code: coordination.ok === false ? "ERROR" : "OK" },
				attributes: {
					"openinference.span.kind": "CHAIN",
					"flow.span_role": "event",
					"flow.event_kind": coordination.kind,
					"flow.event_name": coordination.name,
					"flow.mode": mode,
					"flow.trace_label": storedTraceLabel,
					...storedAttributes(placementAttributes),
					...storedAttributes(coordination.attributes),
					...traceContextAttributes(storedContext),
				},
			});
		},
		async finalize(status, attributes = {}) {
			// Children and events are appended without awaiting so tracing never
			// paces execution; the whole backlog is drained here so the counters
			// below describe what actually reached the file.
			await Promise.all(pending);
			for (const [key, stage] of stages) {
				void append({
					trace_id: traceId,
					span_id: stage.spanId,
					parent_span_id: stage.parentSpanId,
					name: `flow.${mode}.stage.${storedLabel(stage.name)}`,
					start_time_unix_ms: stage.startMs,
					end_time_unix_ms: stage.endMs,
					status: { code: "OK" },
					attributes: {
						"openinference.span.kind": "CHAIN",
						"flow.span_role": "stage",
						"flow.mode": mode,
						"flow.trace_label": storedTraceLabel,
						"flow.stage_key": storedLabel(encodeUnitKey(key)),
						"flow.stage_span_count": stage.spans,
						...traceContextAttributes(storedContext),
					},
				});
			}
			await Promise.all(pending);
			const end = Date.now();
			// The root counts itself: it is the last span written, so "expected"
			// covers everything including this row.
			const expectedSpans = health.expectedSpans + 1;
			const observedSpans = health.observedSpans + 1;
			const rootAppend = append({
				trace_id: traceId,
				span_id: rootSpanId,
				parent_span_id: null,
				name: `flow.${mode}`,
				start_time_unix_ms: rootStart,
				end_time_unix_ms: end,
				status: { code: status.ok ? "OK" : "ERROR" },
				attributes: {
					"openinference.span.kind": "CHAIN",
					"flow.span_role": "root",
					"flow.mode": mode,
					"flow.trace_label": storedTraceLabel,
					...traceContextAttributes(storedContext),
					...storedAttributes(attributes),
					"flow.elapsed_time_ms": Math.max(0, end - rootStart),
					"flow.execution_success": status.ok,
					"flow.trace.expected_spans": expectedSpans,
					"flow.trace.observed_spans": observedSpans,
					"flow.trace.dropped_spans": health.droppedSpans,
					"flow.trace.redacted_spans": health.redactedSpans,
					"flow.trace.failed_exports": health.failedExports,
					"flow.trace.stage_count": stages.size,
					"flow.trace.health": traceHealthStatus({ ...health, expectedSpans, observedSpans }, true),
				},
			});
			await rootAppend;
			const rootWritten = health.observedSpans === observedSpans;
			const spans: FlowTraceHealth = {
				expectedSpans,
				observedSpans: health.observedSpans,
				droppedSpans: health.droppedSpans,
				redactedSpans: health.redactedSpans,
				failedExports: health.failedExports,
			};
			return {
				health: traceHealthStatus(spans, rootWritten),
				traceFile: sanitizeText(safePath(traceFile) ?? traceFile, { ...policy, recordContent: true }, 1024),
				traceId,
				rootSpanId,
				spans,
				...(storedContext ? { context: storedContext } : {}),
				...(writeError ? { error: sanitizeText(writeError, { ...policy, recordContent: true }, 1024) } : {}),
			};
		},
	};
}
