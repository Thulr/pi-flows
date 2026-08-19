// The card's trace line colors health by the writer's own vocabulary
// (trace-scope.ts: "recorded" | "degraded" | "missing"). This file exists
// because the card once compared against "complete" — a value no sink ever
// writes — so a fully recorded trace rendered in the warning color forever.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowTraceHealthStatus } from "../extensions/pi-flows/trace-scope.ts";
import { flowCardLines, type FlowRunEntryData } from "../extensions/pi-flows/ui-flow-card.ts";

const theme = { fg: (color: string, text: string) => `[${color}]${text}`, bold: (text: string) => text, inverse: (text: string) => text } as any;

function traceLine(health: FlowTraceHealthStatus): string {
	const entry = { version: "test", mode: "single", status: "ok", results: [], trace: { traceFile: "~/traces/flow.jsonl", health } } as unknown as FlowRunEntryData;
	const line = flowCardLines(entry, theme, false).find((candidate) => candidate.includes("trace:"));
	assert.ok(line, "the card renders a trace line");
	return line;
}

test("a recorded trace renders in the success color", () => {
	assert.ok(traceLine("recorded").includes("[success](recorded)"), traceLine("recorded"));
});

test("a degraded or missing trace renders in the warning color", () => {
	assert.ok(traceLine("degraded").includes("[warning](degraded)"), traceLine("degraded"));
	assert.ok(traceLine("missing").includes("[warning](missing)"), traceLine("missing"));
});
