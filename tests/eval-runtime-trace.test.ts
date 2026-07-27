import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	appendProcessRuntimeTrace,
	defaultRuntimeTracePath,
	measurementRuntimeEvidence,
	runtimeScoreFamilies,
	runtimeTraceContext,
	runtimeTraceEvidence,
} from "../evals/runtime-trace.mjs";
import { stableTraceIds, traceSummaryAttributes } from "../extensions/pi-flows/trace.ts";
import { runFlow } from "./stub-harness.ts";

test("dry-run runtime traces use separate default paths", () => {
	assert.equal(defaultRuntimeTracePath(), ".thulr/runs/runtime.trace.jsonl");
	assert.equal(defaultRuntimeTracePath({ dryRun: true }), ".thulr/runs/runtime.dry-run.trace.jsonl");
	assert.equal(defaultRuntimeTracePath({ comparison: true }), ".thulr/runs/ab-runtime.trace.jsonl");
	assert.equal(defaultRuntimeTracePath({ dryRun: true, comparison: true }), ".thulr/runs/ab-runtime.dry-run.trace.jsonl");
});

test("trace summaries parse typed verifier verdicts from handoff data", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const verifier = {
		agent: "overwatch",
		agentSource: "package",
		task: "verify",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: '{"data":{"verdict":"pass"}}' }] }],
		stderr: "",
		usage,
		durationMs: 10,
		handoff: { compatibility: "typed", data: { verdict: "pass" } },
	};
	const attrs = traceSummaryAttributes(
		"orchestrate",
		{ orchestrate: { verify: { agent: "overwatch" } } },
		{ content: [{ type: "text", text: "Verification PASS" }], details: { results: [verifier] } } as any,
	);
	assert.equal(attrs["flow.outcome_verified"], true);
	assert.equal(attrs["flow.outcome_success"], true);
	assert.equal(attrs["flow.verify_verdict"], "pass");
});

test("trace summaries exclude rejected verifier handoffs from verified outcomes", () => {
	const verifier = {
		agent: "overwatch",
		agentSource: "package",
		task: "verify",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: '{"data":{"verdict":"pass"}}' }] }],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		durationMs: 10,
	};
	const attrs = traceSummaryAttributes(
		"orchestrate",
		{ orchestrate: { verify: { agent: "overwatch" } } },
		{
			content: [{ type: "text", text: "RETURN_ENVELOPE_INCOMPLETE" }],
			details: { results: [verifier], error: { code: "RETURN_ENVELOPE_INCOMPLETE" } },
		} as any,
	);
	assert.equal(attrs["flow.outcome_verified"], false);
	assert.equal(attrs["flow.outcome_success"], undefined);
	assert.equal(attrs["flow.verify_verdict"], undefined);
});

test("runtime trace ids are stable across file ordering and distinct across paired arms", () => {
	const flows = runtimeTraceContext("run-abc", {
		caseId: "case-a",
		trialId: "case-a::trial-002",
		trialIndex: 2,
		arm: "flows",
	});
	const baseline = runtimeTraceContext("run-abc", {
		caseId: "case-a",
		trialId: "case-a::trial-002",
		trialIndex: 2,
		arm: "plain",
	});
	assert.deepEqual(stableTraceIds(flows, "parallel"), stableTraceIds(structuredClone(flows), "parallel"));
	assert.notEqual(stableTraceIds(flows, "parallel").traceId, stableTraceIds(baseline, "parallel").traceId);
});

test("missing runtime traces are trace-health evidence, not agent failure", () => {
	const context = runtimeTraceContext("run-abc", {
		caseId: "case-a",
		trialId: "case-a::trial-001",
		trialIndex: 1,
		arm: "flows",
	});
	const trace = runtimeTraceEvidence(undefined, "/tmp/runtime.jsonl", context);
	const scores = runtimeScoreFamilies({
		result: { details: { results: [] } },
		objective: { pass: true, score: 1 },
		trace,
	});
	assert.equal(trace.health, "missing");
	assert.equal(scores.execution.pass, true);
	assert.equal(scores.verifiedOutcome.pass, true);
	assert.equal(scores.traceHealth.pass, false);
});

