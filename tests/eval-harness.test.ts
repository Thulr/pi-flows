import { test } from "node:test";
import assert from "node:assert/strict";
import { CALIBRATION_CASES } from "../evals/cases.mjs";
import { injectModel } from "../evals/model-injection.mjs";
import { infraError } from "../evals/lib.mjs";

test("eval injectModel expands vote.agent/count into modeled explicit voters", () => {
	const params = injectModel(
		{ task: "x", vote: { agent: "recon", count: 2, debrief: { agent: "debrief" } } },
		"provider/model",
	);

	assert.equal(params.vote.agent, undefined);
	assert.equal(params.vote.count, undefined);
	assert.deepEqual(params.vote.voters, [
		{ agent: "recon", model: "provider/model" },
		{ agent: "recon", model: "provider/model" },
	]);
	assert.equal(params.vote.debrief.model, "provider/model");
});

test("eval injectModel preserves explicit voter model overrides", () => {
	const params = injectModel(
		{
			task: "x",
			vote: {
				voters: [{ agent: "recon" }, { agent: "overwatch", model: "already-set" }],
			},
		},
		"provider/model",
	);

	assert.deepEqual(params.vote.voters, [
		{ agent: "recon", model: "provider/model" },
		{ agent: "overwatch", model: "already-set" },
	]);
});

test("eval infraError does not flag normal security-review API key wording", () => {
	assert.equal(
		infraError({ content: [{ type: "text", text: "The handler lacks API key or webhook signature verification, so forged requests can be accepted." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "Missing authentication and API key checks let unauthorized webhook callers submit forged payments." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "No authentication required means anyone can invoke the webhook." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "Authentication required is missing from this handler." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "Error: authentication required" }], details: { results: [] } }),
		"provider/API error",
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "provider failed: API key missing" }], details: { results: [] } }),
		"provider/API error",
	);
});

test("eval calibration canaries are fixed true-negative judge fixtures", () => {
	assert.ok(CALIBRATION_CASES.length >= 3, "TNR needs more than two negative data points");
	assert.ok(
		CALIBRATION_CASES.some((c) => c.objective.score > 0 && c.objective.score < 1),
		"at least one canary should be partial to give score-delta machinery headroom",
	);
	for (const testCase of CALIBRATION_CASES) {
		assert.equal(testCase.objective.pass, false, `${testCase.name} must remain a deterministic negative label`);
		assert.ok(testCase.task, `${testCase.name} carries judge task context`);
		assert.ok(testCase.answer, `${testCase.name} carries the answer thulr judges`);
		assert.ok(testCase.criterion, `${testCase.name} carries an inline criterion`);
	}
});
