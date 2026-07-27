// Bridge between the pi-flows eval harness and the `thulr` CLI — the calibrated,
// local-first LLM eval gate. The harness emits one self-contained JSONL trace and
// shells out to thulr for the judge -> calibrate -> gate -> baseline pipeline,
// replacing the harness's old in-process LLM judge + hand-rolled baseline compare.
//
// thulr's trace contract (docs/trace-contract.md in the thulr repo) ingests a
// SELF-CONTAINED trace. Each case's criterion and its deterministic objective
// label travel INLINE in the span attributes, established from thulr's
// openinference_trace adapter:
//   thulr.case_id            – the case identifier (thulr groups spans by this)
//   thulr.criterion          – the one literal criterion the judge grades against
//   thulr.criteria.<dim>     – extra named dimensions, each judged separately
//   thulr.label.<dim>        – optional per-dimension deterministic labels
//   thulr.judge_only.<dim>   – opt a dimension out of deterministic calibration
//   thulr.deterministic_label – the objective pass/fail (boolean) for calibration
//   input.value              – the task text (judge context; falls back to the case id)
//   output.value             – the answer text the judge grades (latest span wins)
//   thulr.expected_behavior  – judge/review context for the intended behavior
//   thulr.failure_modes      – observed/declared failure labels for triage
//   thulr.cost_usd / llm.token_count.total – per-case spend, summed into the EvalRun
//   thulr.prompt_version / thulr.config_version – reproducibility stamps
// plus a numeric `end_time_unix_ms`. So `thulr judge --trace <file>` needs nothing
// else — no --baseline-run, no --cases.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { compareArgs, duelArgs, gateArgs } from "./thulr-compare.mjs";
export { compareArgs, duelArgs, gateArgs } from "./thulr-compare.mjs";

const BIN = "thulr";
const spanId = () => randomUUID().replace(/-/g, "");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/thulr-bridge.test.ts)
// ---------------------------------------------------------------------------

/**
 * The self-contained trace span(s) for one eval case. A root span carries the
 * case context, and a final-answer AGENT span carries the answer to grade plus
 * per-case efficiency metrics. This gives thulr enough trajectory structure for
 * inspect/label workflows while preserving the "latest output.value wins" rule.
 * Returned (not written) so the caller controls the file.
 *
 * @param {{name: string, answer: string, criterion: string, criteria?: Record<string, string>, label?: boolean, labels?: Record<string, boolean>, judgeOnlyDimensions?: string[], journeyStage?: string, endMs: number, model?: string, task?: string, expectedBehavior?: string, failureModes?: string[], costUsd?: number, tokensTotal?: number, promptVersion?: string, configVersion?: string}} input
 * @returns {object[]}
 */
