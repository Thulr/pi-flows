// One run has one state (run.ts). These tests exist because the derivation was
// previously written three times — `isFailed` over the live result read
// `stopReason`, the flow card's own predicate read `errorCode`, and the Gantt
// chart carried a third inline copy of the card's — so a run could render as
// failed in the live row, partial in the card header, and complete in that same
// card's row. Each surface had passing tests of its own; nothing asserted that
// they agreed, which is the gap this file closes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runFailed, runSettled, runState, type RunStateFields } from "../extensions/pi-flows/run.ts";
import { isFailed } from "../extensions/pi-flows/sanitize.ts";
import { flowProgressText } from "../extensions/pi-flows/ui.ts";
import { flowCardLines, type FlowRunEntryData, type FlowRunEntryResult } from "../extensions/pi-flows/ui-flow-card.ts";
import { ganttLayout } from "../extensions/pi-flows/ui-gantt.ts";
import type { FlowDetails, FlowRunResult } from "../extensions/pi-flows/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;

/**
 * The divergence case, and the reason the shared derivation exists: a child
 * that reports a terminal stop reason without a diagnostic. runner.ts copies
 * the child's own `stopReason` verbatim, and its provider-failure branch needs
 * an `errorMessage` too, so with messages present and exit 0 the classification
 * cascade falls through and leaves no `error` behind.
 */
const STOP_REASON_ONLY: RunStateFields = { exitCode: 0, stopReason: "error", agentSource: "package" };

test("every failure signal is a failure, whichever name the shape gives it", () => {
	assert.equal(runFailed({ exitCode: 1, agentSource: "package" }), true, "a non-zero exit");
	assert.equal(runFailed(STOP_REASON_ONLY), true, "a terminal stop reason with no diagnostic");
	assert.equal(runFailed({ exitCode: 0, errorCode: "CHILD_EXIT", agentSource: "package" }), true, "the persisted projection's errorCode");
	assert.equal(runFailed({ exitCode: 0, error: { code: "CHILD_EXIT" }, agentSource: "package" }), true, "the live result's error");
	assert.equal(runFailed({ exitCode: 0, agentSource: "package" }), false, "a clean settled run");
	assert.equal(runFailed({ exitCode: 0, stopReason: "budget_wrap_up", agentSource: "package" }), false, "a graceful wrap-up settles, it does not fail");
});

test("runFailed answers the settled question first; isFailed deliberately does not", () => {
	const live: RunStateFields = { exitCode: -1, agentSource: "package" };
	assert.equal(runSettled(live), false);
	assert.equal(runFailed(live), false, "an outstanding child has not failed, it has not finished");
	assert.equal(isFailed(live), true, "the liveness-unaware primitive is what a handler wants about a run it just settled");
});

test("runState names the four states, queued apart from running", () => {
	assert.equal(runState({ exitCode: -1, agentSource: "unknown" }), "queued", "the agent is unresolved until the runner looks it up");
	assert.equal(runState({ exitCode: -1, agentSource: "package" }), "running");
	assert.equal(runState({ exitCode: 0, agentSource: "package" }), "completed");
	assert.equal(runState(STOP_REASON_ONLY), "failed");
});

/**
 * The cross-surface assertion. Each surface renders the same run through its
 * own path — the live progress text, the durable card, and the timeline — so
 * this is the test that fails if any of them re-derives state for itself again.
 */
test("the live row, the flow card, and the timeline agree about one run", () => {
	const run = { agent: "redteam", agentSource: "package", exitCode: 0, stopReason: "error", durationMs: 8000, startedAtMs: 5000 };

	const details = {
		mode: "parallel",
		results: [
			{ agent: "recon", agentSource: "package", exitCode: 0, durationMs: 4000 },
			run,
		] as unknown as FlowRunResult[],
	} as FlowDetails;
	assert.equal(flowProgressText(details), "1 failed", "the live row counts it against the flow");

	const entry: FlowRunEntryData = {
		version: "test",
		mode: "parallel",
		status: "partial",
		results: [
			{ agent: "recon", agentSource: "package", exitCode: 0, durationMs: 4000, startedAtMs: 1000 },
			run,
		] as FlowRunEntryResult[],
	};
	const collapsed = flowCardLines(entry, theme, false);
	assert.ok(collapsed.some((line) => line.includes("✗")), `the card marks the run failed:\n${collapsed.join("\n")}`);
	assert.ok(
		collapsed.some((line) => line.includes("ctrl+o for failure detail")),
		"a card holding a failed run offers the failure detail affordance",
	);

	const layout = ganttLayout(entry.results)!;
	assert.deepEqual(layout.rows.map((row) => row.failed), [false, true], "the timeline hatches the same run the card marks");
});

/**
 * A guard, not a regression test: no entry written today holds an unsettled
 * run, because the child protocol (jsonl-child.mjs) only ever finishes 0 or 1
 * and the -1 placeholders never leave the progress path. But asking the
 * settled question first turns "not failed" into a green check on a
 * two-verdict surface, so without this the card's honesty would rest on an
 * invariant three modules away — and the failure mode is a success claimed on
 * the durable record, which is what this file exists to prevent.
 */
test("a run the flow never settled is neither ✓ nor ✗ on the durable card", () => {
	const results = [
		{ agent: "recon", agentSource: "package", exitCode: 0, durationMs: 4000 },
		{ agent: "redteam", agentSource: "package", exitCode: -1 },
	] as FlowRunEntryResult[];
	assert.equal(runState(results[1]!), "running");

	const lines = flowCardLines({ version: "test", mode: "parallel", status: "partial", results }, theme, false);
	const row = lines.find((line) => line.includes("redteam"))!;
	assert.ok(row.includes("◌"), `an unsettled run renders as unsettled, not as success:\n${row}`);
	assert.equal(row.includes("✓"), false, "and never as a green check");
	assert.equal(row.includes("✗"), false, "nor as a failure it did not reach");
});

test("a clean run is clean on every surface", () => {
	const results = [
		{ agent: "recon", agentSource: "package", exitCode: 0, durationMs: 4000, startedAtMs: 1000 },
		{ agent: "analyst", agentSource: "package", exitCode: 0, durationMs: 9000, startedAtMs: 2000 },
	];
	assert.equal(flowProgressText({ mode: "parallel", results } as unknown as FlowDetails), "2 ok");
	const lines = flowCardLines({ version: "test", mode: "parallel", status: "ok", results }, theme, false);
	assert.equal(lines.some((line) => line.includes("✗")), false, "no run is marked failed");
	assert.equal(lines.some((line) => line.includes("ctrl+o for failure detail")), false, "and no failure affordance is offered");
	assert.deepEqual(ganttLayout(results)!.rows.map((row) => row.failed), [false, false]);
});
