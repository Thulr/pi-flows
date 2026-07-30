import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FleetPanel, fleetRunLines } from "../extensions/pi-flows/fleet-panel.ts";
import { FlowRunRegistry } from "../extensions/pi-flows/inspector.ts";
import { flowLiveBoardLines } from "../extensions/pi-flows/ui-live-row.ts";
import { flowProgressText, flowStatusText, flowWidgetLines } from "../extensions/pi-flows/ui.ts";

/**
 * The header counter's *meaning*, across every surface that renders it. A bare
 * `settled/total` was ambiguous in both directions: `0/2` read as "no runs
 * started" and `2/2` read as "both runs succeeded" even when both failed. One
 * helper now names what the numerator counts while runs are outstanding, and
 * replaces the ratio with the verdict once nothing is.
 *
 * Every surface assertion goes through `flowProgressText` as well as the literal
 * string, so a surface that starts formatting its own ratio again fails here.
 */

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function result(overrides: Record<string, unknown> = {}): any {
	return { agent: "recon", agentSource: "package", task: "inspect auth", exitCode: -1, messages: [], stderr: "", usage, ...overrides };
}

function details(results: any[], overrides: Record<string, unknown> = {}): any {
	return { mode: "parallel", version: "test", agentScope: "user", config: { redactSecretsDefault: true }, agentsDir: {}, results, ...overrides };
}

/** The four states a two-run fan-out passes through, plus the single-run case. */
const inFlight = details([result(), result({ agent: "analyst" })]);
const allFailed = details([
	result({ exitCode: 1, error: { code: "BUDGET_EXCEEDED" } }),
	result({ agent: "analyst", exitCode: 1, error: { code: "BUDGET_EXCEEDED" } }),
]);
const allOk = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 0 })]);
const partial = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 1, error: { code: "CHILD_EXIT" } })]);
const singleRun = details([result()], { mode: "single" });

function boardHeader(flowDetails: any): string {
	return flowLiveBoardLines(flowDetails, theme, { tick: 0, redactSecrets: true })[0]!;
}

function fleetHeader(flowDetails: any, mode = flowDetails.mode): string {
	return fleetRunLines({ mode, redactSecrets: true, details: flowDetails } as any, theme, 0)[0]!;
}

test("flowProgressText names what the numerator counts, then replaces it with the verdict", () => {
	assert.equal(flowProgressText(inFlight), "0/2 settled");
	assert.equal(flowProgressText(details([result({ exitCode: 0 }), result({ agent: "analyst" })])), "1/2 settled");
	assert.equal(flowProgressText(allFailed), "2 failed", "N/N after total failure reads as a success total");
	assert.equal(flowProgressText(allOk), "2 ok");
	assert.equal(flowProgressText(partial), "1 failed", "a partial settle reports failures, not a success-looking ratio");
	assert.equal(flowProgressText(singleRun), "0/1 settled");
	assert.doesNotMatch(flowProgressText(allFailed), /\d+\/\d+/, "no ratio survives settling");
	assert.doesNotMatch(flowProgressText(allOk), /\d+\/\d+/);
	// A dispatched flow hits the status line before its first run registers.
	assert.equal(flowProgressText(details([])), "starting", "no runs yet is not a clean sweep");
	assert.equal(flowStatusText(details([])), "flow parallel: starting");
});

test("the live tool row labels the ratio while running and shows the verdict on settle", () => {
	assert.match(boardHeader(inFlight), /flow parallel 0\/2 settled/);
	assert.match(boardHeader(inFlight), /▱/, "the labeled counter travels with the progress bar");

	assert.match(boardHeader(allFailed), /flow parallel 2 failed/);
	assert.doesNotMatch(boardHeader(allFailed), /2\/2/, "the ratio must not outlive the run it measured");
	assert.doesNotMatch(boardHeader(allFailed), /▰|▱/, "a settled flow has nothing outstanding to bar-chart");

	assert.match(boardHeader(allOk), /flow parallel 2 ok/);
	assert.doesNotMatch(boardHeader(allOk), /2\/2/);
	assert.match(boardHeader(partial), /flow parallel 1 failed/);

	for (const state of [inFlight, allFailed, allOk, partial]) {
		assert.ok(boardHeader(state).includes(flowProgressText(state)), "the row must not format its own state text");
	}
});

