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

test("thinking: a named level reaches child argv as its own flag", async () => {
	const { calls } = await runFlow(
		{ agent: "recon", task: "scan the repo for the failing check", thinking: "low" },
		{ recon: "found it" },
	);
	assert.equal(calls.length, 1);
	const thinkingFlag = calls[0].args.indexOf("--thinking");
	assert.notEqual(thinkingFlag, -1, "child argv should carry --thinking");
	assert.equal(calls[0].args[thinkingFlag + 1], "low");
	// Its own flag rather than a `model:level` suffix. Naming a level must not
	// change which model runs: recon's own `tier: fast` still decides that.
	const withoutLevel = await runFlow({ agent: "recon", task: "scan the repo" }, { recon: "found it" });
	const modelOf = (call: { args: string[] }) => call.args[call.args.indexOf("--model") + 1];
	assert.equal(modelOf(calls[0]), modelOf(withoutLevel.calls[0]), "the level changed the effort, not the model");
});

test("thinking: a model pin's :level shorthand is split rather than passed through", async () => {
	const { calls } = await runFlow(
		{ agent: "recon", task: "scan the repo", model: "test-provider/some-model:high" },
		{ recon: "done" },
	);
	const modelFlag = calls[0].args.indexOf("--model");
	assert.equal(calls[0].args[modelFlag + 1], "test-provider/some-model", "the level must not travel inside the model id");
	assert.equal(calls[0].args[calls[0].args.indexOf("--thinking") + 1], "high");
});

test("thinking: a child with no level named leaves pi's own default alone", async () => {
	const { calls } = await runFlow({ agent: "operator", task: "implement the fix" }, { operator: "done" });
	assert.equal(calls[0].args.indexOf("--thinking"), -1, "pi-flows must not invent a level it was never told");
});

// Every surface the schema exposes `thinking` on must actually reach the child.
// Modes that rebuild a ref field-by-field are where a new per-unit field gets
// silently dropped, so each of those is exercised through the real dispatch
// path rather than trusted to the schema alone.
const levelOf = (call: { args: string[] }) => {
	const flag = call.args.indexOf("--thinking");
	return flag === -1 ? undefined : call.args[flag + 1];
};

test("thinking: a per-step chain level reaches that step's child", async () => {
	const { calls } = await runFlow(
		{
			task: "ship the fix",
			chain: [
				{ agent: "recon", task: "scout {task}", thinking: "low" },
				{ agent: "operator", task: "apply {previous}", thinking: "high" },
			],
		},
		{ recon: "scouted", operator: "applied" },
	);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(levelOf), ["low", "high"], "each step keeps its own level");
});

test("thinking: a per-phase workflow level reaches that phase's child", async () => {
	const { calls } = await runFlow(
		{
			task: "ship the fix",
			workflow: {
				phases: [
					{ id: "scout", agent: "recon", task: "scout it", thinking: "low" },
					{ id: "build", agent: "operator", task: "build it", thinking: "xhigh" },
				],
			},
		},
		{ recon: "scouted", operator: "built" },
	);
	assert.deepEqual(calls.map(levelOf), ["low", "xhigh"]);
});

test("thinking: a per-task level survives fan-out and the flow-level fallback", async () => {
	const { calls } = await runFlow(
		{
			thinking: "medium",
			tasks: [
				{ agent: "recon", task: "scout the api", tier: "fast", thinking: "low" },
				{ agent: "analyst", task: "read the docs", tier: "capable" },
			],
		},
		{ recon: "a", analyst: "b" },
	);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(levelOf).sort(), ["low", "medium"], "a task states its own level; the other falls back to the flow's");
});

test("tier: with no env mapping a tier still resolves, from the install's own models", async () => {
	// This is the behavior the roster exists for. Before it, an unset
	// PI_FLOWS_FAST_MODEL meant `fast` silently ran the parent's own model and a
	// right-sized call did nothing.
	const prevFast = process.env.PI_FLOWS_FAST_MODEL;
	delete process.env.PI_FLOWS_FAST_MODEL;
	try {
		const { calls } = await runFlow({ agent: "operator", task: "implement the fix", tier: "fast" }, { operator: "done" });
		assert.equal(calls.length, 1);
		const model = calls[0].args[calls[0].args.indexOf("--model") + 1];
		assert.equal(model, "test-provider/cheap-model", "fast resolves to the cheapest model the install can run");

		const deep = await runFlow({ agent: "operator", task: "implement the fix", tier: "deep" }, { operator: "done" });
		assert.equal(deep.calls[0].args[deep.calls[0].args.indexOf("--model") + 1], "test-provider/strong-model");
	} finally {
		if (prevFast !== undefined) process.env.PI_FLOWS_FAST_MODEL = prevFast;
	}
});

test("tier: a registry that cannot answer leaves every tier on the pi default", async () => {
	// The degraded path is still exercised explicitly rather than by accident.
	const { calls } = await runFlow(
		{ agent: "operator", task: "implement the fix", tier: "fast" },
		{ operator: "done" },
		{ registry: null },
	);
	assert.equal(calls[0].args.indexOf("--model"), -1, "no roster means no pin, so the child uses the pi default");
});

test("thinking: a role's model suffix outranks the flow-wide fallback", async () => {
	// Top-level `thinking` is documented as a fallback overridable per role. The
	// role's `model:"id:high"` shorthand is a role-level statement, so collapsing
	// the two before resolution let the flow fallback silently win.
	const { calls } = await runFlow(
		{
			thinking: "low",
			tasks: [
				{ agent: "recon", task: "scout the api", model: "test-provider/some-model:high" },
				{ agent: "analyst", task: "read the docs", tier: "capable" },
			],
		},
		{ recon: "a", analyst: "b" },
	);
	const levelOf = (call: { args: string[] }) => call.args[call.args.indexOf("--thinking") + 1];
	assert.deepEqual(calls.map(levelOf).sort(), ["high", "low"], "the role's suffix applies to it; the other still takes the flow fallback");
});
