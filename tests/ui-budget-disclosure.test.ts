import assert from "node:assert/strict";
import { test } from "node:test";
import { collectBudgetCeilings, formatBudgetCeiling } from "../extensions/pi-flows/budget-disclosure.ts";
import { fleetRunLines } from "../extensions/pi-flows/fleet-panel.ts";
import { appendFlowSessionEntry } from "../extensions/pi-flows/ui.ts";
import { flowCardLines } from "../extensions/pi-flows/ui-flow-card.ts";
import { flowCallLines, flowLiveBoardLines } from "../extensions/pi-flows/ui-live-row.ts";
import { MAX_FLOW_DEPTH, budgetExceededError } from "../extensions/pi-flows/types.ts";
import { integrationContract, integrationEnvelope, runFlow } from "./stub-harness.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function contract(budget: Record<string, number>): any {
	return {
		objective: "Inspect the assigned area",
		constraints: [],
		nonGoals: [],
		dependencies: [],
		authority: { may: [], mustNot: [], requiresApproval: [] },
		sideEffectClass: "read-only",
		budget,
		acceptanceChecks: [],
		returnSchema: { type: "object" },
		owner: "parent",
	};
}

function result(overrides: Record<string, unknown> = {}): any {
	return {
		agent: "analyst",
		agentSource: "package",
		task: "inspect",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage,
		...overrides,
	};
}

function details(results: any[], budgetCeilings: any[]): any {
	return {
		mode: "parallel",
		version: "test",
		agentScope: "user",
		config: { redactSecretsDefault: true },
		agentsDir: {},
		results,
		budgetCeilings,
	};
}

test("budget disclosure finds flow and nested contract ceilings without inventing defaults", () => {
	const ceilings = collectBudgetCeilings({
		maxCostUsd: 0.25,
		maxTokens: 9000,
		tasks: [
			{ agent: "analyst", task: "one", contract: contract({ maxGeneratedTokens: 2000 }) },
			{ agent: "analyst", task: "two", contract: contract({ maxGeneratedTokens: 2000 }) },
			{ agent: "recon", task: "three", contract: contract({ maxTokens: 0 }) },
		],
	});

	assert.deepEqual(ceilings, [
		{ authority: "flow", maxCostUsd: 0.25, maxTokens: 9000 },
		{ authority: "contract", maxGeneratedTokens: 2000 },
		{ authority: "contract", maxTokens: 0 },
	]);
	assert.equal(formatBudgetCeiling(ceilings[0]!), "flow ceiling: $0.25 · 9.0k total tok");
	assert.equal(formatBudgetCeiling(ceilings[1]!), "contract ceiling: 2.0k generated tok");
	assert.deepEqual(collectBudgetCeilings({ tasks: [{ agent: "analyst", task: "uncapped", contract: contract({ timeoutMs: 1000 }) }] }), []);
});

test("budget disclosure omits shadowed fallback contracts and inactive contract-shaped fields", () => {
	const fallback = contract({ maxTokens: 9000 });
	const taskContract = contract({ maxGeneratedTokens: 2000 });

	assert.deepEqual(collectBudgetCeilings({
		contract: fallback,
		tasks: [
			{ agent: "analyst", task: "one", contract: taskContract },
			{ agent: "recon", task: "two", contract: taskContract },
		],
	}), [
		{ authority: "contract", maxGeneratedTokens: 2000 },
	]);

	assert.deepEqual(collectBudgetCeilings({
		contract: fallback,
		route: { controller: { agent: "controller", contract: contract({ maxCostUsd: 1 }) } },
	}), []);
	assert.deepEqual(collectBudgetCeilings({
		vote: { agent: "analyst", count: 2, debrief: { agent: "debrief" } },
	}), []);

	assert.deepEqual(collectBudgetCeilings({
		contract: fallback,
		tasks: [
			{ agent: "analyst", task: "one", contract: taskContract },
			{ agent: "recon", task: "two" },
		],
	}), [
		{ authority: "contract", maxGeneratedTokens: 2000 },
		{ authority: "contract", maxTokens: 9000 },
	]);
});

test("the call and live compact views disclose generated ceilings before usage exists", () => {
	const params = {
		tasks: [
			{ agent: "analyst", task: "one", contract: contract({ maxGeneratedTokens: 2000 }) },
			{ agent: "analyst", task: "two", contract: contract({ maxGeneratedTokens: 2000 }) },
		],
	};
	const ceilings = collectBudgetCeilings(params);

	const call = flowCallLines(params, theme, "parallel", "user").join("\n");
	assert.match(call, /flow parallel \[user\]/);
	assert.match(call, /budget · contract ceiling: 2\.0k generated tok/);

	const live = flowLiveBoardLines(details([], ceilings), theme, { tick: 0, redactSecrets: true, live: true }).join("\n");
	assert.match(live, /flow parallel/);
	assert.match(live, /budget · contract ceiling: 2\.0k generated tok/);
});

