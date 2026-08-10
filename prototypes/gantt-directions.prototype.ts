/**
 * PROTOTYPE — THROWAWAY. Do not fold into production as-is.
 *
 * Plan: three radically different visual directions for the settled flow
 * card's concurrency timeline (extensions/pi-flows/ui-gantt.ts), each
 * rendered with the real raster primitives over mock terminal panels in a
 * single HTML page, switchable via `#A|#B|#C` with a floating bottom bar.
 *
 *   A — Waterfall: devtools-style, real time axis with ticks, inline labels
 *   B — Packed lanes: runs packed by overlap + an "active children" load strip
 *   C — Editorial rails: airy two-line rows, thin rails, dot/tick endpoints
 *
 * Run:  node --import tsx prototypes/gantt-directions.prototype.ts
 * Open: prototypes/gantt-directions.html
 *
 * Failure is never encoded by color alone (light-theme red/green is a deutan
 * collision, ΔE 1.2): every variant hatches failed marks and prints an X.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRaster, encodePng, fillRect, setPixel, type Raster, type Rgba } from "../extensions/pi-flows/png.ts";
import { formatDuration, runDisplayName } from "../extensions/pi-flows/ui-style.ts";

// ---------------------------------------------------------------- sample data

interface Run {
	agent: string;
	role?: string;
	startedAtMs: number;
	durationMs: number;
	failed: boolean;
}

const FAN_OUT: Run[] = [
	{ agent: "scout", role: "planner", startedAtMs: 0, durationMs: 8200, failed: false },
	{ agent: "reviewer", role: "security", startedAtMs: 8600, durationMs: 21300, failed: false },
	{ agent: "reviewer", role: "perf", startedAtMs: 8600, durationMs: 34500, failed: false },
	{ agent: "reviewer", role: "api", startedAtMs: 8900, durationMs: 18100, failed: true },
	{ agent: "reviewer", role: "tests", startedAtMs: 9100, durationMs: 41800, failed: false },
	{ agent: "synthesizer", startedAtMs: 51400, durationMs: 12600, failed: false },
];

const PIPELINE: Run[] = [
	{ agent: "implementer", startedAtMs: 0, durationMs: 25400, failed: false },
	{ agent: "verifier", startedAtMs: 26000, durationMs: 9200, failed: false },
	{ agent: "doc-writer", startedAtMs: 35700, durationMs: 6100, failed: false },
];

function totalMs(runs: Run[]): number {
	return Math.max(...runs.map((run) => run.startedAtMs + run.durationMs));
}

// ------------------------------------------------------------------- palettes

interface Palette {
	mode: "dark" | "light";
	success: Rgba;
	error: Rgba;
	muted: Rgba;
	dim: Rgba;
	/** dark ink for text drawn inside a success-colored block */
	inkOnBar: Rgba;
	bg: string;
	fg: string;
}

const DARK: Palette = {
	mode: "dark",
	success: [130, 190, 100, 255],
	error: [225, 95, 120, 255],
	muted: [152, 156, 170, 255],
	dim: [112, 116, 132, 255],
	inkOnBar: [18, 20, 26, 255],
	bg: "#1e1e2e",
	fg: "#cdd6f4",
};

const LIGHT: Palette = {
	mode: "light",
	success: [56, 125, 45, 255],
	error: [186, 42, 72, 255],
	muted: [92, 97, 112, 255],
	dim: [148, 152, 166, 255],
	inkOnBar: [250, 250, 250, 255],
	bg: "#fafafa",
	fg: "#33363f",
};

const alpha = (rgba: Rgba, value: number): Rgba => [rgba[0], rgba[1], rgba[2], value];

// -------------------------------------------------- pixel font (copied, throwaway)
// Copied from ui-gantt.ts (module-private there). 5×7 glyphs, bit 4 leftmost.

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
	" ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
	"?": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x00, 0x04],
};

const SCALE = 2;
const CHAR_W = 6 * SCALE;
const WIDTH = 56 * 9 * SCALE;

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

