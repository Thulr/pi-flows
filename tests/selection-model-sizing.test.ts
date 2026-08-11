// Offline scoring coverage for issue #121's model-selection eval shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCallMatchesExpectation, scoreSelection } from "../evals/select.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";

test("heterogeneous model-selection cases require explicit per-task tiers", () => {
	const expected = { mode: "parallel", taskTiers: ["fast", "deep"] };
	const explicit = flowCallMatchesExpectation({ arguments: {
		why: "mixed independent work",
		tasks: [
			{ agent: "analyst", task: "extract", tier: "fast" },
			{ agent: "analyst", task: "adjudicate", tier: "deep" },
		],
	} }, expected);
	assert.equal(explicit.pass, true);

	const uniform = flowCallMatchesExpectation({ arguments: {
		why: "mixed independent work",
		tier: "capable",
		tasks: [{ agent: "analyst", task: "extract" }, { agent: "analyst", task: "adjudicate" }],
	} }, expected);
	assert.equal(uniform.pass, false, "a uniform runtime choice does not satisfy the heterogeneous eval case");
	assert.match(uniform.notes, /expected parallel task tiers/);
});

test("the mixed-complexity sizing case's dry-run mock passes its live scorer", () => {
	const testCase = SELECTION_CASES.find((candidate) => candidate.name === "mixed-complexity-parallel-right-sizes-tiers");
	assert.ok(testCase);
	const result = scoreSelection(testCase, {
		flowCalls: testCase.mock.flowCalls,
		flowCallArgs: testCase.mock.flowCallArgs,
		answer: testCase.mock.answer,
	});
	assert.equal(result.pass, true, result.notes);
});
