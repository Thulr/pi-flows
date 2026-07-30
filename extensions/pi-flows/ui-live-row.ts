import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { flowAgentActivity, flowAgentState } from "./inspector.ts";
import { capModelVisibleText, isFailed, resultText } from "./sanitize.ts";
import { flowUsageTotals, formatTokens, formatUsage } from "./trace.ts";
import type { FlowAgent, FlowDetails, FlowRunResult } from "./types.ts";

/**
 * The live tool-row board: the `flow` tool row is the primary progress surface,
 * so while children run it renders per-run state, each child's current
 * activity, and a cost rollup — updating in place instead of a frozen snapshot.
 *
 * Everything that produces *strings* is exported and pure so offline tests can
 * assert on content without a TUI; the component wrappers at the bottom stay
 * thin.
 */

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

/** Rows shown for agents in the collapsed view before "+n more". */
export const COLLAPSED_AGENT_ROWS = 8;

export function spinnerFrame(tick: number, offset = 0): string {
	const index = (Math.trunc(tick) + Math.trunc(offset)) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[(index + SPINNER_FRAMES.length) % SPINNER_FRAMES.length] as string;
}

export function progressBar(settled: number, total: number, width = 12): string {
	if (total <= 0 || width <= 0) return "";
	const filled = Math.min(width, Math.max(0, Math.round((settled / total) * width)));
	return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/**
 * The one-line "what is this child doing right now" summary for a running
 * agent. Capped so a chatty child cannot wrap its row into a paragraph.
 */
export function currentActivityText(result: FlowRunResult, redactSecrets: boolean, maxLength = 72): string {
	const items = flowAgentActivity(result, redactSecrets);
	const last = items[items.length - 1];
	if (!last) return "waiting for activity…";
	const prefix = last.kind === "tool" ? "→ " : last.kind === "result" ? "← " : "";
	const text = `${prefix}${last.text}`;
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Renderer-row ticker: keeps a repaint timer alive exactly while the run is
 * partial. Timer handles live in the tool row's shared renderer state, so the
 * final (non-partial) render is also the cleanup point — without it the
 * interval would outlive the row and keep invalidating a settled component.
 */
export interface RowTickerState {
	tick?: number;
	timer?: ReturnType<typeof setInterval>;
}

export function ensureRowTicker(
	state: RowTickerState,
	running: boolean,
	invalidate: () => void,
	intervalMs = 120,
	schedule: typeof setInterval = setInterval,
	cancel: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
): void {
	state.tick ??= 0;
	if (running && state.timer === undefined) {
		state.timer = schedule(() => {
			state.tick = ((state.tick ?? 0) + 1) % 100000;
			invalidate();
		}, intervalMs);
		state.timer.unref?.();
	} else if (!running && state.timer !== undefined) {
		cancel(state.timer);
		state.timer = undefined;
	}
}

function agentIcon(result: FlowRunResult, index: number, tick: number, theme: Theme): string {
	const state = flowAgentState(result);
	if (state === "queued") return theme.fg("muted", "◌");
	if (state === "running") return theme.fg("warning", spinnerFrame(tick, index * 2));
	return state === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function headerIcon(details: FlowDetails, settled: number, failed: number, tick: number, theme: Theme): string {
	if (details.error) return theme.fg("error", "✗");
	if (settled < details.results.length) return theme.fg("warning", spinnerFrame(tick));
	return failed ? theme.fg("warning", "◐") : theme.fg("success", "✓");
}

function totalsText(details: FlowDetails): string {
	const usage = flowUsageTotals(details.results);
	const parts: string[] = [];
	const tokens = (usage.input || 0) + (usage.output || 0);
	if (tokens) parts.push(`${formatTokens(tokens)} tok`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

export interface LiveBoardOptions {
	tick: number;
	redactSecrets: boolean;
}

/** Collapsed-view lines for a run in progress or settled. First line is the header. */
export function flowLiveBoardLines(details: FlowDetails, theme: Theme, options: LiveBoardOptions): string[] {
	const settled = details.results.filter((item) => item.exitCode !== -1).length;
	const failed = details.results.filter((item) => item.exitCode !== -1 && isFailed(item)).length;
	const total = details.results.length;
	const running = settled < total;

	let header = `${headerIcon(details, settled, failed, options.tick, theme)} ${theme.fg("toolTitle", theme.bold(`flow ${details.mode}`))}`;
	// The settled/total counter, progress bar, and rollup exist to summarize a
	// fan-out. With one child they only restate (or worse, appear to
	// contradict) the agent line below — "0/1" reads as stuck, and the rollup
	// counts input+output while the agent line also shows cache traffic.
	if (total > 1) {
		header += ` ${theme.fg("accent", `${settled}/${total}`)}`;
		const bar = progressBar(settled, total);
		if (bar && running) header += ` ${theme.fg("dim", bar)}`;
		const totals = totalsText(details);
		if (totals) header += ` ${theme.fg("muted", totals)}`;
	}
	const lines = [header];

	const nameWidth = Math.min(16, Math.max(4, ...details.results.map((item) => item.agent.length)));
	details.results.slice(0, COLLAPSED_AGENT_ROWS).forEach((item, index) => {
		let line = `${agentIcon(item, index, options.tick, theme)} ${theme.fg("accent", item.agent.padEnd(nameWidth))}`;
		const usage = formatUsage(item.usage, item.model, item.durationMs);
		if (usage) line += ` ${theme.fg("dim", usage)}`;
		const state = flowAgentState(item);
		if (state === "running") line += `  ${theme.fg("muted", currentActivityText(item, options.redactSecrets))}`;
		else if (state === "queued") line += `  ${theme.fg("muted", "queued")}`;
		else if (state === "failed") line += `  ${theme.fg("error", item.error?.code ?? item.stopReason ?? "failed")}`;
		lines.push(line);
	});
	if (total > COLLAPSED_AGENT_ROWS) lines.push(theme.fg("muted", `... +${total - COLLAPSED_AGENT_ROWS} more`));
	if (details.error) lines.push(theme.fg("error", `error: ${details.error.code}`));
	lines.push(theme.fg("muted", running ? "ctrl+o expand · F8 fleet panel" : "ctrl+o expand"));
	return lines;
}

type SummarizeAgents = (agents: FlowAgent[], issues: NonNullable<FlowDetails["discoveryIssues"]>) => string;

export interface FlowToolResultLike {
	content: Array<{ type: string; text?: string }>;
	details?: FlowDetails;
}

export interface FlowRenderContextLike {
	invalidate: () => void;
	state: RowTickerState;
	lastComponent?: unknown;
}

/**
 * The `flow` tool's renderResult body. Collapsed while running: the live
 * board. Expanded (or settled + expanded): full per-run detail with
 * markdown outputs, matching the pre-live behavior.
 */
export function renderFlowResultRow(
	result: FlowToolResultLike,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: FlowRenderContextLike,
	summarizeAgentsFn: SummarizeAgents,
): Container | Text {
	const details = result.details;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? (text.text ?? "") : "(no output)", 0, 0);
	}

	if (details.mode === "list" || details.mode === "config") {
		const text = result.content[0];
		return new Text(text?.type === "text" ? (text.text ?? "") : summarizeAgentsFn((details.agents ?? []) as FlowAgent[], details.discoveryIssues ?? []), 0, 0);
	}

	const settled = details.results.filter((item) => item.exitCode !== -1).length;
	const running = options.isPartial || settled < details.results.length;
	ensureRowTicker(context.state, running, context.invalidate);

	if (!options.expanded) {
		const lines = flowLiveBoardLines(details, theme, {
			tick: context.state.tick ?? 0,
			redactSecrets: details.config?.redactSecretsDefault ?? true,
		});
		const previous = context.lastComponent;
		if (previous instanceof Text) {
			previous.setText(lines.join("\n"));
			return previous;
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	const failed = details.results.filter((item) => item.exitCode !== -1 && isFailed(item)).length;
	const container = new Container();
	container.addChild(new Text(`${headerIcon(details, settled, failed, context.state.tick ?? 0, theme)} ${theme.fg("toolTitle", theme.bold(`flow ${details.mode}`))}`, 0, 0));
	const mdTheme = getMarkdownTheme();

	details.results.forEach((item, index) => {
		container.addChild(new Spacer(1));
		container.addChild(new Text(`${agentIcon(item, index, context.state.tick ?? 0, theme)} ${theme.fg("accent", item.agent)} ${theme.fg("muted", `(${item.agentSource})`)}`, 0, 0));
		container.addChild(new Text(theme.fg("dim", item.task), 0, 0));
		const usage = formatUsage(item.usage, item.model, item.durationMs);
		if (usage) container.addChild(new Text(theme.fg("muted", usage), 0, 0));
		const output = resultText(item).trim();
		if (output) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(capModelVisibleText(output), 0, 0, mdTheme));
		}
	});

	return container;
}
