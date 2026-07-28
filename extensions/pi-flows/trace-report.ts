/**
 * Reading a trace file back: parse the JSONL, roll it up per run, and say both
 * what the flow did and whether the evidence is complete.
 *
 * Trace health is reported separately from execution success on purpose. A run
 * whose spans were dropped or redacted is not a failed run — it is a run nobody
 * can audit — and collapsing the two would turn every exporter problem into a
 * phantom agent regression.
 */
import { safePath } from "./sanitize.ts";
import { traceHealthStatus } from "./trace-scope.ts";

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
	/** @deprecated Compatibility alias for executionSuccesses. */
	successes: number;
	executionSuccesses: number;
	verifiedOutcomes: number;
	outcomeSuccesses: number;
	costUsd: number;
	tokens: number;
	/** @deprecated Compatibility alias for elapsedTimeMs. */
	durationMs: number;
	elapsedTimeMs: number;
	workerTimeMs: number;
	criticalPathMs: number;
	criticalPathTraces: number;
	legacyDurationTraces: number;
	budgetHits: number;
	sameModelVoteWarnings: number;
	expectedSpans: number;
	observedSpans: number;
	droppedSpans: number;
	redactedSpans: number;
	failedExports: number;
	/** Runs whose trace evidence is provably incomplete (dropped rows or failed exports). */
	incompleteTraces: number;
	coordinationEvents: number;
	stageSpans: number;
}

export interface TraceReport extends TraceReportBucket {
	source?: string;
	parseErrors: number;
	routeChoices: Record<string, number>;
	byMode: Record<string, TraceReportBucket>;
	byLabel: Record<string, TraceReportBucket>;
	eventKinds: Record<string, number>;
}

export function emptyTraceBucket(): TraceReportBucket {
	return {
		traces: 0,
		successes: 0,
		executionSuccesses: 0,
		verifiedOutcomes: 0,
		outcomeSuccesses: 0,
		costUsd: 0,
		tokens: 0,
		durationMs: 0,
		elapsedTimeMs: 0,
		workerTimeMs: 0,
		criticalPathMs: 0,
		criticalPathTraces: 0,
		legacyDurationTraces: 0,
		budgetHits: 0,
		sameModelVoteWarnings: 0,
		expectedSpans: 0,
		observedSpans: 0,
		droppedSpans: 0,
		redactedSpans: 0,
		failedExports: 0,
		incompleteTraces: 0,
		coordinationEvents: 0,
		stageSpans: 0,
	};
}

/**
 * Sum one run's counters into a bucket. The field list comes from
 * `emptyTraceBucket()` rather than from either argument, because the report
 * itself is a bucket with extra non-numeric fields (`byMode`, `routeChoices`, …)
 * and iterating those would concatenate objects into the totals.
 */
const TRACE_BUCKET_FIELDS = Object.keys(emptyTraceBucket()) as Array<keyof TraceReportBucket>;

export function addTraceBucket(bucket: TraceReportBucket, delta: TraceReportBucket): void {
	for (const key of TRACE_BUCKET_FIELDS) bucket[key] += delta[key];
}

