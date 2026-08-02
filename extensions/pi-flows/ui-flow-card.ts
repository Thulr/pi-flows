import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { budgetDisclosureLines, formatBudgetCeiling } from "./budget-disclosure.ts";
import { safePath } from "./sanitize.ts";
import { formatTokens } from "./trace.ts";
import type { BudgetCeiling, FlowMode, UsageStats } from "./types.ts";

/**
 * The durable flow card: the `pi-flows.run` session entry (the entry type
 * keeps its pre-glossary name for session compatibility) rendered as a
 * persistent summary of what a flow actually did — status, per-run
 * durations, cost rollup, and the trace link. Unlike the live tool row this
 * survives session reloads: the renderer re-runs over the stored entry data,
 * so everything it needs must be *in* the entry (no in-memory registry).
 */

export interface FlowRunEntryResult {
	agent: string;
	role?: string;
	agentSource: string;
	exitCode: number;
	stopReason?: string;
	errorCode?: string;
	budgetCeiling?: BudgetCeiling;
	model?: string;
	durationMs?: number;
	usage?: Partial<UsageStats>;
}

export interface FlowRunEntryData {
	version: string;
	mode: FlowMode;
	preset?: string;
	presetOutcome?: "CLEAN" | "FINDINGS" | "PARTIAL";
	status: "ok" | "partial" | "error";
	errorCode?: string;
	results: FlowRunEntryResult[];
	/** Trace evidence pointer, when the run exported one. */
	trace?: { traceFile: string; health: string };
	/** Configured ceilings persisted so session reloads retain their authority. */
	budgetCeilings?: BudgetCeiling[];
}

function entryResultFailed(result: FlowRunEntryResult): boolean {
	return result.exitCode !== 0 || result.errorCode !== undefined;
}

/** Proportional duration bar; the longest child fills the track. */
export function durationBar(durationMs: number, maxDurationMs: number, width = 14): string {
	if (width <= 0 || maxDurationMs <= 0 || durationMs <= 0) return "░".repeat(Math.max(0, width));
	const filled = Math.min(width, Math.max(1, Math.round((durationMs / maxDurationMs) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatDuration(durationMs: number): string {
	if (durationMs >= 60000) {
		const minutes = Math.floor(durationMs / 60000);
		return `${minutes}m ${Math.round((durationMs - minutes * 60000) / 1000)}s`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function entryTotals(results: FlowRunEntryResult[]): { tokens: number; cost: number } {
	let tokens = 0;
	let cost = 0;
	for (const result of results) {
		tokens += (result.usage?.input || 0) + (result.usage?.output || 0);
		cost += result.usage?.cost || 0;
	}
	return { tokens, cost };
}

/** Card lines. First line is the header; `expanded` adds per-run failure detail. */
export function flowCardLines(data: FlowRunEntryData, theme: Theme, expanded: boolean): string[] {
	const statusIcon = data.status === "ok" ? theme.fg("success", "▣") : data.status === "partial" ? theme.fg("warning", "▣") : theme.fg("error", "▣");
	const statusText = data.status === "error" && data.errorCode ? `${data.status}:${data.errorCode}` : data.status;
	const statusColor = data.status === "ok" ? "success" : data.status === "partial" ? "warning" : "error";
	const totals = entryTotals(data.results);
	const maxDuration = Math.max(0, ...data.results.map((result) => result.durationMs ?? 0));

	const headerParts = [`${data.results.length} agent${data.results.length === 1 ? "" : "s"}`];
	if (totals.tokens) headerParts.push(`${formatTokens(totals.tokens)} tok`);
	if (totals.cost) headerParts.push(`$${totals.cost.toFixed(4)}`);
	if (maxDuration) headerParts.push(formatDuration(maxDuration));
	const lines = [
		`${statusIcon} ${theme.fg("toolTitle", theme.bold(`flow ${data.preset ?? data.mode}`))} ${theme.fg(statusColor, data.presetOutcome ?? statusText)}${headerParts.length ? theme.fg("muted", ` · ${headerParts.join(" · ")}`) : ""}`,
		...budgetDisclosureLines(data.budgetCeilings).map((line) => theme.fg("muted", line)),
	];

	const name = (result: FlowRunEntryResult) => result.role ? `${result.role} (${result.agent})` : result.agent;
	const nameWidth = Math.min(28, Math.max(4, ...data.results.map((result) => name(result).length)));
	for (const result of data.results) {
		const failed = entryResultFailed(result);
		const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		let line = `${icon} ${theme.fg("accent", name(result).padEnd(nameWidth))} ${theme.fg("dim", durationBar(result.durationMs ?? 0, maxDuration))}`;
		const meta: string[] = [];
		if (result.durationMs) meta.push(formatDuration(result.durationMs));
		const tokens = (result.usage?.input || 0) + (result.usage?.output || 0);
		if (tokens) meta.push(`${formatTokens(tokens)} tok`);
		if (result.usage?.cost) meta.push(`$${result.usage.cost.toFixed(4)}`);
		if (result.model) meta.push(result.model);
		if (meta.length) line += ` ${theme.fg("muted", meta.join(" · "))}`;
		if (failed && !expanded) {
			const failure = `${result.errorCode ?? result.stopReason ?? "failed"}${result.budgetCeiling ? ` · ${formatBudgetCeiling(result.budgetCeiling)}` : ""}`;
			line += ` ${theme.fg("error", failure)}`;
		}
		lines.push(line);
		if (expanded && failed) {
			const bindingBudget = result.budgetCeiling ? ` · ${formatBudgetCeiling(result.budgetCeiling)}` : "";
			lines.push(`  ${theme.fg("error", `${result.errorCode ?? "failed"}${bindingBudget}${result.stopReason ? ` · stop: ${result.stopReason}` : ""} · exit ${result.exitCode}`)}`);
		}
	}

	if (data.trace) {
		const healthColor = data.trace.health === "complete" ? "success" : "warning";
		lines.push(`${theme.fg("muted", "trace:")} ${theme.fg("dim", safePath(data.trace.traceFile) ?? data.trace.traceFile)} ${theme.fg(healthColor, `(${data.trace.health})`)}`);
	}
	if (!expanded && data.results.some(entryResultFailed)) lines.push(theme.fg("muted", "ctrl+o for failure detail"));
	return lines;
}

/** Entry renderer body for `pi-flows.run`. Returns undefined for entries this version cannot read. */
export function renderFlowCard(data: unknown, expanded: boolean, theme: Theme): Text | undefined {
	if (!data || typeof data !== "object" || !Array.isArray((data as FlowRunEntryData).results)) return undefined;
	return new Text(flowCardLines(data as FlowRunEntryData, theme, expanded).join("\n"), 0, 0);
}
