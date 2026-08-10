import type { Theme } from "@earendil-works/pi-coding-agent";
import { createRaster, encodePng, fillRect, type Raster, type Rgba } from "./png.ts";
import { formatDuration, runDisplayName } from "./ui-style.ts";

/**
 * The settled flow card's concurrency timeline, rendered as a real raster
 * image (Gantt bars) for terminals that speak an inline-image protocol. The
 * card gates on capability detection and keeps the text bars as the
 * fallback, so this module can assume it is drawing — never deciding
 * whether images are appropriate.
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
	label: string;
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
 * says everything a single bar could, and an image would be decoration.
 */
export function ganttLayout(results: GanttResultLike[]): GanttLayout | undefined {
	const timed = results.filter((result) => (result.durationMs ?? 0) > 0);
	if (timed.length < 2) return undefined;
	const starts = timed.filter((result) => result.startedAtMs !== undefined).map((result) => result.startedAtMs!);
	const base = starts.length ? Math.min(...starts) : 0;
	const rows = timed.map((result) => ({
		label: ganttLabel(result),
		offsetMs: result.startedAtMs !== undefined ? result.startedAtMs - base : 0,
		durationMs: result.durationMs!,
		failed: result.exitCode !== 0 || result.errorCode !== undefined,
	}));
	const totalMs = Math.max(...rows.map((row) => row.offsetMs + row.durationMs));
	return totalMs > 0 ? { rows, totalMs } : undefined;
}

/** Longest label the gutter reserves; longer labels truncate in the drawing. */
export const LABEL_CHARS = 16;

/**
 * The row label, sized for the gutter: the full `role (agent)` form when it
 * fits, the role alone when it does not — a whole word beats a form cut
 * mid-parenthesis — and a hard truncation only when a single name is itself
 * too long for the gutter.
 */
function ganttLabel(result: GanttResultLike): string {
	const full = runDisplayName(result);
	const label = full.length <= LABEL_CHARS ? full : result.role ?? result.agent;
	return label.toUpperCase();
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

function drawText(raster: Raster, x: number, y: number, text: string, color: Rgba, scale: number): void {
	let cursor = x;
	for (const character of text.toUpperCase()) {
		const glyph = GLYPHS[character] ?? GLYPHS["?"]!;
		for (let row = 0; row < 7; row++) {
			for (let column = 0; column < 5; column++) {
				if (glyph[row]! & (1 << (4 - column))) fillRect(raster, cursor + column * scale, y + row * scale, scale, scale, color);
			}
		}
		cursor += 6 * scale;
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

export interface GanttImage {
	base64: string;
	dimensions: { widthPx: number; heightPx: number };
	/** Cells the image should occupy; the card passes this to the Image component. */
	maxWidthCells: number;
}

const WIDTH_CELLS = 56;

/**
 * Rasterize the timeline at 2× cell density (crisp on retina-scaled
 * terminals). Transparent background: the terminal composites the chart over
 * its own theme background, which is what keeps one PNG valid in any theme.
 */
export function flowGanttPng(results: GanttResultLike[], theme: Theme): GanttImage | undefined {
	const layout = ganttLayout(results);
	if (!layout) return undefined;
	const scale = 2;
	const charW = 6 * scale;
	const pad = 6 * scale;
	const rowPitch = 15 * scale;
	const barH = 9 * scale;
	const gutter = pad + LABEL_CHARS * charW + charW;
	const width = WIDTH_CELLS * 9 * scale;
	const chartW = width - gutter - pad;
	const axisH = 12 * scale;
	const height = pad * 2 + layout.rows.length * rowPitch + axisH;

	const raster = createRaster(width, height);
	const success = themeRgb(theme, "success");
	const error = themeRgb(theme, "error");
	const text = themeRgb(theme, "muted");
	const grid = themeRgb(theme, "dim", 70);

	// Quarter gridlines give the eye a scale without axis clutter.
	for (const fraction of [0.25, 0.5, 0.75, 1]) {
		fillRect(raster, gutter + chartW * fraction - scale / 2, pad, scale, layout.rows.length * rowPitch, grid);
	}

	layout.rows.forEach((row, index) => {
		const y = pad + index * rowPitch;
		drawText(raster, pad, y + (rowPitch - 7 * scale) / 2, row.label.slice(0, LABEL_CHARS), text, scale);
		const x = gutter + (row.offsetMs / layout.totalMs) * chartW;
		const barW = Math.max(2 * scale, (row.durationMs / layout.totalMs) * chartW);
		fillRect(raster, x, y + (rowPitch - barH) / 2, barW, barH, row.failed ? error : success);
		// Duration label rides after the bar when it fits, else tucks inside its end.
		const duration = formatDuration(row.durationMs);
		const durationW = duration.length * charW;
		const after = x + barW + charW / 2;
		const textY = y + (rowPitch - 7 * scale) / 2;
		if (after + durationW <= gutter + chartW) drawText(raster, after, textY, duration, text, scale);
		else drawText(raster, Math.max(gutter, x + barW - durationW - charW / 2), textY, duration, [0, 0, 0, 255], scale);
	});

	// Axis: a baseline with 0 at the left and the total at the right edge.
	const axisY = pad + layout.rows.length * rowPitch + 2 * scale;
	fillRect(raster, gutter, axisY, chartW, scale, grid);
	drawText(raster, gutter, axisY + 2 * scale, "0", text, scale);
	const total = formatDuration(layout.totalMs);
	drawText(raster, gutter + chartW - total.length * charW, axisY + 2 * scale, total, text, scale);

	return { base64: encodePng(raster), dimensions: { widthPx: width, heightPx: height }, maxWidthCells: WIDTH_CELLS };
}

