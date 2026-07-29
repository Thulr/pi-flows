import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { flowAgentActivity, flowAgentState, oneLine, supportsTui, type FlowRunRegistry, type InspectorContext, type LiveFlowRun } from "./inspector.ts";
import { formatUsage } from "./trace.ts";
import { spinnerFrame } from "./ui-live-row.ts";
import type { FlowBudget, FlowRunResult } from "./types.ts";

/**
 * The mission-control fleet panel: a persistent, *non-capturing* overlay that
 * shows every live flow run at once — per-agent state, each running child's
 * current activity, and budget burn-down. Because the overlay never captures
 * focus, the editor keeps input the whole time: the panel is ambient
 * monitoring, not a modal. F8 toggles it; `/flows inspect` remains the focused
 * single-agent drill-down.
 */

export function budgetLine(budget: FlowBudget | undefined, theme: Theme): string | undefined {
	if (!budget?.maxCostUsd) return undefined;
	const spent = budget.spentCost;
	const max = budget.maxCostUsd;
	const ratio = Math.min(1, max > 0 ? spent / max : 1);
	const width = 12;
	const filled = Math.round(ratio * width);
	const color = ratio >= 0.9 ? "error" : ratio >= 0.6 ? "warning" : "success";
	return `${theme.fg(color, "▰".repeat(filled) + "▱".repeat(width - filled))} ${theme.fg("muted", `$${spent.toFixed(4)} / $${max.toFixed(2)} budget`)}`;
}

function agentStateColor(state: ReturnType<typeof flowAgentState>): "error" | "success" | "muted" | "warning" {
	return state === "failed" ? "error" : state === "completed" ? "success" : state === "queued" ? "muted" : "warning";
}

/** Panel body lines for one run (no borders). Exported for offline tests. */
export function fleetRunLines(run: LiveFlowRun, theme: Theme, tick: number): string[] {
	const done = run.details.results.filter((result) => result.exitCode !== -1).length;
	const lines = [
		`${theme.fg("toolTitle", theme.bold(`flow ${run.mode}`))} ${theme.fg("accent", `${done}/${run.details.results.length}`)}`,
	];
	const budget = budgetLine(run.budget, theme);
	if (budget) lines.push(budget);

	const nameWidth = Math.min(16, Math.max(4, ...run.details.results.map((result: FlowRunResult) => result.agent.length)));
	run.details.results.forEach((result, index) => {
		const state = flowAgentState(result);
		const icon = state === "running" ? theme.fg("warning", spinnerFrame(tick, index * 2)) : state === "queued" ? theme.fg("muted", "◌") : state === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const usage = oneLine(formatUsage(result.usage, undefined, result.durationMs), 40, run.redactSecrets);
		lines.push(`${icon} ${theme.fg("accent", oneLine(result.agent, nameWidth, run.redactSecrets).padEnd(nameWidth))} ${theme.fg(agentStateColor(state), state.padEnd(9))}${usage ? ` ${theme.fg("dim", usage)}` : ""}`);
		if (state === "running") {
			const items = flowAgentActivity(result, run.redactSecrets);
			const last = items[items.length - 1];
			if (last) lines.push(`  ${theme.fg("muted", `└ ${last.kind === "tool" ? "→ " : last.kind === "result" ? "← " : ""}${oneLine(last.text, 64, run.redactSecrets)}`)}`);
		}
		if (state === "failed") lines.push(`  ${theme.fg("error", `└ ${result.error?.code ?? result.stopReason ?? "failed"}`)}`);
	});
	if (run.details.error) lines.push(theme.fg("error", `error: ${run.details.error.code}`));
	return lines;
}

export class FleetPanel {
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private tick = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly registry: FlowRunRegistry,
		private readonly done: () => void,
	) {
		this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
		this.timer = setInterval(() => {
			this.tick = (this.tick + 1) % 100000;
			if (this.registry.activeRuns().some((run) => run.details.results.some((result) => result.exitCode === -1))) this.tui.requestRender();
		}, 120);
		this.timer.unref?.();
	}

	handleInput(data: string): void {
		if (this.matchesCancel(data) || matchesKey(data, Key.f8)) this.done();
	}

	private matchesCancel(data: string): boolean {
		try { return this.keybindings.matches(data, "tui.select.cancel"); } catch { return matchesKey(data, Key.escape as KeyId); }
	}

	private cancelKeyText(): string {
		try { return this.keybindings.getKeys("tui.select.cancel")[0] ?? "esc"; } catch { return "esc"; }
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (width < 3) return [truncateToWidth("…", width, "")];
		const innerWidth = width - 2;
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content = "") => {
			const clipped = truncateToWidth(` ${content}`, innerWidth, "…");
			return `${border("│")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${border("│")}`;
		};
		const separator = () => `${border("├")}${border("─".repeat(innerWidth))}${border("┤")}`;
		const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];

		const active = this.registry.activeRuns();
		if (active.length === 0) {
			const last = this.registry.lastFinishedRun();
			if (last) {
				lines.push(row(this.theme.fg("muted", "no active flow runs · last run:")));
				for (const line of fleetRunLines(last, this.theme, this.tick)) lines.push(row(line));
			} else {
				lines.push(row(this.theme.fg("muted", "no active flow runs")));
			}
		} else {
			active.forEach((run, index) => {
				if (index > 0) lines.push(separator());
				for (const line of fleetRunLines(run, this.theme, this.tick)) lines.push(row(line));
			});
		}

		lines.push(separator());
		lines.push(row(this.theme.fg("dim", `F8 or ${this.cancelKeyText()} close · /flows inspect to drill into a child`)));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.timer);
	}
}

export interface FleetPanelController {
	isOpen(): boolean;
	/** Open the panel if closed, close it if open. Resolves when the toggle action completes (open resolves when the panel later closes). */
	toggle(ctx: InspectorContext, knownTui?: boolean): Promise<void>;
}

export function createFleetPanelController(registry: FlowRunRegistry): FleetPanelController {
	let close: (() => void) | undefined;
	return {
		isOpen: () => close !== undefined,
		async toggle(ctx: InspectorContext, knownTui = false): Promise<void> {
			if (close) {
				close();
				return;
			}
			if (!ctx.hasUI) return;
			if (!supportsTui(ctx, knownTui)) {
				ctx.ui.notify("The flow fleet panel is only available in the Pi TUI.", "info");
				return;
			}
			if (registry.activeRuns().length === 0 && !registry.lastFinishedRun()) {
				ctx.ui.notify("No flow runs yet in this session — the fleet panel opens once a flow is running.", "info");
				return;
			}
			try {
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						close = () => done(undefined as void);
						return new FleetPanel(tui, theme, keybindings, registry, close);
					},
					{
						overlay: true,
						// nonCapturing keeps input in the editor: the panel is a monitor,
						// not a dialog, so opening it must never steal the user's typing.
						overlayOptions: { anchor: "top-right", width: "44%", minWidth: 46, maxHeight: "60%", margin: 1, nonCapturing: true, visible: (termWidth) => termWidth >= 80 },
					},
				);
			} finally {
				close = undefined;
			}
		},
	};
}
