import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { budgetDisclosureLines, exhaustedBudgetText } from "./budget-disclosure.ts";
import { flowAgentActivity, flowAgentState, oneLine, supportsTui, type FlowRegistry, type InspectorContext, type LiveFlow } from "./inspector.ts";
import { formatUsage } from "./trace.ts";
import { spinnerFrame } from "./ui-live-row.ts";
import type { FlowBudget, FlowRunResult } from "./types.ts";
import { flowProgressText, type FlowProgressOptions } from "./ui.ts";

/**
 * The mission-control fleet panel: a persistent, *non-capturing* overlay that
 * shows every live flow at once — per-run state, each running child's
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

/** Panel body lines for one flow (no borders). Exported for offline tests. */
export function fleetFlowLines(flow: LiveFlow, theme: Theme, tick: number, options: FlowProgressOptions = {}): string[] {
	// Same rule as the live tool row: state text only earns its place on a fan-out;
	// for one child it reads as "0/1 = stuck". This header carries no status icon,
	// so that text is its only state signal — all the more reason it comes from the
	// shared helper rather than a locally formatted ratio.
	const total = flow.details.results.length;
	const progress = total > 1 ? ` ${theme.fg("accent", flowProgressText(flow.details, options))}` : "";
	const lines = [`${theme.fg("toolTitle", theme.bold(`flow ${flow.mode}`))}${progress}`];
	lines.push(...budgetDisclosureLines(flow.details.budgetCeilings).map((line) => theme.fg("muted", line)));
	const budget = budgetLine(flow.budget, theme);
	if (budget) lines.push(budget);

	const nameWidth = Math.min(16, Math.max(4, ...flow.details.results.map((result: FlowRunResult) => result.agent.length)));
	flow.details.results.forEach((result, index) => {
		const state = flowAgentState(result);
		const icon = state === "running" ? theme.fg("warning", spinnerFrame(tick, index * 2)) : state === "queued" ? theme.fg("muted", "◌") : state === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const usage = oneLine(formatUsage(result.usage, undefined, result.durationMs), 40, flow.redactSecrets);
		lines.push(`${icon} ${theme.fg("accent", oneLine(result.agent, nameWidth, flow.redactSecrets).padEnd(nameWidth))} ${theme.fg(agentStateColor(state), state.padEnd(9))}${usage ? ` ${theme.fg("dim", usage)}` : ""}`);
		if (state === "running") {
			const items = flowAgentActivity(result, flow.redactSecrets);
			const last = items[items.length - 1];
			if (last) lines.push(`  ${theme.fg("muted", `└ ${last.kind === "tool" ? "→ " : last.kind === "result" ? "← " : ""}${oneLine(last.text, 64, flow.redactSecrets)}`)}`);
		}
		if (state === "failed") {
			const bindingBudget = exhaustedBudgetText(result.error);
			lines.push(`  ${theme.fg("error", `└ ${result.error?.code ?? result.stopReason ?? "failed"}${bindingBudget ? ` · ${bindingBudget}` : ""}`)}`);
		}
	});
	if (flow.details.error) lines.push(theme.fg("error", `error: ${flow.details.error.code}`));
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
		private readonly registry: FlowRegistry,
		private readonly done: () => void,
	) {
		this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
		this.timer = setInterval(() => {
			this.tick = (this.tick + 1) % 100000;
			if (this.registry.activeFlows().some((flow) => flow.details.results.some((result) => result.exitCode === -1))) this.tui.requestRender();
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

		const active = this.registry.activeFlows();
		if (active.length === 0) {
			const last = this.registry.lastSettledFlow();
			if (last) {
				lines.push(row(this.theme.fg("muted", "no live flows · last flow:")));
				// The registry is the liveness authority here: a flow it still holds has a
				// handler that may spawn another stage, and the one it settled cannot.
				for (const line of fleetFlowLines(last, this.theme, this.tick, { live: false })) lines.push(row(line));
			} else {
				lines.push(row(this.theme.fg("muted", "no live flows")));
			}
		} else {
			active.forEach((flow, index) => {
				if (index > 0) lines.push(separator());
				for (const line of fleetFlowLines(flow, this.theme, this.tick, { live: true })) lines.push(row(line));
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

export function createFleetPanelController(registry: FlowRegistry): FleetPanelController {
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
			if (registry.activeFlows().length === 0 && !registry.lastSettledFlow()) {
				ctx.ui.notify("No flows yet in this session — the fleet panel opens once a flow is running.", "info");
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
