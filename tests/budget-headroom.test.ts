// The budget headroom gate (issue #164): a projection of the remaining
// work against each configured ceiling, refused before any worker spawns.
//
// Two layers are pinned. Budget.headroomRefusal owns the arithmetic and the
// refusal sentence — projected spend = current spend + remaining effort weight
// × observed spend per unit of weight, strictly above a ceiling, with the
// already-spent case left to the spawn gate's BUDGET_EXCEEDED. Orchestrate
// wires it: the commander's own settled spend is the observation before any
// worker settles, an unaffordable initial Decomposition is refused (or, with a
// reviewer, routed back to the commander as a "replan smaller" critique inside
// the same attempt bound), and effortWeight scales the projection.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleOrchestrate } from "../extensions/pi-flows/modes/orchestrate.ts";
import { Budget, emptyUsage, type DelegationContract, type UsageStats } from "../extensions/pi-flows/types.ts";
import { faultDeps, makeFaultAdapter } from "./fault-adapter.ts";

const usage = (overrides: Partial<UsageStats>): UsageStats => ({ ...emptyUsage(), ...overrides });

// ---------------------------------------------------------------------------
// The projection on Budget
// ---------------------------------------------------------------------------

test("headroom refuses a projection strictly above a ceiling and admits one that exactly fits", () => {
	const budget = Budget.forFlow({ maxCostUsd: 1 })!;
	budget.charge(usage({ cost: 0.4 }));

	assert.equal(budget.headroomRefusal(3, usage({ cost: 0.1 })), null, "0.4 + 3×0.1 fits under $1");
	assert.equal(budget.headroomRefusal(6, usage({ cost: 0.1 })), null, "a projection exactly at the ceiling is dispatched; the spawn gate takes over after it lands");

	const refusal = budget.headroomRefusal(7, usage({ cost: 0.1 }));
	assert.equal(refusal?.code, "BUDGET_HEADROOM_EXCEEDED");
	assert.match(refusal?.message ?? "", /^Flow budget headroom exceeded \(projected \$1\.1000 of \$1\.0000\)/);
	assert.match(refusal?.cause ?? "", /effort weight 7/);
	assert.match(refusal?.cause ?? "", /Nothing spawned/);
	assert.match(refusal?.fix ?? "", /Replan smaller/);
	assert.equal(refusal?.retryable, false);
	assert.deepEqual(refusal?.budgetCeiling, { authority: "flow", maxCostUsd: 1 });
});

test("an exact cost fit survives binary-decimal arithmetic", () => {
	// 0.1 + 2 × 0.1 evaluates a hair past 0.3 in floating point; that encoding
	// artifact must not read as an unaffordable projection.
	const budget = Budget.forFlow({ maxCostUsd: 0.3 })!;
	budget.charge(usage({ cost: 0.1 }));
	assert.equal(budget.headroomRefusal(2, usage({ cost: 0.1 })), null);
	assert.equal(budget.headroomRefusal(3, usage({ cost: 0.1 }))?.code, "BUDGET_HEADROOM_EXCEEDED", "a real overrun is still refused");
});

test("each ceiling projects its own dimension: total tokens count input plus output, generated tokens count output only", () => {
	const total = Budget.forFlow({ maxTokens: 1000 })!;
	total.charge(usage({ input: 100, output: 100 }));
	assert.equal(total.headroomRefusal(4, usage({ input: 100, output: 100 })), null, "200 + 4×200 exactly fits");
	const totalRefusal = total.headroomRefusal(5, usage({ input: 100, output: 100 }));
	assert.match(totalRefusal?.message ?? "", /projected 1200 of 1000 total tokens/);
	assert.deepEqual(totalRefusal?.budgetCeiling, { authority: "flow", maxTokens: 1000 });

	const generated = Budget.forFlow({ maxGeneratedTokens: 300 })!;
	generated.charge(usage({ input: 500, output: 100 }));
	assert.equal(generated.headroomRefusal(2, usage({ input: 500, output: 100 })), null, "input never counts against a generated ceiling");
	assert.match(generated.headroomRefusal(3, usage({ output: 100 }))?.message ?? "", /projected 400 of 300 generated tokens/);
});

