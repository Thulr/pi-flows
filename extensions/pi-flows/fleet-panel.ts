import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { budgetDisclosureLines, exhaustedBudgetText } from "./budget-disclosure.ts";
import { flowAgentActivity, flowAgentState, oneLine, supportsTui, type FlowRegistry, type InspectorContext, type LiveFlow } from "./inspector.ts";
import { formatUsage } from "./trace.ts";
import type { BudgetSnapshot, FlowRunResult } from "./types.ts";
import { flowProgressText, type FlowProgressOptions } from "./ui.ts";
import { boxFrame, meterBar, meterColor, runDisplayName, runStateBar, sparkline, stateColor, stateIcon, treeGuide } from "./ui-style.ts";

/**
 * The mission-control fleet panel: a persistent, *non-capturing* overlay that
 * shows every live flow at once — per-run state, each running child's
 * current activity, and budget burn-down. Because the overlay never captures
 * focus, the editor keeps input the whole time: the panel is ambient
 * monitoring, not a modal. F8 toggles it; `/flows inspect` remains the focused
 * single-agent drill-down.
 */

export function budgetLine(budget: BudgetSnapshot | undefined, theme: Theme): string | undefined {
	// Absent, not falsy: a ceiling of exactly $0 is a valid configuration that
	// refuses everything, and it is the one a viewer most needs to see rendered.
	if (budget?.maxCostUsd === undefined) return undefined;
	const spent = budget.spentCost;
	const max = budget.maxCostUsd;
	const ratio = Math.min(1, max > 0 ? spent / max : 1);
	return `${theme.fg(meterColor(ratio), meterBar(ratio))} ${theme.fg("muted", `$${spent.toFixed(4)} / $${max.toFixed(2)} budget`)}`;
}

/**
 * Burn-rate line: the sampled spend curve, so a viewer sees *acceleration*
 * (one child suddenly burning tokens) and not only the level the meter
 * already shows. With a cost ceiling the amount lives on the budget line and
 * only the curve is added; without one, this line is the only spend surface,
 * so it carries the total too.
 */
export function spendSparkLine(history: number[] | undefined, hasBudgetLine: boolean, theme: Theme): string | undefined {
	if (!history || history.length < 2) return undefined;
	const latest = history[history.length - 1] ?? 0;
	if (latest <= 0) return undefined;
	const curve = theme.fg("accent", sparkline(history));
	return hasBudgetLine ? `${curve} ${theme.fg("muted", "spend")}` : `${curve} ${theme.fg("muted", `$${latest.toFixed(4)} spent`)}`;
}

export interface FleetLineOptions extends FlowProgressOptions {
	/** Sampled spend totals for the sparkline, oldest first. */
	spendHistory?: number[];
}

/** Panel body lines for one flow (no borders). Exported for offline tests. */
export function fleetFlowLines(flow: LiveFlow, theme: Theme, tick: number, options: FleetLineOptions = {}): string[] {
	// Same rule as the live tool row: state text only earns its place on a fan-out;
	// for one child it reads as "0/1 = stuck". This header carries no status icon,
	// so that text is its only state signal — all the more reason it comes from the
	// shared helper rather than a locally formatted ratio.
	const total = flow.details.results.length;
	const states = flow.details.results.map(flowAgentState);
	const outstanding = flow.details.results.some((result) => result.exitCode === -1);
	const progress = total > 1 ? ` ${theme.fg("accent", flowProgressText(flow.details, options))}` : "";
	// Same rule as the live tool row: the per-run cell bar measures settled-ness,
	// so it belongs to outstanding runs.
	const bar = total > 1 && outstanding ? ` ${runStateBar(theme, states)}` : "";
	const lines = [`${theme.fg("toolTitle", theme.bold(`flow ${flow.details.preset?.name ?? flow.mode}`))}${progress}${bar}`];
	lines.push(...budgetDisclosureLines(flow.details.budgetCeilings).map((line) => theme.fg("muted", line)));
	const budget = budgetLine(flow.budget?.snapshot(), theme);
	if (budget) lines.push(budget);
	const spendSpark = spendSparkLine(options.spendHistory, budget !== undefined, theme);
	if (spendSpark) lines.push(spendSpark);

	const nameWidth = Math.min(28, Math.max(4, ...flow.details.results.map((result: FlowRunResult) => runDisplayName(result).length)));
	flow.details.results.forEach((result, index) => {
		const state = flowAgentState(result);
		const icon = stateIcon(theme, state, tick, index * 2);
		const usage = oneLine(formatUsage(result.usage, undefined, result.durationMs), 40, flow.redactSecrets);
		lines.push(`${theme.fg("dim", treeGuide(index, total))} ${icon} ${theme.fg("accent", oneLine(runDisplayName(result), nameWidth, flow.redactSecrets).padEnd(nameWidth))} ${theme.fg(stateColor(state), state.padEnd(9))}${usage ? ` ${theme.fg("dim", usage)}` : ""}`);
		// Sub-lines hang off their row; a `│` continuation keeps rows below visually
		// attached to the tree instead of floating between two agents.
		const continuation = `${index === total - 1 ? " " : theme.fg("dim", "│")}  ${theme.fg("dim", "└")}`;
		if (state === "running") {
			const items = flowAgentActivity(result, flow.redactSecrets);
			const last = items[items.length - 1];
			if (last) lines.push(`${continuation} ${theme.fg("muted", `${last.kind === "tool" ? "→ " : last.kind === "result" ? "← " : ""}${oneLine(last.text, 64, flow.redactSecrets)}`)}`);
		}
		if (state === "failed") {
			const bindingBudget = exhaustedBudgetText(result.error);
			lines.push(`${continuation} ${theme.fg("error", `${result.error?.code ?? result.stopReason ?? "failed"}${bindingBudget ? ` · ${bindingBudget}` : ""}`)}`);
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
		const frame = boxFrame(this.theme, width - 2);

		const active = this.registry.activeFlows();
		const title = active.length > 0 ? `flows · ${active.length} live` : "flows";
		const lines = [frame.top(title)];
		if (active.length === 0) {
			const last = this.registry.lastSettledFlow();
			if (last) {
				lines.push(frame.row(this.theme.fg("muted", "no live flows · last flow:")));
				// The registry is the liveness authority here: a flow it still holds has a
				// handler that may spawn another stage, and the one it settled cannot.
				for (const line of fleetFlowLines(last, this.theme, this.tick, { live: false, spendHistory: this.registry.spendHistory(last) })) lines.push(frame.row(line));
			} else {
				lines.push(frame.row(this.theme.fg("muted", "no live flows")));
			}
		} else {
			active.forEach((flow, index) => {
				if (index > 0) lines.push(frame.separator());
				for (const line of fleetFlowLines(flow, this.theme, this.tick, { live: true, spendHistory: this.registry.spendHistory(flow) })) lines.push(frame.row(line));
			});
		}

		lines.push(frame.separator());
		lines.push(frame.row(this.theme.fg("dim", `F8 or ${this.cancelKeyText()} close · /flows inspect to drill into a child`)));
		lines.push(frame.bottom());
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
