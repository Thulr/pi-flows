import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
	CapturePolicy,
	FlowMode,
	FlowTraceContext,
	FlowTraceLink,
	RecordSpan,
} from "./types.ts";
import { capModelVisibleText, isFailed, resultText, safePath, sanitizeText } from "./sanitize.ts";
import { stableTraceIds } from "./trace-identity.mjs";

export { stableTraceIds } from "./trace-identity.mjs";

export interface TraceSink {
	record: RecordSpan;
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

/** Emit redacted OpenInference-shaped child and root spans to JSONL. */
export function makeTraceSink(traceFile: string, mode: FlowMode, policy: CapturePolicy, traceLabel?: string, context?: FlowTraceContext): TraceSink {
	const ids = context ? stableTraceIds(context, mode) : { traceId: randomUUID().replace(/-/g, ""), rootSpanId: randomUUID().replace(/-/g, "") };
	const { traceId, rootSpanId } = ids;
	const storedContext = context ? storedTraceContext(context, policy) : undefined;
	const storedTraceLabel = traceLabel ? sanitizeText(traceLabel, { ...policy, recordContent: true }, 256) : undefined;
	const rootStart = Date.now();
	let writeError: string | undefined;

	const append = (obj: unknown): Promise<void> =>
		withFileMutationQueue(traceFile, async () => {
			try {
				await fs.appendFile(traceFile, `${JSON.stringify(obj)}\n`, "utf8");
			} catch (error) {
				writeError = error instanceof Error ? error.message : String(error);
			}
		});

	return {
		record(result) {
			const end = Date.now();
			const start = result.durationMs !== undefined ? end - result.durationMs : end;
			const attributes: Record<string, unknown> = {
				"openinference.span.kind": "AGENT",
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
				...traceContextAttributes(storedContext),
				"llm.model_name": result.model,
				"llm.token_count.prompt": result.usage.input,
				"llm.token_count.completion": result.usage.output,
				"llm.token_count.total": result.usage.contextTokens || result.usage.input + result.usage.output,
			};
			if (policy.recordContent) {
				attributes["input.value"] = sanitizeText(result.task, policy);
				attributes["output.value"] = sanitizeText(capModelVisibleText(resultText(result)), policy);
			}
			void append({
				trace_id: traceId,
				span_id: randomUUID().replace(/-/g, ""),
				parent_span_id: rootSpanId,
				name: `flow.${mode}.${result.agent}`,
				start_time_unix_ms: start,
				end_time_unix_ms: end,
				status: { code: isFailed(result) ? "ERROR" : "OK", message: result.error?.code },
				attributes,
			});
		},
		async finalize(status, attributes = {}) {
			const end = Date.now();
			await append({
				trace_id: traceId,
				span_id: rootSpanId,
				parent_span_id: null,
				name: `flow.${mode}`,
				start_time_unix_ms: rootStart,
				end_time_unix_ms: end,
				status: { code: status.ok ? "OK" : "ERROR" },
				attributes: {
					"openinference.span.kind": "CHAIN",
					"flow.mode": mode,
					"flow.trace_label": storedTraceLabel,
					...traceContextAttributes(storedContext),
					...attributes,
					"flow.elapsed_time_ms": Math.max(0, end - rootStart),
					"flow.execution_success": status.ok,
				},
			});
			return {
				health: writeError ? "missing" : "recorded",
				traceFile: sanitizeText(safePath(traceFile) ?? traceFile, { ...policy, recordContent: true }, 1024),
				traceId,
				rootSpanId,
				...(storedContext ? { context: storedContext } : {}),
				...(writeError ? { error: sanitizeText(writeError, { ...policy, recordContent: true }, 1024) } : {}),
			};
		},
	};
}