export function traceSpansForCase({ name, baseCaseId, trialId, trialIndex, evalRunId, answer, criterion, criteria, label, labels, judgeOnlyDimensions, journeyStage, endMs, model, task, expectedBehavior, failureModes, costUsd, tokensTotal, promptVersion, configVersion, runtimeTrace, scoreFamilies }) {
	const traceId = spanId();
	const rootSpanId = spanId();
	const answerSpanId = spanId();
	const startMs = Math.max(0, endMs - 1);
	const commonAttributes = {
		"openinference.span.kind": "AGENT",
		"thulr.case_id": name,
		"thulr.criterion": criterion,
		"input.value": task || name,
		"thulr.task.input": task || name,
	};
	if (baseCaseId) commonAttributes["thulr.base_case_id"] = baseCaseId;
	if (trialId) commonAttributes["thulr.trial_id"] = trialId;
	if (trialIndex !== undefined) commonAttributes["thulr.trial_index"] = trialIndex;
	if (evalRunId) commonAttributes["pi_flows.eval_run_id"] = evalRunId;
	if (runtimeTrace) {
		commonAttributes["pi_flows.runtime_trace.health"] = runtimeTrace.health;
		commonAttributes["pi_flows.runtime_trace.file"] = runtimeTrace.traceFile;
		if (runtimeTrace.traceId) commonAttributes["pi_flows.runtime_trace.trace_id"] = runtimeTrace.traceId;
		if (runtimeTrace.rootSpanId) commonAttributes["pi_flows.runtime_trace.root_span_id"] = runtimeTrace.rootSpanId;
		if (runtimeTrace.context?.arm) commonAttributes["pi_flows.runtime_trace.arm"] = runtimeTrace.context.arm;
		if (runtimeTrace.context?.attempt !== undefined) commonAttributes["pi_flows.runtime_trace.attempt"] = runtimeTrace.context.attempt;
		if (runtimeTrace.error) commonAttributes["pi_flows.runtime_trace.error"] = runtimeTrace.error;
	}
	for (const [family, values] of Object.entries(scoreFamilies ?? {})) {
		const familyName = family.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
		for (const [field, value] of Object.entries(values ?? {})) {
			if (value === undefined || value === null || Array.isArray(value) || typeof value === "object") continue;
			commonAttributes[`pi_flows.score.${familyName}.${field}`] = value;
		}
	}
	for (const [dimension, text] of Object.entries(criteria ?? {})) {
		if (text) commonAttributes[`thulr.criteria.${dimension}`] = text;
	}
	if (label !== undefined) commonAttributes["thulr.deterministic_label"] = label;
	for (const [dimension, value] of Object.entries(labels ?? {})) {
		if (value !== undefined) commonAttributes[`thulr.label.${dimension}`] = value;
	}
	for (const dimension of judgeOnlyDimensions ?? []) {
		commonAttributes[`thulr.judge_only.${dimension}`] = true;
	}
	if (journeyStage) commonAttributes["thulr.journey_stage"] = journeyStage;
	if (model) commonAttributes["llm.model_name"] = model;
	if (expectedBehavior) commonAttributes["thulr.expected_behavior"] = expectedBehavior;
	if (failureModes) commonAttributes["thulr.failure_modes"] = failureModes;
	if (promptVersion) commonAttributes["thulr.prompt_version"] = promptVersion;
	if (configVersion) commonAttributes["thulr.config_version"] = configVersion;
	const finalAttributes = { ...commonAttributes, "output.value": answer };
	if (costUsd !== undefined) finalAttributes["thulr.cost_usd"] = costUsd;
	if (tokensTotal !== undefined) finalAttributes["llm.token_count.total"] = tokensTotal;
	return [
		{
			trace_id: traceId,
			span_id: rootSpanId,
			parent_span_id: null,
			name: `case.${name}`,
			start_time_unix_ms: startMs,
			end_time_unix_ms: startMs,
			status: { code: "OK" },
			attributes: commonAttributes,
		},
		{
			trace_id: traceId,
			span_id: answerSpanId,
			parent_span_id: rootSpanId,
			name: `case.${name}.final_answer`,
			start_time_unix_ms: startMs,
			end_time_unix_ms: endMs,
			status: { code: "OK" },
			attributes: finalAttributes,
		},
	];
}

/**
 * Whether a `thulr gate` exit code means a blocking regression.
 * thulr exits 10 on FAIL; PASS/WARN exit 0.
 *
 * @param {number} exitCode
 * @returns {boolean}
 */
export function gateBlocks(exitCode) {
	return exitCode === 10;
}

/**
 * Build the `thulr judge` argv. `samples > 1` turns on thulr 0.3.0's repeat
 * sampling: each case is judged N times and aggregated per dimension (majority
 * verdict, ties fail safe; mean score), the EvalRun's `score_stddev` becomes the
 * pooled within-case sample variance (i.e. judge noise), and thulr warns on
 * stderr when cases flip verdicts across samples. Costs N× the judge spend.
 *
 * @param {{trace: string, out: string, model?: string, concurrency?: number, samples?: number, evalSet?: string, rate?: number, redaction?: "off" | "auxiliary", judgeBin?: string}} input
 * @returns {string[]}
 */
export function judgeArgs({ trace, out, model, concurrency, samples, evalSet, rate, redaction, judgeBin }) {
	const args = ["judge", "--trace", trace, "--out", out];
	if (model) args.push("--model", model);
	if (concurrency) args.push("--concurrency", String(concurrency));
	if (samples && samples > 1) args.push("--samples", String(samples));
	if (evalSet) args.push("--eval-set", evalSet);
	if (rate !== undefined) args.push("--rate", String(rate));
	if (redaction) args.push("--redaction", redaction);
	if (judgeBin) args.push("--judge-bin", judgeBin);
	return args;
}

/** @param {{trace: string}} input */
export function inspectTraceArgs({ trace }) {
	return ["inspect-trace", "--trace", trace, "--json"];
}

