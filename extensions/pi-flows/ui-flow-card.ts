import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text, getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { budgetDisclosureLines, formatBudgetCeiling } from "./budget-disclosure.ts";
import { safePath } from "./sanitize.ts";
import { formatTokens } from "./trace.ts";
import type { BudgetCeiling, FlowMode, UsageStats } from "./types.ts";
import { flowGanttPng, type GanttImage } from "./ui-gantt.ts";
import { chip, formatDuration, runDisplayName, treeGuide } from "./ui-style.ts";

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
	/** Epoch ms the child spawned, when the writer recorded it; lets the card draw the real concurrency timeline. */
	startedAtMs?: number;
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

function entryTotals(results: FlowRunEntryResult[]): { tokens: number; cost: number } {
	let tokens = 0;
	let cost = 0;
	for (const result of results) {
		tokens += (result.usage?.input || 0) + (result.usage?.output || 0);
		cost += result.usage?.cost || 0;
	}
	return { tokens, cost };
}

export interface FlowCardLineOptions {
	/** Set when a Gantt image carries the timing story, so the rows drop the text duration track instead of restating it beside the chart. */
	omitDurationBars?: boolean;
}

/** Card lines. First line is the header; `expanded` adds per-run failure detail. */
export function flowCardLines(data: FlowRunEntryData, theme: Theme, expanded: boolean, options: FlowCardLineOptions = {}): string[] {
	// Older entries (and external writers) may persist status=ok alongside a
	// non-clean preset outcome. Derive the durable presentation defensively so
	// FINDINGS/PARTIAL can never render as green success.
	const status = data.status === "ok" && (data.presetOutcome === "FINDINGS" || data.presetOutcome === "PARTIAL") ? "partial" : data.status;
	const statusColor = status === "ok" ? "success" : status === "partial" ? "warning" : "error";
	// A verdict reached before the run failed (a denied finalize checkpoint, an
	// incomplete trace) is no longer the headline: the error code is what the
	// reader can act on.
	const verdict = status === "error" ? `✗ ${data.errorCode ?? "error"}` : status === "partial" ? `◐ ${data.presetOutcome ?? "partial"}` : `✓ ${data.presetOutcome ?? "ok"}`;
	const totals = entryTotals(data.results);
	const maxDuration = Math.max(0, ...data.results.map((result) => result.durationMs ?? 0));

	const headerParts = [`${data.results.length} agent${data.results.length === 1 ? "" : "s"}`];
	if (totals.tokens) headerParts.push(`${formatTokens(totals.tokens)} tok`);
	if (totals.cost) headerParts.push(`$${totals.cost.toFixed(4)}`);
	if (maxDuration) headerParts.push(formatDuration(maxDuration));
	const lines = [
		`${chip(theme, statusColor, verdict)} ${theme.fg("toolTitle", theme.bold(`flow ${data.preset ?? data.mode}`))}${headerParts.length ? theme.fg("muted", ` · ${headerParts.join(" · ")}`) : ""}`,
		...budgetDisclosureLines(data.budgetCeilings).map((line) => theme.fg("muted", line)),
	];

	const nameWidth = Math.min(28, Math.max(4, ...data.results.map((result) => runDisplayName(result).length)));
	data.results.forEach((result, index) => {
		const failed = entryResultFailed(result);
		const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		// The duration track carries the row's outcome color so a failed child
		// reads as a red bar at a glance, not only as a trailing error code.
		let line = `${theme.fg("dim", treeGuide(index, data.results.length))} ${icon} ${theme.fg("accent", runDisplayName(result).padEnd(nameWidth))}`;
		if (!options.omitDurationBars) line += ` ${theme.fg(failed ? "error" : "muted", durationBar(result.durationMs ?? 0, maxDuration))}`;
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
	});

	if (data.trace) {
		const healthColor = data.trace.health === "complete" ? "success" : "warning";
		// The displayed path stays home-redacted; an absolute path additionally
		// becomes an OSC 8 file:// hyperlink, which supporting terminals open on
		// click and every other terminal renders as the plain text.
		//
		// Deliberate: the URL carries the real path. The redaction invariant
		// protects returned content/details — what leaves the flow — while this
		// link exists only in the local terminal stream, and a file:// URL built
		// from the redacted `~` form would not open. The cost is that raw
		// terminal captures (asciinema, script) record the un-redacted path
		// inside the invisible escape.
		const display = safePath(data.trace.traceFile) ?? data.trace.traceFile;
		const link = data.trace.traceFile.startsWith("/") ? hyperlink(display, `file://${encodeURI(data.trace.traceFile)}`) : display;
		lines.push(`${theme.fg("muted", "trace:")} ${theme.fg("dim", link)} ${theme.fg(healthColor, `(${data.trace.health})`)}`);
	}
	if (!expanded && data.results.some(entryResultFailed)) lines.push(theme.fg("muted", "ctrl+o for failure detail"));
	return lines;
}

/**
 * Per-entry cache of the rendered chart, weakly keyed by the entry data
 * object so a session's cards encode their PNG once. Caching the Image
 * component keeps its Kitty image ID stable across repaints, which is what
 * stops the terminal from re-receiving the bitmap every frame.
 *
 * Staleness is keyed on a resolved theme *color*, not the theme reference:
 * pi hands every renderer one stable proxy whose target swaps on a theme
 * switch, so object identity would neither invalidate on switch nor ever
 * miss between repaints. One color's ANSI is the cheapest observable that
 * changes exactly when the palette does.
 */
const ganttCache = new WeakMap<object, { colorKey: string; gantt: GanttImage | undefined; image?: Image }>();

function themeColorKey(theme: Theme): string {
	return (theme as { getFgAnsi?: (color: string) => string }).getFgAnsi?.("success") ?? "";
}

function ganttImageFor(data: FlowRunEntryData, theme: Theme): Image | undefined {
	if (!getCapabilities().images) return undefined;
	const colorKey = themeColorKey(theme);
	let cached = ganttCache.get(data);
	if (!cached || cached.colorKey !== colorKey) {
		cached = { colorKey, gantt: flowGanttPng(data.results, theme) };
		ganttCache.set(data, cached);
	}
	if (!cached.gantt) return undefined;
	cached.image ??= new Image(
		cached.gantt.base64,
		"image/png",
		{ fallbackColor: (text: string) => theme.fg("dim", text) },
		{ maxWidthCells: cached.gantt.maxWidthCells, filename: "flow-timeline.png" },
		cached.gantt.dimensions,
	);
	return cached.image;
}

/** Entry renderer body for `pi-flows.run`. Returns undefined for entries this version cannot read. */
export function renderFlowCard(data: unknown, expanded: boolean, theme: Theme): Text | Container | undefined {
	if (!data || typeof data !== "object" || !Array.isArray((data as FlowRunEntryData).results)) return undefined;
	const entry = data as FlowRunEntryData;
	// The image is a progressive enhancement: only terminals that declare an
	// inline-image protocol get it, and everything it shows also exists in the
	// text card, so no reader is ever worse off than the fallback.
	const image = ganttImageFor(entry, theme);
	if (!image) return new Text(flowCardLines(entry, theme, expanded).join("\n"), 0, 0);

	const lines = flowCardLines(entry, theme, expanded, { omitDurationBars: true });
	const headerCount = 1 + budgetDisclosureLines(entry.budgetCeilings).length;
	const container = new Container();
	container.addChild(new Text(lines.slice(0, headerCount).join("\n"), 0, 0));
	container.addChild(image);
	if (lines.length > headerCount) container.addChild(new Text(lines.slice(headerCount).join("\n"), 0, 0));
	return container;
}