test("runtime score families keep execution, outcome, and policy compliance separate", () => {
	const trace = {
		health: "recorded",
		traceFile: "runtime.jsonl",
		traceId: "a".repeat(32),
		rootSpanId: "b".repeat(32),
		context: runtimeTraceContext("run-abc", {
			caseId: "case-a",
			trialId: "case-a::trial-001",
			trialIndex: 1,
			arm: "flows",
		}),
	};
	const scores = runtimeScoreFamilies({
		result: {
			details: {
				results: [],
				error: { code: "RETURN_ENVELOPE_INCOMPLETE" },
			},
		},
		objective: { pass: true, score: 1 },
		trace,
	});
	assert.equal(scores.execution.pass, false);
	assert.equal(scores.verifiedOutcome.pass, true);
	assert.equal(scores.policyCompliance.pass, false);
	assert.equal(scores.traceHealth.pass, true);
});

test("runtime score-family diagnostics redact secrets and home paths", () => {
	const scores = runtimeScoreFamilies({
		thrown: new Error(`provider failed under ${homedir()} with token=trace-private-value`),
		objective: { pass: false, score: 0 },
		trace: { health: "missing" },
	});
	assert.match(scores.execution.reason, /REDACTED_SECRET/);
	assert.doesNotMatch(scores.execution.reason, /trace-private-value/);
	assert.doesNotMatch(scores.execution.reason, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("flow execution returns an exact redacted runtime-trace root link", async () => {
	const context = runtimeTraceContext("run-abc", {
		caseId: "case-a",
		trialId: "case-a::trial-003",
		trialIndex: 3,
		arm: "flows",
	});
	const { result, stubDir } = await runFlow(
		{
			agent: "recon",
			task: "read secret=private-value",
			traceFile: "runtime.jsonl",
			traceContext: context,
			recordContent: false,
		},
		{ recon: "secret=private-value" },
	);
	const expected = stableTraceIds(context, "single");
	assert.equal(result.details.trace?.health, "recorded");
	assert.equal(result.details.trace?.traceId, expected.traceId);
	assert.equal(result.details.trace?.rootSpanId, expected.rootSpanId);
	const spans = (await readFile(`${stubDir}/runtime.jsonl`, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const root = spans.find((span) => span.span_id === expected.rootSpanId);
	assert.equal(root.attributes["flow.run_id"], "run-abc");
	assert.equal(root.attributes["flow.trial_id"], "case-a::trial-003");
	assert.doesNotMatch(JSON.stringify(spans), /private-value/);
});

test("recorded runtime span content redacts secrets and home paths", async () => {
	const secret = "secret=span-private-value";
	const { stubDir } = await runFlow(
		{
			agent: "recon",
			task: `read ${homedir()} with ${secret}`,
			traceFile: "runtime.jsonl",
			recordContent: true,
			redactSecrets: true,
		},
		{ recon: `result from ${homedir()} with ${secret}` },
	);
	const spans = await readFile(`${stubDir}/runtime.jsonl`, "utf8");
	assert.doesNotMatch(spans, /span-private-value/);
	assert.doesNotMatch(spans, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(spans, /REDACTED_SECRET/);
});

test("trace identifiers, paths, and write failures honor the redaction policy", async () => {
	const secret = "secret=trace-private-value";
	const context = runtimeTraceContext(`run-${secret}`, {
		caseId: `case-${secret}`,
		trialId: `trial-${secret}`,
		trialIndex: 1,
		arm: `arm-${secret}`,
	});
	const traceFile = path.join(homedir(), `trace-${secret}`, "missing", "runtime.jsonl");
	const { result } = await runFlow(
		{
			agent: "recon",
			task: "return a safe result",
			traceFile,
			traceContext: context,
			recordContent: true,
			redactSecrets: true,
		},
		{ recon: "safe result" },
	);
	const stored = JSON.stringify(result.details.trace);
	assert.equal(result.details.trace?.health, "missing");
	assert.doesNotMatch(stored, /trace-private-value/);
	assert.doesNotMatch(stored, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(result.details.trace?.context?.runId ?? "", /REDACTED_SECRET/);
	assert.match(result.details.trace?.traceFile ?? "", /^~/);
});

test("baseline trace evidence redacts displayed paths and write failures", () => {
	const secret = "secret=baseline-private-value"; // privacy-scan: allow deliberate trace-redaction fixture
	const traceFile = path.join(homedir(), `trace-${secret}`, "missing", "runtime.jsonl");
	const trace = appendProcessRuntimeTrace(traceFile, runtimeTraceContext("run", {
		caseId: "case",
		trialId: "trial",
		arm: "plain",
	}), {
		mode: "baseline.pi",
		startMs: 1,
		endMs: 2,
		executionSuccess: false,
	});
	const stored = JSON.stringify(trace);
	assert.equal(trace.health, "missing");
	assert.doesNotMatch(stored, /baseline-private-value/);
	assert.doesNotMatch(stored, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(trace.traceFile, /^~/);
});

test("baseline child failures mark both runtime traces and execution scores failed", async () => {
	const outputDir = await mkdtemp(path.join(tmpdir(), "pi-eval-baseline-trace-"));
	const traceFile = path.join(outputDir, "runtime.jsonl");
	const evidence = measurementRuntimeEvidence({
		dryRun: false,
		runner: "baseline",
		result: { details: { results: [{ exitCode: 1, stopReason: "error" }] } },
		objective: { pass: false, score: 0 },
		traceFile,
		displayTraceFile: "runtime.jsonl",
		context: runtimeTraceContext("run", { caseId: "case", trialId: "trial", arm: "plain" }),
		baselineMode: "baseline.pi",
		startMs: 1,
		endMs: 2,
		model: "stub-model",
	});
	assert.equal(evidence.runtimeTrace.health, "recorded");
	assert.equal(evidence.scoreFamilies.execution.pass, false);
	const span = JSON.parse((await readFile(traceFile, "utf8")).trim());
	assert.equal(span.status.code, "ERROR");
	assert.equal(span.attributes["flow.execution_success"], false);
});

test("eval runner links repeated trials in the raw reliability artifact", async () => {
	const outputDir = await mkdtemp(path.join(tmpdir(), "pi-eval-runtime-trace-"));
	const traceOut = path.join(outputDir, "trace.jsonl");
	const runtimeTraceOut = path.join(outputDir, "runtime.jsonl");
	const reliabilityOut = path.join(outputDir, "reliability.json");
	const child = spawnSync(process.execPath, [
		"--import", "tsx", "evals/run.mjs", "--dry-run",
		"--filter=route-classifies", "--trials=2", "--run-id=run-test-123",
		`--trace-out=${traceOut}`, `--runtime-trace=${runtimeTraceOut}`,
		`--reliability-out=${reliabilityOut}`,
	], { cwd: process.cwd(), encoding: "utf8" });

	assert.equal(child.status, 0, child.stderr);
	const report = JSON.parse(await readFile(reliabilityOut, "utf8"));
	assert.equal(report.runId, "run-test-123");
	assert.equal(report.runtimeTraceFile, runtimeTraceOut);
	assert.deepEqual(report.cases[0].trials.map((trial) => trial.trialId), [
		"route-classifies-bug-to-recon::trial-001",
		"route-classifies-bug-to-recon::trial-002",
	]);
	assert.equal(report.cases[0].trials.every((trial) => trial.runtimeTrace.health === "missing"), true);
	assert.equal(report.cases[0].trials.every((trial) => trial.scoreFamilies.traceHealth.pass === false), true);
});

test("eval runner dry-run reliability points at the isolated runtime trace default", async () => {
	const outputDir = await mkdtemp(path.join(tmpdir(), "pi-eval-dry-runtime-trace-"));
	const traceOut = path.join(outputDir, "trace.jsonl");
	const reliabilityOut = path.join(outputDir, "reliability.json");
	const child = spawnSync(process.execPath, [
		"--import", "tsx", "evals/run.mjs", "--dry-run",
		"--filter=route-classifies",
		`--trace-out=${traceOut}`,
		`--reliability-out=${reliabilityOut}`,
	], { cwd: process.cwd(), encoding: "utf8" });

	assert.equal(child.status, 0, child.stderr);
	const report = JSON.parse(await readFile(reliabilityOut, "utf8"));
	assert.equal(report.runtimeTraceFile, ".thulr/runs/runtime.dry-run.trace.jsonl");
});