/** @param {{trace: string, out?: string}} input */
export function labelFailuresArgs({ trace, out }) {
	const args = ["label-failures", "--trace", trace];
	if (out) args.push("--out", out);
	return args;
}

/** @param {{evalRun: string, labels?: string, reviews?: string}} input */
export function calibrateArgs({ evalRun, labels, reviews }) {
	const args = ["calibrate"];
	if (labels) args.push("--labels", labels);
	if (reviews) args.push("--reviews", reviews);
	args.push(evalRun);
	return args;
}

/**
 * Build the `thulr pareto` argv. FREE corpus-wide failure-mode ranking: which
 * failure on which prompt/config version to fix first, joining deterministic
 * labels, human reviews, and stored EvalRun scores. No judge calls.
 *
 * @param {{traces?: string, by?: "prompt-version" | "config-version", limit?: number, json?: boolean}} input
 * @returns {string[]}
 */
export function paretoArgs({ traces, by, limit, json } = {}) {
	const args = ["pareto"];
	if (json) args.push("--json");
	if (traces) args.push("--traces", traces);
	if (by) args.push("--by", by);
	if (limit !== undefined) args.push("--limit", String(limit));
	return args;
}

/**
 * Build the `thulr review` argv. Records (or `--list`s) a human SME verdict for
 * one trace case into a `thulr.review_set.v1` artifact; `calibrate --reviews`
 * then measures judge-vs-human TPR/TNR on top of the deterministic-label axis.
 * One verdict per invocation.
 *
 * @param {{trace: string, out?: string, list?: boolean, caseId?: string, verdict?: "pass" | "fail" | "unsure", failureMode?: string, note?: string, reviewer?: string, json?: boolean}} input
 * @returns {string[]}
 */
export function reviewArgs({ trace, out, list, caseId, verdict, failureMode, note, reviewer, json }) {
	const args = ["review"];
	if (json) args.push("--json");
	args.push("--trace", trace);
	if (list) args.push("--list");
	if (caseId) args.push("--case", caseId);
	if (verdict) args.push("--verdict", verdict);
	if (failureMode) args.push("--failure-mode", failureMode);
	if (note) args.push("--note", note);
	if (reviewer) args.push("--reviewer", reviewer);
	if (out) args.push("--out", out);
	return args;
}

const fixed = (value, digits) => Number.isFinite(value) ? value.toFixed(digits) : "n/a";
const signedFixed = (value, digits) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(digits)}` : "n/a";
const pct = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
const pctPoints = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp` : "n/a";

function metricValue(metric, value, { signed = false } = {}) {
	if (!Number.isFinite(value)) return "n/a";
	const sign = signed ? value >= 0 ? "+" : "-" : "";
	const abs = Math.abs(value);
	if (metric === "cost_usd") return signed ? `${sign}$${abs.toFixed(4)}` : `$${value.toFixed(4)}`;
	if (metric === "tokens" || metric === "steps" || metric === "tool_errors") return `${sign}${Math.round(abs)}`;
	return `${sign}${fixed(abs, 3)}`;
}

function dimensionDeltaLine(d) {
	const passDelta = d.delta ?? d.pass_rate_delta ?? (d.candidate_pass_rate - d.baseline_pass_rate);
	const scoreDelta = d.score_delta ?? (d.candidate_score_mean - d.baseline_score_mean);
	return `${d.dimension ?? "aggregate"}: score ${fixed(d.baseline_score_mean, 3)} -> ${fixed(d.candidate_score_mean, 3)} (Δ${signedFixed(scoreDelta, 3)}); pass-rate ${pct(d.baseline_pass_rate)} -> ${pct(d.candidate_pass_rate)} (Δ${pctPoints(passDelta)})`;
}

/**
 * Convert `thulr gate --json` output into the summary pi-flows should lead with:
 * numeric score and efficiency deltas, not just PASS/FAIL glyphs.
 *
 * @param {object | string | null | undefined} report
 * @returns {string[]}
 */
