import { test } from "node:test";
import assert from "node:assert/strict";
import { traceSpansForCase, gateBlocks, gateArgs, compareArgs, duelArgs, judgeArgs, calibrateArgs, inspectTraceArgs, labelFailuresArgs, formatGateScoreSummary, gateCandidateForEvalRun, evalRunDimensions, sharedGateDimensions, paretoArgs, reviewArgs } from "../evals/thulr.mjs";

// thulr ingests a SELF-CONTAINED trace: each case's criterion and its
// deterministic (objective) label travel INLINE in the span attributes — no more
// separate cases-manifest or labels files. thulr groups by `thulr.case_id` and
// grades the latest span's `output.value`. (See thulr's docs/trace-contract.md.)
test("traceSpansForCase emits a self-contained case trace: case_id, criterion, label, answer inline", () => {
	const spans = traceSpansForCase({
		name: "my-case",
		answer: "the value is xyzzy-42",
		criterion: "The answer states the value is xyzzy-42.",
		label: true,
		endMs: 2500,
	});

	const graded = spans.find((s) => s.attributes["output.value"] !== undefined);
	assert.equal(spans.length, 2, "a case root plus final-answer span gives thulr trajectory coverage");
	assert.ok(graded, "a span carries output.value for the judge to grade");
	assert.equal(graded.parent_span_id, spans[0].span_id);
	assert.equal(graded.attributes["thulr.case_id"], "my-case");
	assert.equal(graded.attributes["thulr.criterion"], "The answer states the value is xyzzy-42.");
	assert.equal(graded.attributes["thulr.deterministic_label"], true);
	assert.equal(graded.attributes["output.value"], "the value is xyzzy-42");
	assert.equal(graded.end_time_unix_ms, 2500, "thulr needs a numeric end_time_unix_ms");
});

// thulr's trace contract takes optional judge context + repro telemetry per case:
// the task text (input.value), cost/tokens (summed into the EvalRun), and the
// prompt version (queryable via `thulr query-traces --prompt-version`).
test("traceSpansForCase carries task, cost, tokens, and prompt version when given", () => {
	const spans = traceSpansForCase({
		name: "c",
		answer: "a",
		criterion: "x",
		endMs: 1,
		task: "Find the value of SAMPLE_IDENTIFIER.",
		expectedBehavior: "The answer states xyzzy-42.",
		failureModes: [],
		costUsd: 0.0421,
		tokensTotal: 1234,
		promptVersion: "pi-flows@0.1.0",
		configVersion: "pi-flows-eval:provider/model",
	});
	const root = spans[0];
	const span = spans.find((s) => s.attributes["output.value"] !== undefined);

	assert.equal(span.attributes["input.value"], "Find the value of SAMPLE_IDENTIFIER.", "the task text is the judge's input context");
	assert.equal(span.attributes["thulr.task.input"], "Find the value of SAMPLE_IDENTIFIER.");
	assert.equal(span.attributes["thulr.expected_behavior"], "The answer states xyzzy-42.");
	assert.deepEqual(span.attributes["thulr.failure_modes"], []);
	assert.equal(span.attributes["thulr.cost_usd"], 0.0421);
	assert.equal(span.attributes["llm.token_count.total"], 1234);
	assert.equal(span.attributes["thulr.prompt_version"], "pi-flows@0.1.0");
	assert.equal(span.attributes["thulr.config_version"], "pi-flows-eval:provider/model");
	assert.equal("thulr.cost_usd" in root.attributes, false, "cost belongs to the final-answer span only");
});

test("traceSpansForCase carries stable base-case and unique trial identifiers", () => {
	const spans = traceSpansForCase({
		name: "case-a::trial-002",
		baseCaseId: "case-a",
		trialId: "case-a::trial-002",
		trialIndex: 2,
		answer: "answer",
		criterion: "correct",
		endMs: 5,
	});
	const graded = spans.find((span) => span.attributes["output.value"] !== undefined);
	assert.equal(graded.attributes["thulr.case_id"], "case-a::trial-002");
	assert.equal(graded.attributes["thulr.base_case_id"], "case-a");
	assert.equal(graded.attributes["thulr.trial_id"], "case-a::trial-002");
	assert.equal(graded.attributes["thulr.trial_index"], 2);
});

