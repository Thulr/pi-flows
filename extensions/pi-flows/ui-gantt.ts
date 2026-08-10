import type { Theme } from "@earendil-works/pi-coding-agent";
import { createRaster, encodePng, fillRect, hatchRect, hslToRgb, withAlpha, type Raster, type Rgba } from "./png.ts";
import { formatDuration, runDisplayName } from "./ui-style.ts";

/**
 * The settled flow card's concurrency timeline, rendered as a real raster
 * image for terminals that speak an inline-image protocol. The card gates on
 * capability detection and keeps the text bars as the fallback, so this
 * module can assume it is drawing — never deciding whether images are
 * appropriate.
 *
 * The drawing is an "editorial rails" layout: each run is two lines — an
 * identicon and the full run name with the duration right-aligned, then a
 * thin rail from start to finish over a faint full-width track. Failure is
 * never encoded by color alone (the theme's red/green pair is a deuteranopia
 * collision): failed rails are hatched and the label says FAILED.
 *
 * Everything through {@link ganttLayout} is pure math over entry results;
 * {@link flowGanttPng} rasterizes that layout with the theme's own colors.
 */

/** The slice of a persisted entry result the timeline needs. Declared here (structurally compatible with the card's type) so the card can import the chart without a module cycle. */
export interface GanttResultLike {
	agent: string;
	role?: string;
	exitCode: number;
	errorCode?: string;
	durationMs?: number;
	startedAtMs?: number;
}

export interface GanttRow {
	/** The full `role (agent)` display form; the drawing truncates to fit. */
	label: string;
	/** The agent name alone — the identicon seed, so a fan-out over one agent visibly shares one mark. */
	agent: string;
	/** Offset from the earliest recorded start, ms. Entries written before start times were recorded collapse to 0 — the chart then still compares durations. */
	offsetMs: number;
	durationMs: number;
	failed: boolean;
}

export interface GanttLayout {
	rows: GanttRow[];
	totalMs: number;
}

/**
 * A chart needs at least two timed runs: with one, the text card already
 * says everything a single rail could, and an image would be decoration.
 */
export function ganttLayout(results: GanttResultLike[]): GanttLayout | undefined {
	const timed = results.filter((result) => (result.durationMs ?? 0) > 0);
	if (timed.length < 2) return undefined;
	const starts = timed.filter((result) => result.startedAtMs !== undefined).map((result) => result.startedAtMs!);
	const base = starts.length ? Math.min(...starts) : 0;
	const rows = timed.map((result) => ({
		label: runDisplayName(result),
		agent: result.agent,
		offsetMs: result.startedAtMs !== undefined ? result.startedAtMs - base : 0,
		durationMs: result.durationMs!,
		failed: result.exitCode !== 0 || result.errorCode !== undefined,
	}));
	const totalMs = Math.max(...rows.map((row) => row.offsetMs + row.durationMs));
	return totalMs > 0 ? { rows, totalMs } : undefined;
}