/** Failed-mark texture: translucent base + solid 45° stripes. Never color alone. */
function hatchRect(raster: Raster, x: number, y: number, w: number, h: number, color: Rgba): void {
	fillRect(raster, x, y, w, h, alpha(color, 110));
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	for (let row = y0; row < y0 + h; row++) {
		for (let column = x0; column < x0 + w; column++) {
			if (((column + row) % 12 + 12) % 12 < 4) setPixel(raster, column, row, color);
		}
	}
}

const short = (ms: number): string => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);

interface Png {
	base64: string;
	widthPx: number;
	heightPx: number;
}

const finish = (raster: Raster): Png => ({ base64: encodePng(raster), widthPx: raster.width, heightPx: raster.height });

// ------------------------------------------------- variant A: waterfall

function variantA(runs: Run[], p: Palette): Png {
	const total = totalMs(runs);
	const pad = 6 * SCALE;
	const headerH = 12 * SCALE;
	const rowPitch = 13 * SCALE;
	const barH = 5 * SCALE;
	const chartW = WIDTH - 2 * pad;
	const height = pad + headerH + runs.length * rowPitch + pad;
	const raster = createRaster(WIDTH, height);
	const xAt = (ms: number): number => pad + (ms / total) * chartW;

	// time axis on top: ticks every "nice" step, labels beside them
	const stepMs = ([1, 2, 5, 10, 15, 20, 30, 60, 120, 300].find((s) => total / (s * 1000) <= 6) ?? 600) * 1000;
	const totalLabel = formatDuration(total);
	drawText(raster, pad, pad, "0", p.dim);
	for (let t = stepMs; t < total; t += stepMs) {
		fillRect(raster, xAt(t), pad + 9 * SCALE, SCALE, headerH - 9 * SCALE + runs.length * rowPitch, alpha(p.dim, 60));
		// skip a tick label that would collide with the right-edge total label
		if (xAt(t) + 2 * SCALE + textW(short(t)) <= WIDTH - pad - textW(totalLabel) - CHAR_W) {
			drawText(raster, xAt(t) + 2 * SCALE, pad, short(t), p.dim);
		}
	}
	drawText(raster, WIDTH - pad - textW(totalLabel), pad, totalLabel, p.dim);
	fillRect(raster, xAt(total), pad + 9 * SCALE, SCALE, headerH - 9 * SCALE + runs.length * rowPitch, alpha(p.dim, 60));

	runs.forEach((run, index) => {
		const y = pad + headerH + index * rowPitch;
		if (index % 2 === 1) fillRect(raster, pad, y, chartW, rowPitch, alpha(p.dim, 18));
		const x = xAt(run.startedAtMs);
		const w = Math.max(2 * SCALE, (run.durationMs / total) * chartW);
		const barY = y + (rowPitch - barH) / 2;
		if (run.failed) hatchRect(raster, x, barY, w, barH, p.error);
		else fillRect(raster, x, barY, w, barH, p.success);

		const textY = y + (rowPitch - 7 * SCALE) / 2;
		const label = (run.failed ? "X " : "") + runDisplayName(run);
		const labelColor = run.failed ? p.error : p.muted;
		const duration = formatDuration(run.durationMs);
		// duration tucks inside the bar's end whenever it has no room after it
		const durationAfter = (from: number): void => {
			if (from + textW(duration) <= WIDTH - pad) drawText(raster, from, textY, duration, p.dim);
			else drawText(raster, Math.max(x, x + w - textW(duration) - 2 * SCALE), textY, duration, p.inkOnBar);
		};
		if (textW(label) + 3 * SCALE <= x - pad) {
			// label right-aligned against the bar start, duration after the bar
			drawText(raster, x - 3 * SCALE - textW(label), textY, label, labelColor);
			durationAfter(x + w + 3 * SCALE);
		} else {
			// both ride after the bar
			drawText(raster, x + w + 3 * SCALE, textY, label, labelColor);
			durationAfter(x + w + 3 * SCALE + textW(label) + CHAR_W);
		}
	});
	return finish(raster);
}

