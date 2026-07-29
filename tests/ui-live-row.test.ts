import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	COLLAPSED_AGENT_ROWS,
	SPINNER_FRAMES,
	currentActivityText,
	ensureRowTicker,
	flowLiveBoardLines,
	progressBar,
	renderFlowResultRow,
	spinnerFrame,
	type RowTickerState,
} from "../extensions/pi-flows/ui-live-row.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function result(overrides: Record<string, unknown> = {}): any {
	return { agent: "recon", agentSource: "package", task: "inspect auth", exitCode: -1, messages: [], stderr: "", usage, ...overrides };
}

function details(results: any[], overrides: Record<string, unknown> = {}): any {
	return { mode: "parallel", version: "test", agentScope: "user", config: { redactSecretsDefault: true }, agentsDir: {}, results, ...overrides };
}

test("progressBar is proportional and safe at the edges", () => {
	assert.equal(progressBar(0, 0), "");
	assert.equal(progressBar(3, 5, 0), "");
	assert.equal(progressBar(0, 4, 4), "▱▱▱▱");
	assert.equal(progressBar(2, 4, 4), "▰▰▱▱");
	assert.equal(progressBar(4, 4, 4), "▰▰▰▰");
	assert.equal(progressBar(9, 4, 4), "▰▰▰▰", "overshoot must clamp");
});

test("spinnerFrame cycles deterministically and offsets stagger agents", () => {
	assert.equal(spinnerFrame(0), SPINNER_FRAMES[0]);
	assert.equal(spinnerFrame(SPINNER_FRAMES.length), SPINNER_FRAMES[0]);
	assert.notEqual(spinnerFrame(0, 2), spinnerFrame(0, 0));
});

