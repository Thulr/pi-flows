// Bridge between the pi-flows eval harness and the `thulr` CLI — the calibrated,
// local-first LLM eval gate. The harness emits ONE self-contained JSONL trace and
// shells out to thulr for the judge -> calibrate -> gate -> baseline pipeline,
// replacing the harness's old in-process LLM judge + hand-rolled baseline compare.
//
// thulr (0.1.2 contract, docs/trace-contract.md in the thulr repo) ingests a
// SELF-CONTAINED trace. Each case's criterion and its deterministic objective
// label travel INLINE in the span attributes, established from thulr's
// openinference_trace adapter:
//   thulr.case_id            – the case identifier (thulr groups spans by this)
//   thulr.criterion          – the one literal criterion the judge grades against
//   thulr.deterministic_label – the objective pass/fail (boolean) for calibration
//   input.value              – the task text (judge context; falls back to the case id)
//   output.value             – the answer text the judge grades (latest span wins)
//   thulr.cost_usd / llm.token_count.total – per-case spend, summed into the EvalRun
//   thulr.prompt_version     – reproducibility stamp (the pi-flows package version,
//                              since the agent prompts ship with the package)
// plus a numeric `end_time_unix_ms`. So `thulr judge --trace <file>` needs nothing
// else — no --baseline-run, no --cases.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";

const BIN = "thulr";
const spanId = () => randomUUID().replace(/-/g, "");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/thulr-bridge.test.ts)
// ---------------------------------------------------------------------------

/**
 * The self-contained trace span(s) for one eval case. A single AGENT span carries
 * the case id, criterion, objective label, and the answer to grade — everything
 * thulr needs, inline — plus optional task/cost/token/version context that improves
 * judging and lands in the EvalRun's repro metadata (thulr's trace contract calls
 * all of these out). Returned (not written) so the caller controls the file.
 *
 * @param {{name: string, answer: string, criterion: string, label?: boolean, endMs: number, model?: string, task?: string, costUsd?: number, tokensTotal?: number, promptVersion?: string}} input
 * @returns {object[]}
 */
export function traceSpansForCase({ name, answer, criterion, label, endMs, model, task, costUsd, tokensTotal, promptVersion }) {
	const attributes = {
		"openinference.span.kind": "AGENT",
		"thulr.case_id": name,
		"thulr.criterion": criterion,
		"input.value": task || name,
		"output.value": answer,
	};
	if (label !== undefined) attributes["thulr.deterministic_label"] = label;
	if (model) attributes["llm.model_name"] = model;
	if (costUsd) attributes["thulr.cost_usd"] = costUsd;
	if (tokensTotal) attributes["llm.token_count.total"] = tokensTotal;
	if (promptVersion) attributes["thulr.prompt_version"] = promptVersion;
	return [
		{
			trace_id: spanId(),
			span_id: spanId(),
			parent_span_id: null,
			name: `case.${name}`,
			end_time_unix_ms: endMs,
			status: { code: "OK" },
			attributes,
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
 * Build the `thulr judge` argv. `samples > 1` turns on thulr 0.1.2's repeat
 * sampling: each case is judged N times and aggregated per dimension (majority
 * verdict, ties fail safe; mean score), the EvalRun's `score_stddev` becomes the
 * pooled within-case sample variance (i.e. judge noise), and thulr warns on
 * stderr when cases flip verdicts across samples. Costs N× the judge spend.
 *
 * @param {{trace: string, out: string, model?: string, concurrency?: number, samples?: number}} input
 * @returns {string[]}
 */
export function judgeArgs({ trace, out, model, concurrency, samples }) {
	const args = ["judge", "--trace", trace, "--out", out];
	if (model) args.push("--model", model);
	if (concurrency) args.push("--concurrency", String(concurrency));
	if (samples && samples > 1) args.push("--samples", String(samples));
	return args;
}

/**
 * Build the `thulr gate` argv. Two guard axes:
 *   - guardrails (`--guardrail`): a dimension's PASS-RATE regressing fails the gate.
 *   - scoreGuardrails (`--score-guardrail`): a dimension's mean SCORE regressing
 *     fails the gate even if pass-rate holds (thulr's "Gap 1") — catches quality
 *     drift (1.00 -> 0.85) that every verdict still passing would otherwise hide.
 * `format: "junit"` replaces the terminal report on stdout with a JUnit XML
 * testsuite (one testcase per case×dimension) for CI test ingestion; the exit
 * code is unchanged either way.
 *
 * @param {{baseline: string, candidate: string, guardrails?: string[], scoreGuardrails?: string[], noiseBand?: number, format?: "junit"}} input
 * @returns {string[]}
 */
export function gateArgs({ baseline, candidate, guardrails = [], scoreGuardrails = [], noiseBand, format }) {
	const args = ["gate"];
	if (format) args.push("--format", format);
	for (const dim of guardrails) args.push("--guardrail", dim);
	for (const dim of scoreGuardrails) args.push("--score-guardrail", dim);
	if (noiseBand !== undefined) args.push("--noise-band", String(noiseBand));
	args.push(baseline, candidate);
	return args;
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
export function judge({ trace, model, out, concurrency, samples }) {
	const { stdout } = run(judgeArgs({ trace, out, model, concurrency, samples }));
	return { out, report: stdout };
}

/** Print/return the TPR/TNR calibration metrics for an EvalRun. Free. */
export function calibrate(evalRun) {
	return run(["calibrate", evalRun]).stdout;
}

/**
 * Gate a candidate EvalRun against a baseline EvalRun. Free. Returns the exit
 * code (10 = FAIL), whether it blocks, and the report — human-readable by
 * default, a JUnit XML testsuite with `format: "junit"` (for CI test ingestion).
 */
export function gate({ baseline, candidate, guardrails = [], scoreGuardrails = [], noiseBand, format }) {
	const { code, stdout } = run(gateArgs({ baseline, candidate, guardrails, scoreGuardrails, noiseBand, format }), { allowExit: [0, 10] });
	return { exitCode: code, blocks: gateBlocks(code), report: stdout };
}

/** Promote a candidate EvalRun to be the baseline thulr gates against. Free. */
export function promoteBaseline({ input, output }) {
	return run(["baseline", input, output]).stdout;
}
