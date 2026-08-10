import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
import { isFailed, redactText } from "./sanitize.ts";
import { formatUsage } from "./trace.ts";
import type { Budget, FlowDetails, FlowMode, FlowRunResult } from "./types.ts";
import { boxFrame, chip, stateColor } from "./ui-style.ts";

export interface LiveFlow {
	mode: FlowMode;
	details: FlowDetails;
	redactSecrets: boolean;
	/** Live budget reference — the flow charges it as children settle, so observers see burn-down without another update channel. Read it through `snapshot()`; a view never moves a ceiling. */
	budget?: Budget;
}

export interface FlowAgentTarget {
	flow: LiveFlow;
	resultIndex: number;
}

export interface FlowActivityItem {
	kind: "text" | "tool" | "result";
	text: string;
}

/** The flow's total recorded cost right now — the quantity the spend sparkline samples. */
export function flowSpentCost(details: FlowDetails): number {
	return details.results.reduce((sum, result) => sum + (result.usage?.cost || 0), 0);
}

/** Points in the resampled spend series a reader gets — the sparkline's width. */
const SPEND_SERIES_POINTS = 24;

/** Raw timestamped samples retained per flow (~4 minutes at the default cadence). */
const SPEND_RAW_SAMPLES = 240;

/**
 * The live-flow registry. Its unit is a **flow** — one `flow` tool call and
 * every run under it — not a run: a flow the registry still holds has a handler
 * that may open another stage, which is exactly the liveness question the fleet
 * panel and the progress header ask. See CONTEXT.md.
 *
 * The registry also samples each flow's spend curve. It has to live here, not
 * in the fleet panel: the panel is constructed on F8 and discarded on close,
 * so a panel-owned history would start empty mid-flow and forget everything
 * between openings. Sampling piggybacks on the update traffic children already
 * stream (decimated to one sample per `spendSampleIntervalMs`), so no timer
 * exists and the curve accrues whether or not any observer is watching.
 *
 * Because that traffic is irregular, samples keep their timestamps and
 * {@link spendHistory} resamples onto a uniform time grid before anyone
 * plots them: a sparkline renders points at equal horizontal spacing, so
 * without the grid a quiet ten seconds and a busy one would look identical
 * and the burn-rate reading would lie.
 */
export class FlowRegistry {
	private readonly flows = new Map<string, LiveFlow>();
	private readonly listeners = new Set<() => void>();
	private readonly spendSamples = new WeakMap<LiveFlow, Array<{ at: number; cost: number }>>();
	private lastSettled: LiveFlow | undefined;

	constructor(
		private readonly spendSampleIntervalMs = 1000,
		private readonly now: () => number = Date.now,
	) {}

	start(id: string, mode: FlowMode, details: FlowDetails, redactSecrets = true, budget?: Budget): void {
		const flow = { mode, details, redactSecrets, budget };
		this.flows.set(id, flow);
		this.sampleSpend(flow);
		this.notify();
	}

	update(id: string, details: FlowDetails): void {
		const flow = this.flows.get(id);
		if (!flow) return;
		flow.details = details;
		this.sampleSpend(flow);
		this.notify();
	}

	settle(id: string, details: FlowDetails): void {
		const flow = this.flows.get(id);
		if (!flow) return;
		flow.details = details;
		// The final sample skips decimation: the curve must end on the true total.
		this.sampleSpend(flow, true);
		this.lastSettled = flow;
		this.flows.delete(id);
		this.notify();
	}

	/**
	 * The spend curve for a flow this registry has seen, resampled onto a
	 * uniform time grid (oldest first) so equal spacing means equal time.
	 * Between samples the curve holds the last known total — spend is a step
	 * function, not an interpolation.
	 *
	 * For a flow that is still live the grid ends at *now*, not at the last
	 * sample: a child that spends and then goes quiet must render as a long
	 * flat tail, or stopped spend keeps looking like current spend at the
	 * right edge. A settled flow's grid ends on its forced final sample.
	 */
	spendHistory(flow: LiveFlow): number[] | undefined {
		const samples = this.spendSamples.get(flow);
		if (!samples || samples.length === 0) return undefined;
		const first = samples[0]!;
		const last = samples[samples.length - 1]!;
		const live = [...this.flows.values()].includes(flow);
		const end = live ? Math.max(this.now(), last.at) : last.at;
		if (end <= first.at) return [last.cost];
		const series: number[] = [];
		let index = 0;
		for (let point = 0; point < SPEND_SERIES_POINTS; point++) {
			const time = first.at + ((end - first.at) * point) / (SPEND_SERIES_POINTS - 1);
			while (index + 1 < samples.length && samples[index + 1]!.at <= time) index++;
			series.push(samples[index]!.cost);
		}
		return series;
	}

