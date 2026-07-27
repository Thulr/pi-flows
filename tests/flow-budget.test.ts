import { test } from "node:test";
import assert from "node:assert/strict";
import { infraError } from "../evals/lib.mjs";
import { __test } from "../extensions/pi-flows/index.ts";
import { budgetExceededError } from "../extensions/pi-flows/types.ts";
import { runFlow } from "./stub-harness.ts";

const contractWithBudget = (budget: Record<string, number>) => ({
	objective: "Return a bounded answer.",
	constraints: [],
	nonGoals: [],
	dependencies: [],
	authority: { may: [], mustNot: [], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget,
	acceptanceChecks: [],
	returnSchema: { type: "object" },
	owner: "parent",
});

test("budget helpers accumulate spend and trip each supported ceiling", () => {
	const usage = (cost: number, input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 1 });
	assert.equal(__test.budgetExceeded(undefined), false, "no budget never trips");

	const cost = { maxCostUsd: 0.01, spentCost: 0, spentTokens: 0, spentGeneratedTokens: 0 };
	assert.equal(__test.budgetExceeded(cost), false);
	__test.chargeBudget(cost, usage(0.02, 100, 50));
	assert.equal(__test.budgetExceeded(cost), true, "cost ceiling trips after charge");

	const tokens = { maxTokens: 100, spentCost: 0, spentTokens: 0, spentGeneratedTokens: 0 };
	__test.chargeBudget(tokens, usage(0, 60, 50));
	assert.equal(tokens.spentTokens, 110);
	assert.equal(__test.budgetExceeded(tokens), true, "token ceiling counts input+output");

	const generated = { maxGeneratedTokens: 40, spentCost: 0, spentTokens: 0, spentGeneratedTokens: 0 };
	__test.chargeBudget(generated, usage(0, 60, 50));
	assert.equal(generated.spentGeneratedTokens, 50);
	assert.equal(__test.budgetExceeded(generated), true, "generated-token ceiling counts output only");
});

test("budget errors name the ceiling that actually crossed", () => {
	const generated = {
		maxCostUsd: 10,
		maxGeneratedTokens: 4,
		spentCost: 0.001,
		spentTokens: 20,
		spentGeneratedTokens: 8,
	};
	const total = {
		maxCostUsd: 10,
		maxTokens: 10,
		spentCost: 0.001,
		spentTokens: 20,
		spentGeneratedTokens: 8,
	};
	assert.match(budgetExceededError(generated).message, /8 of 4 generated tokens/);
	assert.match(budgetExceededError(total).message, /20 of 10 total tokens/);
});

test("eval treats a binding budget stop as an invalid outcome, not infrastructure", () => {
	const result = {
		details: {
			results: [{
				exitCode: 1,
				stopReason: "budget_exceeded",
				error: { code: "BUDGET_EXCEEDED", message: "Flow budget exhausted." },
				errorMessage: "Flow budget exhausted.",
			}],
		},
	};
	assert.equal(infraError(result), null);
});

test("generated-token budget stops the active child at a response boundary", async () => {
	const startedAt = Date.now();
	const { result } = await runFlow(
		{ agent: "recon", task: "return a bounded answer", maxGeneratedTokens: 4, timeoutMs: 2_000 },
		{ recon: { reply: "partial answer", holdOpenMs: 5_000 } },
	);
	const child = result.details.results[0];
	assert.equal(child.usage.output, 8);
	assert.equal(child.stopReason, "budget_exceeded");
	assert.equal(child.exitCode, 1);
	assert.equal(child.error.code, "BUDGET_EXCEEDED");
	assert.match(result.content[0].text, /Code: BUDGET_EXCEEDED/);
	assert.ok(Date.now() - startedAt < 1_500, "budget should stop the held-open child before timeout");
});

test("typed contract cost and token budgets stop the contracted child", async () => {
	for (const budget of [{ maxCostUsd: 0.00001 }, { maxTokens: 4 }, { maxGeneratedTokens: 4 }]) {
		const { result } = await runFlow(
			{ agent: "recon", contract: contractWithBudget(budget), timeoutMs: 2_000 },
			{ recon: { reply: "bounded response", holdOpenMs: 5_000 } },
		);
		const child = result.details.results[0];
		assert.equal(child.stopReason, "budget_exceeded", JSON.stringify(budget));
		assert.equal(child.error.code, "BUDGET_EXCEEDED");
	}
});

test("typed contract timeout tightens the top-level child timeout", async () => {
	const startedAt = Date.now();
	const { result } = await runFlow(
		{ agent: "recon", contract: contractWithBudget({ timeoutMs: 50 }), timeoutMs: 2_000 },
		{ recon: { reply: "too late", delayBeforeReplyMs: 500 } },
	);
	const child = result.details.results[0];
	assert.equal(child.error.code, "CHILD_TIMEOUT");
	assert.ok(Date.now() - startedAt < 1_500, "contract timeout should win over the looser top-level timeout");
});

test("legacy total-token budgets remain a between-child spawn gate", async () => {
	const { result } = await runFlow(
		{ agent: "recon", task: "return one complete answer", maxTokens: 4, timeoutMs: 2_000 },
		{ recon: { reply: "complete answer" } },
	);
	const child = result.details.results[0];
	assert.equal(child.usage.input + child.usage.output, 20);
	assert.equal(child.stopReason, "endTurn");
	assert.equal(child.exitCode, 0);
	assert.equal(child.error, undefined);
	assert.match(result.content[0].text, /complete answer/);
});

test("cost budget fails closed when provider cost telemetry is absent", async () => {
	const { result } = await runFlow(
		{ agent: "recon", task: "return a cost-bounded answer", maxCostUsd: 1, timeoutMs: 2_000 },
		{ recon: { reply: "unpriced answer", omitCost: true, holdOpenMs: 5_000 } },
	);
	const child = result.details.results[0];
	assert.equal(child.usage.costKnown, false);
	assert.equal(child.stopReason, "budget_unobservable");
	assert.equal(child.error.code, "BUDGET_UNOBSERVABLE");
	assert.match(result.content[0].text, /Code: BUDGET_UNOBSERVABLE/);
});

test("cost budget fails closed when provider usage telemetry is absent", async () => {
	const { result } = await runFlow(
		{ agent: "recon", task: "return a cost-bounded answer", maxCostUsd: 1, timeoutMs: 2_000 },
		{ recon: { reply: "unmetered answer", omitUsage: true } },
	);
	const child = result.details.results[0];
	assert.equal(child.usage.costKnown, false);
	assert.equal(child.stopReason, "budget_unobservable");
	assert.equal(child.error.code, "BUDGET_UNOBSERVABLE");
});
