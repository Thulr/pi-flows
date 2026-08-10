// The session's effective model scope (`/scoped-models`, `--models`) must
// constrain automatically derived tiers. The regression these guard against:
// `fast`/`deep` dispatching a child to a model the user disabled, because the
// roster ranked everything `modelRegistry.getAvailable()` returned (#108).
//
// The scope constrains *automatic* derivation only — explicit pins remain
// explicit overrides, and `capable` mirrors the active parent model even when
// that model sits outside the cycling scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentModelRoster } from "../extensions/pi-flows/roster-source.ts";
import { runFlow } from "./stub-harness.ts";

/** A registry whose strongest and cheapest models both sit outside the scope. */
const WIDE_REGISTRY = {
	getAvailable: () => [
		{ id: "scoped", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 3, output: 12 } },
		{ id: "outside-scope", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 15, output: 60 } },
		{ id: "outside-cheap", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 0.1, output: 0.4 } },
	],
};

const modelOf = (call: { args: string[] }) => {
	const flag = call.args.indexOf("--model");
	return flag === -1 ? undefined : call.args[flag + 1];
};

test("currentModelRoster derives fast and deep from the session scope, not the whole registry", () => {
	// The issue's deterministic repro: the out-of-scope model ranks strongest,
	// so an unconstrained roster hands `deep` to it.
	const roster = currentModelRoster({
		modelRegistry: WIDE_REGISTRY,
		model: { provider: "test-provider", id: "scoped" },
		scopedModels: [{ model: { provider: "test-provider", id: "scoped" } }],
	});
	assert.equal(roster.deep.model, "test-provider/scoped", "deep escaped the effective session scope");
	assert.equal(roster.fast.model, "test-provider/scoped", "fast escaped the effective session scope");

	// An empty scoped list means no scoping is configured: current behavior.
	const unscoped = currentModelRoster({
		modelRegistry: WIDE_REGISTRY,
		model: { provider: "test-provider", id: "scoped" },
		scopedModels: [],
	});
	assert.equal(unscoped.deep.model, "test-provider/outside-scope");
	assert.equal(unscoped.fast.model, "test-provider/outside-cheap");

	// Older pi runtimes have no `scopedModels` at all; entries whose shape is
	// foreign are skipped rather than trusted.
	const absent = currentModelRoster({ modelRegistry: WIDE_REGISTRY, model: { provider: "test-provider", id: "scoped" } });
	assert.equal(absent.deep.model, "test-provider/outside-scope");
	const malformed = currentModelRoster({
		modelRegistry: WIDE_REGISTRY,
		model: { provider: "test-provider", id: "scoped" },
		scopedModels: [null, { model: { provider: 7, id: "scoped" } }] as never,
	});
	assert.equal(malformed.deep.model, "test-provider/outside-scope", "a scope with no readable entry falls back to unscoped");
});

test("no automatically tiered child receives a model excluded from the session scope", async () => {
	// Execution path: the wider registry offers a stronger and a cheaper model,
	// both excluded from the effective scope. Neither tier may reach them.
	const scopedModels = [{ model: { provider: "test-provider", id: "scoped" } }];
	const deep = await runFlow(
		{ agent: "operator", task: "adjudicate the design", tier: "deep" },
		{ operator: "done" },
		{ registry: WIDE_REGISTRY, model: { provider: "test-provider", id: "scoped" }, scopedModels },
	);
	assert.equal(deep.calls.length, 1);
	// The exact in-scope model, not merely "not the strongest outsider": any
	// out-of-scope model on the argv would break the session-scope contract.
	assert.equal(modelOf(deep.calls[0]), "test-provider/scoped", "deep dispatched a child to a model outside the session scope");

	const fast = await runFlow(
		{ agent: "operator", task: "scout the repo", tier: "fast" },
		{ operator: "done" },
		{ registry: WIDE_REGISTRY, model: { provider: "test-provider", id: "scoped" }, scopedModels },
	);
	assert.equal(modelOf(fast.calls[0]), "test-provider/scoped", "fast dispatched a child to a model outside the session scope");
});

test("a scope with no usable model keeps a tiered child on the session model's argv", async () => {
	// The stranded-scope edge: the only scoped model is below the context floor.
	// An unresolved tier would spawn the child with no --model at all — pi's
	// configured default, which the scope may exclude — so the tier pins the
	// session's own model instead.
	const registry = {
		getAvailable: () => [
			{ id: "tiny-scoped", provider: "test-provider", reasoning: true, contextWindow: 8_000, maxTokens: 8192, cost: { input: 0.1, output: 0.4 } },
			{ id: "session-model", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 3, output: 12 } },
			{ id: "outside-strong", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 15, output: 60 } },
		],
	};
	const { calls } = await runFlow(
		{ agent: "operator", task: "adjudicate the design", tier: "deep" },
		{ operator: "done" },
		{ registry, model: { provider: "test-provider", id: "session-model" }, scopedModels: [{ model: { provider: "test-provider", id: "tiny-scoped" } }] },
	);
	assert.equal(modelOf(calls[0]), "test-provider/session-model", "a stranded scope anchors the tier to the session model, never to an unpinned default");
});

test("the scoped roster is what showConfig reports", async () => {
	const { text } = await runFlow(
		{ showConfig: true, why: undefined },
		{},
		{ registry: WIDE_REGISTRY, model: { provider: "test-provider", id: "scoped" }, scopedModels: [{ model: { provider: "test-provider", id: "scoped" } }] },
	);
	assert.doesNotMatch(text, /modelTier\.(fast|deep): test-provider\/outside/, "the disclosure must describe the constrained roster");
});
