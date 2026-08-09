import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_MODE_CONTRACTS, criticalPathForMode } from "../extensions/pi-flows/modes/contract.ts";
import { RUN_MODE_NAMES } from "../extensions/pi-flows/types.ts";

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

test("evaluate critical path is unavailable when an unmeasured deterministic gate runs", () => {
	assert.equal(criticalPathForMode("evaluate", { evaluate: { checkCommand: "npm test" } }, [result("operator", 100), result("critic", 50)] as any[]), undefined);
});

test("every mode declares its critical path, and each answer is a duration or a declared unavailable", () => {
	// Which modes can answer for one minimal settled run is itself declared per
	// mode: sequential modes sum, fan-out modes bound by their slowest run, and
	// the rest — including orchestrate and monitor, formerly silent
	// fall-throughs — declare undefined for a shape their arithmetic does not
	// cover.
	const answerable = new Set(["single", "parallel", "chain", "evaluate", "vote", "route", "loop", "workflow"]);
	for (const mode of RUN_MODE_NAMES) {
		const contract = RUN_MODE_CONTRACTS.find((candidate) => candidate.mode === mode);
		assert.equal(typeof contract?.criticalPath, "function", `${mode} must declare a critical path in the mode table`);
		const answer = criticalPathForMode(mode, { [mode]: {} }, [result("a", 100)] as any[]);
		assert.ok(answer === undefined || typeof answer === "number", `${mode} must answer with a duration or undefined`);
		assert.equal(answer, answerable.has(mode) ? 100 : undefined, `${mode}: one settled run must ${answerable.has(mode) ? "sum to its own duration" : "stay unavailable"}`);
		assert.equal(criticalPathForMode(mode, { [mode]: {} }, []), undefined, `${mode}: zero results has no critical path`);
	}
});
