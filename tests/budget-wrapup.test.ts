// The soft wrap-up threshold (issue #104): a budget nearing a ceiling it would
// stop the live run for steers the child to emit its return envelope now, so a
// breach becomes a valid partial envelope instead of a total loss.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Budget } from "../extensions/pi-flows/types.ts";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { parseTraceJsonl } from "../extensions/pi-flows/trace.ts";
import { WRAPUP_FILE_ENV, registerWrapUpSteering, requestWrapUp } from "../extensions/pi-flows/wrapup.ts";
import { runFlow } from "./stub-harness.ts";

const turn = (cost: number, input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, cost, contextTokens: 0, turns: 1 });

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

test("a budget nears its live stop at the wrap-up fraction of each mid-stream ceiling", () => {
	const contract = Budget.forContract({ maxTokens: 100 })!;
	contract.charge(turn(0, 50, 25));
	assert.equal(contract.nearsLiveStop(), false, "75% is below the wrap-up threshold");
	contract.charge(turn(0, 5, 0));
	assert.equal(contract.nearsLiveStop(), true, "80% is the wrap-up threshold");
	assert.equal(contract.stopsLiveRun(), false, "the wrap-up warns strictly before the hard stop");

	const flowTotal = Budget.forFlow({ maxTokens: 100 })!;
	flowTotal.charge(turn(0, 90, 0));
	assert.equal(flowTotal.nearsLiveStop(), false, "a flow total-token ceiling is a spawn gate, so it never asks a live run to wrap up");

	const generated = Budget.forFlow({ maxGeneratedTokens: 10 })!;
	generated.charge(turn(0, 0, 8));
	assert.equal(generated.nearsLiveStop(), true);

	const cost = Budget.forContract({ maxCostUsd: 1 })!;
	cost.charge(turn(0.8, 0, 0));
	assert.equal(cost.nearsLiveStop(), true);
	assert.equal(Budget.forContract({ maxTokens: 100 })!.nearsLiveStop(), false, "an uncharged budget nears nothing");
});

test("the wrap-up notice names the nearing ceiling and asks for a partial envelope now", () => {
	const budget = Budget.forContract({ maxTokens: 100 })!;
	budget.charge(turn(0, 60, 25));
	const notice = budget.wrapUpNotice();
	assert.match(notice, /85 of 100 total tokens/, "the child should see the actual spend");
	assert.match(notice, /Contract/, "the notice names the authority that will stop the run");
	assert.match(notice, /status "partial"/);
	assert.match(notice, /skipped/);
	assert.match(notice, /unresolvedQuestions/);

	const cost = Budget.forContract({ maxCostUsd: 1 })!;
	cost.charge(turn(0.9, 0, 0));
	assert.match(cost.wrapUpNotice(), /\$0\.9000 of \$1\.0000/);
});

