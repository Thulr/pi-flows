// Return assurance levels (issue #146): an ordinary Result carries no machine
// contract assurance, a contract-bound Return proves attribution, integrity,
// and conformance — never the truth of its claims — and Verified outcome
// success exists only when an independent verifier assessed the outcome.
//
// These run against the stub `pi` through the real dispatch path (see
// tests/stub-harness.ts) and pin the distinctions where the parent sees them:
// public result details and trace reporting.
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { formatTraceReport, parseTraceJsonl, summarizeTraceSpans, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";
import { integrationContract, integrationEnvelope, runFlow } from "./stub-harness.ts";

const TRACE = "flow-trace.jsonl";

async function readSpans(stubDir: string): Promise<TraceSpanRecord[]> {
	const text = await readFile(path.join(stubDir, TRACE), "utf8");
	return parseTraceJsonl(text).spans;
}

const attr = (span: TraceSpanRecord | undefined, key: string) => span?.attributes?.[key];
const root = (spans: TraceSpanRecord[]) => spans.find((span) => span.parent_span_id === null);
const childSpans = (spans: TraceSpanRecord[]) => spans.filter((span) => attr(span, "flow.span_role") === "child");
const eventNames = (spans: TraceSpanRecord[]) => spans.filter((span) => attr(span, "flow.span_role") === "event").map((span) => span.name);

test("uncontracted single: an ordinary Result carries no machine contract assurance", async () => {
	const { result, stubDir } = await runFlow(
		{ agent: "recon", task: "find the billing routes", traceFile: TRACE },
		{ recon: "ROUTES: /charge /refund" },
	);

	// The public result exposes the child's account and nothing contract-shaped.
	const run = result.details.results[0];
	assert.equal(result.details.error, undefined);
	assert.equal(run.envelope, undefined, "an uncontracted Result must not carry a Return envelope");
	assert.equal(run.handoff, undefined, "a terminal result is not a handoff");

	// The trace claims contract identity only for an enforced contract (#137),
	// and never records a validation that did not happen.
	const spans = await readSpans(stubDir);
	assert.equal(attr(childSpans(spans)[0], "flow.contract_id"), undefined);
	assert.ok(!eventNames(spans).some((name) => name.includes("envelope.")), "no envelope validation event without a contract");

	// Execution success is the harness's verdict; verification never happened.
	assert.equal(attr(root(spans), "flow.execution_success"), true);
	assert.equal(attr(root(spans), "flow.outcome_verified"), false);
});

test("contracted single: a contract-bound Return proves attribution and conformance, not verified outcome", async () => {
	const { result, stubDir } = await runFlow(
		{ agent: "recon", contract: integrationContract, traceFile: TRACE },
		{ recon: integrationEnvelope({ answer: "xyzzy-42" }) },
	);

	// The validated Return envelope is public, bound to the exact resolved
	// contract identity, with its schema-checked data.
	const run = result.details.results[0];
	assert.equal(result.details.error, undefined);
	assert.equal(run.envelope?.contractId, delegationContractId(integrationContract as never));
	assert.equal(run.envelope?.data.answer, "xyzzy-42");

	// The trace records the enforced contract identity and the validation event.
	const spans = await readSpans(stubDir);
	assert.equal(attr(childSpans(spans)[0], "flow.contract_id"), delegationContractId(integrationContract as never));
	assert.ok(eventNames(spans).some((name) => name.endsWith("envelope.validated")), "terminal contract validation is recorded");

	// The distinction this issue exists for: a validated Return is still not an
	// independently verified outcome. No verifier ran, so verification is absent.
	assert.equal(attr(root(spans), "flow.execution_success"), true);
	assert.equal(attr(root(spans), "flow.outcome_verified"), false);
});

test("evaluate with a critic: only an independent verifier grants Verified outcome success", async () => {
	const { result, stubDir } = await runFlow(
		{ task: "add the endpoint", evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" } }, traceFile: TRACE },
		{ operator: "built it", redteam: "VERDICT: PASS" },
	);

	assert.equal(result.details.error, undefined);
	const spans = await readSpans(stubDir);
	assert.equal(attr(root(spans), "flow.outcome_verified"), true, "a critic's assessment is independent verification");
	assert.equal(attr(root(spans), "flow.outcome_success"), true);
});

test("trace report: execution success never promotes to Verified outcome success without a verifier", async () => {
	const uncontracted = await runFlow(
		{ agent: "recon", task: "find the billing routes", traceFile: TRACE },
		{ recon: "ROUTES: /charge /refund" },
	);
	const contracted = await runFlow(
		{ agent: "recon", contract: integrationContract, traceFile: TRACE },
		{ recon: integrationEnvelope({ answer: "xyzzy-42" }) },
	);

	const spans = [...await readSpans(uncontracted.stubDir), ...await readSpans(contracted.stubDir)];
	const report = summarizeTraceSpans(spans);
	assert.equal(report.traces, 2);
	assert.equal(report.executionSuccesses, 2);
	assert.equal(report.verifiedOutcomes, 0, "a contract-bound Return alone is not a verified outcome");
	assert.equal(report.outcomeSuccesses, 0);

	// The report exposes the assurance split by run: one child dispatched under
	// a contract, one ordinary Result with no machine contract assurance.
	assert.equal(report.contractedRuns, 1);
	assert.equal(report.uncontractedRuns, 1);

	// The rendered report separates the assurances by name and reports the
	// unverified remainder as unavailable — never as failed, never as verified.
	const text = formatTraceReport(report);
	assert.match(text, /Execution success: 2\/2/);
	assert.match(text, /Verified outcome success: 0\/0 \(n\/a; 2 unavailable\)/);
	assert.match(text, /Return assurance: 1 child run under a delegation contract, 1 ordinary Result \(no machine contract assurance\)/);
});

test("trace report: a verifier-assessed run is the only one counted as verified", async () => {
	const verified = await runFlow(
		{ task: "add the endpoint", evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" } }, traceFile: TRACE },
		{ operator: "built it", redteam: "VERDICT: PASS" },
	);
	const contracted = await runFlow(
		{ agent: "recon", contract: integrationContract, traceFile: TRACE },
		{ recon: integrationEnvelope({ answer: "xyzzy-42" }) },
	);

	const spans = [...await readSpans(verified.stubDir), ...await readSpans(contracted.stubDir)];
	const report = summarizeTraceSpans(spans);
	assert.equal(report.traces, 2);
	assert.equal(report.verifiedOutcomes, 1);
	assert.equal(report.outcomeSuccesses, 1);
	assert.match(formatTraceReport(report), /Verified outcome success: 1\/1 \(100\.0%; 1 unavailable\)/);
});
