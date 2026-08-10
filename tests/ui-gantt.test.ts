import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { Container, Text, getPngDimensions, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { encodePng, createRaster, fillRect } from "../extensions/pi-flows/png.ts";
import { AVATAR_HUES, flowGanttPng, ganttLayout, themeRgb } from "../extensions/pi-flows/ui-gantt.ts";
import { renderFlowCard, type FlowRunEntryData } from "../extensions/pi-flows/ui-flow-card.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;

function timedResults() {
	return [
		{ agent: "recon", exitCode: 0, durationMs: 8000, startedAtMs: 1000 },
		{ agent: "operator", role: "editor", exitCode: 0, durationMs: 20000, startedAtMs: 3000 },
		{ agent: "strategist", exitCode: 1, errorCode: "CHILD_EXIT", durationMs: 2000, startedAtMs: 5000 },
	];
}

test("ganttLayout offsets runs against the earliest start and needs two timed runs", () => {
	const layout = ganttLayout(timedResults())!;
	assert.deepEqual(layout.rows.map((row) => row.offsetMs), [0, 2000, 4000], "offsets are relative to the first spawn");
	assert.equal(layout.totalMs, 22000, "the span ends with the last run to finish, not the longest run");
	assert.deepEqual(layout.rows.map((row) => row.failed), [false, false, true]);
	assert.equal(layout.rows[1]!.label, "editor (operator)", "rows carry the full display form; the drawing truncates, not the layout");
	assert.deepEqual(layout.rows.map((row) => row.agent), ["recon", "operator", "strategist"], "rows carry the agent name — it seeds the per-agent identicon");

	assert.equal(ganttLayout([{ agent: "solo", exitCode: 0, durationMs: 5000 }]), undefined, "one bar says nothing the text card does not");
	assert.equal(ganttLayout([{ agent: "a", exitCode: 0 }, { agent: "b", exitCode: 0 }]), undefined, "no durations, no chart");
});

test("ganttLayout collapses to duration comparison when starts were never recorded", () => {
	const layout = ganttLayout([
		{ agent: "a", exitCode: 0, durationMs: 5000 },
		{ agent: "b", exitCode: 0, durationMs: 9000 },
	])!;
	assert.deepEqual(layout.rows.map((row) => row.offsetMs), [0, 0]);
	assert.equal(layout.totalMs, 9000);
});

test("encodePng produces a PNG whose header and pixel data round-trip", () => {
	const raster = createRaster(10, 4);
	fillRect(raster, 0, 0, 10, 4, [10, 20, 30, 255]);
	const base64 = encodePng(raster);
	const bytes = Buffer.from(base64, "base64");
	assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
	assert.deepEqual(getPngDimensions(base64), { widthPx: 10, heightPx: 4 }, "IHDR carries the raster dimensions");

	// The IDAT payload must inflate back to filter-prefixed scanlines.
	const idatOffset = bytes.indexOf(Buffer.from("IDAT")) + 4;
	const idatLength = bytes.readUInt32BE(idatOffset - 8);
	const scanlines = inflateSync(bytes.subarray(idatOffset, idatOffset + idatLength));
	assert.equal(scanlines.length, 4 * (1 + 10 * 4));
	assert.equal(scanlines[0], 0, "filter type None");
	assert.deepEqual([...scanlines.subarray(1, 5)], [10, 20, 30, 255], "first pixel survives the round trip");
});

test("flowGanttPng rasterizes the layout at its declared dimensions", () => {
	const image = flowGanttPng(timedResults(), theme)!;
	assert.deepEqual(getPngDimensions(image.base64), image.dimensions, "declared dimensions match the encoded bitmap");
	assert.equal(image.dimensions.widthPx, image.maxWidthCells * 9 * 2, "rendered at 2x cell density");
	assert.equal(flowGanttPng([{ agent: "solo", exitCode: 0, durationMs: 5000 }], theme), undefined);
});

/** Decode one of this encoder's own PNGs (single IDAT, filter type None) back to raw RGBA. */
function decodeRgba(base64: string): { width: number; height: number; pixels: Buffer } {
	const bytes = Buffer.from(base64, "base64");
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	const idatOffset = bytes.indexOf(Buffer.from("IDAT")) + 4;
	const idatLength = bytes.readUInt32BE(idatOffset - 8);
	const scanlines = inflateSync(bytes.subarray(idatOffset, idatOffset + idatLength));
	const pixels = Buffer.alloc(width * height * 4);
	for (let row = 0; row < height; row++) {
		scanlines.copy(pixels, row * width * 4, row * (1 + width * 4) + 1, (row + 1) * (1 + width * 4));
	}
	return { width, height, pixels };
}

// Drawing geometry the pixel assertions below need: 2× cell density, 7-unit
// padding, 21-unit row pitch, 5×5 identicon at 3px cells at each row's left
// edge. These mirror the constants in ui-gantt.ts.
const PAD = 14;
const ROW_PITCH = 42;
const AVATAR = 15;

function avatarStrip(image: { base64: string }, rowIndex: number): Buffer {
	const { width, pixels } = decodeRgba(image.base64);
	const y = PAD + rowIndex * ROW_PITCH;
	const rows: Buffer[] = [];
	for (let row = y; row < y + AVATAR; row++) {
		rows.push(pixels.subarray((row * width + PAD) * 4, (row * width + PAD + AVATAR) * 4));
	}
	return Buffer.concat(rows);
}

test("identicons are deterministic per agent, shared by a fan-out, and never blank", () => {
	const fanOut = flowGanttPng([
		{ agent: "reviewer", role: "security", exitCode: 0, durationMs: 8000, startedAtMs: 1000 },
		{ agent: "reviewer", role: "perf", exitCode: 0, durationMs: 20000, startedAtMs: 3000 },
		{ agent: "solo", exitCode: 0, durationMs: 5000, startedAtMs: 2000 },
	], theme)!;
	assert.deepEqual(avatarStrip(fanOut, 0), avatarStrip(fanOut, 1), "two runs of one agent wear one mark, whatever their roles");
	assert.notDeepEqual(avatarStrip(fanOut, 0), avatarStrip(fanOut, 2), "different agents wear different marks");
	assert.ok(avatarStrip(fanOut, 0).some((byte) => byte !== 0), "a mark is never blank");

	const otherFlow = flowGanttPng([
		{ agent: "scout", exitCode: 0, durationMs: 4000, startedAtMs: 0 },
		{ agent: "reviewer", exitCode: 0, durationMs: 6000, startedAtMs: 500 },
	], theme)!;
	assert.deepEqual(avatarStrip(otherFlow, 1), avatarStrip(fanOut, 0), "the same agent wears the same mark in every flow");

	// "agent-3000" hashes every pattern bit to zero — the one name family that
	// would wear no mark without the center-cell fallback.
	const blankPattern = flowGanttPng([
		{ agent: "agent-3000", exitCode: 0, durationMs: 4000, startedAtMs: 0 },
		{ agent: "scout", exitCode: 0, durationMs: 6000, startedAtMs: 500 },
	], theme)!;
	assert.ok(avatarStrip(blankPattern, 0).some((byte) => byte !== 0), "an all-zero hash pattern still wears the center cell");
});

test("every allowed avatar hue stays ≥30° from the status hues — unconditionally, not just for hashed samples", () => {
	const degreesFrom = (hue: number, status: number): number => Math.min(Math.abs(hue - status), 360 - Math.abs(hue - status));
	for (const hue of AVATAR_HUES) {
		assert.ok(degreesFrom(hue, 100) >= 30, `avatar hue ${hue}° could read as success green`);
		assert.ok(degreesFrom(hue, 345) >= 30, `avatar hue ${hue}° could read as error red`);
	}
});

test("avatar hues stay clear of the reserved status bands and adapt lightness to the theme", () => {
	const agents = ["recon", "analyst", "operator", "redteam", "strategist", "reviewer", "scout", "synthesizer"];
	const results = agents.map((agent, index) => ({ agent, exitCode: 0, durationMs: 5000 + index * 1000, startedAtMs: index * 500 }));
	// Dark terminals set light muted text and vice versa — that luminance is the renderer's theme signal.
	const darkTheme = { getFgAnsi: (color: string) => (color === "muted" ? "[38;2;169;177;214m" : "[39m") } as any;
	const lightTheme = { getFgAnsi: (color: string) => (color === "muted" ? "[38;2;92;97;112m" : "[39m") } as any;
	const dark = flowGanttPng(results, darkTheme)!;
	const light = flowGanttPng(results, lightTheme)!;

	const colorOf = (image: { base64: string }, row: number): [number, number, number] => {
		const strip = avatarStrip(image, row);
		for (let offset = 0; offset < strip.length; offset += 4) {
			if (strip[offset + 3]) return [strip[offset]! / 255, strip[offset + 1]! / 255, strip[offset + 2]! / 255];
		}
		assert.fail("blank avatar");
	};
	const hueOf = ([r, g, b]: [number, number, number]): number => {
		const max = Math.max(r, g, b);
		const delta = max - Math.min(r, g, b);
		if (delta === 0) return 0;
		const h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
		return (h * 60 + 360) % 360;
	};
	const lightnessOf = ([r, g, b]: [number, number, number]): number => (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
	const degreesFrom = (hue: number, status: number): number => Math.min(Math.abs(hue - status), 360 - Math.abs(hue - status));

	agents.forEach((agent, row) => {
		const hue = hueOf(colorOf(dark, row));
		assert.ok(degreesFrom(hue, 100) >= 30, `${agent} avatar hue ${hue.toFixed(0)}° could read as success green`);
		assert.ok(degreesFrom(hue, 345) >= 30, `${agent} avatar hue ${hue.toFixed(0)}° could read as error red`);
		assert.ok(lightnessOf(colorOf(dark, row)) > lightnessOf(colorOf(light, row)), `${agent} avatar must be lighter on a dark theme`);
	});
});

test("a failed run's rail is hatched — texture, not color alone", () => {
	const image = flowGanttPng([
		{ agent: "ok", exitCode: 0, durationMs: 30000, startedAtMs: 0 },
		{ agent: "bad", exitCode: 1, durationMs: 30000, startedAtMs: 0 },
	], theme)!;
	const { width, pixels } = decodeRgba(image.base64);
	// The rail band sits 11 units below the row's label line; sample its
	// middle scanline across the chart, skipping the dot/tick end caps.
	const railAlphas = (rowIndex: number): Set<number> => {
		const y = PAD + rowIndex * ROW_PITCH + 22 + 2;
		const alphas = new Set<number>();
		for (let column = PAD + 20; column < width - PAD - 20; column++) alphas.add(pixels[(y * width + column) * 4 + 3]!);
		return alphas;
	};
	assert.deepEqual(railAlphas(0), new Set([255]), "a successful rail is solid");
	assert.deepEqual(railAlphas(1), new Set([110, 255]), "a failed rail alternates translucent base and solid stripes");
});

test("themeRgb reads truecolor themes and falls back for anything else", () => {
	const truecolor = { getFgAnsi: (color: string) => (color === "success" ? "[38;2;158;206;106m" : "[39m") } as any;
	assert.deepEqual(themeRgb(truecolor, "success"), [158, 206, 106, 255]);
	assert.deepEqual(themeRgb(truecolor, "error"), [225, 95, 120, 255], "a non-truecolor answer falls back");
	assert.deepEqual(themeRgb(theme, "muted", 70), [128, 132, 148, 70], "fakes without getFgAnsi fall back");
});

function entry(): FlowRunEntryData {
	return {
		version: "test",
		mode: "parallel",
		status: "ok",
		results: [
			{ agent: "recon", agentSource: "package", exitCode: 0, durationMs: 8000, startedAtMs: 1000, usage: {} },
			{ agent: "operator", agentSource: "package", exitCode: 0, durationMs: 20000, startedAtMs: 3000, usage: {} },
		],
	};
}

test("renderFlowCard embeds the Gantt image only when the terminal declares an image protocol", (t) => {
	t.after(() => resetCapabilitiesCache());

	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const fallback = renderFlowCard(entry(), false, theme);
	assert.ok(fallback instanceof Text, "no protocol, no image — the text card is the whole card");
	assert.match((fallback as any).text ?? "", /█/, "the text card keeps its duration bars");

	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	const card = renderFlowCard(entry(), false, theme);
	assert.ok(card instanceof Container, "an image-capable terminal gets header + chart + rows");
	const texts = (card as any).children.filter((child: unknown) => child instanceof Text);
	assert.doesNotMatch(texts.map((text: any) => text.text).join("\n"), /█/, "the chart owns the timing story; rows must not restate the bars");
});

test("the Gantt image and its Kitty ID are cached per entry, invalidated by palette — not object identity", (t) => {
	t.after(() => resetCapabilitiesCache());
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });

	// pi hands renderers one stable theme proxy whose target swaps on a theme
	// switch, so the cache must key on a resolved color, never the reference.
	const green = { ...theme, getFgAnsi: () => "[38;2;158;206;106m" };
	const data = entry();
	const first = renderFlowCard(data, false, green) as Container;
	const second = renderFlowCard(data, true, { ...theme, getFgAnsi: () => "[38;2;158;206;106m" }) as Container;
	const imageOf = (container: Container) => (container as any).children.find((child: unknown) => !(child instanceof Text));
	assert.equal(imageOf(first), imageOf(second), "same palette, same entry: one Image component across repaints, even across theme object identities");

	const red = { ...theme, getFgAnsi: () => "[38;2;247;118;142m" };
	const retinted = renderFlowCard(data, false, red) as Container;
	assert.notEqual(imageOf(retinted), imageOf(first), "a palette change re-rasterizes with the new colors");

	// The key must watch every color the chart draws with, not just one:
	// success stays identical here and only error moves.
	const errorOnly = { ...theme, getFgAnsi: (color: string) => (color === "error" ? "[38;2;200;0;0m" : "[38;2;158;206;106m") };
	const greenish = { ...theme, getFgAnsi: () => "[38;2;158;206;106m" };
	const base = renderFlowCard(data, false, greenish) as Container;
	const errorShift = renderFlowCard(data, false, errorOnly) as Container;
	assert.notEqual(imageOf(errorShift), imageOf(base), "a change to a non-success chart color must also invalidate");
});