	private sampleSpend(flow: LiveFlow, force = false): void {
		const samples = this.spendSamples.get(flow) ?? [];
		const latest = samples[samples.length - 1];
		// Clamped to the last sample so a wall clock stepping backwards cannot
		// produce out-of-order timestamps, which the resampler's step walk
		// requires monotone. Non-forced samples stay decimated until the clock
		// recovers past the old time plus the interval — an accepted gap; the
		// forced settle sample still lands, so the curve always ends true.
		const at = Math.max(this.now(), latest?.at ?? Number.NEGATIVE_INFINITY);
		if (!force && latest !== undefined && at - latest.at < this.spendSampleIntervalMs) return;
		samples.push({ at, cost: flowSpentCost(flow.details) });
		if (samples.length > SPEND_RAW_SAMPLES) samples.shift();
		this.spendSamples.set(flow, samples);
	}

	activeFlows(): LiveFlow[] {
		return [...this.flows.values()];
	}

	/** The most recently settled flow, kept so the fleet panel can show a final state after the last child exits. */
	lastSettledFlow(): LiveFlow | undefined {
		return this.lastSettled;
	}

	inspectableAgents(): FlowAgentTarget[] {
		const targets: FlowAgentTarget[] = [];
		for (const flow of this.flows.values()) {
			for (let resultIndex = 0; resultIndex < flow.details.results.length; resultIndex++) {
				if (flow.details.results[resultIndex]?.exitCode === -1) targets.push({ flow, resultIndex });
			}
		}
		return targets;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try { listener(); } catch { /* A UI observer must not break the flow. */ }
		}
	}
}

export function sanitizeInspectorText(text: string, redactSecrets = true): string {
	const clean = stripVTControlCharacters(text)
		.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, (character) => /\s/u.test(character) ? " " : "");
	return redactSecrets ? redactText(clean) : clean;
}

export function oneLine(text: string, maxLength: number, redactSecrets: boolean): string {
	const compact = sanitizeInspectorText(text, redactSecrets).replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function argument(args: unknown, key: string): string {
	if (!args || typeof args !== "object") return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function toolSummary(name: string, args: unknown, redactSecrets: boolean): string {
	const safeName = oneLine(name, 64, redactSecrets) || "tool";
	const path = oneLine(argument(args, "path") || argument(args, "file_path"), 140, redactSecrets);
	if (name === "bash") return `$ ${oneLine(argument(args, "command") || "command", 180, redactSecrets)}`;
	if (name === "read" || name === "write" || name === "edit") return `${safeName} ${path || "file"}`;
	if (name === "grep") return `grep ${oneLine(argument(args, "pattern"), 100, redactSecrets)}${path ? ` in ${path}` : ""}`;
	if (name === "find") return `find ${oneLine(argument(args, "pattern") || "*", 100, redactSecrets)}${path ? ` in ${path}` : ""}`;
	return safeName;
}

function textContent(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.slice(0, 8)
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join(" ");
}

export function flowAgentActivity(result: FlowRunResult, redactSecrets = true): FlowActivityItem[] {
	const items: FlowActivityItem[] = [];
	for (const message of result.messages.slice(-100) as any[]) {
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content.slice(0, 50)) {
				if (part?.type === "toolCall" && typeof part.name === "string") {
					items.push({ kind: "tool", text: toolSummary(part.name, part.arguments, redactSecrets) });
				} else if (part?.type === "text" && typeof part.text === "string") {
					const text = oneLine(part.text, 220, redactSecrets);
					if (text) items.push({ kind: "text", text });
				}
			}
		} else if (message?.role === "toolResult") {
			const name = oneLine(typeof message.toolName === "string" ? message.toolName : "tool", 64, redactSecrets);
			const preview = oneLine(textContent(message), 160, redactSecrets);
			items.push({ kind: "result", text: preview ? `${name}: ${preview}` : `${name} completed` });
		}
	}
	return items.slice(-100);
}

export function flowAgentState(result: FlowRunResult): "queued" | "running" | "completed" | "failed" {
	if (result.exitCode === -1) return result.agentSource === "unknown" ? "queued" : "running";
	return isFailed(result) ? "failed" : "completed";
}

function targetLabel(target: FlowAgentTarget, index: number): string {
	const result = target.flow.details.results[target.resultIndex];
	if (!result) return `${index + 1}. unavailable child`;
	return `${index + 1}. ${oneLine(result.agent, 48, target.flow.redactSecrets)} · ${flowAgentState(result)} · ${oneLine(result.task, 72, target.flow.redactSecrets)}`;
}