// ------------------------------------------- variant B: packed lanes + load

function packLanes(runs: Run[]): { laneOf: number[]; lanes: number } {
	const order = runs.map((_run, index) => index).sort((a, b) => runs[a]!.startedAtMs - runs[b]!.startedAtMs);
	const laneEnds: number[] = [];
	const laneOf = new Array<number>(runs.length).fill(0);
	for (const index of order) {
		const run = runs[index]!;
		let lane = laneEnds.findIndex((end) => end <= run.startedAtMs);
		if (lane === -1) lane = laneEnds.push(0) - 1;
		laneEnds[lane] = run.startedAtMs + run.durationMs;
		laneOf[index] = lane;
	}
	return { laneOf, lanes: laneEnds.length };
}

function concurrencySteps(runs: Run[]): { t0: number; t1: number; count: number }[] {
	const events = runs
		.flatMap((run) => [
			{ t: run.startedAtMs, d: 1 },
			{ t: run.startedAtMs + run.durationMs, d: -1 },
		])
		.sort((a, b) => a.t - b.t || b.d - a.d);
	const steps: { t0: number; t1: number; count: number }[] = [];
	let count = 0;
	let last = 0;
	for (const event of events) {
		if (event.t > last && count > 0) steps.push({ t0: last, t1: event.t, count });
		count += event.d;
		last = event.t;
	}
	return steps;
}

function variantB(runs: Run[], p: Palette): Png {
	const total = totalMs(runs);
	const pad = 6 * SCALE;
	const blockH = 12 * SCALE;
	const lanePitch = blockH + 2 * SCALE;
	const { laneOf, lanes } = packLanes(runs);
	const stripGap = 5 * SCALE;
	const stripH = 12 * SCALE;
	const axisH = 12 * SCALE;
	const chartW = WIDTH - 2 * pad;
	const height = pad + lanes * lanePitch + stripGap + stripH + axisH + pad;
	const raster = createRaster(WIDTH, height);
	const xAt = (ms: number): number => pad + (ms / total) * chartW;

	// blocks first, labels second — an outside label must never be painted over
	// by a later block in the same lane
	const geometry = runs.map((run, index) => ({
		run,
		y: pad + laneOf[index]! * lanePitch,
		x: xAt(run.startedAtMs),
		w: Math.max(3 * SCALE, (run.durationMs / total) * chartW),
	}));
	for (const { run, x, y, w } of geometry) {
		if (run.failed) hatchRect(raster, x, y, w, blockH, p.error);
		else fillRect(raster, x, y, w, blockH, p.success);
	}
	for (const { run, x, y, w } of geometry) {
		const name = run.role ?? run.agent;
		const duration = formatDuration(run.durationMs);
		const textY = y + (blockH - 7 * SCALE) / 2;
		// inside tiers: full form, name alone, duration alone — a cramped block
		// keeps its label instead of spilling into a lane neighbor
		const inside = [`${name} ${duration}`, name, duration].find((candidate) => textW(candidate) + 6 * SCALE <= w);
		if (!run.failed && inside !== undefined) {
			drawText(raster, x + 3 * SCALE, textY, inside, p.inkOnBar);
		} else {
			// hatched or narrow blocks label outside — right of the block when it fits
			const outside = `${run.failed ? "X " : ""}${name} ${duration}`;
			const color = run.failed ? p.error : p.muted;
			if (x + w + 3 * SCALE + textW(outside) <= WIDTH - pad) drawText(raster, x + w + 3 * SCALE, textY, outside, color);
			else drawText(raster, x - 3 * SCALE - textW(outside), textY, outside, color);
		}
	}

	// load strip: how many children were running at each moment
	const stripY = pad + lanes * lanePitch + stripGap;
	const peak = Math.max(...concurrencySteps(runs).map((step) => step.count));
	for (const step of concurrencySteps(runs)) {
		const h = Math.max(SCALE, (step.count / peak) * stripH);
		fillRect(raster, xAt(step.t0), stripY + stripH - h, xAt(step.t1) - xAt(step.t0), h, alpha(p.dim, 90));
	}
	drawText(raster, WIDTH - pad - textW(`PEAK ${peak}`), stripY - 1 * SCALE, `PEAK ${peak}`, p.dim);

	// axis under the strip
	const axisY = stripY + stripH + 2 * SCALE;
	fillRect(raster, pad, axisY, chartW, SCALE, alpha(p.dim, 70));
	drawText(raster, pad, axisY + 2 * SCALE, "0", p.dim);
	const totalLabel = formatDuration(total);
	drawText(raster, pad + chartW - textW(totalLabel), axisY + 2 * SCALE, totalLabel, p.dim);
	return finish(raster);
}

