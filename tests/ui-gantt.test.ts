import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { Container, Text, getPngDimensions, resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { encodePng, createRaster, fillRect } from "../extensions/pi-flows/png.ts";
import { flowGanttPng, ganttLayout, themeRgb } from "../extensions/pi-flows/ui-gantt.ts";
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
	assert.equal(layout.rows[1]!.label, "EDITOR", "an overflowing role (agent) form falls back to the whole role, folded to the font's case");

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