test("the status line and widget report the same state text as the board", () => {
	assert.equal(flowStatusText(inFlight), "flow parallel: 0/2 settled");
	assert.equal(flowStatusText(allFailed), "flow parallel: 2 failed");
	assert.equal(flowStatusText(allOk), "flow parallel: 2 ok");
	assert.equal(flowStatusText(partial), "flow parallel: 1 failed");
	// A standalone one-liner has no agent rows beside it, so a one-run flow still
	// gets its state text — unlike the two board surfaces.
	assert.equal(flowStatusText(singleRun), "flow single: 0/1 settled");

	for (const state of [inFlight, allFailed, allOk, partial, singleRun]) {
		assert.equal(flowWidgetLines(state)[0], flowStatusText(state), "the widget header is the status line");
	}
});

test("a flow-level error still outranks the counter on the status line", () => {
	const errored = details([result({ exitCode: 0 }), result({ agent: "analyst" })], { error: { code: "BUDGET_EXCEEDED", message: "over budget" } });
	assert.equal(flowStatusText(errored), "flow parallel: error:BUDGET_EXCEEDED");
	assert.doesNotMatch(flowStatusText(errored), /1\/2/);
	assert.match(flowWidgetLines(errored).join("\n"), /error: over budget/);
});

test("the board surfaces report a flow-level error beside the run counts, as before", () => {
	// Only the status line gives the error precedence *over* the state text. On the
	// boards it has always been a separate signal, because the runs it reports are
	// a different fact from the flow-level failure (a denied checkpoint or an
	// incomplete trace can fail a flow whose every run succeeded).
	const errored = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 0 })], { error: { code: "TRACE_INCOMPLETE", message: "trace incomplete" } });
	const board = flowLiveBoardLines(errored, theme, { tick: 0, redactSecrets: true });
	assert.match(board[0]!, /flow parallel 2 ok/);
	assert.match(board.join("\n"), /error: TRACE_INCOMPLETE/, "the error line is what carries the flow-level failure");
	assert.match(fleetRunLines({ mode: "parallel", redactSecrets: true, details: errored } as any, theme, 0).join("\n"), /error: TRACE_INCOMPLETE/);
});

test("the fleet panel run header carries the same labeled counter and verdict", () => {
	assert.match(fleetHeader(inFlight), /flow parallel 0\/2 settled/);
	assert.match(fleetHeader(allFailed), /flow parallel 2 failed/);
	assert.doesNotMatch(fleetHeader(allFailed), /2\/2/, "the panel header has no status icon, so the text is the only signal");
	assert.match(fleetHeader(allOk), /flow parallel 2 ok/);
	assert.match(fleetHeader(partial), /flow parallel 1 failed/);

	for (const state of [inFlight, allFailed, allOk, partial]) {
		assert.ok(fleetHeader(state).includes(flowProgressText(state)), "the panel must not format its own state text");
	}
});

test("single-run flows keep bare headers on both board surfaces", () => {
	assert.equal(boardHeader(singleRun).includes("0/1"), false);
	assert.equal(boardHeader(singleRun).includes("settled"), false, "with one run the header would only restate the agent row");
	assert.equal(boardHeader(details([result({ exitCode: 0 })], { mode: "single" })).includes("1 ok"), false);
	assert.equal(fleetHeader(singleRun, "single").includes("0/1"), false);
	assert.equal(fleetHeader(singleRun, "single").includes("settled"), false);
	assert.equal(fleetHeader(details([result({ exitCode: 0 })], { mode: "single" }), "single").includes("1 ok"), false);
});

test("the longest realistic fleet header survives an 80-column terminal", () => {
	// The overlay is 44% wide with minWidth 46 and hides itself below 80 columns,
	// so 46 is the narrowest box the header ever renders in.
	const panelWidth = Math.max(46, Math.floor(80 * 0.44));
	const registry = new FlowRunRegistry();
	const runs = Array.from({ length: 16 }, (_item, index) => result({ agent: `agent-${index}`, exitCode: index < 12 ? 0 : -1 }));
	registry.start("flow-1", "orchestrate", details(runs, { mode: "orchestrate" }), true);
	const panel = new FleetPanel({ requestRender: () => {} } as any, theme, { matches: () => false, getKeys: () => ["esc"] } as any, registry, () => {});

	const rendered = panel.render(panelWidth);
	const header = rendered.find((line) => line.includes("flow orchestrate"))!;
	assert.ok(header, "the longest mode name must still reach the panel");
	assert.match(header, /flow orchestrate 12\/16 settled/, "the label must not be the part that gets clipped");
	assert.ok(rendered.every((line) => visibleWidth(line) <= panelWidth));
	panel.dispose();
});
