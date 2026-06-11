import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { emptyUsage, type CapturePolicy, type FlowMode, type FlowRunResult, type ModeOutput, type RecordSpan, type UsageStats } from "./types.ts";
import { capModelVisibleText, isFailed, resultText, safePath } from "./sanitize.ts";
import { parseVerdict } from "./parse.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(usage: UsageStats, model?: string, durationMs?: number): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export interface TraceSink {
	record: RecordSpan;
	finalize: (status: { ok: boolean }, attributes?: Record<string, unknown>) => Promise<void>;
}

/**
 * Emit one OpenInference-shaped JSON span per child run to an append-only JSONL
 * file. The wiki's llm-observability page makes OpenTelemetry + OpenInference the
 * de-facto agent-tracing stack and stresses "build for agents, not just humans" —
 * trace data a coding agent can query (SQL/jq) and self-heal from. A delegation
 * tree is exactly the multi-step trajectory those spans are meant to attribute
 * failure across. Dependency-free by design: JSONL any OTel pipeline can ingest.
 * All values are already redacted/capped by the capture policy upstream.
 */
export function makeTraceSink(traceFile: string, mode: FlowMode, policy: CapturePolicy, traceLabel?: string): TraceSink {
	const traceId = randomUUID().replace(/-/g, "");
	const rootSpanId = randomUUID().replace(/-/g, "");
	const rootStart = Date.now();

	const append = (obj: unknown): Promise<void> =>
		withFileMutationQueue(traceFile, async () => {
			try {
				await fs.appendFile(traceFile, `${JSON.stringify(obj)}\n`, "utf8");
			} catch {
				// Tracing is best-effort; never let an export failure break a flow.
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
			await append({
				trace_id: traceId,
				span_id: rootSpanId,
				parent_span_id: null,
				name: `flow.${mode}`,
				start_time_unix_ms: rootStart,
				end_time_unix_ms: Date.now(),
				status: { code: status.ok ? "OK" : "ERROR" },
				attributes: { "openinference.span.kind": "CHAIN", "flow.mode": mode, "flow.trace_label": traceLabel, ...attributes },
			});
		},
	};
}

export interface TraceSpanRecord {
	trace_id?: string;
	span_id?: string;
	parent_span_id?: string | null;
	name?: string;
	start_time_unix_ms?: number;
	end_time_unix_ms?: number;
	status?: { code?: string; message?: string };
	attributes?: Record<string, unknown>;
}

export interface TraceReportBucket {
	traces: number;
	successes: number;
	costUsd: number;
	tokens: number;
	durationMs: number;
	budgetHits: number;
	sameModelVoteWarnings: number;
}

export interface TraceReport {
	source?: string;
	parseErrors: number;
	traces: number;
	successes: number;
	costUsd: number;
	tokens: number;
	durationMs: number;
	budgetHits: number;
	sameModelVoteWarnings: number;
	routeChoices: Record<string, number>;
	byMode: Record<string, TraceReportBucket>;
	byLabel: Record<string, TraceReportBucket>;
}

export function emptyTraceBucket(): TraceReportBucket {
	return { traces: 0, successes: 0, costUsd: 0, tokens: 0, durationMs: 0, budgetHits: 0, sameModelVoteWarnings: 0 };
}

export function addTraceBucket(bucket: TraceReportBucket, delta: TraceReportBucket): void {
	bucket.traces += delta.traces;
	bucket.successes += delta.successes;
	bucket.costUsd += delta.costUsd;
	bucket.tokens += delta.tokens;
	bucket.durationMs += delta.durationMs;
	bucket.budgetHits += delta.budgetHits;
	bucket.sameModelVoteWarnings += delta.sameModelVoteWarnings;
}

export function numericAttr(span: TraceSpanRecord, key: string): number {
	const value = span.attributes?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function stringAttr(span: TraceSpanRecord, key: string): string | undefined {
	const value = span.attributes?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function boolAttr(span: TraceSpanRecord, key: string): boolean {
	return span.attributes?.[key] === true;
}

export function parseTraceJsonl(text: string): { spans: TraceSpanRecord[]; parseErrors: number } {
	const spans: TraceSpanRecord[] = [];
	let parseErrors = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			spans.push(JSON.parse(line) as TraceSpanRecord);
		} catch {
			parseErrors += 1;
		}
	}
	return { spans, parseErrors };
}

export function summarizeTraceSpans(spans: TraceSpanRecord[], parseErrors = 0, source?: string): TraceReport {
	const byTrace = new Map<string, TraceSpanRecord[]>();
	for (const span of spans) {
		if (!span.trace_id) continue;
		byTrace.set(span.trace_id, [...(byTrace.get(span.trace_id) ?? []), span]);
	}
	const report: TraceReport = {
		source,
		parseErrors,
		traces: 0,
		successes: 0,
		costUsd: 0,
		tokens: 0,
		durationMs: 0,
		budgetHits: 0,
		sameModelVoteWarnings: 0,
		routeChoices: {},
		byMode: {},
		byLabel: {},
	};

	for (const traceSpans of byTrace.values()) {
		const root = traceSpans.find((span) => span.parent_span_id === null) ?? traceSpans.find((span) => span.name && !span.name.includes(".", "flow.".length));
		const childSpans = root ? traceSpans.filter((span) => span !== root) : traceSpans;
		const representative = root ?? traceSpans[0] ?? ({} as TraceSpanRecord);
		const rootSpan = root ?? ({} as TraceSpanRecord);
		const mode = stringAttr(representative, "flow.mode") ?? "unknown";
		const label = stringAttr(representative, "flow.trace_label") ?? "(unlabeled)";
		const costUsd = numericAttr(rootSpan, "flow.cost_usd_total") || childSpans.reduce((sum, span) => sum + numericAttr(span, "flow.cost_usd"), 0);
		const tokens =
			numericAttr(rootSpan, "flow.token_count_total") ||
			childSpans.reduce((sum, span) => sum + numericAttr(span, "llm.token_count.prompt") + numericAttr(span, "llm.token_count.completion"), 0);
		const durationMs =
			numericAttr(rootSpan, "flow.duration_ms_total") ||
			(root?.start_time_unix_ms !== undefined && root?.end_time_unix_ms !== undefined ? Math.max(0, root.end_time_unix_ms - root.start_time_unix_ms) : 0);
		const success = (root?.status?.code ?? "OK") === "OK" && !childSpans.some((span) => span.status?.code === "ERROR");
		const budgetHit = boolAttr(rootSpan, "flow.budget_exceeded") || childSpans.some((span) => stringAttr(span, "flow.error_code") === "BUDGET_EXCEEDED");
		const sameModelVoteWarning = boolAttr(rootSpan, "flow.same_model_vote_warning");
		const routeChoice = stringAttr(rootSpan, "flow.route_choice");

		const delta: TraceReportBucket = {
			traces: 1,
			successes: success ? 1 : 0,
			costUsd,
			tokens,
			durationMs,
			budgetHits: budgetHit ? 1 : 0,
			sameModelVoteWarnings: sameModelVoteWarning ? 1 : 0,
		};
		report.traces += 1;
		report.successes += delta.successes;
		report.costUsd += costUsd;
		report.tokens += tokens;
		report.durationMs += durationMs;
		report.budgetHits += delta.budgetHits;
		report.sameModelVoteWarnings += delta.sameModelVoteWarnings;
		if (routeChoice) report.routeChoices[routeChoice] = (report.routeChoices[routeChoice] ?? 0) + 1;
		report.byMode[mode] ??= emptyTraceBucket();
		addTraceBucket(report.byMode[mode], delta);
		report.byLabel[label] ??= emptyTraceBucket();
		addTraceBucket(report.byLabel[label], delta);
	}
	return report;
}

export function formatRate(numerator: number, denominator: number): string {
	return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "n/a";
}

export function formatTpso(bucket: TraceReportBucket): string {
	return bucket.successes > 0 ? (bucket.tokens / bucket.successes).toFixed(0) : "n/a";
}

export function formatTraceReport(report: TraceReport): string {
	const lines = [
		`Trace report${report.source ? `: ${safePath(report.source)}` : ""}`,
		`Runs: ${report.traces} (${report.successes} succeeded, ${formatRate(report.successes, report.traces)} success)`,
		`Cost: $${report.costUsd.toFixed(4)}  Tokens: ${formatTokens(report.tokens)}  Duration: ${(report.durationMs / 1000).toFixed(1)}s`,
		`TPSO: ${formatTpso({ ...emptyTraceBucket(), successes: report.successes, tokens: report.tokens })} tokens/success  Budget hits: ${report.budgetHits}  Same-model vote warnings: ${report.sameModelVoteWarnings}`,
	];
	if (report.parseErrors) lines.push(`Parse errors: ${report.parseErrors}`);

	const renderBuckets = (title: string, buckets: Record<string, TraceReportBucket>) => {
		const entries = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return;
		lines.push("", title, "name | runs | success | cost | tokens | tpso | budget | vote-model");
		lines.push("--- | ---: | ---: | ---: | ---: | ---: | ---: | ---:");
		for (const [name, bucket] of entries) {
			lines.push(
				`${name} | ${bucket.traces} | ${formatRate(bucket.successes, bucket.traces)} | $${bucket.costUsd.toFixed(4)} | ${formatTokens(bucket.tokens)} | ${formatTpso(bucket)} | ${bucket.budgetHits} | ${bucket.sameModelVoteWarnings}`,
			);
		}
	};

	renderBuckets("By mode", report.byMode);
	renderBuckets("By trace label", report.byLabel);
	const routeChoices = Object.entries(report.routeChoices).sort(([a], [b]) => a.localeCompare(b));
	if (routeChoices.length > 0) {
		lines.push("", "Route choices");
		for (const [choice, count] of routeChoices) lines.push(`- ${choice}: ${count}`);
	}
	return lines.join("\n");
}

export function flowUsageTotals(results: FlowRunResult[]): UsageStats {
	const total = emptyUsage();
	for (const result of results) {
		total.input += result.usage.input || 0;
		total.output += result.usage.output || 0;
		total.cacheRead += result.usage.cacheRead || 0;
		total.cacheWrite += result.usage.cacheWrite || 0;
		total.cost += result.usage.cost || 0;
		total.contextTokens += result.usage.contextTokens || 0;
		total.turns += result.usage.turns || 0;
	}
	return total;
}

export function traceSummaryAttributes(mode: FlowMode, params: any, output: ModeOutput): Record<string, unknown> {
	const results = output.details.results.filter((result) => result.exitCode !== -1);
	const usage = flowUsageTotals(results);
	const failed = results.filter(isFailed);
	const attrs: Record<string, unknown> = {
		"flow.child_count": results.length,
		"flow.failed_child_count": failed.length,
		"flow.cost_usd_total": usage.cost,
		"flow.token_count_total": usage.input + usage.output,
		"flow.duration_ms_total": results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
		"flow.budget_exceeded": results.some((result) => result.error?.code === "BUDGET_EXCEEDED") || output.details.error?.code === "BUDGET_EXCEEDED",
	};
	if (mode === "vote") {
		const voterCount = Array.isArray(params.vote?.voters) && params.vote.voters.length > 0 ? params.vote.voters.length : Number.isFinite(params.vote?.count) ? Math.floor(params.vote.count) : results.length;
		const voters = results.slice(0, Math.max(0, voterCount));
		const models = new Set(voters.map((result) => result.model ?? "(default)"));
		attrs["flow.same_model_vote_warning"] = voters.length >= 2 && models.size <= 1;
	}
	if (mode === "route") {
		const routeChoice = results[1]?.agent;
		if (routeChoice) attrs["flow.route_choice"] = routeChoice;
	}
	if (mode === "orchestrate" && params.orchestrate?.verify) {
		const verifier = results.at(-1);
		if (verifier) attrs["flow.verify_verdict"] = parseVerdict(resultText(verifier));
	}
	return attrs;
}
