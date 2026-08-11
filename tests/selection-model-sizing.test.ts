// Offline scoring coverage for issue #121's model-selection eval shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCallMatchesExpectation, scoreSelection } from "../evals/select.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";

test("heterogeneous model-selection cases bind each tier to the intended task", () => {
	const expected = { mode: "parallel", tieredTasks: [
		{ tier: "fast", taskPattern: "extract" },
		{ tier: "deep", taskPattern: "adjudicate" },
	] };
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
	assert.match(uniform.notes, /expected a fast parallel task/);

	const swapped = flowCallMatchesExpectation({ arguments: {
		why: "mixed independent work",
		tasks: [
			{ agent: "analyst", task: "extract", tier: "deep" },
			{ agent: "analyst", task: "adjudicate", tier: "fast" },
		],
	} }, expected);
	assert.equal(swapped.pass, false, "the right tier multiset on the wrong tasks must fail");
	assert.match(swapped.notes, /expected a fast parallel task matching \/extract\/i/);
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
