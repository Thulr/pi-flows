#!/usr/bin/env node
// Summarize pi-flows OpenInference-shaped JSONL traces.
// This source-repo helper is intentionally not packaged; the installed extension
// also exposes the same user-facing path via `/flows report [trace-file]`.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function safePath(candidate) {
	const home = homedir();
	return home && candidate.startsWith(home) ? `~${candidate.slice(home.length)}` : candidate;
}

function formatTokens(count) {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function num(span, key) {
	const value = span?.attributes?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(span, key) {
	const value = span?.attributes?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function bool(span, key) {
	return span?.attributes?.[key] === true;
}

function parseJsonl(text) {
	const spans = [];
	let parseErrors = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			spans.push(JSON.parse(line));
		} catch {
			parseErrors += 1;
		}
	}
	return { spans, parseErrors };
}

function emptyBucket() {
	return { traces: 0, successes: 0, costUsd: 0, tokens: 0, durationMs: 0, budgetHits: 0, sameModelVoteWarnings: 0 };
}

function add(bucket, delta) {
	for (const key of Object.keys(bucket)) bucket[key] += delta[key];
}

function summarize(spans, parseErrors, source) {
	const byTrace = new Map();
	for (const span of spans) {
		if (!span.trace_id) continue;
		byTrace.set(span.trace_id, [...(byTrace.get(span.trace_id) ?? []), span]);
	}
	const report = {
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
		const root = traceSpans.find((span) => span.parent_span_id === null);
		const childSpans = root ? traceSpans.filter((span) => span !== root) : traceSpans;
		const representative = root ?? traceSpans[0] ?? {};
		const costUsd = num(root, "flow.cost_usd_total") || childSpans.reduce((sum, span) => sum + num(span, "flow.cost_usd"), 0);
		const tokens = num(root, "flow.token_count_total") || childSpans.reduce((sum, span) => sum + num(span, "llm.token_count.prompt") + num(span, "llm.token_count.completion"), 0);
		const durationMs =
			num(root, "flow.duration_ms_total") ||
			(root?.start_time_unix_ms !== undefined && root?.end_time_unix_ms !== undefined ? Math.max(0, root.end_time_unix_ms - root.start_time_unix_ms) : 0);
		const success = (root?.status?.code ?? "OK") === "OK" && !childSpans.some((span) => span.status?.code === "ERROR");
		const delta = {
			traces: 1,
			successes: success ? 1 : 0,
			costUsd,
			tokens,
			durationMs,
			budgetHits: bool(root, "flow.budget_exceeded") || childSpans.some((span) => str(span, "flow.error_code") === "BUDGET_EXCEEDED") ? 1 : 0,
			sameModelVoteWarnings: bool(root, "flow.same_model_vote_warning") ? 1 : 0,
		};
		const mode = str(representative, "flow.mode") ?? "unknown";
		const label = str(representative, "flow.trace_label") ?? "(unlabeled)";
		const routeChoice = str(root, "flow.route_choice");
		report.traces += 1;
		report.successes += delta.successes;
		report.costUsd += costUsd;
		report.tokens += tokens;
		report.durationMs += durationMs;
		report.budgetHits += delta.budgetHits;
		report.sameModelVoteWarnings += delta.sameModelVoteWarnings;
		if (routeChoice) report.routeChoices[routeChoice] = (report.routeChoices[routeChoice] ?? 0) + 1;
		report.byMode[mode] ??= emptyBucket();
		add(report.byMode[mode], delta);
		report.byLabel[label] ??= emptyBucket();
		add(report.byLabel[label], delta);
	}
	return report;
}

function rate(num, den) {
	return den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "n/a";
}

function tpso(bucket) {
	return bucket.successes > 0 ? (bucket.tokens / bucket.successes).toFixed(0) : "n/a";
}

function render(report) {
	const lines = [
		`Trace report: ${safePath(report.source)}`,
		`Runs: ${report.traces} (${report.successes} succeeded, ${rate(report.successes, report.traces)} success)`,
		`Cost: $${report.costUsd.toFixed(4)}  Tokens: ${formatTokens(report.tokens)}  Duration: ${(report.durationMs / 1000).toFixed(1)}s`,
		`TPSO: ${tpso({ successes: report.successes, tokens: report.tokens })} tokens/success  Budget hits: ${report.budgetHits}  Same-model vote warnings: ${report.sameModelVoteWarnings}`,
	];
	if (report.parseErrors) lines.push(`Parse errors: ${report.parseErrors}`);
	const buckets = (title, table) => {
		const entries = Object.entries(table).sort(([a], [b]) => a.localeCompare(b));
		if (!entries.length) return;
		lines.push("", title, "name | runs | success | cost | tokens | tpso | budget | vote-model");
		lines.push("--- | ---: | ---: | ---: | ---: | ---: | ---: | ---:");
		for (const [name, bucket] of entries) lines.push(`${name} | ${bucket.traces} | ${rate(bucket.successes, bucket.traces)} | $${bucket.costUsd.toFixed(4)} | ${formatTokens(bucket.tokens)} | ${tpso(bucket)} | ${bucket.budgetHits} | ${bucket.sameModelVoteWarnings}`);
	};
	buckets("By mode", report.byMode);
	buckets("By trace label", report.byLabel);
	const routeChoices = Object.entries(report.routeChoices).sort(([a], [b]) => a.localeCompare(b));
	if (routeChoices.length) {
		lines.push("", "Route choices");
		for (const [choice, count] of routeChoices) lines.push(`- ${choice}: ${count}`);
	}
	return lines.join("\n");
}

const traceFile = path.resolve(process.cwd(), process.argv[2] ?? process.env.PI_FLOWS_TRACE_FILE ?? "flow-trace.jsonl");
try {
	const parsed = parseJsonl(readFileSync(traceFile, "utf8"));
	console.log(render(summarize(parsed.spans, parsed.parseErrors, traceFile)));
} catch (error) {
	console.error(`Could not read flow trace report from ${safePath(traceFile)}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