test("traceSpansForCase links the exact runtime trace and separates score families", () => {
	const spans = traceSpansForCase({
		name: "case-a::trial-002",
		baseCaseId: "case-a",
		trialId: "case-a::trial-002",
		trialIndex: 2,
		evalRunId: "run-abc",
		answer: "42",
		criterion: "answer is correct",
		endMs: 10,
		runtimeTrace: {
			health: "recorded",
			traceFile: ".thulr/runs/runtime.jsonl",
			traceId: "a".repeat(32),
			rootSpanId: "b".repeat(32),
			context: {
				runId: "run-abc",
				caseId: "case-a",
				trialId: "case-a::trial-002",
				trialIndex: 2,
				arm: "flows",
			},
		},
		scoreFamilies: {
			execution: { available: true, pass: true, reason: null },
			verifiedOutcome: { available: true, pass: false, score: 0.5 },
			policyCompliance: { available: true, pass: true, reasons: [] },
			traceHealth: { available: true, pass: true, status: "recorded", reason: null },
		},
	});
	const answer = spans.find((span) => span.attributes["output.value"] !== undefined);
	assert.equal(answer.attributes["pi_flows.eval_run_id"], "run-abc");
	assert.equal(answer.attributes["pi_flows.runtime_trace.file"], ".thulr/runs/runtime.jsonl");
	assert.equal(answer.attributes["pi_flows.runtime_trace.trace_id"], "a".repeat(32));
	assert.equal(answer.attributes["pi_flows.runtime_trace.root_span_id"], "b".repeat(32));
	assert.equal(answer.attributes["pi_flows.runtime_trace.health"], "recorded");
	assert.equal(answer.attributes["pi_flows.score.execution.pass"], true);
	assert.equal(answer.attributes["pi_flows.score.verified_outcome.pass"], false);
	assert.equal(answer.attributes["pi_flows.score.verified_outcome.score"], 0.5);
	assert.equal(answer.attributes["pi_flows.score.policy_compliance.pass"], true);
});

test("traceSpansForCase carries thulr 0.3 named criteria, dimension labels, and judge-only flags", () => {
	const span = traceSpansForCase({
		name: "review-case",
		answer: "found all defects with file evidence",
		criterion: "finds the critical defect",
		criteria: {
			completeness: "finds all defects",
			evidence_quality: "cites concrete code evidence",
		},
		label: true,
		labels: { completeness: true },
		judgeOnlyDimensions: ["evidence_quality"],
		journeyStage: "review",
		endMs: 1,
	}).find((s) => s.attributes["output.value"] !== undefined);

	assert.equal(span.attributes["thulr.criteria.completeness"], "finds all defects");
	assert.equal(span.attributes["thulr.criteria.evidence_quality"], "cites concrete code evidence");
	assert.equal(span.attributes["thulr.label.completeness"], true);
	assert.equal(span.attributes["thulr.judge_only.evidence_quality"], true);
	assert.equal(span.attributes["thulr.journey_stage"], "review");
});

// Without a task the span stays valid: input.value falls back to the case id, and
// none of the optional telemetry attributes appear half-set.
test("traceSpansForCase omits optional telemetry and falls back input.value to the case id", () => {
	const [span] = traceSpansForCase({ name: "c", answer: "a", criterion: "x", endMs: 1 });
	assert.equal(span.attributes["input.value"], "c");
	assert.equal("thulr.cost_usd" in span.attributes, false);
	assert.equal("llm.token_count.total" in span.attributes, false);
	assert.equal("thulr.prompt_version" in span.attributes, false);
});

test("traceSpansForCase preserves zero-valued efficiency metrics", () => {
	const span = traceSpansForCase({ name: "c", answer: "a", criterion: "x", endMs: 1, costUsd: 0, tokensTotal: 0 }).find((s) => s.attributes["output.value"] !== undefined);
	assert.equal(span.attributes["thulr.cost_usd"], 0);
	assert.equal(span.attributes["llm.token_count.total"], 0);
});

// The deterministic label is a boolean (objective pass/fail), not a score — false
// for a failing case so thulr can measure the judge's true-negative rate.
test("traceSpansForCase carries the deterministic label as a boolean", () => {
	const spans = traceSpansForCase({ name: "c", answer: "wrong", criterion: "x", label: false, endMs: 1 });
	const graded = spans.find((s) => s.attributes["output.value"] !== undefined);
	assert.equal(graded.attributes["thulr.deterministic_label"], false);
});

// thulr gate exits 10 on FAIL (a real regression that must block);
// any non-10 exit (PASS/WARN) does not block the harness.
test("gateBlocks is true only for the thulr FAIL exit code (10)", () => {
	assert.equal(gateBlocks(10), true);
	assert.equal(gateBlocks(0), false);
});

// The gate guards BOTH axes: a pass-rate regression (--guardrail) and a mean-SCORE
// regression that holds pass-rate (--score-guardrail, thulr's "Gap 1").
test("gateArgs passes both the pass-rate and mean-score guardrails", () => {
	const args = gateArgs({
		baseline: "base.json",
		candidate: "cand.json",
		guardrails: ["criterion"],
		scoreGuardrails: ["criterion"],
		efficiencyGuardrails: ["cost_usd", "tokens"],
		noiseBand: 0.05,
	});

	assert.deepEqual(args, [
		"gate",
		"--guardrail", "criterion",
		"--score-guardrail", "criterion",
		"--efficiency-guardrail", "cost_usd",
		"--efficiency-guardrail", "tokens",
		"--noise-band", "0.05",
		"base.json", "cand.json",
	]);
});