test("a contract budget refuses under its own authority label", () => {
	const budget = Budget.forContract({ maxTokens: 300 })!;
	const refusal = budget.headroomRefusal(2, usage({ input: 100, output: 100 }));
	assert.match(refusal?.message ?? "", /^Contract budget headroom exceeded/);
	assert.equal(refusal?.budgetCeiling?.authority, "contract");
});

test("headroom never speaks for the spawn gate, for zero weight, or for an unobserved spend", () => {
	// An already-spent budget is BUDGET_EXCEEDED at the spawn gate; a projection
	// claiming it would imply smaller remaining work could fit when none can.
	const spent = Budget.forFlow({ maxTokens: 100 })!;
	spent.charge(usage({ input: 100, output: 100 }));
	assert.equal(spent.refusesSpawn(), true);
	assert.equal(spent.headroomRefusal(50, usage({ input: 100, output: 100 })), null);

	const open = Budget.forFlow({ maxCostUsd: 0.5 })!;
	assert.equal(open.headroomRefusal(0, usage({ cost: 9 })), null, "no remaining work projects nothing");
	assert.equal(open.headroomRefusal(1000, emptyUsage()), null, "no observed spend is not evidence of unaffordability");
});

// ---------------------------------------------------------------------------
// The gate in orchestrate
// ---------------------------------------------------------------------------

// The fault adapter charges each scripted turn as one unit of usage, so with
// input/output 100 the commander's settled spend — the projection's observation
// before any worker settles — is 200 total tokens per unit of weight.
const CHILD_USAGE = { input: 100, output: 100, cost: 0 };

const breakdown = (entries: unknown[]) => `\`\`\`json\n${JSON.stringify(entries)}\n\`\`\``;
const workspace = () => mkdtempSync(path.join(tmpdir(), "pi-flow-headroom-"));