// ----------------------------------------------------- per-agent identicons

function hash32(seed: string): number {
	let hash = 2166136261;
	for (const character of seed) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function hslToRgb(h: number, s: number, l: number): Rgba {
	const chroma = (1 - Math.abs(2 * l - 1)) * s;
	const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - chroma / 2;
	const sector = Math.floor(h / 60) % 6;
	const [r, g, b] = [
		[chroma, x, 0],
		[x, chroma, 0],
		[0, chroma, x],
		[0, x, chroma],
		[x, 0, chroma],
		[chroma, 0, x],
	][sector]!;
	return [Math.round((r! + m) * 255), Math.round((g! + m) * 255), Math.round((b! + m) * 255), 255];
}

const AVATAR_CELL = 3;
const AVATAR_PX = 5 * AVATAR_CELL;

/**
 * GitHub-style identicon, deterministic from the agent name: a 5×5 sprite
 * mirrored around its center column, in a hue hashed from the same name so
 * every appearance of an agent carries the same mark. Lightness adapts to
 * the theme; shape stays the primary identity signal (hashed hues can land
 * near each other, and the terminal theme owns the real color budget).
 */
/** Hues an avatar may take: none near the reserved status colors (success green ~100°, error red ~345°), so no agent's mark can read as pass/fail. */
const AVATAR_HUES = [205, 262, 30, 178, 300, 52];

function drawAvatar(raster: Raster, x: number, y: number, agent: string, p: Palette): void {
	const hash = hash32(agent);
	const color = hslToRgb(AVATAR_HUES[hash % AVATAR_HUES.length]!, 0.55, p.mode === "dark" ? 0.62 : 0.42);
	for (let row = 0; row < 5; row++) {
		for (let column = 0; column < 5; column++) {
			const bit = row * 3 + (column < 3 ? column : 4 - column);
			if ((hash >> (bit + 8)) & 1) fillRect(raster, x + column * AVATAR_CELL, y + row * AVATAR_CELL, AVATAR_CELL, AVATAR_CELL, color);
		}
	}
}

// --------------------------------------------- variant C: editorial rails

function variantC(runs: Run[], p: Palette): Png {
	const total = totalMs(runs);
	const pad = 7 * SCALE;
	const rowPitch = 21 * SCALE;
	const axisH = 12 * SCALE;
	const chartW = WIDTH - 2 * pad;
	const height = pad + runs.length * rowPitch + axisH + pad;
	const raster = createRaster(WIDTH, height);
	const xAt = (ms: number): number => pad + (ms / total) * chartW;

	runs.forEach((run, index) => {
		const y = pad + index * rowPitch;
		const duration = formatDuration(run.durationMs);
		// each agent's own mark: identicon beside the label, seeded by agent
		// name — the four reviewers visibly share theirs
		drawAvatar(raster, pad, y - 1, run.agent, p);
		const labelX = pad + AVATAR_PX + 4 * SCALE;
		drawText(raster, labelX, y, runDisplayName(run), p.muted);
		if (run.failed) drawText(raster, labelX + textW(runDisplayName(run)) + CHAR_W, y, "X FAILED", p.error);
		drawText(raster, WIDTH - pad - textW(duration), y, duration, p.dim);

		// faint full-width track, then the run's rail with a dot and an end tick
		const railY = y + 11 * SCALE;
		fillRect(raster, pad, railY + SCALE, chartW, SCALE, alpha(p.dim, 45));
		const xs = xAt(run.startedAtMs);
		const xe = Math.max(xs + 2 * SCALE, xAt(run.startedAtMs + run.durationMs));
		const color = run.failed ? p.error : p.success;
		if (run.failed) hatchRect(raster, xs, railY, xe - xs, 3 * SCALE, p.error);
		else fillRect(raster, xs, railY, xe - xs, 3 * SCALE, color);
		fillRect(raster, xs - SCALE, railY - 2 * SCALE, 3 * SCALE, 7 * SCALE, color); // start dot
		fillRect(raster, xe - SCALE, railY - 2 * SCALE, 2 * SCALE, 7 * SCALE, color); // end tick
	});

	const axisY = pad + runs.length * rowPitch + 2 * SCALE;
	fillRect(raster, pad, axisY, chartW, SCALE, alpha(p.dim, 60));
	drawText(raster, pad, axisY + 2 * SCALE, "0", p.dim);
	const mid = short(total / 2);
	drawText(raster, pad + chartW / 2 - textW(mid) / 2, axisY + 2 * SCALE, mid, p.dim);
	const end = formatDuration(total);
	drawText(raster, pad + chartW - textW(end), axisY + 2 * SCALE, end, p.dim);
	return finish(raster);
}

// ------------------------------------------------------------------ the page

interface Variant {
	key: string;
	name: string;
	blurb: string;
	render: (runs: Run[], p: Palette) => Png;
}

const VARIANTS: Variant[] = [
	{
		key: "A",
		name: "Waterfall",
		blurb: "Devtools-style: a real time axis with ticks, inline labels that hug their bars, alternating row tint. Optimizes for reading precise start offsets.",
		render: variantA,
	},
	{
		key: "B",
		name: "Packed lanes",
		blurb: "Runs packed into minimal lanes by overlap, labels inside the blocks, plus an “active children” load strip. Optimizes for seeing parallelism and utilization; height scales with peak concurrency, not run count.",
		render: variantB,
	},
	{
		key: "C",
		name: "Editorial rails",
		blurb: "Airy two-line rows: full label + duration as a text line, a thin rail with dot/tick endpoints beneath. Each agent carries its own identicon — a 5×5 sprite and hue hashed from the agent name, so repeated agents (the four reviewers) visibly share one mark. Optimizes for legibility and calm; costs vertical space.",
		render: variantC,
	},
];

const SCENARIOS: { title: string; caption: string; runs: Run[] }[] = [
	{ title: "flow review · fan-out", caption: "✓ 5/6 ok · 1 failed · 1m 4s · $0.63", runs: FAN_OUT },
	{ title: "flow build · pipeline", caption: "✓ 3/3 ok · 42s · $0.21", runs: PIPELINE },
];

function panel(png: Png, p: Palette, title: string, caption: string, mode: string): string {
	const img = `<img src="data:image/png;base64,${png.base64}" width="${png.widthPx / 2}" height="${png.heightPx / 2}" alt="">`;
	return `<div class="term" style="background:${p.bg};color:${p.fg}">
  <div class="chrome"><i></i><i></i><i></i><span>${mode}</span></div>
  <div class="head">◆ ${title} · <b style="color:rgb(${p.success.slice(0, 3).join(",")})">settled</b></div>
  ${img}
  <div class="foot" style="color:rgb(${p.muted.slice(0, 3).join(",")})">${caption}</div>
</div>`;
}

function variantSection(variant: Variant): string {
	const scenarios = SCENARIOS.map((scenario) => {
		const dark = panel(variant.render(scenario.runs, DARK), DARK, scenario.title, scenario.caption, "dark");
		const light = panel(variant.render(scenario.runs, LIGHT), LIGHT, scenario.title, scenario.caption, "light");
		return `<div class="pair">${dark}${light}</div>`;
	}).join("\n");
	return `<section id="v${variant.key}" data-key="${variant.key}" data-name="${variant.name}">
  <h2>${variant.key} — ${variant.name}</h2>
  <p>${variant.blurb}</p>
  ${scenarios}
</section>`;
}

const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PROTOTYPE — gantt directions</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #101014; color: #d6d9e2; font: 15px/1.5 -apple-system, "SF Pro Text", sans-serif; padding: 32px 24px 120px; }
  .wrap { max-width: 1160px; margin: 0 auto; }
  h1 { font-size: 18px; letter-spacing: .02em; margin-bottom: 4px; }
  .note { color: #8a8fa3; font-size: 13px; margin-bottom: 28px; }
  section { display: none; }
  section.active { display: block; }
  h2 { font-size: 15px; margin-bottom: 6px; }
  section > p { color: #a2a7ba; font-size: 13px; max-width: 72ch; margin-bottom: 20px; }
  .pair { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
  .term { border-radius: 10px; padding: 10px 14px 12px; font: 12px/1.6 "SF Mono", ui-monospace, monospace; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
  .chrome { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; opacity: .8; }
  .chrome i { width: 10px; height: 10px; border-radius: 50%; background: #5a5e70; display: inline-block; }
  .chrome span { margin-left: auto; font-size: 10px; opacity: .7; }
  .head { margin-bottom: 6px; }
  .foot { margin-top: 4px; }
  img { display: block; image-rendering: auto; max-width: 100%; height: auto; }
  .bar { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 4px;
         background: #f2f3f7; color: #16171c; border-radius: 999px; padding: 6px 10px; font: 13px/1 -apple-system, sans-serif;
         box-shadow: 0 6px 24px rgba(0,0,0,.5); user-select: none; }
  .bar button { all: unset; cursor: pointer; padding: 6px 10px; border-radius: 999px; font-size: 15px; }
  .bar button:hover { background: rgba(0,0,0,.08); }
  .bar .label { min-width: 150px; text-align: center; font-weight: 600; }
</style>
<div class="wrap">
  <h1>PROTOTYPE — settled-card timeline directions</h1>
  <p class="note">Three variants × two scenarios, each over dark and light terminal panels (the PNG is transparent and composites over the theme background, exactly as in the real card). Switch with the bar below, ←/→, or #A/#B/#C in the URL.</p>
  ${VARIANTS.map(variantSection).join("\n")}
</div>
<div class="bar">
  <button id="prev" aria-label="previous">←</button>
  <span class="label" id="label"></span>
  <button id="next" aria-label="next">→</button>
</div>
<script>
  const sections = [...document.querySelectorAll("section")];
  const keys = sections.map((s) => s.dataset.key);
  function show(key) {
    if (!keys.includes(key)) key = "C";
    sections.forEach((s) => s.classList.toggle("active", s.dataset.key === key));
    const s = sections.find((s) => s.dataset.key === key);
    document.getElementById("label").textContent = key + " — " + s.dataset.name;
    if (location.hash !== "#" + key) history.replaceState(null, "", "#" + key);
  }
  function step(delta) {
    const current = keys.indexOf(location.hash.slice(1));
    show(keys[((current === -1 ? 0 : current) + delta + keys.length) % keys.length]);
  }
  document.getElementById("prev").addEventListener("click", () => step(-1));
  document.getElementById("next").addEventListener("click", () => step(1));
  addEventListener("keydown", (event) => {
    if (event.target.matches("input, textarea, [contenteditable]")) return;
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });
  addEventListener("hashchange", () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
</script>
`;

const out = join(dirname(fileURLToPath(import.meta.url)), "gantt-directions.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out}`);
console.log("open it in a browser; switch variants with the bottom bar, arrow keys, or #A/#B/#C");