// `--format junit` replaces the terminal report on stdout with a
// JUnit XML testsuite for CI test ingestion; exit codes are unchanged.
test("gateArgs renders the CI-native JUnit format when asked", () => {
	const args = gateArgs({ baseline: "b.json", candidate: "c.json", format: "junit" });
	assert.deepEqual(args, ["gate", "--format", "junit", "b.json", "c.json"]);
});

test("gateArgs requests the machine-readable JSON report when asked", () => {
	const args = gateArgs({ baseline: "b.json", candidate: "c.json", json: true, guardrails: ["criterion"] });
	assert.deepEqual(args, ["gate", "--json", "--guardrail", "criterion", "b.json", "c.json"]);
});

test("compareArgs builds a non-blocking thulr compare invocation", () => {
	const args = compareArgs({
		baseline: "plain.json",
		candidate: "flows.json",
		json: true,
		guardrails: ["criterion", "completeness"],
		scoreGuardrails: ["criterion"],
		efficiencyGuardrails: ["tokens"],
		noiseBand: 0.1,
		redaction: "auxiliary",
	});
	assert.deepEqual(args, [
		"compare",
		"--json",
		"--guardrail", "criterion",
		"--guardrail", "completeness",
		"--score-guardrail", "criterion",
		"--efficiency-guardrail", "tokens",
		"--noise-band", "0.1",
		"--redaction", "auxiliary",
		"plain.json", "flows.json",
	]);
});

test("duelArgs builds a native pairwise thulr duel invocation", () => {
	const args = duelArgs({
		traceA: "plain.trace.jsonl",
		traceB: "flows.trace.jsonl",
		labelA: "plain",
		labelB: "flows",
		out: "duel.json",
		model: "anthropic/claude-haiku-4-5",
		concurrency: 2,
		evalSet: "set.json",
		json: true,
		judgeBin: "scripts/thulr-judge-pi.sh",
	});

	assert.deepEqual(args, [
		"duel",
		"--json",
		"plain.trace.jsonl", "flows.trace.jsonl",
		"--label-a", "plain",
		"--label-b", "flows",
		"--out", "duel.json",
		"--model", "anthropic/claude-haiku-4-5",
		"--concurrency", "2",
		"--eval-set", "set.json",
		"--judge-bin", "scripts/thulr-judge-pi.sh",
	]);
});

test("formatGateScoreSummary leads with numeric score and efficiency deltas", () => {
	const lines = formatGateScoreSummary({
		comparison: {
			per_dimension: [{
				dimension: "criterion",
				baseline_score_mean: 0.9,
				candidate_score_mean: 0.85,
				score_delta: -0.05,
				baseline_pass_rate: 1,
				candidate_pass_rate: 0.9,
				delta: -0.1,
			}],
			efficiency: {
				deltas: [
					{ metric: "cost_usd", baseline: 0.1, candidate: 0.12, delta: 0.02, relative: 0.2 },
					{ metric: "tokens", baseline: 1000, candidate: 900, delta: -100, relative: -0.1 },
				],
			},
		},
	});

	assert.deepEqual(lines, [
		"criterion: score 0.900 -> 0.850 (Δ-0.050); pass-rate 100.0% -> 90.0% (Δ-10.0pp)",
		"cost_usd: $0.1000 -> $0.1200 (Δ+$0.0200, +20.0%)",
		"tokens: 1000 -> 900 (Δ-100, -10.0%)",
	]);
});

test("gateCandidateForEvalRun excludes calibration canaries and recomputes summary", () => {
	const gateRun = gateCandidateForEvalRun({
		id: "run-1",
		source: { n_cases: 3 },
		summary: [{ dimension: "criterion", n: 3, pass_count: 1, score_mean: 0.5, score_stddev: 0.4 }],
		cases: [
			{ case_id: "behaviour-a", dims: { criterion: { verdict: true, score: 1 } } },
			{ case_id: "hard-b", dims: { criterion: { verdict: true, score: 0.5 } } },
			{ case_id: "calibration-c", dims: { criterion: { verdict: false, score: 0 } } },
		],
	}, { excludeCaseIds: ["calibration-c"] });

	assert.equal(gateRun.id, "run-1-gate");
	assert.equal(gateRun.source.n_cases, 2);
	assert.deepEqual(gateRun.cases.map((c) => c.case_id), ["behaviour-a", "hard-b"]);
	assert.equal(gateRun.summary[0].n, 2);
	assert.equal(gateRun.summary[0].pass_count, 2);
	assert.equal(gateRun.summary[0].score_mean, 0.75);
});

