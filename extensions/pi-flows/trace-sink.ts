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
import { emptyTraceHealth, traceHealthStatus } from "./trace-scope.ts";
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
	parent?: string;
	startMs: number;
	endMs: number;
	spans: number;
}

const spanId = () => randomUUID().replace(/-/g, "");

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
	const spanIdByKey = new Map<string, string>();
	const pending: Array<Promise<void>> = [];
	let writeError: string | undefined;

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

	/** Stage spans are created on first use and closed at finalize over the bounds of what ran inside them. */
	const ensureStage = (stage: SpanStage, startMs: number, endMs: number): string => {
		const existing = stages.get(stage.key);
		if (existing) {
			existing.startMs = Math.min(existing.startMs, startMs);
			existing.endMs = Math.max(existing.endMs, endMs);
			existing.spans += 1;
			return existing.spanId;
		}
		const record: StageRecord = { spanId: spanId(), name: stage.name, parent: stage.parent, startMs, endMs, spans: 1 };
		stages.set(stage.key, record);
		spanIdByKey.set(stage.key, record.spanId);
		return record.spanId;
	};

	const placement = (scope: ChildSpanScope | undefined, startMs: number, endMs: number) => {
		const parentSpanId = scope?.stage ? ensureStage(scope.stage, startMs, endMs) : rootSpanId;
		const dependsOn = scope?.dependsOn ?? [];
		const attributes: Record<string, unknown> = {};
		if (dependsOn.length) {
			attributes["flow.depends_on"] = dependsOn.join(",");
			const resolved = dependsOn.map((key) => spanIdByKey.get(key)).filter((value): value is string => Boolean(value));
			if (resolved.length) attributes["flow.depends_on_span_ids"] = resolved.join(",");
		}
		if (scope?.key) attributes["flow.unit_key"] = scope.key;
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
				...placementAttributes,
				...(span?.attributes ?? {}),
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
			void append({
				trace_id: traceId,
				span_id: spanId(),
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
					...placementAttributes,
					...(coordination.attributes ?? {}),
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
					parent_span_id: (stage.parent && spanIdByKey.get(stage.parent)) || rootSpanId,
					name: `flow.${mode}.stage.${stage.name}`,
					start_time_unix_ms: stage.startMs,
					end_time_unix_ms: stage.endMs,
					status: { code: "OK" },
					attributes: {
						"openinference.span.kind": "CHAIN",
						"flow.span_role": "stage",
						"flow.mode": mode,
						"flow.trace_label": storedTraceLabel,
						"flow.stage_key": key,
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
					...attributes,
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
