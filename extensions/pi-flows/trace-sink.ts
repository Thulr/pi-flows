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
import { emptyTraceHealth, encodeUnitKey, traceHealthStatus, type FlowTraceStructure } from "./trace-scope.ts";
import { verifyExportedTrace } from "./trace-verify.ts";
import { capModelVisibleText, isFailed, resultText, safePath, sanitizeText } from "./sanitize.ts";
import { stableTraceIds } from "./trace-identity.mjs";

export { stableTraceIds } from "./trace-identity.mjs";

export interface TraceSink {
	record: RecordSpan;
	event: RecordEvent;
	/**
	 * Root attributes may be given as a function of the span accounting observed
	 * just before the root is written. A caller that must not claim more than the
	 * evidence supports — a verified outcome under strict tracing — needs to see
	 * that health while the root record is still being composed.
	 */
	finalize: (status: { ok: boolean }, attributes?: Record<string, unknown> | ((health: FlowTraceHealth) => Record<string, unknown>)) => Promise<FlowTraceLink>;
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
 * Structural keys get their own, larger bound. They are machine identifiers the
 * report parses to check the attribution chain, and a truncated one would read as
 * a broken chain — a valid run failing the gate because its ids were long.
 *
 * All five share the bound deliberately. A key capped on one side and intact on
 * the other cannot be matched to itself, so capping them differently would break
 * exactly the comparison they exist for. The unresolved list is part of that
 * comparison: its entries are declared keys, matched against the declared list.
 */
const STRUCTURAL_CAP = 8 * 1024;
const STRUCTURAL_ATTRIBUTES = new Set(["flow.unit_key", "flow.stage_key", "flow.depends_on", "flow.depends_on_span_ids", "flow.depends_on_unresolved"]);

/** What a caller configures beyond the file, the mode, and the capture policy. An object rather than three more positional slots, so a caller asking only for `verify` does not have to pass two `undefined`s to reach it. */
export interface TraceSinkOptions {
	traceLabel?: string;
	context?: FlowTraceContext;
	/** Read the export back once the root is written. Strict runs set it; ordinary flows do not, and pay nothing. */
	verify?: boolean;
}

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
export function makeTraceSink(traceFile: string, mode: FlowMode, policy: CapturePolicy, options: TraceSinkOptions = {}): TraceSink {
	const { traceLabel, context, verify = false } = options;
	const ids = context ? stableTraceIds(context, mode) : { traceId: randomUUID().replace(/-/g, ""), rootSpanId: spanId() };
	const { traceId, rootSpanId } = ids;
	const storedContext = context ? storedTraceContext(context, policy) : undefined;
	const storedTraceLabel = traceLabel ? sanitizeText(traceLabel, { ...policy, recordContent: true }, 256) : undefined;
	const rootStart = Date.now();
	const health: FlowTraceHealth = emptyTraceHealth();
	const stages = new Map<string, StageRecord>();
	// The widest interval anything recorded. Date.now() is not monotonic, so a
	// clock that steps backwards between a child and finalize could otherwise
	// leave the root ending before its own children — an impossible tree, and a
	// healthy run failing the read-back check for a reason it did not cause.
	let earliestSpanMs = Number.POSITIVE_INFINITY;
	let latestSpanMs = Number.NEGATIVE_INFINITY;
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
	/** How a structural key list looks once written: redacted, then capped. */
	const storedStructural = (value: string) => sanitizeText(value, { ...policy, recordContent: true }, STRUCTURAL_CAP);

	const storedAttributes = (attributes: Record<string, unknown> | undefined): Record<string, unknown> => {
		if (!attributes) return {};
		const stored: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(attributes)) {
			stored[key] = typeof value === "string"
				? sanitizeText(value, { ...policy, recordContent: true }, STRUCTURAL_ATTRIBUTES.has(key) ? STRUCTURAL_CAP : ATTRIBUTE_CAP)
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

	const observeInterval = (startMs: number, endMs: number) => {
		earliestSpanMs = Math.min(earliestSpanMs, startMs);
		latestSpanMs = Math.max(latestSpanMs, endMs);
	};

	const placement = (scope: ChildSpanScope | undefined, startMs: number, endMs: number) => {
		observeInterval(startMs, endMs);
		const parentSpanId = scope?.stage ? ensureStage(scope.stage, startMs, endMs) : rootSpanId;
		const dependsOn = scope?.dependsOn ?? [];
		const attributes: Record<string, unknown> = {};
		if (dependsOn.length) {
			// The authoritative count. A reader must not have to infer it from a
			// string that any cap or transform could have shortened.
			attributes["flow.depends_on_count"] = dependsOn.length;
			// Stored first, then measured. The flag has to describe the list that
			// reaches the file: redaction can shorten an over-cap list back under the
			// cap, and a flag derived from the raw string would then claim a
			// truncation the reader cannot see — failing a healthy run.
			const stored = storedStructural(dependsOn.map(encodeUnitKey).join(","));
			attributes["flow.depends_on"] = stored;
			// Capping is the one reason a healthy run's key list is shorter than its
			// count, so the writer says when it happens. Without that signal a reader
			// cannot tell capping from erasure, and has to let both through. Counting
			// keys rather than bytes states exactly what the reader checks.
			if (stored.split(",").filter(Boolean).length < dependsOn.length) attributes["flow.depends_on_truncated"] = true;
			// A dependency may name a unit or a whole stage ("this debrief consumed
			// round 2"), so both namespaces are searched, units first.
			const resolved: string[] = [];
			const unresolved: string[] = [];
			for (const key of dependsOn) {
				const id = spanIdByKey.get(key) ?? stageSpanIdByKey.get(key);
				if (id) resolved.push(id);
				else unresolved.push(key);
			}
			if (resolved.length) attributes["flow.depends_on_span_ids"] = resolved.join(",");
			// A key that resolves to nothing is a real case: handlers pass dependsOn
			// keys as plain strings, so a key naming a unit that never registered
			// reaches this point. Dropping its id silently wrote the very shape the
			// reader refuses as erasure — the run healthy at runtime, structurally
			// invalid on read-back. Naming the unresolved keys keeps the arithmetic
			// whole (count = resolved + unresolved), so the row reads as an honest
			// record of a handler bug instead of as a corrupted file.
			if (unresolved.length) {
				// Stored, measured, and flagged under the same rules as the declared
				// list above, so the two lists stay matchable to each other.
				const storedUnresolved = storedStructural(unresolved.map(encodeUnitKey).join(","));
				attributes["flow.depends_on_unresolved"] = storedUnresolved;
				if (storedUnresolved.split(",").filter(Boolean).length < unresolved.length) attributes["flow.depends_on_unresolved_truncated"] = true;
			}
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
						"flow.stage_key": sanitizeText(encodeUnitKey(key), { ...policy, recordContent: true }, STRUCTURAL_CAP),
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
			const preRootHealth: FlowTraceHealth = {
				expectedSpans,
				observedSpans,
				droppedSpans: health.droppedSpans,
				redactedSpans: health.redactedSpans,
				failedExports: health.failedExports,
			};
			const rootAttributes = typeof attributes === "function" ? attributes(preRootHealth) : attributes;
			const rootAppend = append({
				trace_id: traceId,
				span_id: rootSpanId,
				parent_span_id: null,
				name: `flow.${mode}`,
				start_time_unix_ms: Math.min(rootStart, earliestSpanMs),
				end_time_unix_ms: Math.max(end, latestSpanMs),
				status: { code: status.ok ? "OK" : "ERROR" },
				attributes: {
					"openinference.span.kind": "CHAIN",
					"flow.span_role": "root",
					"flow.mode": mode,
					"flow.trace_label": storedTraceLabel,
					...traceContextAttributes(storedContext),
					...storedAttributes(rootAttributes),
					"flow.elapsed_time_ms": Math.max(0, end - rootStart),
					"flow.execution_success": status.ok,
					"flow.trace.expected_spans": expectedSpans,
					"flow.trace.observed_spans": observedSpans,
					"flow.trace.dropped_spans": health.droppedSpans,
					"flow.trace.redacted_spans": health.redactedSpans,
					"flow.trace.failed_exports": health.failedExports,
					"flow.trace.stage_count": stages.size,
					"flow.trace.health": traceHealthStatus({ ...health, expectedSpans, observedSpans }, true),
					// A strict run cannot verify itself before this row exists, so the row
					// says its own claims are contingent. A reader then requires positive
					// certification to honour them, which makes every way the certification
					// can fail to arrive — including the append for it failing — read as
					// unverified rather than verified.
					...(verify ? { "flow.trace.verification_pending": true } : {}),
				},
			});
			await rootAppend;
			const rootWritten = health.observedSpans === observedSpans;
			// The root is already on disk, and an exported span is immutable — so a
			// verification that fails after it cannot unsay `flow.outcome_verified`.
			// It records the revocation as a linked event instead, exactly as a revoked
			// budget wrap-up does, and the report applies the correction. Only an
			// already-failing trace gains this row, so no healthy export is pushed past
			// its own declared count by it.
			const structure = verify ? await verifyExportedTrace(traceFile, traceId, expectedSpans, policy) : undefined;
			if (structure) {
				const certified = structure.valid;
				await append({
					trace_id: traceId,
					span_id: spanId(),
					parent_span_id: rootSpanId,
					name: `flow.${mode}.event.trace.${certified ? "structure_verified" : "structure_invalid"}`,
					start_time_unix_ms: end,
					end_time_unix_ms: end,
					status: { code: certified ? "OK" : "ERROR" },
					attributes: {
						"openinference.span.kind": "CHAIN",
						"flow.span_role": "event",
						"flow.event_kind": "validation",
						"flow.event_name": `trace.${certified ? "structure_verified" : "structure_invalid"}`,
						"flow.mode": mode,
						"flow.trace_label": storedTraceLabel,
						...(certified ? { "flow.trace.structure_verified": true } : { "flow.trace.structure_revoked": true }),
						"flow.depends_on_span_ids": rootSpanId,
						...storedAttributes({ "flow.trace.structure_issue": structure.issue }),
						...traceContextAttributes(storedContext),
					},
				});
			}
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
				// Read back only when asked. An ordinary flow pays nothing; a strict run
				// must not report evidence whose shape it never checked, and the root is
				// on disk by now, so what the file holds is a complete tree or it is not.
				...(structure ? { structure } : {}),
			};
		},
	};
}
