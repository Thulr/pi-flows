import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
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
import { storedAttributes, storedLabel, storedStructural, storedTraceContext, traceContextAttributes } from "./trace-attributes.ts";
import { reconcileVerdicts, verifyExportedTrace } from "./trace-verify.ts";
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

interface StageRecord {
	spanId: string;
	name: string;
	parentSpanId: string;
	startMs: number;
	endMs: number;
	spans: number;
}

const spanId = () => randomUUID().replace(/-/g, "");

/**
 * One JSONL row as this sink writes it. Only the attribute map is named — the
 * one part `append` reaches into, to stamp the invocation id — while the
 * identity and interval fields stay each call site's own statement.
 */
interface ExportRow {
	attributes: Record<string, unknown>;
	[key: string]: unknown;
}

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
	// One random id per sink, stamped on every row this invocation writes. The
	// stable trace id is deliberately reusable — an eval row and its runtime
	// trace correlate through it — so two calls sharing a trace context and mode
	// (a project-preset refusal and the retry after it, into one file) share a
	// trace id, and #127 was the second call's read-back refusing its own healthy
	// run over the first call's rows. This id is the discriminator that scoping
	// filters on instead; it lives beside the identity, never inside it.
	const invocationId = spanId();
	// Where this invocation's record begins: the file's size the moment the sink
	// is born, before any of its rows can exist — the record extent the read-back
	// is bounded by (#129; readExtent in trace-verify.ts holds why the boundary is
	// sound). Captured at birth rather than at first write because the sink
	// appends without awaiting: a row another writer gets onto disk ahead of the
	// queued first append must not slip behind the boundary. Races can only
	// under-estimate this (appends grow the file), which reads extra foreign rows
	// — the safe direction; an unreadable path reads as 0, the whole file.
	let extentStart = 0;
	try {
		extentStart = statSync(traceFile).size;
	} catch {}
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

	// The invocation id is stamped here, on the one path every row leaves
	// through, so no row this sink writes can be missing the discriminator the
	// read-back and the report scope by.
	const append = (row: ExportRow): Promise<void> => {
		row.attributes["flow.invocation_id"] = invocationId;
		health.expectedSpans += 1;
		const write = withFileMutationQueue(traceFile, async () => {
			try {
				await fs.appendFile(traceFile, `${JSON.stringify(row)}\n`, "utf8");
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
			const stored = storedStructural(dependsOn.map(encodeUnitKey).join(","), policy);
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
				const storedUnresolved = storedStructural(unresolved.map(encodeUnitKey).join(","), policy);
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
				...storedAttributes(placementAttributes, policy),
				...storedAttributes(span?.attributes, policy),
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
					...storedAttributes(placementAttributes, policy),
					...storedAttributes(coordination.attributes, policy),
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
					name: `flow.${mode}.stage.${storedLabel(stage.name, policy)}`,
					start_time_unix_ms: stage.startMs,
					end_time_unix_ms: stage.endMs,
					status: { code: "OK" },
					attributes: {
						"openinference.span.kind": "CHAIN",
						"flow.span_role": "stage",
						"flow.mode": mode,
						"flow.trace_label": storedTraceLabel,
						"flow.stage_key": storedStructural(encodeUnitKey(key), policy),
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
			// A verifying run reserves one more slot: the certification the reader
			// requires is itself a row, and it can only be written after this root has
			// frozen the count. Without the reservation every healthy strict trace
			// reads back one span over its declaration, and the strict report gate
			// rejects exactly the traces that verified clean. A certification that
			// never lands leaves the trace one row short of its declaration, which
			// reads as loss — the failing-closed direction.
			const declaredExpectation = expectedSpans + (verify ? 1 : 0);
			// The certification is counted the way the root counts itself: in the
			// write that precedes it. Both root counters then share one convention —
			// the rows this finalize will have written when it completes — and match
			// the link's on the healthy path. Neither append's own failure is
			// recordable in a row already written; the link (which counts real
			// appends) and the file's own shortfall carry that truth.
			const declaredObserved = observedSpans + (verify ? 1 : 0);
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
					...storedAttributes(rootAttributes, policy),
					"flow.elapsed_time_ms": Math.max(0, end - rootStart),
					"flow.execution_success": status.ok,
					"flow.trace.expected_spans": declaredExpectation,
					"flow.trace.observed_spans": declaredObserved,
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
			// The first reading decides only what the event below may truthfully
			// record; it is not the verdict, because this finalize still has one write
			// left. A row this run appends after its own reading is evidence its
			// reading never saw.
			const preCertification = verify ? await verifyExportedTrace(traceFile, { traceId, invocationId }, { attempted: expectedSpans, declared: declaredExpectation }, policy, { start: extentStart }) : undefined;
			const appendStructureEvent = (certified: boolean, issue: string | undefined) => append({
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
					...storedAttributes({ "flow.trace.structure_issue": issue }, policy),
					...traceContextAttributes(storedContext),
				},
			});
			if (preCertification) {
				await appendStructureEvent(preCertification.valid, preCertification.issue);
			}
			// The verdict the link carries is of the file as this finalize leaves it —
			// certification row included, so nothing this run wrote postdates what it
			// verified. A path rotated or truncated between the first reading and the
			// event append lands here as missing rows rather than as a pass against a
			// file that no longer exists; every row is now expected, so attempted and
			// declared are the same number.
			const structure = preCertification
				? reconcileVerdicts(preCertification, await verifyExportedTrace(traceFile, { traceId, invocationId }, { attempted: declaredExpectation, declared: declaredExpectation }, policy, { start: extentStart }))
				: undefined;
			// A final failure after a positive certification would otherwise leave
			// the file claiming verified while the live call refuses. Best-effort
			// like every append, but the reserved slot makes its bare arrival
			// durable: one surplus row withholds on completeness before any reader
			// sees the flag. Past this, a read and a write failing together is a
			// window no append-only record can close from inside.
			if (structure && !structure.valid && preCertification?.valid) {
				await appendStructureEvent(false, structure.issue);
			}
			const spans: FlowTraceHealth = {
				// The declared count, so a landed certification reads as observed ==
				// expected rather than as one span of surplus.
				expectedSpans: declaredExpectation,
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
				invocationId,
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
