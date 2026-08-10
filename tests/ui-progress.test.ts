import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { flowLiveBoardLines, renderFlowResultRow } from "../extensions/pi-flows/ui-live-row.ts";
import { clearFlowUi, flowProgressText } from "../extensions/pi-flows/ui.ts";

/**
 * The header counter's *meaning*, across every surface that renders it. A bare
 * `settled/total` was ambiguous in both directions: `0/2` read as "no runs
 * started" and `2/2` read as "both runs succeeded" even when both failed. One
 * helper now names what the numerator counts while runs are outstanding, and
 * replaces the ratio with the verdict once nothing is.
 *
 * Every surface assertion goes through `flowProgressText` as well as the literal
 * string, so a surface that starts formatting its own ratio again fails here.
 */

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function result(overrides: Record<string, unknown> = {}): any {
	return { agent: "recon", agentSource: "package", task: "inspect auth", exitCode: -1, messages: [], stderr: "", usage, ...overrides };
}

function details(results: any[], overrides: Record<string, unknown> = {}): any {
	return { mode: "parallel", version: "test", agentScope: "user", config: { redactSecretsDefault: true }, agentsDir: {}, results, ...overrides };
}

/** The four states a two-run fan-out passes through, plus the single-run case. */
const inFlight = details([result(), result({ agent: "analyst" })]);
const allFailed = details([
	result({ exitCode: 1, error: { code: "BUDGET_EXCEEDED" } }),
	result({ agent: "analyst", exitCode: 1, error: { code: "BUDGET_EXCEEDED" } }),
]);
const allOk = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 0 })]);
const partial = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 1, error: { code: "CHILD_EXIT" } })]);
const singleRun = details([result()], { mode: "single" });

function boardHeader(flowDetails: any): string {
	return flowLiveBoardLines(flowDetails, theme, { tick: 0, redactSecrets: true })[0]!;
}

test("flowProgressText names what the numerator counts, then replaces it with the verdict", () => {
	assert.equal(flowProgressText(inFlight), "0/2 settled");
	assert.equal(flowProgressText(details([result({ exitCode: 0 }), result({ agent: "analyst" })])), "1/2 settled");
	assert.equal(flowProgressText(allFailed), "2 failed", "N/N after total failure reads as a success total");
	assert.equal(flowProgressText(allOk), "2 ok");
	assert.equal(flowProgressText(partial), "1 failed", "a partial settle reports failures, not a success-looking ratio");
	assert.equal(flowProgressText(singleRun), "0/1 settled");
	assert.doesNotMatch(flowProgressText(allFailed), /\d+\/\d+/, "no ratio survives settling");
	assert.doesNotMatch(flowProgressText(allOk), /\d+\/\d+/);
	// A dispatched flow can be rendered before its first run registers.
	assert.equal(flowProgressText(details([])), "starting", "no runs yet is not a clean sweep");
});

/**
 * Between the stages of a multi-stage mode, every run *so far* has settled while
 * the flow is still working: `evaluate` emits an update after its generator
 * settles, before the check command and the critic panel. A verdict there would
 * announce an outcome the flow has not reached, so callers that know the flow is
 * still live say so and keep the labeled ratio.
 */
test("a live flow between stages reports settled runs, not a verdict", () => {
	const betweenStages = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 0 })], { mode: "evaluate" });
	assert.equal(flowProgressText(betweenStages, { live: true }), "2/2 settled");
	assert.equal(flowProgressText(betweenStages), "2 ok", "an unqualified call still settles into the verdict");

	const board = flowLiveBoardLines(betweenStages, theme, { tick: 0, redactSecrets: true, live: true });
	assert.match(board[0]!, /flow evaluate 2\/2 settled/);
	assert.equal(board[0]!.includes("2 ok"), false, "the next stage has not run yet");
	assert.equal(board[0]!.startsWith("✓"), false, "a ✓ beside 'settled so far' contradicts itself");
	assert.doesNotMatch(board[0]!, /█|░/, "the bar measures outstanding runs, and between stages there are none");
});

