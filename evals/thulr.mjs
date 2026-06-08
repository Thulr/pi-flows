// Bridge between the pi-flows eval harness and the `thulr-evaluator` CLI — the
// calibrated, local-first LLM eval gate. The harness produces three artifacts
// thulr reads (a JSONL trace, the objectiveScore labels, the cases manifest) and
// this module shells out to thulr for the judge -> calibrate -> gate -> baseline
// pipeline, replacing the harness's old in-process LLM judge + hand-rolled
// baseline comparison.
//
// The trace contract here was established EMPIRICALLY (see the probes documented
// in evals/README.md), not assumed:
//   1. thulr grades the LAST `AGENT` span's `output.value` for each
//      `flow.trace_label`. It ignores the CHAIN root span.
//   2. every span must carry numeric `start_time_unix_ms` / `end_time_unix_ms`
//      or the line is rejected as malformed.
// So each case emits exactly ONE AGENT span carrying the canonical final answer
// (the same text the objective scorer graded) — no dependence on a flow's
// internal multi-span structure, which would otherwise mis-grade vote/evaluate.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";

const BIN = "thulr-evaluator";
const spanId = () => randomUUID().replace(/-/g, "");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/thulr-bridge.test.ts)
// ---------------------------------------------------------------------------

/**
 * The trace spans for one eval case: a CHAIN root plus a single AGENT child whose
 * `output.value` is the answer thulr will grade. Returned (not written) so the
 * caller controls the trace file; see appendCaseSpans for the I/O wrapper.
 *
 * @param {{name: string, answer: string, startMs: number, endMs: number}} input
 * @returns {object[]} OpenInference-shaped spans, root first then the AGENT child.
 */
export function traceSpansForCase({ name, answer, startMs, endMs }) {
	const traceId = spanId();
	const rootId = spanId();
	const base = (kind) => ({
		"openinference.span.kind": kind,
		"flow.mode": "single",
		"flow.trace_label": name,
	});
	return [
		{
			trace_id: traceId,
			span_id: rootId,
			parent_span_id: null,
			name: "flow.single",
			start_time_unix_ms: startMs,
			end_time_unix_ms: endMs,
			status: { code: "OK" },
			attributes: base("CHAIN"),
		},
		{
			trace_id: traceId,
			span_id: spanId(),
			parent_span_id: rootId,
			name: "flow.single.eval",
			start_time_unix_ms: startMs,
			end_time_unix_ms: endMs,
			status: { code: "OK" },
			attributes: { ...base("AGENT"), "input.value": name, "output.value": answer },
		},
	];
}

/**
 * The `--baseline-run` payload: the deterministic objectiveScore labels thulr
 * calibrates the judge against. Pass through the per-case rows (each needs at
 * least `name` and `objectiveScore`).
 *
 * @param {{model: string, cases: object[]}} input
 */
export function buildLabels({ model, cases }) {
	return { createdAt: new Date().toISOString(), model, cases };
}

/**
 * Whether a `thulr-evaluator gate` exit code means a blocking regression.
 * thulr exits 10 on FAIL; PASS/WARN exit 0.
 *
 * @param {number} exitCode
 * @returns {boolean}
 */
export function gateBlocks(exitCode) {
	return exitCode === 10;
}

// ---------------------------------------------------------------------------
// I/O wrappers (exercised by `npm run eval -- --dry-run` and the real run)
// ---------------------------------------------------------------------------

/** True if the `thulr-evaluator` CLI is installed and on PATH. */
export function available() {
	try {
		execFileSync(BIN, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Truncate (or create) the trace file so a run starts from an empty trace. */
export function startTrace(traceFile) {
	writeFileSync(traceFile, "", "utf8");
}

/** Append the spans for one case (one JSON object per line) to the trace file. */
export function appendCaseSpans(traceFile, { name, answer, startMs, endMs }) {
	const lines = traceSpansForCase({ name, answer, startMs, endMs }).map((span) => JSON.stringify(span));
	appendFileSync(traceFile, `${lines.join("\n")}\n`, "utf8");
}

/** Write the objectiveScore labels (the `--baseline-run` file). */
export function writeLabels(path, { model, cases }) {
	writeFileSync(path, `${JSON.stringify(buildLabels({ model, cases }), null, 2)}\n`, "utf8");
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
 * Judge a trace against its cases, calibrated by the objectiveScore labels.
 * Writes an EvalRun JSON to `out`. Spends judge-model tokens.
 */
export function judge({ trace, labels, cases, model, out, concurrency }) {
	const args = ["judge", "--trace", trace, "--baseline-run", labels, "--cases", cases, "--out", out];
	if (model) args.push("--model", model);
	if (concurrency) args.push("--concurrency", String(concurrency));
	const { stdout } = run(args);
	return { out, report: stdout };
}

/** Print/return the TPR/TNR calibration metrics for an EvalRun. Free. */
export function calibrate(evalRun) {
	return run(["calibrate", evalRun]).stdout;
}

/**
 * Gate a candidate EvalRun against a baseline EvalRun. Free. Returns the exit
 * code (10 = FAIL), whether it blocks, and the human-readable report.
 */
export function gate({ baseline, candidate, guardrails = [], noiseBand }) {
	const args = ["gate"];
	for (const dim of guardrails) args.push("--guardrail", dim);
	if (noiseBand !== undefined) args.push("--noise-band", String(noiseBand));
	args.push(baseline, candidate);
	const { code, stdout } = run(args, { allowExit: [0, 10] });
	return { exitCode: code, blocks: gateBlocks(code), report: stdout };
}

/** Promote a candidate EvalRun to be the baseline thulr gates against. Free. */
export function promoteBaseline({ input, output }) {
	return run(["baseline", input, output]).stdout;
}