test("currentActivityText surfaces the child's latest tool call", () => {
	const running = result({
		messages: [
			{ role: "assistant", content: [
				{ type: "text", text: "Looking at the session module" },
				{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
			] },
		],
	});
	assert.match(currentActivityText(running, true), /^→ \$ npm test/);
	assert.match(currentActivityText(result(), true), /waiting for activity/);

	const chatty = result({
		messages: [{ role: "assistant", content: [{ type: "text", text: "word ".repeat(60) }] }],
	});
	assert.ok(currentActivityText(chatty, true).length <= 72, "activity must not wrap the row into a paragraph");
	assert.match(currentActivityText(chatty, true), /…$/);
});

test("flowLiveBoardLines shows progress, per-agent state, and activity while running", () => {
	const board = flowLiveBoardLines(details([
		result({ exitCode: 0, usage: { ...usage, input: 1000, output: 200, cost: 0.01 }, durationMs: 4200 }),
		result({
			agent: "operator",
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/auth.ts" } }] }],
		}),
		result({ agent: "analyst", agentSource: "unknown", task: "queued work" }),
		result({ agent: "redteam", exitCode: 1, error: { code: "CHILD_EXIT" } }),
	]), theme, { tick: 0, redactSecrets: true });

	assert.match(board[0]!, /flow parallel 2\/4/);
	assert.match(board[0]!, /▰+▱+/, "running header should carry a progress bar");
	assert.match(board[0]!, /tok/, "header should roll up token totals");
	assert.match(board[0]!, /\$0\.01/);
	const text = board.join("\n");
	assert.match(text, /operator.*→ read src\/auth\.ts/);
	assert.match(text, /analyst.*queued/);
	assert.match(text, /redteam.*CHILD_EXIT/);
	assert.match(text, /F8 fleet panel/);
});

test("single-child runs drop the done/total counter, bar, and rollup from the header", () => {
	const board = flowLiveBoardLines(details([
		result({ usage: { ...usage, input: 2000, output: 300, cost: 0.94 } }),
	], { mode: "single" }), theme, { tick: 0, redactSecrets: true });
	assert.doesNotMatch(board[0]!, /0\/1/, "a 0/1 counter reads as stuck, not as progress");
	assert.doesNotMatch(board[0]!, /▰|▱/);
	assert.doesNotMatch(board[0]!, /tok|\$/, "the rollup would only restate the single agent line");
	assert.match(board[0]!, /flow single/);
	assert.match(board.join("\n"), /recon/);
});

test("flowLiveBoardLines caps collapsed rows and settles without a spinner hint", () => {
	const many = Array.from({ length: COLLAPSED_AGENT_ROWS + 3 }, (_item, index) => result({ agent: `agent-${index}`, exitCode: 0 }));
	const board = flowLiveBoardLines(details(many), theme, { tick: 0, redactSecrets: true });
	assert.match(board.join("\n"), new RegExp(`\\+3 more`));
	assert.doesNotMatch(board.join("\n"), /F8 fleet panel/, "settled runs need no live-panel hint");
	assert.equal(board.length, 1 + COLLAPSED_AGENT_ROWS + 1 + 1, "header + rows + more + hint");
});

test("ensureRowTicker starts one timer while running and stops it on settle", () => {
	let scheduled = 0;
	let cancelled = 0;
	let invalidations = 0;
	let tickFn: (() => void) | undefined;
	const schedule = ((fn: () => void) => { scheduled++; tickFn = fn; return { unref() {} } as any; }) as typeof setInterval;
	const cancel = () => { cancelled++; };
	const state: RowTickerState = {};

	ensureRowTicker(state, true, () => invalidations++, 120, schedule, cancel);
	ensureRowTicker(state, true, () => invalidations++, 120, schedule, cancel);
	assert.equal(scheduled, 1, "a second render must not stack another timer");
	tickFn?.();
	tickFn?.();
	assert.equal(invalidations, 2);
	assert.equal(state.tick, 2);

	ensureRowTicker(state, false, () => invalidations++, 120, schedule, cancel);
	assert.equal(cancelled, 1);
	assert.equal(state.timer, undefined);
	ensureRowTicker(state, false, () => invalidations++, 120, schedule, cancel);
	assert.equal(cancelled, 1, "settled state must not cancel twice");
});

test("renderFlowResultRow reuses the collapsed Text component and cleans up its ticker", () => {
	const flowResult = { content: [{ type: "text", text: "done" }], details: details([result()]) };
	const state: RowTickerState = {};
	const context = { invalidate: () => {}, state, lastComponent: undefined as unknown } as any;
	const summarize = () => "agents";

	const first = renderFlowResultRow(flowResult as any, { expanded: false, isPartial: true }, theme, context, summarize as any);
	assert.ok(first instanceof Text);
	assert.notEqual(state.timer, undefined, "partial render must start the repaint ticker");

	context.lastComponent = first;
	const second = renderFlowResultRow(flowResult as any, { expanded: false, isPartial: true }, theme, context, summarize as any);
	assert.equal(second, first, "collapsed rerenders should update the same component in place");

	const settled = { content: [{ type: "text", text: "done" }], details: details([result({ exitCode: 0 })]) };
	renderFlowResultRow(settled as any, { expanded: false, isPartial: false }, theme, context, summarize as any);
	assert.equal(state.timer, undefined, "settled render must stop the repaint ticker");
});

test("renderFlowResultRow keeps expanded detail and non-run modes intact", () => {
	const state: RowTickerState = {};
	const context = { invalidate: () => {}, state, lastComponent: undefined } as any;
	const summarize = () => "agents";

	const listResult = { content: [{ type: "text", text: "agent list here" }], details: details([], { mode: "list" }) };
	const listComponent = renderFlowResultRow(listResult as any, { expanded: false, isPartial: false }, theme, context, summarize as any);
	assert.ok(listComponent instanceof Text);

	const bare = renderFlowResultRow({ content: [{ type: "text", text: "plain" }] } as any, { expanded: false, isPartial: false }, theme, context, summarize as any);
	assert.ok(bare instanceof Text);

	const expanded = renderFlowResultRow(
		{ content: [{ type: "text", text: "done" }], details: details([result({ exitCode: 0 })]) } as any,
		{ expanded: true, isPartial: false },
		theme,
		context,
		summarize as any,
	);
	assert.ok(expanded instanceof Container, "expanded view keeps the full per-agent container");
});
