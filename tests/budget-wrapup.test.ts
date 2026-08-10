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
import { WRAP_UP_NOTICE_MARKER } from "../extensions/pi-flows/budget.ts";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { ChildBudgets } from "../extensions/pi-flows/runner-budget.ts";
import { parseTraceJsonl } from "../extensions/pi-flows/trace.ts";
import { flowProgressText } from "../extensions/pi-flows/ui.ts";
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
	assert.equal(wrapUp!.attributes!["flow.budget.wrapup_delivered"], true, "the echo of the steered notice is the delivery proof");
});

test("a delivered wrap-up answered with prose is not marked successful before envelope validation", async () => {
	// Issue #112: settle() used to treat notice *delivery* as notice *compliance*
	// — a child that ignored the instruction and returned prose still rendered as
	// exitCode 0 / budget_wrap_up beside the flow's RETURN_ENVELOPE_INVALID.
	const contract = contractWithBudget({ maxTokens: 25 });
	const { result, stubDir } = await runFlow(
		{ agent: "recon", contract, timeoutMs: 5_000 },
		{ recon: { reply: "still reading", wrapUpReply: "ran out of budget; here are my notes in plain prose.", holdOpenMs: 4_000 } },
	);
	const child = result.details.results[0];
	assert.equal(child.wrapUpRequested, true, "the wrap-up was requested and delivered");
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.notEqual(child.exitCode, 0, `invalid wrap-up was marked successful (${child.stopReason}) before envelope validation`);
	assert.equal(child.error?.code, "RETURN_ENVELOPE_INVALID", "the failing run itself carries the validation cause");
	assert.equal(child.usage.cost, 0.0002, "usage accrued before the failure stays on the ledger");
	assert.equal(flowProgressText(result.details), "1 failed", "the board must never report ok beside RETURN_ENVELOPE_INVALID");

	// The strengthened contracted notice: the generic ask alone has failed in a
	// real run, so the child is told the exact identity and format its final
	// envelope needs.
	const notice = readFileSync(path.join(stubDir, "wrapup-notice.txt"), "utf8");
	assert.match(notice, /pi-flows\.return-envelope\.v1/);
	assert.ok(notice.includes(delegationContractId(contract as never)), "the notice names the contract identity the envelope must carry");
});

test("a notice that never reaches the child keeps exhaustion fatal", async () => {
	// The child runs without the pi-flows extension (the stub only honors the
	// wrap-up file when scripted to), so the requested notice is never seen.
	// Settling gracefully here would return arbitrary truncated output as
	// success — the hard stop must stand.
	const secondTurn = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "still going, never saw the notice" }],
			usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 }, totalTokens: 20 },
			model: "stub-model",
			stopReason: "endTurn",
		},
	};
	const { result } = await runFlow(
		{ agent: "recon", contract: contractWithBudget({ maxTokens: 25 }), timeoutMs: 5_000 },
		{ recon: { reply: "still reading", extraEvents: [{ delayMs: 400, event: secondTurn }], holdOpenMs: 2_000 } },
	);
	const child = result.details.results[0];
	assert.equal(child.wrapUpRequested, true, "the first turn crossed 80%, so a wrap-up was requested");
	assert.equal(child.stopReason, "budget_exceeded", "an unconfirmed notice must not soften the stop");
	assert.equal(child.error?.code, "BUDGET_EXCEEDED");
});

/** Arm a fresh ChildBudgets on `budgets`, collecting delivered notices; release() is the caller's job. */
function armed(budgets: Budget[]): { child: ChildBudgets; notices: string[] } {
	const child = new ChildBudgets(budgets, undefined, undefined);
	const notices: string[] = [];
	child.arm((notice) => notices.push(notice));
	return { child, notices };
}

