import assert from "node:assert/strict";
import { test } from "node:test";
import { criticalPathForMode } from "../extensions/pi-flows/trace.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
const result = (agent: string, durationMs: number) => ({
	agent,
	agentSource: "package",
	task: agent,
	exitCode: 0,
	messages: [],
	stderr: "",
	usage,
	durationMs,
});

test("search critical path sums generator/scorer fanout waves and the debrief tail", () => {
	const results = [
		result("generator", 100), result("generator", 200), result("scorer", 30), result("scorer", 40),
		result("generator", 150), result("generator", 120), result("scorer", 50), result("scorer", 60),
		result("debrief", 25),
	] as any[];
	assert.equal(criticalPathForMode("search", { search: { candidates: 2, maxRounds: 2 } }, results), 475);
	assert.equal(criticalPathForMode("search", { search: { candidates: 2, maxRounds: 2 } }, results.slice(0, -1)), undefined);
});
