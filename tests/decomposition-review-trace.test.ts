// Trace evidence for Decomposition review (issue #160): each attempt has a
// unique child span, each verdict and retry is explicit, and worker dispatch
// depends on the final PASS gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTraceJsonl, traceReportIsComplete, summarizeTraceSpans, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";
import { runFlow } from "./stub-harness.ts";

const TRACE = "flow-trace.jsonl";
const first = [{ id: "login", objective: "Map login" }];
const replacement = [{ id: "login", objective: "Map login" }, { id: "refresh", objective: "Map refresh" }];

const attr = (span: TraceSpanRecord | undefined, key: string) => span?.attributes?.[key];
const unit = (spans: TraceSpanRecord[], key: string) => spans.find((span) => attr(span, "flow.unit_key") === key);
const event = (spans: TraceSpanRecord[], name: string) => spans.filter((span) => attr(span, "flow.event_name") === name);
const root = (spans: TraceSpanRecord[]) => spans.find((span) => span.parent_span_id === null)!;

async function spansOf(stubDir: string): Promise<TraceSpanRecord[]> {
	return parseTraceJsonl(await readFile(path.join(stubDir, TRACE), "utf8")).spans;
}

const params = (max = 2) => ({
	task: "Map login and refresh.",
	traceFile: TRACE,
	concurrency: 1,
	orchestrate: {
		commander: { agent: "commander" }, review: { agent: "overwatch" }, reviewMaxIterations: max,
		recon: { agent: "recon" }, debrief: { agent: "debrief" },
	},
});

test("a first PASS records the review gate before worker dispatch", async () => {
	const { stubDir, result } = await runFlow(
		params(),
		{ commander: JSON.stringify(replacement), overwatch: "VERDICT: PASS\nComplete.", recon: "FINDING", debrief: "REPORT" },
	);
	assert.equal(result.details.error, undefined);
	const spans = await spansOf(stubDir);
	const review = unit(spans, "decomposition-review-1")!;
	const verdict = event(spans, "orchestrate.decomposition_review_verdict")[0]!;
	const worker = unit(spans, "worker-login")!;

	assert.ok(review, "the reviewer has its own child span");
	assert.equal(attr(verdict, "flow.verdict.value"), "pass");
	assert.equal(attr(worker, "flow.depends_on"), "decompose.handoff,decomposition-review-1.verdict");
	assert.ok(worker.start_time_unix_ms! >= review.end_time_unix_ms!, "worker dispatch starts after review settles");
	assert.equal(attr(root(spans), "flow.outcome_verified"), false, "Decomposition PASS is not Verified outcome success");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("REVISE then PASS records unique attempt spans, both verdicts, and one retry", async () => {
	const { stubDir, result } = await runFlow(
		params(),
		{
			commander: [JSON.stringify(first), JSON.stringify(replacement)],
			overwatch: ["VERDICT: REVISE\nRefresh is missing.", "VERDICT: PASS\nComplete."],
			recon: "FINDING", debrief: "REPORT",
		},
	);
	assert.equal(result.details.error, undefined);
	const spans = await spansOf(stubDir);
	for (const key of ["decompose", "decomposition-review-1", "decompose-2", "decomposition-review-2"]) {
		assert.equal(spans.filter((span) => attr(span, "flow.unit_key") === key).length, 1, `${key} is unique`);
	}
	const verdicts = event(spans, "orchestrate.decomposition_review_verdict");
	assert.deepEqual(verdicts.map((span) => attr(span, "flow.verdict.value")), ["revise", "pass"]);
	assert.deepEqual(verdicts.map((span) => attr(span, "flow.verdict.attempt")), [1, 2]);
	const retries = event(spans, "orchestrate.revise_decomposition");
	assert.equal(retries.length, 1);
	assert.equal(attr(retries[0], "flow.retry.attempt"), 2);
	assert.equal(attr(unit(spans, "decompose-2"), "flow.depends_on"), "decompose.handoff,decomposition-review-1.verdict,decomposition-review-1.handoff");
	assert.equal(attr(unit(spans, "worker-refresh"), "flow.depends_on"), "decompose-2.handoff,decomposition-review-2.verdict");
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});

test("a final REVISE records the final verdict and no worker span", async () => {
	const { stubDir, result } = await runFlow(
		params(1),
		{ commander: JSON.stringify(first), overwatch: "VERDICT: REVISE\nRefresh is missing.", recon: "MUST NOT RUN" },
	);
	assert.equal(result.details.error?.code, "DECOMPOSITION_REVIEW_FAILED");
	const spans = await spansOf(stubDir);
	assert.equal(attr(event(spans, "orchestrate.decomposition_review_verdict")[0], "flow.verdict.value"), "revise");
	assert.equal(spans.some((span) => String(attr(span, "flow.unit_key") ?? "").startsWith("worker-")), false);
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, TRACE)), true);
});
