import { test } from "node:test";
import assert from "node:assert/strict";
import { injectModel } from "../evals/model-injection.mjs";

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