test("execution details and the session entry carry generated ceilings end to end", async () => {
	const entries: Array<{ customType: string; data: any }> = [];
	const { result } = await runFlow(
		{ agent: "recon", contract: integrationContract },
		{ recon: integrationEnvelope({ answer: "xyzzy-42" }) },
		{ api: { appendEntry: (customType: string, data: any) => entries.push({ customType, data }) } },
	);

	const expected = [{ authority: "contract", maxGeneratedTokens: 2000 }];
	assert.deepEqual(result.details.budgetCeilings, expected);
	assert.deepEqual(entries[0]?.data.budgetCeilings, expected);
});

test("pre-dispatch refusals preserve the ceilings shown before work", async () => {
	const params = { agent: "recon", contract: integrationContract, maxTokens: 9000 };
	const expected = [
		{ authority: "flow", maxTokens: 9000 },
		{ authority: "contract", maxGeneratedTokens: 2000 },
	];
	const invalidConcurrency = await runFlow({ ...params, concurrency: 1.5 }, {});
	assert.equal(invalidConcurrency.result.details.error?.code, "INVALID_CONCURRENCY");
	assert.deepEqual(invalidConcurrency.result.details.budgetCeilings, expected);

	const strictTrace = await runFlow({ ...params, traceStrict: true }, {});
	assert.equal(strictTrace.result.details.error?.code, "TRACE_INCOMPLETE");
	assert.deepEqual(strictTrace.result.details.budgetCeilings, expected);

	const previousDepth = process.env.PI_FLOWS_DEPTH;
	process.env.PI_FLOWS_DEPTH = String(MAX_FLOW_DEPTH);
	try {
		const depthExceeded = await runFlow(params, {});
		assert.equal(depthExceeded.result.details.error?.code, "FLOW_DEPTH_EXCEEDED");
		assert.deepEqual(depthExceeded.result.details.budgetCeilings, expected);
	} finally {
		if (previousDepth === undefined) delete process.env.PI_FLOWS_DEPTH;
		else process.env.PI_FLOWS_DEPTH = previousDepth;
	}
});

test("exhausted live, fleet, and durable views retain the binding authority and ceiling", () => {
	const budgetCeilings = collectBudgetCeilings({
		maxCostUsd: 0.5,
		tasks: [{ agent: "analyst", task: "one", contract: contract({ maxGeneratedTokens: 2000 }) }],
	});
	const exhausted = details([
		result({
			exitCode: 1,
			stopReason: "budget_exceeded",
			error: budgetExceededError({
				maxGeneratedTokens: 2000,
				spentCost: 0.1,
				spentTokens: 3200,
				spentGeneratedTokens: 2200,
			}, "contract"),
			usage: { ...usage, input: 1000, output: 2200, cost: 0.1 },
		}),
	], budgetCeilings);
	assert.deepEqual(exhausted.results[0].error.budgetCeiling, {
		authority: "contract",
		maxGeneratedTokens: 2000,
	});

	const live = flowLiveBoardLines(exhausted, theme, { tick: 0, redactSecrets: true }).join("\n");
	assert.match(live, /flow ceiling: \$0\.5/);
	assert.match(live, /BUDGET_EXCEEDED · contract ceiling: 2\.0k generated tok/);

	const fleet = fleetRunLines({ mode: "parallel", redactSecrets: true, details: exhausted } as any, theme, 0).join("\n");
	assert.match(fleet, /flow ceiling: \$0\.5/);
	assert.match(fleet, /BUDGET_EXCEEDED · contract ceiling: 2\.0k generated tok/);

	const entries: Array<{ customType: string; data: any }> = [];
	appendFlowSessionEntry({ appendEntry: (customType: string, data: any) => entries.push({ customType, data }) } as any, exhausted);
	assert.deepEqual(entries[0]?.data.budgetCeilings, budgetCeilings);

	const card = flowCardLines(entries[0]?.data, theme, false).join("\n");
	assert.match(card, /flow ceiling: \$0\.5/);
	assert.match(card, /BUDGET_EXCEEDED · contract ceiling: 2\.0k generated tok/);
});
