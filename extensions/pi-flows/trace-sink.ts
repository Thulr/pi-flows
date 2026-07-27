import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
	CapturePolicy,
	FlowMode,
	FlowTraceContext,
	FlowTraceLink,
	RecordSpan,
} from "./types.ts";
import { capModelVisibleText, isFailed, resultText, safePath } from "./sanitize.ts";

export interface TraceSink {
	record: RecordSpan;
	finalize: (status: { ok: boolean }, attributes?: Record<string, unknown>) => Promise<FlowTraceLink>;
}

export function stableTraceIds(context: FlowTraceContext, mode: string): { traceId: string; rootSpanId: string } {
	const identity = JSON.stringify({
		schemaVersion: "pi-flows.runtime-trace.v1",
		runId: context.runId,
		caseId: context.caseId,
		trialId: context.trialId,
		trialIndex: context.trialIndex ?? null,
		arm: context.arm ?? null,
		attempt: context.attempt ?? null,
		mode,
	});
	const traceId = createHash("sha256").update(identity).digest("hex").slice(0, 32);
	const rootSpanId = createHash("sha256").update(`${traceId}:root`).digest("hex").slice(0, 32);
	return { traceId, rootSpanId };
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
				"flow.trace_label": traceLabel,
				"flow.agent": result.agent,
				"flow.agent_source": result.agentSource,
				"flow.step": result.step,
				"flow.cost_usd": result.usage.cost,
				"flow.turns": result.usage.turns,
				"flow.duration_ms": result.durationMs,
				"flow.stop_reason": result.stopReason,
				"flow.error_code": result.error?.code,
				...traceContextAttributes(context),
				"llm.model_name": result.model,
				"llm.token_count.prompt": result.usage.input,
				"llm.token_count.completion": result.usage.output,
				"llm.token_count.total": result.usage.contextTokens || result.usage.input + result.usage.output,
			};
			if (policy.recordContent) {
				attributes["input.value"] = result.task;
				attributes["output.value"] = capModelVisibleText(resultText(result));
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
					"flow.trace_label": traceLabel,
					...traceContextAttributes(context),
					...attributes,
					"flow.elapsed_time_ms": Math.max(0, end - rootStart),
					"flow.execution_success": status.ok,
				},
			});
			return {
				health: writeError ? "missing" : "recorded",
				traceFile: safePath(traceFile) ?? traceFile,
				traceId,
				rootSpanId,
				...(context ? { context } : {}),
				...(writeError ? { error: writeError } : {}),
			};
		},
	};
}