class FlowAgentViewer {
	private readonly unsubscribe: () => void;
	private scrollFromBottom = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly target: FlowAgentTarget,
		registry: FlowRegistry,
		private readonly done: () => void,
	) {
		this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
	}

	handleInput(data: string): void {
		const count = this.currentResult() ? this.activity().length : 0;
		const maxOffset = Math.max(0, count - 1);
		if (this.matches(data, "tui.select.cancel", Key.escape)) this.done();
		else if (this.matches(data, "tui.select.up", Key.up)) this.scrollFromBottom = Math.min(maxOffset, this.scrollFromBottom + 1);
		else if (this.matches(data, "tui.select.down", Key.down)) this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1);
		else if (this.matches(data, "tui.select.pageUp", Key.pageUp)) this.scrollFromBottom = Math.min(maxOffset, this.scrollFromBottom + 5);
		else if (this.matches(data, "tui.select.pageDown", Key.pageDown) || matchesKey(data, Key.end)) this.scrollFromBottom = 0;
		else return;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (width < 3) return [truncateToWidth("…", width, "")];
		const result = this.currentResult();
		const frame = boxFrame(this.theme, width - 2);
		const row = frame.row;
		const separator = frame.separator;
		const lines = [frame.top("flow inspect")];

		if (!result) {
			lines.push(row("Child details are unavailable."), frame.bottom());
			return lines;
		}

		const state = flowAgentState(result);
		const usage = oneLine(formatUsage(result.usage, result.model, result.durationMs), 120, this.target.flow.redactSecrets);
		lines.push(row(`${this.theme.fg("accent", this.theme.bold(oneLine(result.agent, 70, this.target.flow.redactSecrets)))} ${chip(this.theme, stateColor(state), state)}`));
		lines.push(row(this.theme.fg("dim", `${this.target.flow.mode}${usage ? ` · ${usage}` : ""}`)));
		lines.push(separator());
		lines.push(row(`${this.theme.fg("muted", "Task ·")} ${this.theme.fg("dim", oneLine(result.task || "(no task)", 200, this.target.flow.redactSecrets))}`));
		lines.push(separator());
		lines.push(row(this.theme.fg("muted", "Recent activity")));

		const activity = this.activity();
		const capacity = 5;
		this.scrollFromBottom = Math.min(this.scrollFromBottom, Math.max(0, activity.length - capacity));
		const end = Math.max(0, activity.length - this.scrollFromBottom);
		const start = Math.max(0, end - capacity);
		const visible = activity.slice(start, end);
		if (visible.length === 0) lines.push(row(this.theme.fg("dim", state === "queued" ? "Waiting to start…" : "Waiting for activity…")));
		for (const item of visible) {
			const prefix = item.kind === "tool" ? "→" : item.kind === "result" ? "←" : "•";
			lines.push(row(this.theme.fg(item.kind === "tool" ? "accent" : "muted", `${prefix} ${item.text}`)));
		}
		if (activity.length > capacity) lines.push(row(this.theme.fg("dim", `${start + 1}-${end} of ${activity.length}`)));
		lines.push(separator());
		const up = this.keyText("tui.select.up", "↑");
		const down = this.keyText("tui.select.down", "↓");
		const close = this.keyText("tui.select.cancel", "Esc");
		lines.push(row(this.theme.fg("dim", `${up}/${down} scroll · End latest · ${close} close`)));
		lines.push(frame.bottom());
		return lines;
	}

	invalidate(): void {}
	dispose(): void { this.unsubscribe(); }

	private currentResult(): FlowRunResult | undefined {
		return this.target.flow.details.results[this.target.resultIndex];
	}

	private activity(): FlowActivityItem[] {
		const result = this.currentResult();
		return result ? flowAgentActivity(result, this.target.flow.redactSecrets) : [];
	}

	private matches(data: string, binding: "tui.select.cancel" | "tui.select.up" | "tui.select.down" | "tui.select.pageUp" | "tui.select.pageDown", fallback: KeyId): boolean {
		try { return this.keybindings.matches(data, binding); } catch { return matchesKey(data, fallback); }
	}

	private keyText(binding: "tui.select.cancel" | "tui.select.up" | "tui.select.down", fallback: string): string {
		try { return this.keybindings.getKeys(binding)[0] ?? fallback; } catch { return fallback; }
	}
}

export type InspectorContext = Pick<ExtensionContext, "hasUI" | "ui"> & { mode?: string };

export function supportsTui(ctx: InspectorContext, knownTui: boolean): boolean {
	if (knownTui || ctx.mode === "tui") return true;
	if (ctx.mode !== undefined) return false;
	try { return ctx.ui.getAllThemes().length > 0; } catch { return false; }
}

export async function showFlowInspector(ctx: InspectorContext, registry: FlowRegistry, knownTui = false): Promise<void> {
	if (!ctx.hasUI) return;
	if (!supportsTui(ctx, knownTui)) {
		ctx.ui.notify("The live flow inspector is only available in the Pi TUI.", "info");
		return;
	}
	const targets = registry.inspectableAgents();
	if (targets.length === 0) {
		ctx.ui.notify("No child flow agent is queued or running.", "info");
		return;
	}

	let target = targets[0];
	if (targets.length > 1) {
		const labels = targets.map(targetLabel);
		const selected = await ctx.ui.select("Inspect a running flow agent", labels);
		if (!selected) return;
		target = targets[labels.indexOf(selected)];
	}
	if (!target) return;

	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => new FlowAgentViewer(tui, theme, keybindings, target, registry, done),
		{ overlay: true, overlayOptions: { anchor: "right-center", width: "80%", minWidth: 50, maxHeight: 16, margin: 1 } },
	);
}