test("the live tool row takes its liveness from the tool call, not just its runs", () => {
	const settledRuns = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 0 })], { mode: "chain" });
	const context = { invalidate: () => {}, state: {}, lastComponent: undefined } as any;
	const flowResult = { content: [{ type: "text", text: "done" }], details: settledRuns };

	const partialRow = renderFlowResultRow(flowResult as any, { expanded: false, isPartial: true }, theme, context, (() => "agents") as any) as Text;
	assert.match(partialRow.text ?? String(partialRow), /flow chain 2\/2 settled/, "a partial tool row means another stage may still spawn");

	context.lastComponent = undefined;
	const finalRow = renderFlowResultRow(flowResult as any, { expanded: false, isPartial: false }, theme, context, (() => "agents") as any) as Text;
	assert.match(finalRow.text ?? String(finalRow), /flow chain 2 ok/, "the settled row reports the verdict");
});

test("the live tool row labels the ratio while running and shows the verdict on settle", () => {
	assert.match(boardHeader(inFlight), /flow parallel 0\/2 settled/);
	assert.match(boardHeader(inFlight), /██/, "the per-run state cells travel with the labeled counter");

	assert.match(boardHeader(allFailed), /flow parallel 2 failed/);
	assert.doesNotMatch(boardHeader(allFailed), /2\/2/, "the ratio must not outlive the run it measured");
	assert.doesNotMatch(boardHeader(allFailed), /█|░/, "a settled flow has nothing outstanding to bar-chart");

	assert.match(boardHeader(allOk), /flow parallel 2 ok/);
	assert.doesNotMatch(boardHeader(allOk), /2\/2/);
	assert.match(boardHeader(partial), /flow parallel 1 failed/);

	for (const state of [inFlight, allFailed, allOk, partial]) {
		assert.ok(boardHeader(state).includes(flowProgressText(state)), "the row must not format its own state text");
	}
});

test("non-clean preset outcomes cannot render as a successful live-row verdict", () => {
	const findings = details(
		[result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 0 })],
		{ preset: { name: "code-review" }, presetOutcome: "FINDINGS" },
	);
	assert.equal(flowProgressText(findings), "FINDINGS");
	assert.match(boardHeader(findings), /^◐ flow code-review FINDINGS/);
	assert.doesNotMatch(boardHeader(findings), /✓|2 ok/);
});

test("a live flow clears duplicate transient progress surfaces", () => {
	const statusCalls: unknown[][] = [];
	const widgetCalls: unknown[][] = [];
	const ctx = {
		ui: {
			setStatus: (...args: unknown[]) => statusCalls.push(args),
			setWidget: (...args: unknown[]) => widgetCalls.push(args),
		},
	};

	clearFlowUi(ctx);

	assert.deepEqual(statusCalls, [["pi-flows", undefined]], "the inline tool row is the one primary live view");
	assert.deepEqual(widgetCalls, [["pi-flows", undefined]], "the detailed inline tool row is the one primary live view");
});

test("the board surfaces report a flow-level error beside the run counts, as before", () => {
	// Progress text describes run state. A flow-level failure remains a separate
	// signal because a denied checkpoint or incomplete trace can fail a flow whose
	// every run succeeded.
	const errored = details([result({ exitCode: 0 }), result({ agent: "analyst", exitCode: 0 })], { error: { code: "TRACE_INCOMPLETE", message: "trace incomplete" } });
	const board = flowLiveBoardLines(errored, theme, { tick: 0, redactSecrets: true });
	assert.match(board[0]!, /flow parallel 2 ok/);
	assert.match(board.join("\n"), /error: TRACE_INCOMPLETE/, "the error line is what carries the flow-level failure");
});

test("single-child flows keep bare headers on the live board", () => {
	assert.equal(boardHeader(singleRun).includes("0/1"), false);
	assert.equal(boardHeader(singleRun).includes("settled"), false, "with one run the header would only restate the agent row");
	assert.equal(boardHeader(details([result({ exitCode: 0 })], { mode: "single" })).includes("1 ok"), false);
});
