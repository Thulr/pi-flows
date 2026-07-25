// Offline tests for the delegation contract on the flow tool: the WHY_REQUIRED
// justification gate and portable tier-based model selection. Uses the shared
// stub-pi harness (tests/stub-harness.ts) — no model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "./stub-harness.ts";

test("a spawning call without `why` is refused before any child runs", async () => {
	const { result, calls, text } = await runFlow(
		{ agent: "recon", task: "find the billing routes", why: undefined },
		{ recon: "ROUTES: /charge /refund" },
	);

	assert.equal(calls.length, 0, "no child process should be spawned");
	assert.equal(result.details.error?.code, "WHY_REQUIRED");
	assert.match(text, /`why` is required/);
	assert.match(text, /do the work directly/);
});

test("list and showConfig do not require `why`", async () => {
	const listResult = await runFlow({ list: true, why: undefined }, {});
	assert.match(listResult.text, /recon/);
	const configResult = await runFlow({ showConfig: true, why: undefined }, {});
	assert.match(configResult.text, /modelTier\.fast/);
	assert.match(configResult.text, /modelTier\.deep/);
});

test("tier: a flow-call tier resolves through the user's tier mapping onto child argv", async () => {
	const prevDeep = process.env.PI_FLOWS_DEEP_MODEL;
	process.env.PI_FLOWS_DEEP_MODEL = "test-provider/deep-model";
	try {
		const { calls } = await runFlow(
			{ agent: "recon", task: "judge this artifact", tier: "deep" },
			{ recon: "VERDICT" },
		);
		assert.equal(calls.length, 1);
		const modelFlag = calls[0].args.indexOf("--model");
		assert.notEqual(modelFlag, -1, "child argv should carry --model");
		assert.equal(calls[0].args[modelFlag + 1], "test-provider/deep-model");
	} finally {
		if (prevDeep === undefined) delete process.env.PI_FLOWS_DEEP_MODEL;
		else process.env.PI_FLOWS_DEEP_MODEL = prevDeep;
	}
});

test("tier: an unmapped tier falls back to the default model (no --model flag)", async () => {
	const prevFast = process.env.PI_FLOWS_FAST_MODEL;
	delete process.env.PI_FLOWS_FAST_MODEL;
	try {
		const { calls } = await runFlow(
			{ agent: "operator", task: "implement the fix", tier: "fast" },
			{ operator: "done" },
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].args.indexOf("--model"), -1, "unmapped tier should omit --model so the child uses the pi default");
	} finally {
		if (prevFast !== undefined) process.env.PI_FLOWS_FAST_MODEL = prevFast;
	}
});