/** 5×7 bitmap glyphs, one number per row, bit 4 leftmost. Labels fold to uppercase; anything uncovered renders as '?'. */
const GLYPHS: Record<string, number[]> = {
	A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
	B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
	C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
	D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
	E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
	F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
	G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
	H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
	I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
	J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
	K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
	L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
	M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
	N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
	O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
	P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
	Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
	R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
	S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
	T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
	U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
	V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
	W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
	X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
	Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
	Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
	"0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
	"1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
	"2": [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
	"3": [0x1f, 0x01, 0x02, 0x06, 0x01, 0x11, 0x0e],
	"4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
	"5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
	"6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
	"7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
	"8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
	"9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
	".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
	"-": [0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00],
	"(": [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
	")": [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
	"/": [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
	":": [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
	"$": [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
	"%": [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
	" ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
	"?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
};

const SCALE = 2;
const CHAR_W = 6 * SCALE;

function drawText(raster: Raster, x: number, y: number, text: string, color: Rgba): void {
	let cursor = x;
	for (const character of text.toUpperCase()) {
		const glyph = GLYPHS[character] ?? GLYPHS["?"]!;
		for (let row = 0; row < 7; row++) {
			for (let column = 0; column < 5; column++) {
				if (glyph[row]! & (1 << (4 - column))) fillRect(raster, cursor + column * SCALE, y + row * SCALE, SCALE, SCALE, color);
			}
		}
		cursor += CHAR_W;
	}
}

const textW = (text: string): number => text.length * CHAR_W;

/** The one failure marker every failed row draws and reserves width for. The bitmap font has no ✗, so the letter X carries it. */
const FAILED_LABEL = "X FAILED";

function hash32(seed: string): number {
	let hash = 2166136261;
	for (const character of seed) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/** Hues an identicon may take: none near the reserved status colors (success green ~100°, error red ~345°), so no agent's mark can read as pass/fail. Exported so the test can hold every entry to that rule — hashing samples only some of them. */
export const AVATAR_HUES = [205, 262, 30, 178, 300, 52];

const AVATAR_CELL = 3;
/** Identicon footprint in px; the label column starts after it. */
const AVATAR_PX = 5 * AVATAR_CELL;

/**
 * Each agent's own mark: a 5×5 sprite mirrored around its center column, in
 * a hue hashed from the agent name — deterministic, so an agent wears the
 * same mark in every flow, and a fan-out over one agent visibly shares it.
 * Shape is the primary identity signal; the hue list is small on purpose and
 * only lightness adapts to the theme.
 */
function drawAvatar(raster: Raster, x: number, y: number, agent: string, dark: boolean): void {
	const hash = hash32(agent);
	const color = hslToRgb(AVATAR_HUES[hash % AVATAR_HUES.length]!, 0.55, dark ? 0.62 : 0.42);
	for (let row = 0; row < 5; row++) {
		for (let column = 0; column < 5; column++) {
			const bit = row * 3 + (column < 3 ? column : 4 - column);
			if ((hash >> (bit + 8)) & 1) fillRect(raster, x + column * AVATAR_CELL, y + row * AVATAR_CELL, AVATAR_CELL, AVATAR_CELL, color);
		}
	}
}

/**
 * The theme's own color, as RGB. Truecolor themes embed `38;2;r;g;b` in the
 * ANSI prefix; 256-color themes (or the offline test fakes, which have no
 * getFgAnsi at all) fall back to a fixed palette readable on dark and light.
 */
export function themeRgb(theme: Theme, color: "success" | "error" | "muted" | "dim", alpha = 255): Rgba {
	const fallback: Record<string, Rgba> = {
		success: [130, 190, 100, alpha],
		error: [225, 95, 120, alpha],
		muted: [128, 132, 148, alpha],
		dim: [110, 114, 130, alpha],
	};
	const ansi = (theme as { getFgAnsi?: (color: string) => string }).getFgAnsi?.(color);
	const match = ansi?.match(/38;2;(\d+);(\d+);(\d+)/);
	if (!match) return fallback[color]!;
	return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

/**
 * Dark terminals set light muted text and vice versa, so the text color's
 * luminance is the one theme-background signal available to a renderer that
 * only ever sees foreground colors.
 */
function isDarkTheme(theme: Theme): boolean {
	const [r, g, b] = themeRgb(theme, "muted");
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.45;
}

export interface GanttImage {
	base64: string;
	dimensions: { widthPx: number; heightPx: number };
	/** Cells the image should occupy; the card passes this to the Image component. */
	maxWidthCells: number;
}

const WIDTH_CELLS = 56;

/** Sub-minute values as e.g. `42s`, longer ones rounded to whole minutes — axis labels, where `formatDuration`'s precision would be noise. */
const shortDuration = (ms: number): string => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);

/**
 * Rasterize the timeline at 2× cell density (crisp on retina-scaled
 * terminals). Transparent background: the terminal composites the chart over
 * its own theme background, which is what keeps one PNG valid in any theme.
 */
export function flowGanttPng(results: GanttResultLike[], theme: Theme): GanttImage | undefined {
	const layout = ganttLayout(results);
	if (!layout) return undefined;
	const pad = 7 * SCALE;
	const rowPitch = 21 * SCALE;
	const axisH = 12 * SCALE;
	const width = WIDTH_CELLS * 9 * SCALE;
	const chartW = width - 2 * pad;
	const height = pad + layout.rows.length * rowPitch + axisH + pad;

	const raster = createRaster(width, height);
	const success = themeRgb(theme, "success");
	const error = themeRgb(theme, "error");
	const muted = themeRgb(theme, "muted");
	const dim = themeRgb(theme, "dim");
	const dark = isDarkTheme(theme);
	const xAt = (ms: number): number => pad + (ms / layout.totalMs) * chartW;

	layout.rows.forEach((row, index) => {
		const y = pad + index * rowPitch;
		const duration = formatDuration(row.durationMs);
		drawAvatar(raster, pad, y, row.agent, dark);

		// label line: identicon, name, FAILED marker, duration right-aligned —
		// the name truncates before it can reach the duration column
		const labelX = pad + AVATAR_PX + 4 * SCALE;
		const suffix = row.failed ? ` ${FAILED_LABEL}` : "";
		const labelChars = Math.floor((width - pad - textW(duration) - CHAR_W - labelX) / CHAR_W) - suffix.length;
		const label = row.label.length <= labelChars ? row.label : row.label.slice(0, Math.max(1, labelChars));
		drawText(raster, labelX, y, label, row.failed ? error : muted);
		if (row.failed) drawText(raster, labelX + textW(label) + CHAR_W, y, FAILED_LABEL, error);
		drawText(raster, width - pad - textW(duration), y, duration, dim);

		// rail line: a faint full-width track, the run's span, a start dot and
		// an end tick
		const railY = y + 11 * SCALE;
		fillRect(raster, pad, railY + SCALE, chartW, SCALE, withAlpha(dim, 45));
		const xs = xAt(row.offsetMs);
		const xe = Math.max(xs + 2 * SCALE, xAt(row.offsetMs + row.durationMs));
		const color = row.failed ? error : success;
		if (row.failed) hatchRect(raster, xs, railY, xe - xs, 3 * SCALE, error);
		else fillRect(raster, xs, railY, xe - xs, 3 * SCALE, color);
		fillRect(raster, xs - SCALE, railY - 2 * SCALE, 3 * SCALE, 7 * SCALE, color);
		fillRect(raster, xe - SCALE, railY - 2 * SCALE, 2 * SCALE, 7 * SCALE, color);
	});

	// Axis: a baseline with 0 at the left, the midpoint, and the total.
	const axisY = pad + layout.rows.length * rowPitch + 2 * SCALE;
	fillRect(raster, pad, axisY, chartW, SCALE, withAlpha(dim, 60));
	drawText(raster, pad, axisY + 2 * SCALE, "0", dim);
	const mid = shortDuration(layout.totalMs / 2);
	drawText(raster, pad + chartW / 2 - textW(mid) / 2, axisY + 2 * SCALE, mid, dim);
	const total = formatDuration(layout.totalMs);
	drawText(raster, pad + chartW - textW(total), axisY + 2 * SCALE, total, dim);

	return { base64: encodePng(raster), dimensions: { widthPx: width, heightPx: height }, maxWidthCells: WIDTH_CELLS };
}
