import { test } from "node:test";
import assert from "node:assert/strict";
import { infraError } from "../evals/lib.mjs";
import { __test } from "../extensions/pi-flows/index.ts";

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
