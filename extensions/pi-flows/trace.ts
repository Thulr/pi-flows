import { emptyUsage, type FlowMode, type FlowRunResult, type ModeOutput, type UsageStats } from "./types.ts";
import { isFailed, safePath } from "./sanitize.ts";
import { parseVerdict } from "./parse.ts";
import { debateRounds, searchTopology, successfulRuns } from "./topology.ts";
import { integrationControlText } from "./delegation.ts";
export { makeTraceSink, stableTraceIds, type TraceSink } from "./trace-sink.ts";

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
}

export interface TraceReport extends TraceReportBucket {
	source?: string;
	parseErrors: number;
	routeChoices: Record<string, number>;
	byMode: Record<string, TraceReportBucket>;
	byLabel: Record<string, TraceReportBucket>;
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
	};
}

export function addTraceBucket(bucket: TraceReportBucket, delta: TraceReportBucket): void {
	bucket.traces += delta.traces;
	bucket.successes += delta.successes;
	bucket.executionSuccesses += delta.executionSuccesses;
	bucket.verifiedOutcomes += delta.verifiedOutcomes;
	bucket.outcomeSuccesses += delta.outcomeSuccesses;
	bucket.costUsd += delta.costUsd;
	bucket.tokens += delta.tokens;
	bucket.durationMs += delta.durationMs;
	bucket.elapsedTimeMs += delta.elapsedTimeMs;
	bucket.workerTimeMs += delta.workerTimeMs;
	bucket.criticalPathMs += delta.criticalPathMs;
	bucket.criticalPathTraces += delta.criticalPathTraces;
	bucket.legacyDurationTraces += delta.legacyDurationTraces;
	bucket.budgetHits += delta.budgetHits;
	bucket.sameModelVoteWarnings += delta.sameModelVoteWarnings;
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
		};
		addTraceBucket(report, delta);
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

