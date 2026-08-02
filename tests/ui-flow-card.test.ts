import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { appendFlowSessionEntry } from "../extensions/pi-flows/ui.ts";
import { durationBar, flowCardLines, renderFlowCard, type FlowRunEntryData } from "../extensions/pi-flows/ui-flow-card.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

function entryData(overrides: Partial<FlowRunEntryData> = {}): FlowRunEntryData {
	return {
		version: "test",
		mode: "evaluate",
		status: "ok",
		results: [
			{ agent: "strategist", agentSource: "package", exitCode: 0, durationMs: 31000, usage: { input: 9000, output: 1200, cost: 0.11 } },
			{ agent: "operator", agentSource: "package", exitCode: 0, durationMs: 73000, model: "sonnet", usage: { input: 40000, output: 9000, cost: 0.61 } },
			{ agent: "redteam", agentSource: "package", exitCode: 1, errorCode: "CHILD_EXIT", stopReason: "error", durationMs: 8000, usage: {} },
		],
		...overrides,
	};
}

test("durationBar scales against the longest child and stays in-bounds", () => {
	assert.equal(durationBar(0, 0), "░".repeat(14));
	assert.equal(durationBar(50, 100, 4), "██░░");
	assert.equal(durationBar(100, 100, 4), "████");
	assert.equal(durationBar(1, 100000, 4), "█░░░", "tiny durations still render one cell");
});

test("flow card header rolls up status, agents, tokens, cost, and duration", () => {
	const lines = flowCardLines(entryData(), theme, false);
	assert.match(lines[0]!, /flow evaluate ok/);
	assert.match(lines[0]!, /3 agents/);
	assert.match(lines[0]!, /59k tok/);
	assert.match(lines[0]!, /\$0\.7200/);
	assert.match(lines[0]!, /1m 13s/);
	const text = lines.join("\n");
	assert.match(text, /operator\s+█+/, "longest child fills its duration track");
	assert.match(text, /redteam.*CHILD_EXIT/);
	assert.match(text, /ctrl\+o for failure detail/);
});

test("flow card expanded view spells out failures; trace pointer is linked with health", () => {
	const lines = flowCardLines(entryData({ trace: { traceFile: "audit/flow-trace.jsonl", health: "complete" } }), theme, true);
	const text = lines.join("\n");
	assert.match(text, /CHILD_EXIT · stop: error · exit 1/);
	assert.match(text, /trace:.*audit\/flow-trace\.jsonl.*\(complete\)/);
	assert.doesNotMatch(text, /ctrl\+o for failure detail/, "the hint disappears once expanded");
});

test("flow card marks error status with the flow error code", () => {
	const lines = flowCardLines(entryData({ status: "error", errorCode: "BUDGET_EXCEEDED" }), theme, false);
	assert.match(lines[0]!, /error:BUDGET_EXCEEDED/);
});

test("non-clean preset outcomes persist and render as warnings, never green success", () => {
	const entries: Array<{ customType: string; data: any }> = [];
	const pi = { appendEntry: (customType: string, data: any) => entries.push({ customType, data }) } as any;
	appendFlowSessionEntry(pi, {
		mode: "parallel",
		version: "test",
		agentScope: "user",
		config: {},
		agentsDir: {},
		preset: { name: "code-review" },
		presetOutcome: "FINDINGS",
		results: [{ agent: "overwatch", agentSource: "package", task: "t", exitCode: 0, messages: [], stderr: "", usage: {} }],
	} as any);
	assert.equal(entries[0]?.data.status, "partial");

	const coloredTheme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]`, bold: (text: string) => text } as any;
	const legacyInconsistentEntry = entryData({ status: "ok", preset: "code-review", presetOutcome: "PARTIAL", results: [] });
	const header = flowCardLines(legacyInconsistentEntry, coloredTheme, false)[0]!;
	assert.match(header, /\[warning\]▣\[\/warning\]/);
	assert.match(header, /\[warning\]PARTIAL\[\/warning\]/);
	assert.doesNotMatch(header, /\[success\](?:▣|PARTIAL)/);
});

test("renderFlowCard tolerates entries written by other versions", () => {
	assert.equal(renderFlowCard(undefined, false, theme), undefined);
	assert.equal(renderFlowCard({ mode: "single" }, false, theme), undefined, "entries without results are skipped, not crashed");
	assert.ok(renderFlowCard(entryData(), false, theme) instanceof Text);
});

test("appendFlowSessionEntry persists the trace pointer for reload-safe rendering", () => {
	const entries: Array<{ customType: string; data: any }> = [];
	const pi = { appendEntry: (customType: string, data: any) => entries.push({ customType, data }) } as any;
	appendFlowSessionEntry(pi, {
		mode: "single",
		version: "test",
		agentScope: "user",
		config: {},
		agentsDir: {},
		results: [{ agent: "recon", agentSource: "package", task: "t", exitCode: 0, messages: [], stderr: "", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 2, turns: 1 } }],
		trace: { health: "complete", traceFile: "flow-trace.jsonl", traceId: "t1", rootSpanId: "s1" },
	} as any);

	assert.equal(entries[0]?.customType, "pi-flows.run");
	assert.deepEqual(entries[0]?.data.trace, { traceFile: "flow-trace.jsonl", health: "complete" });
	assert.ok(renderFlowCard(entries[0]?.data, false, theme) instanceof Text, "the persisted entry must round-trip through the card renderer");
});