test("a budget already inside the wrap-up window steers at arm, and delivery cannot be confirmed before a request exists", () => {
	const turnUsage = turn(0, 60, 25);
	const nearlySpent = () => {
		const budget = Budget.forContract({ maxTokens: 100 })!;
		budget.charge(turnUsage);
		return budget;
	};
	const atSpawn = armed([nearlySpent()]);
	assert.ok(atSpawn.notices[0]?.includes(WRAP_UP_NOTICE_MARKER), "a child joining a nearly spent budget is told to wrap up before its first turn");
	atSpawn.child.release();

	// Past the hard ceiling, nearsLiveStop is still true — but a child the
	// budget refuses gets a refusal, never a steer: a sibling can exhaust a
	// shared budget between the admission check and the spawn.
	const spent = Budget.forFlow({ maxGeneratedTokens: 10 })!;
	spent.charge(turn(0, 0, 12));
	const refused = armed([spent]);
	assert.equal(refused.notices.length, 0, "an exhausted budget refuses; it does not steer");
	assert.ok(refused.child.refuseSpawn("recon"), "the late recheck must surface the refusal instead");
	refused.child.release();

	const fresh = armed([Budget.forContract({ maxTokens: 100 })!]);
	assert.equal(fresh.notices.length, 0);
	fresh.child.confirmDelivery(`${WRAP_UP_NOTICE_MARKER} anything`); // no wrap-up requested yet: a stray marker echo must not pre-arm graceful settling
	fresh.child.release();

	// A quoted marker — one steered child's output riding into a sibling's
	// prompt — is not delivery either: only the latched notice verbatim counts.
	const crossing = armed([nearlySpent()]);
	assert.equal(crossing.notices.length, 1);
	crossing.child.confirmDelivery(`${WRAP_UP_NOTICE_MARKER} some other budget's notice`);
	crossing.child.chargeTurn(turn(0, 60, 25), true);
	const settled: any = { exitCode: -1 };
	assert.equal(crossing.child.settle(settled), true);
	assert.equal(settled.error?.code, "BUDGET_EXCEEDED", "a marker without the latched notice must not soften the stop");
	crossing.child.release();

	// The genuine echo — the latched notice verbatim — is what flips it.
	const delivered = armed([nearlySpent()]);
	delivered.child.confirmDelivery(`context before\n${delivered.notices[0]}\ncontext after`);
	delivered.child.chargeTurn(turn(0, 60, 25), true);
	const gracefully: any = { exitCode: -1 };
	assert.equal(delivered.child.settle(gracefully), true);
	assert.equal(gracefully.error, undefined);
	assert.equal(gracefully.stopReason, "budget_wrap_up");
	delivered.child.release();
});

test("a threshold transition steers every live child on the shared budget, not only the one whose turn crossed", () => {
	const shared = Budget.forFlow({ maxGeneratedTokens: 10 })!;
	const a = armed([shared]);
	const b = armed([shared]);
	const released = armed([shared]);
	released.child.release();

	a.child.chargeTurn(turn(0, 0, 8), true); // 80% of the shared ceiling, crossed by A's turn
	assert.equal(a.notices.length, 1, "the crossing child is steered through its own channel");
	assert.equal(b.notices.length, 1, "a live sibling mid-turn is steered at the same moment, not at its own next settle");
	assert.equal(released.notices.length, 0, "a released child's reclaimed channel receives nothing");

	// The steered sibling's graceful settle works exactly as a self-latched one.
	b.child.confirmDelivery(b.notices[0]);
	b.child.chargeTurn(turn(0, 0, 8), true); // crosses the hard ceiling
	const settled: any = { exitCode: -1 };
	assert.equal(b.child.settle(settled), true);
	assert.equal(settled.stopReason, "budget_wrap_up");
	a.child.release();
	b.child.release();
});

test("a child already latched by its contract still broadcasts the shared flow transition", () => {
	// The transition belongs to the budget: gating the broadcast on the charging
	// child's own latch would steer flow siblings one turn late whenever a
	// contract ceiling latched that child first.
	const flow = Budget.forFlow({ maxGeneratedTokens: 20 })!;
	const worker = armed([flow, Budget.forContract({ maxGeneratedTokens: 5 })!]);
	const sibling = armed([flow]);

	worker.child.chargeTurn(turn(0, 0, 4), true); // contract at 80%: the worker is latched, the flow (20%) is not near
	assert.equal(worker.notices.length, 1);
	assert.equal(sibling.notices.length, 0);

	// The worker's next turn hard-stops its contract AND pushes the shared flow
	// ceiling to 80% — the sibling must be steered by that same turn.
	worker.child.chargeTurn(turn(0, 0, 12), true);
	assert.equal(sibling.notices.length, 1, "an already-latched (even stopping) child still broadcasts the flow transition");
	worker.child.release();
	sibling.child.release();
});

