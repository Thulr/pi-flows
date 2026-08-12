import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { providerFailureGuidance, providerFailureReason } from "./provider-failure.ts";
import { formatTokens } from "./trace.ts";
import type { ProviderFailure } from "./types.ts";

/**
 * The shared visual vocabulary for every pi-flows surface — the live tool
 * row, the durable flow card, and the inspector. One
 * module owns the glyphs, bars, badges, and box frames so the surfaces read
 * as one system instead of three hand-rolled ones: a run state is always the
 * same icon in the same color, a meter always fills the same way, and a
 * panel always frames itself with the same border language.
 *
 * Everything here is a pure string builder over the pi {@link Theme} — no
 * component state, no timers — so offline tests can assert on content
 * without a TUI.
 */

/** The four states a child run can be in, as every surface names them. */
export type RunState = "queued" | "running" | "completed" | "failed";

/** The one display form for a run: `role (agent)` when a role exists, the agent name alone otherwise. Every surface labels a run through this. */
export function runDisplayName(result: { agent: string; role?: string }): string {
	return result.role ? `${result.role} (${result.agent})` : result.agent;
}

export function providerFailurePresentation(failure: ProviderFailure, contextTokens: number | undefined, thinking: string | undefined, exitCode: number) {
	const used = contextTokens !== undefined ? formatTokens(contextTokens) : "?";
	return {
		context: `ctx:${used}${failure.contextWindow !== undefined ? `/${formatTokens(failure.contextWindow)}` : ""}`,
		thinking: `thinking:${thinking ?? "unknown/pi-default"}`,
		reason: `${providerFailureReason(failure)} · exit ${exitCode}`,
		recovery: `recovery: ${providerFailureGuidance(failure.category)}`,
	};
}

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

export function spinnerFrame(tick: number, offset = 0): string {
	const index = (Math.trunc(tick) + Math.trunc(offset)) % SPINNER_FRAMES.length;
	return SPINNER_FRAMES[(index + SPINNER_FRAMES.length) % SPINNER_FRAMES.length] as string;
}

export function stateColor(state: RunState): "muted" | "warning" | "success" | "error" {
	return state === "queued" ? "muted" : state === "running" ? "warning" : state === "completed" ? "success" : "error";
}

/** One glyph per run state; running animates on the shared spinner, staggered by `offset` so a fan-out shimmers instead of blinking in lockstep. */
export function stateIcon(theme: Theme, state: RunState, tick = 0, offset = 0): string {
	if (state === "running") return theme.fg("warning", spinnerFrame(tick, offset));
	return theme.fg(stateColor(state), state === "queued" ? "◌" : state === "completed" ? "✓" : "✗");
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/**
 * Smooth eighth-block meter for continuous quantities (budget burn-down).
 * Pure glyphs — color the whole bar at the call site, usually with
 * {@link meterColor} so fullness and urgency agree.
 */
export function meterBar(ratio: number, width = 12): string {
	if (width <= 0) return "";
	const cells = Math.min(1, Math.max(0, ratio)) * width;
	let full = Math.floor(cells);
	let eighth = Math.round((cells - full) * 8);
	if (eighth === 8) {
		full += 1;
		eighth = 0;
	}
	const partial = full < width ? EIGHTHS[eighth]! : "";
	return "█".repeat(full) + partial + "░".repeat(Math.max(0, width - full - (partial ? 1 : 0)));
}

/** Threshold color for a consumed-fraction meter: calm, then warning at 60%, alarm at 90%. */
export function meterColor(ratio: number): "success" | "warning" | "error" {
	return ratio >= 0.9 ? "error" : ratio >= 0.6 ? "warning" : "success";
}

/**
 * Per-run state cells, pipeline style: each cell is one run colored by its
 * state, so a fan-out's bar shows *which* runs succeeded, failed, or are
 * still out — not just how much of the whole settled. Queued runs render as
 * empty track so the bar also reads as progress at a squint. Above
 * `maxWidth` runs the bar compresses to proportional segments in a fixed
 * state order, which keeps the same reading without per-run resolution.
 */
export function runStateBar(theme: Theme, states: RunState[], maxWidth = 16): string {
	if (states.length === 0 || maxWidth <= 0) return "";
	const cell = (state: RunState) => theme.fg(stateColor(state), state === "queued" ? "░" : "█");
	if (states.length <= maxWidth) return states.map(cell).join("");

	const segments: string[] = [];
	let counted = 0;
	let used = 0;
	for (const state of ["completed", "failed", "running", "queued"] as const) {
		counted += states.filter((candidate) => candidate === state).length;
		const upto = Math.round((counted / states.length) * maxWidth);
		if (upto > used) segments.push(theme.fg(stateColor(state), (state === "queued" ? "░" : "█").repeat(upto - used)));
		used = upto;
	}
	return segments.join("");
}

/**
 * Inverse-video badge: the label on a block of `color`. Inverse trades the
 * foreground against the terminal background, so the badge works in any
 * theme without needing background color keys.
 */
export function chip(theme: Theme, color: ThemeColor, label: string): string {
	return theme.inverse(theme.fg(color, ` ${label} `));
}

/** Tree connector for the row at `index` of `total` — `├` inside the list, `└` on the last row. */
export function treeGuide(index: number, total: number): string {
	return index === total - 1 ? "└" : "├";
}

export function formatDuration(durationMs: number): string {
	if (durationMs >= 60000) {
		// Round to whole seconds first so the carry lands in minutes: rounding
		// the remainder alone turns 119.5s into the impossible "1m 60s".
		const totalSeconds = Math.round(durationMs / 1000);
		return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Rounded box frame with an optional title woven into the top border. */
export interface BoxFrame {
	top(title?: string): string;
	/** One content row, padded to the frame width; overflow truncates with an ellipsis. */
	row(content?: string): string;
	separator(): string;
	bottom(): string;
}

export function boxFrame(theme: Theme, innerWidth: number): BoxFrame {
	const border = (text: string) => theme.fg("border", text);
	return {
		top(title?: string): string {
			if (!title || innerWidth < 4) return border(`╭${"─".repeat(innerWidth)}╮`);
			const label = truncateToWidth(` ${title} `, innerWidth - 2, "…");
			const rest = Math.max(0, innerWidth - visibleWidth(label) - 1);
			return border("╭─") + theme.bold(theme.fg("borderAccent", label)) + border(`${"─".repeat(rest)}╮`);
		},
		row(content = ""): string {
			const clipped = truncateToWidth(` ${content}`, innerWidth, "…");
			return `${border("│")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${border("│")}`;
		},
		separator(): string {
			return border(`├${"─".repeat(innerWidth)}┤`);
		},
		bottom(): string {
			return border(`╰${"─".repeat(innerWidth)}╯`);
		},
	};
}
