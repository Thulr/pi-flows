import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { infraError } from "../evals/lib.mjs";
import { Budget } from "../extensions/pi-flows/types.ts";
import { parseTraceJsonl } from "../extensions/pi-flows/trace.ts";
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

const turn = (cost: number, input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 1 });

test("a budget accumulates spend and trips each supported ceiling", () => {
	assert.equal(Budget.forFlow(undefined), undefined, "no configured ceiling means there is no budget to enforce");
	assert.equal(Budget.forFlow({}), undefined);

	const cost = Budget.forFlow({ maxCostUsd: 0.01 })!;
	assert.equal(cost.refusesSpawn(), false);
	cost.charge(turn(0.02, 100, 50));
	assert.equal(cost.refusesSpawn(), true, "cost ceiling trips after charge");

	const tokens = Budget.forFlow({ maxTokens: 100 })!;
	tokens.charge(turn(0, 60, 50));
	assert.equal(tokens.snapshot().spentTokens, 110, "token ceiling counts input+output");
	assert.equal(tokens.refusesSpawn(), true);

	const generated = Budget.forFlow({ maxGeneratedTokens: 40 })!;
	generated.charge(turn(0, 60, 50));
	assert.equal(generated.snapshot().spentGeneratedTokens, 50, "generated-token ceiling counts output only");
	assert.equal(generated.refusesSpawn(), true);
});

test("only a contract budget stops a live run on its total-token ceiling", () => {
	// A flow's total-token ceiling counts input the parent never chose to spend
	// turn by turn, so it stays a between-run spawn gate. A contract budget bounds
	// the runs fulfilling one contract, so it must stop the run overspending it.
	const flow = Budget.forFlow({ maxTokens: 100 })!;
	const contract = Budget.forContract({ maxTokens: 100 })!;
	for (const budget of [flow, contract]) budget.charge(turn(0, 60, 50));

	assert.equal(flow.refusesSpawn(), true);
	assert.equal(flow.stopsLiveRun(), false, "a flow total-token ceiling never kills the run it is already paying for");
	assert.equal(contract.stopsLiveRun(), true, "a contract total-token ceiling does");
});

test("budget errors name the ceiling that actually crossed, and the authority that owns it", () => {
	const generated = Budget.forFlow({ maxCostUsd: 10, maxGeneratedTokens: 4 })!;
	const total = Budget.forFlow({ maxCostUsd: 10, maxTokens: 10 })!;
	const contracted = Budget.forContract({ maxCostUsd: 10, maxGeneratedTokens: 4 })!;
	for (const budget of [generated, total, contracted]) budget.charge(turn(0.001, 12, 8));

	assert.match(generated.exhaustedError().message, /8 of 4 generated tokens/);
	assert.match(total.exhaustedError().message, /20 of 10 total tokens/);
	assert.match(contracted.exhaustedError().message, /^Contract budget exhausted/);
	assert.deepEqual(generated.exhaustedError().budgetCeiling, { authority: "flow", maxGeneratedTokens: 4 }, "the crossed ceiling, not every configured one");
	assert.match(contracted.unobservableError().message, /^Contract cost budget cannot be enforced/);
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

test("generated-token budget stops the active child and forbids unchanged replay", async () => {
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
	assert.match(result.content[0].text, /Retryable unchanged: no/);
	assert.match(result.content[0].text, /Do not automatically replay this flow/);
	assert.match(result.content[0].text, /Preserve the flow budget unless the user explicitly approves changing it/);
	assert.ok(Date.now() - startedAt < 1_500, "budget should stop the held-open child before timeout");
});

test("delegation-contract cost and token budgets stop the contracted child", async () => {
	for (const budget of [{ maxCostUsd: 0.00001 }, { maxTokens: 4 }, { maxGeneratedTokens: 4 }]) {
		const { result } = await runFlow(
			{ agent: "recon", contract: contractWithBudget(budget), timeoutMs: 2_000 },
			{ recon: { reply: "bounded response", holdOpenMs: 5_000 } },
		);
		const child = result.details.results[0];
		assert.equal(child.stopReason, "budget_exceeded", JSON.stringify(budget));
		assert.equal(child.error.code, "BUDGET_EXCEEDED");
		assert.match(child.error.message, /^Contract budget exhausted/);
	}
});

test("delegation-contract timeout tightens the top-level child timeout", async () => {
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

test("contract cost budget names its authority when telemetry is absent", async () => {
	const { result } = await runFlow(
		{ agent: "recon", contract: contractWithBudget({ maxCostUsd: 1 }), timeoutMs: 2_000 },
		{ recon: { reply: "unpriced answer", omitCost: true, holdOpenMs: 5_000 } },
	);
	const child = result.details.results[0];
	assert.equal(child.error.code, "BUDGET_UNOBSERVABLE");
	assert.match(child.error.message, /^Contract cost budget cannot be enforced/);
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

test("an exhausted ceiling refuses the next child before it spawns, and says so on the trace", async () => {
	// The pre-spawn refusal is the half of budget enforcement that leaves no
	// child process behind to inspect, so nothing but the call log and the
	// coordination event records that it happened at all.
	const { result, calls, stubDir } = await runFlow(
		{
			task: "two scouts, one budget",
			tier: "capable",
			maxTokens: 4,
			traceFile: "flow-trace.jsonl",
			concurrency: 1,
			tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }],
		},
		{ recon: { reply: "finding" } },
	);
	assert.equal(calls.length, 1, "the second child must never be spawned once the ceiling is spent");
	const refused = result.details.results[1];
	assert.equal(refused.error?.code, "BUDGET_EXCEEDED");
	assert.equal(refused.messages.length, 0, "a refused child produced no assistant turn because it never ran");
	assert.equal(refused.usage.cost, 0);

	const spans = parseTraceJsonl(await readFile(path.join(stubDir, "flow-trace.jsonl"), "utf8")).spans;
	const budgetEvent = spans.find((span) => span.attributes?.["flow.event_kind"] === "budget");
	assert.ok(budgetEvent, "a refusal that spawns nothing must still be attributable as a budget event");
	assert.equal(budgetEvent.attributes!["flow.event_name"], "child.refused");
	assert.equal(budgetEvent.attributes!["flow.budget.refused_agent"], "recon");
	assert.equal(budgetEvent.attributes!["flow.budget.limit_tokens"], 4);
	assert.equal(budgetEvent.status?.code, "ERROR");
});