export function numericAttr(span: TraceSpanRecord, key: string): number {
	const value = span.attributes?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function optionalNumericAttr(span: TraceSpanRecord, key: string): number | undefined {
	const value = span.attributes?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringAttr(span: TraceSpanRecord, key: string): string | undefined {
	const value = span.attributes?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function boolAttr(span: TraceSpanRecord, key: string): boolean {
	return span.attributes?.[key] === true;
}

export function optionalBoolAttr(span: TraceSpanRecord, key: string): boolean | undefined {
	const value = span.attributes?.[key];
	return typeof value === "boolean" ? value : undefined;
}

/** Traces written before span roles existed have only root and child spans, so an unlabeled span is a child. */
function spanRole(span: TraceSpanRecord, root: TraceSpanRecord | undefined): "root" | "child" | "stage" | "event" {
	if (root && span === root) return "root";
	const declared = stringAttr(span, "flow.span_role");
	return declared === "stage" || declared === "event" || declared === "root" ? declared : "child";
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
		...emptyTraceBucket(),
		source,
		parseErrors,
		routeChoices: {},
		byMode: {},
		byLabel: {},
		eventKinds: {},
	};

	for (const traceSpans of byTrace.values()) {
		const root = traceSpans.find((span) => span.parent_span_id === null) ?? traceSpans.find((span) => span.name && !span.name.includes(".", "flow.".length));
		const childSpans = traceSpans.filter((span) => span !== root && spanRole(span, root) === "child");
		const eventSpans = traceSpans.filter((span) => spanRole(span, root) === "event");
		const stageSpans = traceSpans.filter((span) => spanRole(span, root) === "stage");
		const representative = root ?? traceSpans[0] ?? ({} as TraceSpanRecord);
		const rootSpan = root ?? ({} as TraceSpanRecord);
		const mode = stringAttr(representative, "flow.mode") ?? "unknown";
		const label = stringAttr(representative, "flow.trace_label") ?? "(unlabeled)";
		const costUsd = numericAttr(rootSpan, "flow.cost_usd_total") || childSpans.reduce((sum, span) => sum + numericAttr(span, "flow.cost_usd"), 0);
		const tokens =
			numericAttr(rootSpan, "flow.token_count_total") ||
			childSpans.reduce((sum, span) => sum + numericAttr(span, "llm.token_count.prompt") + numericAttr(span, "llm.token_count.completion"), 0);
		const legacyWorkerTime = optionalNumericAttr(rootSpan, "flow.duration_ms_total");
		const elapsedTimeMs =
			optionalNumericAttr(rootSpan, "flow.elapsed_time_ms") ??
			(root?.start_time_unix_ms !== undefined && root?.end_time_unix_ms !== undefined ? Math.max(0, root.end_time_unix_ms - root.start_time_unix_ms) : 0);
		const workerTimeMs =
			optionalNumericAttr(rootSpan, "flow.worker_time_ms") ??
			legacyWorkerTime ??
			childSpans.reduce((sum, span) => sum + numericAttr(span, "flow.duration_ms"), 0);
		const criticalPath = optionalNumericAttr(rootSpan, "flow.critical_path_ms");
		const executionSuccess =
			optionalBoolAttr(rootSpan, "flow.execution_success") ??
			((root?.status?.code ?? "OK") === "OK" && !childSpans.some((span) => span.status?.code === "ERROR"));
		const outcomeVerified = boolAttr(rootSpan, "flow.outcome_verified");
		const outcomeSuccess = outcomeVerified && boolAttr(rootSpan, "flow.outcome_success");
		const budgetHit = boolAttr(rootSpan, "flow.budget_exceeded") || childSpans.some((span) => stringAttr(span, "flow.error_code") === "BUDGET_EXCEEDED");
		const sameModelVoteWarning = boolAttr(rootSpan, "flow.same_model_vote_warning");
		const routeChoice = stringAttr(rootSpan, "flow.route_choice");

		// Two independent views of completeness: what the exporter admitted it
		// failed to write, and what the file is missing relative to what the root
		// span said to expect. The second catches loss *after* a successful write.
		const redactedSpans = numericAttr(rootSpan, "flow.trace.redacted_spans");
		const declaredExpected = optionalNumericAttr(rootSpan, "flow.trace.expected_spans");
		const expectedSpans = declaredExpected ?? traceSpans.length;
		const failedExports = numericAttr(rootSpan, "flow.trace.failed_exports");
		const droppedSpans = Math.max(failedExports, Math.max(0, expectedSpans - traceSpans.length));

		const delta: TraceReportBucket = {
			traces: 1,
			successes: executionSuccess ? 1 : 0,
			executionSuccesses: executionSuccess ? 1 : 0,
			verifiedOutcomes: outcomeVerified ? 1 : 0,
			outcomeSuccesses: outcomeSuccess ? 1 : 0,
			costUsd,
			tokens,
			durationMs: elapsedTimeMs,
			elapsedTimeMs,
			workerTimeMs,
			criticalPathMs: criticalPath ?? 0,
			criticalPathTraces: criticalPath === undefined ? 0 : 1,
			legacyDurationTraces: legacyWorkerTime === undefined || optionalNumericAttr(rootSpan, "flow.worker_time_ms") !== undefined ? 0 : 1,
			budgetHits: budgetHit ? 1 : 0,
			sameModelVoteWarnings: sameModelVoteWarning ? 1 : 0,
			expectedSpans,
			observedSpans: traceSpans.length,
			droppedSpans,
			redactedSpans,
			failedExports,
			// Same derivation the sink used when it stamped `flow.trace.health`, so a
			// read-back verdict and a live one cannot disagree.
			incompleteTraces: traceHealthStatus(
				{ expectedSpans, observedSpans: traceSpans.length, droppedSpans, redactedSpans, failedExports },
				Boolean(root),
			) === "recorded" ? 0 : 1,
			coordinationEvents: eventSpans.length,
			stageSpans: stageSpans.length,
		};
		addTraceBucket(report, delta);
		for (const span of eventSpans) {
			const kind = stringAttr(span, "flow.event_kind") ?? "unknown";
			report.eventKinds[kind] = (report.eventKinds[kind] ?? 0) + 1;
		}
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
	return bucket.outcomeSuccesses > 0 ? (bucket.tokens / bucket.outcomeSuccesses).toFixed(0) : "n/a";
}

/**
 * True when the report is complete evidence a strict (eval/release) run can rest
 * on. A report of zero runs is not: an empty or trace_id-less file has nothing
 * incomplete in it precisely because it has nothing in it, and a release gate
 * that accepted that would pass on an artifact nobody wrote.
 */
export function traceReportIsComplete(report: TraceReport): boolean {
	return report.traces > 0 && report.incompleteTraces === 0 && report.parseErrors === 0;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatTraceReport(report: TraceReport): string {
	const lines = [
		`Trace report${report.source ? `: ${safePath(report.source)}` : ""}`,
		`Runs: ${report.traces}`,
		`Execution success: ${report.executionSuccesses}/${report.traces} (${formatRate(report.executionSuccesses, report.traces)})`,
		`Verified outcome success: ${report.outcomeSuccesses}/${report.verifiedOutcomes} (${formatRate(report.outcomeSuccesses, report.verifiedOutcomes)}; ${report.traces - report.verifiedOutcomes} unavailable)`,
		`Cost: $${report.costUsd.toFixed(4)}  Tokens: ${formatTokens(report.tokens)}`,
		`Elapsed: ${(report.elapsedTimeMs / 1000).toFixed(1)}s  Worker: ${(report.workerTimeMs / 1000).toFixed(1)}s  Critical path: ${(report.criticalPathMs / 1000).toFixed(1)}s (${report.criticalPathTraces}/${report.traces} available)`,
		`Verified TPSO: ${formatTpso({ ...emptyTraceBucket(), outcomeSuccesses: report.outcomeSuccesses, tokens: report.tokens })} tokens/success  Budget hits: ${report.budgetHits}  Same-model vote warnings: ${report.sameModelVoteWarnings}`,
		`Trace health: ${report.observedSpans}/${report.expectedSpans} spans observed (${report.droppedSpans} dropped, ${report.redactedSpans} redacted, ${report.failedExports} failed export${report.failedExports === 1 ? "" : "s"}); ${report.incompleteTraces}/${report.traces} runs incomplete`,
		`Topology: ${report.stageSpans} stage span${report.stageSpans === 1 ? "" : "s"}, ${report.coordinationEvents} coordination event${report.coordinationEvents === 1 ? "" : "s"}`,
	];
	if (report.parseErrors) lines.push(`Parse errors: ${report.parseErrors}`);
	if (report.legacyDurationTraces) lines.push(`Compatibility: legacy \`flow.duration_ms_total\` compatibility: ${report.legacyDurationTraces} trace${report.legacyDurationTraces === 1 ? "" : "s"} (interpreted as worker time).`);

	const renderBuckets = (title: string, buckets: Record<string, TraceReportBucket>) => {
		const entries = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return;
		lines.push("", title, "name | runs | execution | verified outcome | cost | tokens | elapsed | worker | critical | verified tpso | budget | vote-model | trace health");
		lines.push("--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:");
		for (const [name, bucket] of entries) {
			lines.push(
				`${name} | ${bucket.traces} | ${formatRate(bucket.executionSuccesses, bucket.traces)} | ${formatRate(bucket.outcomeSuccesses, bucket.verifiedOutcomes)} | $${bucket.costUsd.toFixed(4)} | ${formatTokens(bucket.tokens)} | ${(bucket.elapsedTimeMs / 1000).toFixed(1)}s | ${(bucket.workerTimeMs / 1000).toFixed(1)}s | ${bucket.criticalPathTraces ? `${(bucket.criticalPathMs / 1000).toFixed(1)}s` : "n/a"} | ${formatTpso(bucket)} | ${bucket.budgetHits} | ${bucket.sameModelVoteWarnings} | ${bucket.observedSpans}/${bucket.expectedSpans}${bucket.incompleteTraces ? ` (${bucket.incompleteTraces} incomplete)` : ""}`,
			);
		}
	};

	renderBuckets("By mode", report.byMode);
	renderBuckets("By trace label", report.byLabel);
	const eventKinds = Object.entries(report.eventKinds).sort(([a], [b]) => a.localeCompare(b));
	if (eventKinds.length > 0) {
		lines.push("", "Coordination events");
		for (const [kind, count] of eventKinds) lines.push(`- ${kind}: ${count}`);
	}
	const routeChoices = Object.entries(report.routeChoices).sort(([a], [b]) => a.localeCompare(b));
	if (routeChoices.length > 0) {
		lines.push("", "Route choices");
		for (const [choice, count] of routeChoices) lines.push(`- ${choice}: ${count}`);
	}
	return lines.join("\n");
}