export function formatTraceReport(report: TraceReport): string {
	const lines = [
		`Trace report${report.source ? `: ${safePath(report.source)}` : ""}`,
		`Runs: ${report.traces}`,
		`Execution success: ${report.executionSuccesses}/${report.traces} (${formatRate(report.executionSuccesses, report.traces)})`,
		`Verified outcome success: ${report.outcomeSuccesses}/${report.verifiedOutcomes} (${formatRate(report.outcomeSuccesses, report.verifiedOutcomes)}; ${report.traces - report.verifiedOutcomes} unavailable)`,
		`Cost: $${report.costUsd.toFixed(4)}  Tokens: ${formatTokens(report.tokens)}`,
		`Elapsed: ${(report.elapsedTimeMs / 1000).toFixed(1)}s  Worker: ${(report.workerTimeMs / 1000).toFixed(1)}s  Critical path: ${(report.criticalPathMs / 1000).toFixed(1)}s (${report.criticalPathTraces}/${report.traces} available)`,
		`Verified TPSO: ${formatTpso({ ...emptyTraceBucket(), outcomeSuccesses: report.outcomeSuccesses, tokens: report.tokens })} tokens/success  Budget hits: ${report.budgetHits}  Same-model vote warnings: ${report.sameModelVoteWarnings}`,
	];
	if (report.parseErrors) lines.push(`Parse errors: ${report.parseErrors}`);
	if (report.legacyDurationTraces) lines.push(`Compatibility: legacy \`flow.duration_ms_total\` compatibility: ${report.legacyDurationTraces} trace${report.legacyDurationTraces === 1 ? "" : "s"} (interpreted as worker time).`);

	const renderBuckets = (title: string, buckets: Record<string, TraceReportBucket>) => {
		const entries = Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length === 0) return;
		lines.push("", title, "name | runs | execution | verified outcome | cost | tokens | elapsed | worker | critical | verified tpso | budget | vote-model");
		lines.push("--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:");
		for (const [name, bucket] of entries) {
			lines.push(
				`${name} | ${bucket.traces} | ${formatRate(bucket.executionSuccesses, bucket.traces)} | ${formatRate(bucket.outcomeSuccesses, bucket.verifiedOutcomes)} | $${bucket.costUsd.toFixed(4)} | ${formatTokens(bucket.tokens)} | ${(bucket.elapsedTimeMs / 1000).toFixed(1)}s | ${(bucket.workerTimeMs / 1000).toFixed(1)}s | ${bucket.criticalPathTraces ? `${(bucket.criticalPathMs / 1000).toFixed(1)}s` : "n/a"} | ${formatTpso(bucket)} | ${bucket.budgetHits} | ${bucket.sameModelVoteWarnings}`,
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

function runDuration(result: FlowRunResult | undefined): number {
	return Math.max(0, result?.durationMs ?? 0);
}

function fanoutThenTailCriticalPath(results: FlowRunResult[], fanoutCount: number): number {
	const fanout = results.slice(0, Math.max(0, fanoutCount));
	const tail = results.slice(fanout.length);
	return Math.max(0, ...fanout.map(runDuration)) + tail.reduce((sum, result) => sum + runDuration(result), 0);
}

function graphCriticalPath(params: any, results: FlowRunResult[]): number | undefined {
	const nodes = Array.isArray(params.graph?.nodes) ? params.graph.nodes : [];
	if (nodes.length === 0 || results.length < nodes.length) return undefined;
	const remaining = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
	const completed = new Set<string>();
	const pathById = new Map<string, number>();
	let resultIndex = 0;
	while (remaining.size > 0 && resultIndex < Math.min(nodes.length, results.length)) {
		const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dependency: string) => completed.has(dependency)));
		if (ready.length === 0) return undefined;
		for (const node of ready) {
			const dependencyPath = Math.max(0, ...(node.dependsOn ?? []).map((dependency: string) => pathById.get(dependency) ?? 0));
			pathById.set(node.id, dependencyPath + runDuration(results[resultIndex]));
			resultIndex += 1;
			remaining.delete(node.id);
		}
		for (const node of ready) completed.add(node.id);
	}
	const nodePath = Math.max(0, ...pathById.values());
	return nodePath + results.slice(resultIndex).reduce((sum, result) => sum + runDuration(result), 0);
}

function debateCriticalPath(params: any, results: FlowRunResult[]): number | undefined {
	const participantCount = Array.isArray(params.debate?.participants) ? params.debate.participants.length : 0;
	const rounds = debateRounds(params.debate);
	if (participantCount < 2 || results.length !== participantCount * rounds + 1) return undefined;
	let path = runDuration(results.at(-1));
	for (let round = 0; round < rounds; round += 1) {
		path += Math.max(...results.slice(round * participantCount, (round + 1) * participantCount).map(runDuration));
	}
	return path;
}

function searchCriticalPath(params: any, results: FlowRunResult[]): number | undefined {
	const { candidateCount: candidates, rounds } = searchTopology(params.search);
	let offset = 0;
	let path = 0;
	for (let round = 0; round < rounds; round += 1) {
		const generated = results.slice(offset, offset + candidates);
		if (generated.length !== candidates) return undefined;
		path += Math.max(...generated.map(runDuration));
		offset += candidates;
		const scoredCount = successfulRuns(generated).length;
		const scored = results.slice(offset, offset + scoredCount);
		if (scoredCount === 0 || scored.length !== scoredCount) return undefined;
		path += Math.max(...scored.map(runDuration));
		offset += scoredCount;
	}
	return results.length === offset + 1 ? path + runDuration(results[offset]) : undefined;
}