export function formatGateScoreSummary(report) {
	const parsed = typeof report === "string" ? JSON.parse(report) : report;
	const comparison = parsed?.comparison;
	if (!comparison) return [];

	const lines = [];
	const dimensions = comparison.per_dimension?.length
		? comparison.per_dimension
		: comparison.aggregate
			? [{ ...comparison.aggregate, dimension: "criterion" }]
			: [];
	for (const d of dimensions) lines.push(dimensionDeltaLine(d));

	for (const d of comparison.efficiency?.deltas ?? []) {
		const relative = Number.isFinite(d.relative) ? `, ${signedFixed(d.relative * 100, 1)}%` : "";
		lines.push(`${d.metric}: ${metricValue(d.metric, d.baseline)} -> ${metricValue(d.metric, d.candidate)} (Δ${metricValue(d.metric, d.delta, { signed: true })}${relative})`);
	}

	return lines;
}

export function evalRunDimensions(evalRun) {
	return (evalRun?.summary ?? [])
		.map((d) => d.dimension)
		.filter((d) => typeof d === "string" && d.length > 0);
}

export function sharedGateDimensions(baselineEvalRun, candidateEvalRun, desired = null) {
	const baseline = new Set(evalRunDimensions(baselineEvalRun));
	const candidate = new Set(evalRunDimensions(candidateEvalRun));
	const requested = desired?.length ? desired : [...candidate];
	return requested.filter((dimension) => baseline.has(dimension) && candidate.has(dimension));
}

function summarizeCases(cases) {
	const dimensions = new Map();
	for (const c of cases) {
		for (const [dimension, result] of Object.entries(c.dims ?? {})) {
			const bucket = dimensions.get(dimension) ?? { dimension, n: 0, pass_count: 0, scores: [] };
			bucket.n += 1;
			if (result?.verdict === true) bucket.pass_count += 1;
			bucket.scores.push(Number(result?.score ?? 0));
			dimensions.set(dimension, bucket);
		}
	}
	return [...dimensions.values()].map((d) => {
		const score_mean = d.scores.reduce((sum, score) => sum + score, 0) / d.scores.length;
		const variance = d.scores.reduce((sum, score) => sum + ((score - score_mean) ** 2), 0) / d.scores.length;
		return {
			dimension: d.dimension,
			n: d.n,
			pass_count: d.pass_count,
			score_mean,
			score_stddev: Math.sqrt(variance),
		};
	});
}

/**
 * Build the EvalRun that should be compared by the release gate. Calibration
 * canaries stay in the full judged EvalRun so `thulr calibrate` can measure TNR,
 * but they are expected-fail rows; putting them in the release pass-rate gate
 * inverts their meaning and makes a better TNR look like a product regression.
 *
 * @param {object} evalRun
 * @param {{excludeCaseIds?: Iterable<string>}} options
 * @returns {object}
 */
export function gateCandidateForEvalRun(evalRun, { excludeCaseIds = [] } = {}) {
	const excluded = new Set(excludeCaseIds);
	const cases = (evalRun.cases ?? []).filter((c) => !excluded.has(c.case_id));
	return {
		...evalRun,
		id: excluded.size ? `${evalRun.id}-gate` : evalRun.id,
		source: evalRun.source ? { ...evalRun.source, n_cases: cases.length } : evalRun.source,
		summary: summarizeCases(cases),
		cases,
	};
}

// ---------------------------------------------------------------------------
// I/O wrappers (exercised by `npm run eval -- --dry-run` and the real run)
// ---------------------------------------------------------------------------