test("sharedGateDimensions keeps only dimensions present in both baseline and candidate", () => {
	const baseline = { summary: [{ dimension: "criterion" }, { dimension: "completeness" }] };
	const candidate = { summary: [{ dimension: "criterion" }, { dimension: "completeness" }, { dimension: "evidence_quality" }] };

	assert.deepEqual(evalRunDimensions(candidate), ["criterion", "completeness", "evidence_quality"]);
	assert.deepEqual(
		sharedGateDimensions(baseline, candidate, ["criterion", "completeness", "evidence_quality"]),
		["criterion", "completeness"],
	);
});

// Judge repeat-sampling: `--samples N` judges each case N times and
// aggregates (majority verdict, mean score). N=1 is the default — no flag emitted,
// byte-identical to single-sample judging.
test("judgeArgs passes --samples only when repeat-sampling is on", () => {
	assert.deepEqual(
		judgeArgs({ trace: "t.jsonl", out: "run.json", model: "anthropic/claude-sonnet-4-6", concurrency: 4, samples: 3, evalSet: "set.json", rate: 2, redaction: "auxiliary", judgeBin: "scripts/thulr-judge-pi.sh" }),
		["judge", "--trace", "t.jsonl", "--out", "run.json", "--model", "anthropic/claude-sonnet-4-6", "--concurrency", "4", "--samples", "3", "--eval-set", "set.json", "--rate", "2", "--redaction", "auxiliary", "--judge-bin", "scripts/thulr-judge-pi.sh"],
	);
	assert.deepEqual(
		judgeArgs({ trace: "t.jsonl", out: "run.json", samples: 1 }),
		["judge", "--trace", "t.jsonl", "--out", "run.json"],
	);
});

test("trace inspection, failure labels, and calibration args match thulr", () => {
	assert.deepEqual(inspectTraceArgs({ trace: "t.jsonl" }), ["inspect-trace", "--trace", "t.jsonl", "--json"]);
	assert.deepEqual(labelFailuresArgs({ trace: "t.jsonl", out: "labels.json" }), ["label-failures", "--trace", "t.jsonl", "--out", "labels.json"]);
	assert.deepEqual(calibrateArgs({ evalRun: "run.json", labels: "labels.json", reviews: "reviews.json" }), ["calibrate", "--labels", "labels.json", "--reviews", "reviews.json", "run.json"]);
});

// `thulr pareto` ranks failure modes across stored traces — free, no judge calls.
test("paretoArgs builds the failure-mode ranking argv", () => {
	assert.deepEqual(
		paretoArgs({ traces: "evals/thulr-trace.jsonl", by: "config-version", limit: 10, json: true }),
		["pareto", "--json", "--traces", "evals/thulr-trace.jsonl", "--by", "config-version", "--limit", "10"],
	);
	assert.deepEqual(paretoArgs(), ["pareto"]);
});

// `thulr review` records one human SME verdict per invocation, or --lists state.
test("reviewArgs records one verdict and lists state", () => {
	assert.deepEqual(
		reviewArgs({ trace: "t.jsonl", caseId: "route-x", verdict: "fail", failureMode: "tool.error", note: "missed it", reviewer: "justin" }),
		["review", "--trace", "t.jsonl", "--case", "route-x", "--verdict", "fail", "--failure-mode", "tool.error", "--note", "missed it", "--reviewer", "justin"],
	);
	assert.deepEqual(reviewArgs({ trace: "t.jsonl", list: true, json: true }), ["review", "--json", "--trace", "t.jsonl", "--list"]);
});

// Multi-dimension criteria ride the trace as thulr.criteria.<dimension> and are
// judged into their own dimensions alongside criterion. Empty values are dropped.
test("traceSpansForCase emits non-empty criteria", () => {
	const spans = traceSpansForCase({
		name: "c",
		answer: "a",
		criterion: "primary",
		endMs: 1,
		criteria: { evidence_quality: "cites the specific code", impact_explanation: "states the production impact", blank: "" },
	});
	const root = spans[0];
	const graded = spans.find((s) => s.attributes["output.value"] !== undefined);
	assert.equal(graded.attributes["thulr.criteria.evidence_quality"], "cites the specific code");
	assert.equal(graded.attributes["thulr.criteria.impact_explanation"], "states the production impact");
	assert.equal("thulr.criteria.blank" in graded.attributes, false, "empty dimension values are skipped");
	assert.equal(root.attributes["thulr.criteria.evidence_quality"], "cites the specific code");
});

test("traceSpansForCase omits criteria attributes when none are given", () => {
	const graded = traceSpansForCase({ name: "c", answer: "a", criterion: "x", endMs: 1 }).find((s) => s.attributes["output.value"] !== undefined);
	assert.equal(Object.keys(graded.attributes).some((k) => k.startsWith("thulr.criteria.")), false);
});