test("an errored turn's metered usage still broadcasts the threshold it crossed", () => {
	// The hard stop is healthy-only, but the charge is not: a provider-error
	// turn moves shared ceilings all the same, and the live sibling it
	// endangers deserves the steer either way.
	const shared = Budget.forFlow({ maxGeneratedTokens: 10 })!;
	const erroring = armed([shared]);
	const sibling = armed([shared]);
	erroring.child.chargeTurn(turn(0, 0, 8), false); // errored turn, usage metered: 80%
	assert.equal(sibling.notices.length, 1, "the sibling is steered by usage an errored turn charged");
	const settled: any = { exitCode: -1 };
	assert.equal(erroring.child.settle(settled), false, "an errored turn still never latches the hard stop itself");
	erroring.child.release();
	sibling.child.release();
});

test("a spent flow total-token spawn gate does not suppress the steer for a live-stop ceiling", () => {
	// A flow maxTokens ceiling only gates later spawns — children legitimately
	// keep running under it. When the generated ceiling then enters its window,
	// those live children still get their steer; screening on the spawn gate
	// would let them cross the generated hard ceiling unsteered.
	const mixed = Budget.forFlow({ maxTokens: 30, maxGeneratedTokens: 10 })!;
	const a = armed([mixed]);
	const b = armed([mixed]);
	a.child.chargeTurn(turn(0, 22, 8), true); // total 30 ≥ 30 (gate spent) and generated 8 = 80%
	assert.equal(mixed.refusesSpawn(), true, "the spawn gate is reached");
	assert.equal(a.notices.length, 1, "the crossing child is still steered");
	assert.equal(b.notices.length, 1, "so is its live sibling");
	a.child.release();
	b.child.release();

	// Past a live-stop ceiling the screen still holds: an exhausted generated
	// ceiling never steers.
	const spentGenerated = Budget.forFlow({ maxGeneratedTokens: 10 })!;
	spentGenerated.charge(turn(0, 0, 12));
	const late = armed([spentGenerated]);
	assert.equal(late.notices.length, 0);
	late.child.release();
});

test("a live sibling in a concurrent fan-out is steered when another child's turn crosses the shared threshold", async () => {
	// The scout's one settled turn lands exactly at 80% of the shared flow
	// ceiling while the analyst's child process is still holding open. The same
	// transition writes the analyst's wrap-up file; its answer to the steer
	// crosses the hard ceiling and settles gracefully — the concurrent shape of
	// the code-review preset (two children, one flow budget).
	const { result, stubDir } = await runFlow(
		{
			task: "two readers, one ceiling",
			maxGeneratedTokens: 10,
			concurrency: 2,
			timeoutMs: 8_000,
			tasks: [
				{ agent: "recon", task: "read A" },
				{ agent: "analyst", task: "read B" },
			],
		},
		{
			recon: { reply: "scanned" },
			analyst: { omitUsage: true, reply: "ack", wrapUpReply: "wrapped with partial notes", holdOpenMs: 6_000 },
		},
	);
	const sibling = result.details.results[1];
	assert.equal(sibling.wrapUpRequested, true, "the sibling was steered by a transition another child's turn crossed");
	assert.equal(sibling.stopReason, "budget_wrap_up");
	assert.equal(sibling.error, undefined);
	const notice = readFileSync(path.join(stubDir, "wrapup-notice.txt"), "utf8");
	assert.match(notice, /Flow budget/, "the steered notice names the shared flow ceiling");
});

test("a child spawned into a nearly spent shared budget is steered before its first turn can cross", async () => {
	// Two scouts spend a shared flow generated-token ceiling to 89%; the third
	// child then starts inside the wrap-up window. Its notice lands at spawn, the
	// stub finds it on the first poll, and its answer to the steer is what
	// crosses the ceiling — settling gracefully instead of as a breach.
	const { result } = await runFlow(
		{
			task: "three readers, one ceiling",
			maxGeneratedTokens: 18,
			concurrency: 1,
			timeoutMs: 5_000,
			tasks: [
				{ agent: "recon", task: "read A" },
				{ agent: "recon", task: "read B" },
				{ agent: "analyst", task: "read C" },
			],
		},
		{
			recon: { reply: "finding" },
			analyst: { omitUsage: true, reply: "ack", wrapUpReply: "wrapped up early with partial notes", holdOpenMs: 4_000 },
		},
	);
	const third = result.details.results[2];
	assert.equal(third.wrapUpRequested, true, "the wrap-up was requested at spawn, before any settled turn");
	assert.equal(third.stopReason, "budget_wrap_up");
	assert.equal(third.error, undefined);
	assert.equal(third.exitCode, 0);
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
