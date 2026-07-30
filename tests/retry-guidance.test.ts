import assert from "node:assert/strict";
import { test } from "node:test";
import registerPiFlows from "../extensions/pi-flows/index.ts";

test("the parent is told not to replay a non-retryable budget failure", () => {
	let flowTool: any;
	registerPiFlows({
		registerCommand() {},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		registerTool(tool: any) {
			if (tool.name === "flow") flowTool = tool;
		},
	} as any);

	assert.ok(flowTool, "the flow tool must be registered");
	assert.ok(
		flowTool.promptGuidelines.some((line: string) =>
			line.includes("retryable:false")
			&& line.includes("BUDGET_EXCEEDED")
			&& line.includes("do not automatically replay"),
		),
		"the parent-facing tool contract must treat unchanged budget replay as terminal",
	);
});