export function criticalPathForMode(mode: FlowMode, params: any, results: FlowRunResult[]): number | undefined {
	if (results.length === 0) return undefined;
	if (mode === "parallel") return Math.max(...results.map(runDuration));
	if (["single", "chain", "route", "loop", "workflow"].includes(mode)) return results.reduce((sum, result) => sum + runDuration(result), 0);
	if (mode === "evaluate") {
		if (typeof params.evaluate?.checkCommand === "string" && params.evaluate.checkCommand.trim()) return undefined;
		return !Array.isArray(params.evaluate?.redteam) || params.evaluate.redteam.length <= 1 ? results.reduce((sum, result) => sum + runDuration(result), 0) : undefined;
	}
	if (mode === "graph") return graphCriticalPath(params, results);
	if (mode === "debate") return debateCriticalPath(params, results);
	if (mode === "search") return searchCriticalPath(params, results);
	if (mode === "vote") {
		const voterCount = Array.isArray(params.vote?.voters) && params.vote.voters.length > 0 ? params.vote.voters.length : Math.floor(params.vote?.count ?? 3);
		return voterCount > 0 ? fanoutThenTailCriticalPath(results, voterCount) : undefined;
	}
	if (mode === "dossier") {
		const sectionCount = Array.isArray(params.dossier?.sections) ? params.dossier.sections.length : 0;
		return sectionCount > 0 ? fanoutThenTailCriticalPath(results, sectionCount) : undefined;
	}
	if (mode === "worktree") {
		const workerCount = Array.isArray(params.worktree?.tasks) ? params.worktree.tasks.length : 0;
		return workerCount > 0 ? fanoutThenTailCriticalPath(results, workerCount) : undefined;
	}
	return undefined;
}

function acceptedVerifierResult(params: any, output: ModeOutput): FlowRunResult | undefined {
	if (!params.orchestrate?.verify?.agent) return undefined;
	const verifier = output.details.results.at(-1);
	return verifier
		&& verifier.agent === params.orchestrate.verify.agent
		&& !isFailed(verifier)
		&& verifier.handoff
		? verifier
		: undefined;
}

function verifiedOutcome(mode: FlowMode, params: any, output: ModeOutput): { verified: boolean; success?: boolean } {
	const text = output.content[0]?.type === "text" ? output.content[0].text : "";
	if (mode === "evaluate") {
		if (/^Flow evaluate: PASS\b/.test(text)) return { verified: true, success: true };
		if (/^Flow evaluate: did not pass\b/.test(text)) return { verified: true, success: false };
	}
	if (mode === "orchestrate" && params.orchestrate?.verify?.agent) {
		const verifier = acceptedVerifierResult(params, output);
		if (verifier) {
			return { verified: true, success: parseVerdict(integrationControlText(verifier)) === "pass" };
		}
	}
	return { verified: false };
}

export function traceSummaryAttributes(mode: FlowMode, params: any, output: ModeOutput): Record<string, unknown> {
	const results = output.details.results.filter((result) => result.exitCode !== -1);
	const usage = flowUsageTotals(results);
	const failed = results.filter(isFailed);
	const workerTimeMs = results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0);
	const criticalPathMs = criticalPathForMode(mode, params, results);
	const outcome = verifiedOutcome(mode, params, output);
	const attrs: Record<string, unknown> = {
		"flow.child_count": results.length,
		"flow.failed_child_count": failed.length,
		"flow.cost_usd_total": usage.cost,
		"flow.token_count_total": usage.input + usage.output,
		"flow.worker_time_ms": workerTimeMs,
		"flow.critical_path_available": criticalPathMs !== undefined,
		"flow.outcome_verified": outcome.verified,
		"flow.budget_exceeded": results.some((result) => result.error?.code === "BUDGET_EXCEEDED") || output.details.error?.code === "BUDGET_EXCEEDED",
	};
	if (criticalPathMs !== undefined) attrs["flow.critical_path_ms"] = criticalPathMs;
	if (outcome.success !== undefined) attrs["flow.outcome_success"] = outcome.success;
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
		const verifier = acceptedVerifierResult(params, output);
		if (verifier) attrs["flow.verify_verdict"] = parseVerdict(integrationControlText(verifier));
	}
	return attrs;
}