/** True if the `thulr` CLI is installed and on PATH. */
export function available() {
	try {
		execFileSync(BIN, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * `thulr doctor --json` — preflight the gate's environment. Returns the health
 * verdict plus the structured report (version, workspace, judge binary, store).
 * thulr exits 1 when a check fails (e.g. the judge binary is missing), so the
 * harness can gate on `ok` and print thulr's own diagnosis. Free.
 *
 * @returns {{ok: boolean, report: {version?: string, workspace?: string, judge_bin?: string, judge_bin_found?: boolean} | null}}
 */
export function doctor() {
	try {
		const { code, stdout } = run(["doctor", "--json"], { allowExit: [0, 1] });
		let report = null;
		try { report = JSON.parse(stdout); } catch { /* keep report null on unparseable output */ }
		return { ok: code === 0 && report?.healthy !== false, report };
	} catch {
		return { ok: false, report: null };
	}
}

/** Truncate (or create) the trace file so a run starts from an empty trace. */
export function startTrace(traceFile) {
	writeFileSync(traceFile, "", "utf8");
}

/** Append the self-contained span(s) for one case to the trace file. */
export function appendCaseSpans(traceFile, caseSpan) {
	const lines = traceSpansForCase(caseSpan).map((span) => JSON.stringify(span));
	appendFileSync(traceFile, `${lines.join("\n")}\n`, "utf8");
}

// Run the CLI, capturing stdout and the exit code. execFileSync throws on a
// non-zero exit, so codes the caller expects (e.g. gate's FAIL=10) are surfaced
// rather than thrown. Anything outside `allowExit` is a real failure.
function run(args, { allowExit = [0] } = {}) {
	try {
		const stdout = execFileSync(BIN, args, { encoding: "utf8" });
		return { code: 0, stdout };
	} catch (error) {
		const code = typeof error.status === "number" ? error.status : 1;
		const stdout = error.stdout?.toString?.() ?? "";
		const stderr = error.stderr?.toString?.() ?? error.message ?? "";
		if (allowExit.includes(code)) return { code, stdout, stderr };
		throw new Error(`\`${BIN} ${args[0]}\` failed (exit ${code}): ${(stderr || stdout).trim() || "no output"}`);
	}
}

/**
 * Judge a self-contained trace. Writes an EvalRun JSON to `out`. Spends judge-model
 * tokens (× `samples` when repeat-sampling). The criterion and objective label are
 * read inline from the trace. thulr's stderr (excluded-case and flaky-verdict
 * warnings) passes straight through to the terminal.
 */
export function inspectTrace(trace) {
	const stdout = run(inspectTraceArgs({ trace })).stdout;
	return JSON.parse(stdout);
}

export function labelFailures({ trace, out }) {
	const { stdout } = run(labelFailuresArgs({ trace, out }));
	return stdout;
}

export function judge({ trace, model, out, concurrency, samples, evalSet, rate, redaction, judgeBin }) {
	const { stdout } = run(judgeArgs({ trace, out, model, concurrency, samples, evalSet, rate, redaction, judgeBin }));
	return { out, report: stdout };
}

/** Print/return the TPR/TNR calibration metrics for an EvalRun. Free. */
export function calibrate(evalRun, options = {}) {
	return run(calibrateArgs({ evalRun, ...options })).stdout;
}

/** Rank failure modes across stored traces (`thulr pareto`). Free — no judge calls. */
export function pareto(options = {}) {
	const { stdout } = run(paretoArgs(options));
	return options.json ? JSON.parse(stdout) : stdout;
}

/**
 * Record (or `--list`) a human review verdict for a trace case (`thulr review`).
 * Free. Writes a `thulr.review_set.v1` artifact that `calibrate --reviews`
 * consumes as judge-vs-human ground truth.
 */
export function review(options) {
	const { stdout } = run(reviewArgs(options));
	return options.json ? JSON.parse(stdout) : stdout;
}

/**
 * Gate a candidate EvalRun against a baseline EvalRun. Free. Returns the exit
 * code (10 = FAIL), whether it blocks, and the report — human-readable by
 * default, a JUnit XML testsuite with `format: "junit"` (for CI test ingestion).
 */
export function gate({ baseline, candidate, guardrails = [], scoreGuardrails = [], efficiencyGuardrails = [], noiseBand, format, json, redaction }) {
	const { code, stdout } = run(gateArgs({ baseline, candidate, guardrails, scoreGuardrails, efficiencyGuardrails, noiseBand, format, json, redaction }), { allowExit: [0, 10] });
	return { exitCode: code, blocks: gateBlocks(code), report: stdout };
}

export function compare({ baseline, candidate, guardrails = [], scoreGuardrails = [], efficiencyGuardrails = [], noiseBand, json, redaction }) {
	const { code, stdout } = run(compareArgs({ baseline, candidate, guardrails, scoreGuardrails, efficiencyGuardrails, noiseBand, json, redaction }));
	return { exitCode: code, report: stdout };
}

export function duel({ traceA, traceB, labelA, labelB, out, model, concurrency, evalSet, json, judgeBin }) {
	const { code, stdout } = run(duelArgs({ traceA, traceB, labelA, labelB, out, model, concurrency, evalSet, json, judgeBin }));
	return { exitCode: code, report: stdout };
}

/** Promote a candidate EvalRun to be the baseline thulr gates against. Free. */
export function promoteBaseline({ input, output }) {
	return run(["baseline", input, output]).stdout;
}