test("orchestrate refuses an unaffordable initial Decomposition before any worker spawns", async () => {
	const adapter = makeFaultAdapter({
		replies: { commander: breakdown(["survey the routes", "trace refresh", "read the tests"]), recon: "MUST NOT RUN" },
		usage: CHILD_USAGE,
	});
	// Commander spends 200; three plain subtasks project 200 + 3×200 = 800 > 500.
	const deps = faultDeps(
		{ task: "document how auth works", orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" } } },
		adapter,
		workspace(),
		{ budget: Budget.forFlow({ maxTokens: 500 }) },
	);
	const output = await handleOrchestrate(deps);

	assert.equal(output.details.error?.code, "BUDGET_HEADROOM_EXCEEDED");
	assert.deepEqual(output.details.error?.budgetCeiling, { authority: "flow", maxTokens: 500 });
	assert.equal(adapter.ledger.reached("recon"), false, "the refusal lands before the first worker");
	assert.equal(adapter.ledger.reached("debrief"), false);
});

test("effortWeight scales the projection: two heavy subtasks can be refused where three plain ones fit", async () => {
	const heavy = breakdown([
		{ id: "survey", objective: "Survey the routes", effortWeight: 5 },
		{ id: "audit", objective: "Audit each route", effortWeight: 5 },
	]);
	const adapter = makeFaultAdapter({ replies: { commander: heavy, recon: "MUST NOT RUN" }, usage: CHILD_USAGE });
	// Weight 10 projects 200 + 10×200 = 2200 > 900, where three plain subtasks
	// (200 + 3×200 = 800) would have been admitted under the same ceiling.
	const deps = faultDeps(
		{ task: "audit the routes", orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" } } },
		adapter,
		workspace(),
		{ budget: Budget.forFlow({ maxTokens: 900 }) },
	);
	const output = await handleOrchestrate(deps);

	assert.equal(output.details.error?.code, "BUDGET_HEADROOM_EXCEEDED");
	assert.equal(adapter.ledger.reached("recon"), false);
});

test("the worker contract budget is projected too, and refuses under the contract authority", async () => {
	const contract: DelegationContract = {
		objective: "Return one verified finding per subtask.",
		constraints: [], nonGoals: [], dependencies: [],
		authority: { may: ["read the workspace"], mustNot: [], requiresApproval: [] },
		sideEffectClass: "read-only",
		budget: { maxTokens: 300 },
		acceptanceChecks: ["The answer names its source."],
		returnSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false },
		owner: "parent",
	};
	const adapter = makeFaultAdapter({ replies: { commander: breakdown(["survey", "trace"]), recon: "MUST NOT RUN" }, usage: CHILD_USAGE });
	// The flow has no budget of its own; the contract's 300-token ceiling cannot
	// pay for the projected 2×200, and the refusal must say so as the contract's.
	const deps = faultDeps(
		{ task: "document how auth works", orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon", contract }, debrief: { agent: "debrief" } } },
		adapter,
		workspace(),
	);
	const output = await handleOrchestrate(deps);

	assert.equal(output.details.error?.code, "BUDGET_HEADROOM_EXCEEDED");
	assert.match(output.details.error?.message ?? "", /^Contract budget headroom exceeded/);
	assert.deepEqual(output.details.error?.budgetCeiling, { authority: "contract", maxTokens: 300 });
	assert.equal(adapter.ledger.reached("recon"), false);
});

test("with a reviewer, a Decomposition that does not fit routes back to the commander as a replan-smaller critique", async () => {
	const heavy = breakdown([
		{ id: "survey", objective: "Survey everything", effortWeight: 5 },
		{ id: "audit", objective: "Audit everything", effortWeight: 5 },
		{ id: "report", objective: "Write it all up", effortWeight: 5 },
	]);
	const smaller = breakdown([
		{ id: "survey", objective: "Survey the auth routes" },
		{ id: "audit", objective: "Audit the auth routes", dependsOn: ["survey"] },
	]);
	const adapter = makeFaultAdapter({
		replies: {
			commander: [heavy, smaller],
			overwatch: "VERDICT: PASS\nCovers the goal.",
			recon: "FINDING",
			debrief: "MERGED_DOC",
		},
		usage: CHILD_USAGE,
	});
	// Ceiling 1600: the heavy Decomposition projects 200 + 15×200 = 3200 and is refused;
	// the replacement projects 400 + 2×200 = 800 after the revision commander's
	// own spend, passes headroom, and only then reaches the reviewer.
	const deps = faultDeps(
		{
			task: "document how auth works",
			orchestrate: {
				commander: { agent: "commander" }, review: { agent: "overwatch" }, reviewMaxIterations: 2,
				recon: { agent: "recon" }, debrief: { agent: "debrief" },
			},
		},
		adapter,
		workspace(),
		{ budget: Budget.forFlow({ maxTokens: 1600 }) },
	);
	const output = await handleOrchestrate(deps);

	assert.equal(output.details.error, undefined);
	assert.deepEqual(
		adapter.ledger.dispatches.map((dispatch) => dispatch.agent),
		["commander", "commander", "overwatch", "recon", "recon", "debrief"],
		"the reviewer never judges the Decomposition that does not fit; the critique goes straight to the commander",
	);
	const revision = adapter.ledger.dispatches[1].task;
	assert.match(revision, /does not fit what remains of the budget/);
	assert.match(revision, /Flow budget headroom exceeded/);
	assert.match(revision, /"effortWeight": 5/, "the reviewer-facing normalized JSON carries the weights the commander declared");
	assert.match(revision, /Replace the complete Decomposition/);
	const retry = adapter.ledger.events.find((event) => event.kind === "retry" && event.attributes["flow.retry.reason"] === "budget_headroom");
	assert.ok(retry, "the headroom replan is recorded as a retry event");
	assert.match(output.content[0].text, /Decomposition review PASS after 2 attempts/);
});

test("a reviewer PASS is re-projected: the reviewer's own spend can send the Decomposition back for a smaller replacement", async () => {
	const wide = breakdown(["survey", "trace", "audit", "report"]);
	const narrow = breakdown(["survey the auth routes"]);
	const adapter = makeFaultAdapter({
		replies: { commander: [wide, narrow], overwatch: "VERDICT: PASS\nCovers the goal.", recon: "FINDING", debrief: "MERGED_DOC" },
		usage: CHILD_USAGE,
	});
	// Ceiling 1100: the four-subtask Decomposition projects 200 + 4×200 = 1000
	// and is admitted, the reviewer's own run lifts spend to 400 so the same
	// Decomposition re-projects to 1200 after its PASS, and only the one-subtask
	// replacement (600 + 200 = 800 at its own review) reaches the workers.
	const deps = faultDeps(
		{
			task: "document how auth works",
			orchestrate: {
				commander: { agent: "commander" }, review: { agent: "overwatch" }, reviewMaxIterations: 2,
				recon: { agent: "recon" }, debrief: { agent: "debrief" },
			},
		},
		adapter,
		workspace(),
		{ budget: Budget.forFlow({ maxTokens: 1100 }) },
	);
	const output = await handleOrchestrate(deps);

	assert.equal(output.details.error, undefined);
	assert.deepEqual(
		adapter.ledger.dispatches.map((dispatch) => dispatch.agent),
		["commander", "overwatch", "commander", "overwatch", "recon", "debrief"],
		"the PASS on the wide Decomposition does not dispatch it; the commander replans and the replacement is reviewed",
	);
	assert.match(adapter.ledger.dispatches[2].task, /does not fit what remains of the budget/);
	const workerTask = adapter.ledger.dispatches[4].task;
	assert.match(workerTask, /survey the auth routes/, "only the replacement's subtask runs");
});

test("a budget that strands every terminal subtask keeps its reason in the completion", async () => {
	const chain = breakdown([
		{ id: "survey", objective: "Survey the routes" },
		{ id: "trace", objective: "Trace the refresh", dependsOn: ["survey"] },
		{ id: "writeup", objective: "Write the summary", dependsOn: ["trace"] },
	]);
	const adapter = makeFaultAdapter({
		replies: { commander: chain, recon: { reply: "SURVEY_FINDING", turns: 3 }, debrief: "MUST NOT RUN" },
		usage: CHILD_USAGE,
	});
	// The projection admits 200 + 3×200 = 800 exactly; the three-turn worker
	// then spends the whole ceiling, stranding the chain behind it — including
	// the only terminal subtask, so nothing can be synthesized.
	const deps = faultDeps(
		{ task: "document how auth works", orchestrate: { commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" } } },
		adapter,
		workspace(),
		{ budget: Budget.forFlow({ maxTokens: 800 }) },
	);
	const output = await handleOrchestrate(deps);

	assert.equal(output.details.error, undefined);
	assert.equal(adapter.ledger.reached("debrief"), false);
	const text = output.content[0].text;
	assert.match(text, /1 succeeded, 0 failed, 2 stranded; no final subtask succeeded/);
	assert.match(text, /## Subtasks not completed \(2\)/, "the manifest reaches the caller when nothing synthesizes");
	assert.match(text, /- trace: Trace the refresh — stranded: Flow budget exhausted/);
	assert.match(text, /- writeup: Write the summary — stranded: Flow budget exhausted/);
});

test("when every attempt stays unaffordable, the flow refuses with the headroom error itself", async () => {
	const heavy = breakdown([{ id: "audit", objective: "Audit everything", effortWeight: 5 }]);
	const adapter = makeFaultAdapter({
		replies: { commander: heavy, overwatch: "MUST NOT RUN", recon: "MUST NOT RUN" },
		usage: CHILD_USAGE,
	});
	const deps = faultDeps(
		{
			task: "audit the estate",
			orchestrate: {
				commander: { agent: "commander" }, review: { agent: "overwatch" }, reviewMaxIterations: 1,
				recon: { agent: "recon" }, debrief: { agent: "debrief" },
			},
		},
		adapter,
		workspace(),
		{ budget: Budget.forFlow({ maxTokens: 700 }) },
	);
	const output = await handleOrchestrate(deps);

	assert.equal(output.details.error?.code, "BUDGET_HEADROOM_EXCEEDED");
	assert.deepEqual(adapter.ledger.dispatches.map((dispatch) => dispatch.agent), ["commander"], "no attempt remained, so neither the reviewer nor a revision spawns");
});
