import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateProductionTrace } from "../evals/failure-trace.mjs";
import { validateReleaseRuntimeTrace } from "../evals/release-trace.mjs";
import { sha256File } from "../evals/release-system.mjs";

test("release trace validation rejects a root-only remnant of a larger trace", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-release-trace-"));
	const traceFile = path.join(directory, "runtime.jsonl");
	const trialId = "release-case::trial-001";
	await writeFile(traceFile, `${JSON.stringify({
		trace_id: "trace-1",
		span_id: "root-1",
		parent_span_id: null,
		start_time_unix_ms: 1,
		end_time_unix_ms: 2,
		attributes: {
			"flow.span_role": "root",
			"flow.trace.expected_spans": 2,
			"flow.run_id": "release-run",
			"flow.case_id": "release-case",
			"flow.trial_id": trialId,
		},
	})}\n`, "utf8");
	const reliability = {
		runId: "release-run",
		runtimeTraceFile: traceFile,
		cases: [{ caseId: "release-case", trials: [{
			trialId,
			runtimeTrace: {
				health: "recorded",
				traceFile,
				traceId: "trace-1",
				rootSpanId: "root-1",
				context: { runId: "release-run", caseId: "release-case", trialId },
			},
		}] }],
	};
	const validation = validateReleaseRuntimeTrace(traceFile, reliability);
	assert.equal(validation.valid, false);
	assert.match(validation.issues.join("\n"), /structural gate failed/);
});

test("production failure import rejects a structurally incomplete linked trace", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-production-trace-"));
	const traceFile = path.join(directory, "runtime.jsonl");
	await writeFile(traceFile, `${JSON.stringify({
		trace_id: "trace-7",
		span_id: "root-7",
		parent_span_id: null,
		start_time_unix_ms: 1,
		end_time_unix_ms: 2,
		attributes: {
			"flow.span_role": "root",
			"flow.trace.expected_spans": 2,
			"flow.run_id": "run-7",
			"flow.case_id": "case-7",
			"flow.trial_id": "trial-7",
		},
	})}\n`, "utf8");
	const validation = validateProductionTrace({
		traceFile,
		sha256: sha256File(traceFile),
		traceId: "trace-7",
		rootSpanId: "root-7",
		runId: "run-7",
		caseId: "case-7",
		trialId: "trial-7",
	});
	assert.equal(validation.valid, false);
	assert.match(validation.issues.join("\n"), /structural gate failed/);
});