test("the child-side watcher steers the wrap-up notice into the live session exactly once", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-flow-wrapup-"));
	try {
		const file = path.join(dir, "wrap-up.md");
		const sent: Array<{ content: unknown; options: unknown }> = [];
		const watcher = registerWrapUpSteering(
			{ sendUserMessage: (content: unknown, options: unknown) => sent.push({ content, options }) } as any,
			{ [WRAPUP_FILE_ENV]: file },
			5,
		);
		assert.ok(watcher, "a wrap-up file path in the environment starts a watcher");
		assert.equal(sent.length, 0, "nothing is steered before the parent requests a wrap-up");
		requestWrapUp(file, "stop and emit the envelope");
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.deepEqual(sent, [{ content: "stop and emit the envelope", options: { deliverAs: "steer" } }]);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(sent.length, 1, "the notice is delivered once, not on every poll");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("no wrap-up watcher starts without a file path in the environment", () => {
	assert.equal(registerWrapUpSteering({ sendUserMessage: () => undefined } as any, {}), null);
	assert.equal(registerWrapUpSteering({ sendUserMessage: () => undefined } as any, { [WRAPUP_FILE_ENV]: " " }), null);
});

test("a child steered to wrap up returns a partial envelope instead of forfeiting the run", async () => {
	// Contract ceiling 25 total tokens; each stub turn spends 20. The first turn
	// lands at 80%, so the runner requests a wrap-up; the stub answers the steer
	// with a partial envelope whose second turn crosses the ceiling — the exact
	// shape of the incident in issue #104, which used to end BUDGET_EXCEEDED with
	// zero output for full cost.
	const contract = contractWithBudget({ maxTokens: 25 });
	const partialEnvelope = JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract as never),
		status: "partial",
		summary: "Wrapped up at the budget notice.",
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: ["budget exhausted before full coverage"],
		retry: { retryable: false },
		data: {},
	});
	const { result, stubDir } = await runFlow(
		{ agent: "recon", contract, incompleteHandoffPolicy: "include", timeoutMs: 5_000, traceFile: "wrapup-trace.jsonl" },
		{ recon: { reply: "still reading", wrapUpReply: partialEnvelope, holdOpenMs: 4_000 } },
	);
	const child = result.details.results[0];
	assert.equal(child.error, undefined, "a steered wrap-up is not a budget failure");
	assert.equal(child.exitCode, 0);
	assert.equal(child.stopReason, "budget_wrap_up");
	assert.equal(child.wrapUpRequested, true);
	assert.equal(child.envelope?.status, "partial");
	assert.deepEqual(child.envelope?.unresolvedQuestions, ["budget exhausted before full coverage"]);
	assert.equal(result.details.error, undefined);

	const notice = readFileSync(path.join(stubDir, "wrapup-notice.txt"), "utf8");
	assert.match(notice, /Contract/, "the steered notice names the authority nearing its ceiling");
	assert.match(notice, /status "partial"/);

	const spans = parseTraceJsonl(await readFile(path.join(stubDir, "wrapup-trace.jsonl"), "utf8")).spans;
	const events = spans.filter((span) => span.attributes?.["flow.event_kind"] === "budget");
	const wrapUp = events.find((span) => span.attributes?.["flow.event_name"] === "child.wrap_up");
	assert.ok(wrapUp, "the wrap-up request is coordination evidence");
	assert.equal(wrapUp!.attributes!["flow.budget.authority"], "contract");
	const exhausted = events.find((span) => span.attributes?.["flow.event_name"] === "child.exhausted");
	assert.ok(exhausted, "crossing the ceiling after the wrap-up is still recorded");
	assert.equal(exhausted!.attributes!["flow.budget.graceful"], true);
});

test("a ceiling crossed with no wrap-up requested still hard-stops the child", async () => {
	// A single turn that jumps from zero past the ceiling leaves no room to wrap
	// up; the existing hard stop and total-loss semantics must be unchanged.
	const { result } = await runFlow(
		{ agent: "recon", contract: contractWithBudget({ maxTokens: 4 }), timeoutMs: 2_000 },
		{ recon: { reply: "instant overrun", holdOpenMs: 4_000 } },
	);
	const child = result.details.results[0];
	assert.equal(child.stopReason, "budget_exceeded");
	assert.equal(child.error?.code, "BUDGET_EXCEEDED");
	assert.equal(child.wrapUpRequested, undefined);
});

test("the wrap-up channel is offered only to children running under a budget", async () => {
	const budgeted = await runFlow(
		{ agent: "recon", contract: contractWithBudget({ maxTokens: 1_000 }), timeoutMs: 2_000 },
		{ recon: { reply: "bounded" } },
	);
	assert.ok(budgeted.calls[0].env.PI_FLOWS_WRAPUP_FILE, "a budgeted child gets a wrap-up file path");

	const unbudgeted = await runFlow(
		{ agent: "recon", task: "unbounded", timeoutMs: 2_000 },
		{ recon: { reply: "free" } },
	);
	assert.equal(unbudgeted.calls[0].env.PI_FLOWS_WRAPUP_FILE || "", "", "no budget, no wrap-up channel — and no inherited path leaks in");
});

test("requestWrapUp lands atomically and tolerates a vanished child directory", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-flow-wrapup-write-"));
	try {
		const file = path.join(dir, "wrap-up.md");
		requestWrapUp(file, "notice text");
		assert.equal(readFileSync(file, "utf8"), "notice text");
		assert.equal(existsSync(`${file}.tmp`), false, "the temp half of the atomic write does not linger");
		requestWrapUp(path.join(dir, "missing", "wrap-up.md"), "notice"); // must not throw
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
