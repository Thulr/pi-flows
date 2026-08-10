import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SPINNER_FRAMES,
	boxFrame,
	chip,
	formatDuration,
	meterBar,
	meterColor,
	runStateBar,
	sparkline,
	spinnerFrame,
	stateIcon,
	treeGuide,
	type RunState,
} from "../extensions/pi-flows/ui-style.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;
const tagged = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]`, bold: (text: string) => `[b]${text}[/b]`, inverse: (text: string) => `[inv]${text}[/inv]` } as any;

test("spinnerFrame cycles deterministically and offsets stagger agents", () => {
	assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
	assert.equal(spinnerFrame(SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
	assert.notEqual(spinnerFrame(0, 2), spinnerFrame(0, 0));
});

test("stateIcon pairs each state with its glyph and color", () => {
	assert.equal(stateIcon(tagged, "completed"), "[success]✓[/success]");
	assert.equal(stateIcon(tagged, "failed"), "[error]✗[/error]");
	assert.equal(stateIcon(tagged, "queued"), "[muted]◌[/muted]");
	assert.match(stateIcon(tagged, "running", 0, 0), /^\[warning\]/, "running animates in warning");
});

test("meterBar fills smoothly, clamps, and always spans its width", () => {
	assert.equal(meterBar(0, 4), "░░░░");
	assert.equal(meterBar(0.25, 12), "███░░░░░░░░░");
	assert.equal(meterBar(1, 12), "████████████");
	assert.equal(meterBar(7, 4), "████", "overshoot must clamp");
	assert.equal(meterBar(-1, 4), "░░░░", "undershoot must clamp");
	assert.equal(meterBar(0.5, 0), "");
	// Partial cells render as eighth blocks rather than snapping a whole cell.
	assert.equal(meterBar(0.5, 5), "██▌░░");
	for (const ratio of [0, 0.1, 0.33, 0.5, 0.66, 0.875, 0.99, 1]) {
		assert.equal(visibleWidth(meterBar(ratio, 12)), 12, `width must hold at ratio ${ratio}`);
	}
});

test("meterColor turns warning at 60% and alarm at 90%", () => {
	assert.equal(meterColor(0), "success");
	assert.equal(meterColor(0.59), "success");
	assert.equal(meterColor(0.6), "warning");
	assert.equal(meterColor(0.89), "warning");
	assert.equal(meterColor(0.9), "error");
	assert.equal(meterColor(1), "error");
});

test("runStateBar renders one colored cell per run, queued as empty track", () => {
	const states: RunState[] = ["completed", "running", "queued", "failed"];
	assert.equal(runStateBar(plain, states), "██░█");
	assert.equal(
		runStateBar(tagged, states),
		"[success]█[/success][warning]█[/warning][muted]░[/muted][error]█[/error]",
		"each cell carries its own state color",
	);
	assert.equal(runStateBar(plain, []), "");
	assert.equal(runStateBar(plain, states, 0), "");
});

test("runStateBar compresses to proportional segments above maxWidth", () => {
	const states: RunState[] = [
		...Array.from({ length: 10 }, () => "completed" as const),
		...Array.from({ length: 6 }, () => "running" as const),
		...Array.from({ length: 4 }, () => "queued" as const),
	];
	const bar = runStateBar(plain, states, 10);
	assert.equal(visibleWidth(bar), 10, "compressed bar must hold maxWidth");
	assert.equal(bar, "████████░░", "10/6/4 of 20 runs compress to 5/3/2 cells");
	const colored = runStateBar(tagged, states, 10);
	assert.match(colored, /\[success\]█{5}\[\/success\]/);
	assert.match(colored, /\[warning\]█{3}\[\/warning\]/);
	assert.match(colored, /\[muted\]░{2}\[\/muted\]/);
});

test("sparkline scales to the window maximum and keeps a visible baseline at zero", () => {
	assert.equal(sparkline([]), "");
	assert.equal(sparkline([0, 0, 0]), "▁▁▁", "sampled-and-idle must not vanish");
	assert.equal(sparkline([0, 1, 2, 4]), "▁▃▅█", "the curve is scaled to the window's own max");
	assert.equal(sparkline([1, 1, 1]), "███", "a flat non-zero series sits at the top, not mid-scale");
	assert.equal(sparkline([-5, 4]), "▁█", "negative samples clamp to the baseline");
	assert.equal(sparkline([1, 2, 3, 4], 2), "▆█", "the window keeps the most recent samples");
});

test("chip wraps the label in inverse video over its color", () => {
	assert.equal(chip(tagged, "success", "✓ ok"), "[inv][success] ✓ ok [/success][/inv]");
});

test("treeGuide closes the tree on the last row", () => {
	assert.equal(treeGuide(0, 3), "├");
	assert.equal(treeGuide(1, 3), "├");
	assert.equal(treeGuide(2, 3), "└");
	assert.equal(treeGuide(0, 1), "└");
});

test("formatDuration switches to minutes past one minute", () => {
	assert.equal(formatDuration(1500), "1.5s");
	assert.equal(formatDuration(73000), "1m 13s");
});

test("boxFrame keeps every line at the outer width, with and without a title", () => {
	const frame = boxFrame(plain, 30);
	for (const line of [frame.top(), frame.top("flows · 2 live"), frame.row("hello"), frame.row(), frame.separator(), frame.bottom()]) {
		assert.equal(visibleWidth(line), 32, `line must span the frame: ${line}`);
	}
	assert.match(frame.top("flows"), /^╭─ flows ─+╮$/, "the title is woven into the top border");
	assert.match(frame.row("x".repeat(99)), /…/, "overflowing rows truncate instead of wrapping");
	assert.match(frame.top("t".repeat(99)), /…/, "an overlong title truncates inside the border");
	assert.equal(visibleWidth(frame.top("t".repeat(99))), 32);
});
