import { readFileSync } from "node:fs";
import path from "node:path";
import { parseTraceJsonl, summarizeTraceSpans, traceReportIsComplete } from "../extensions/pi-flows/trace-report.ts";
import { sha256Bytes } from "./release-system.mjs";

export function validateProductionTrace(traceLink, { baseDir = process.cwd() } = {}) {
	const issues = [];
	const traceFile = typeof traceLink?.traceFile === "string" ? path.resolve(baseDir, traceLink.traceFile) : null;
	if (!traceFile) issues.push("production trace link does not identify a trace file");
	if (!/^[a-f0-9]{64}$/.test(traceLink?.sha256 ?? "")) issues.push("production trace link sha256 must be a full lowercase SHA-256 digest");

	let actualSha256 = null;
	let rows = [];
	if (traceFile) {
		try {
			const bytes = readFileSync(traceFile);
			const raw = bytes.toString("utf8");
			actualSha256 = sha256Bytes(bytes);
			if (actualSha256 !== traceLink.sha256) issues.push("production trace file sha256 does not match the validated failure link");
			rows = raw
				.split(/\r?\n/)
				.filter((line) => line.trim())
				.map((line, index) => {
					try {
						return JSON.parse(line);
					} catch {
						issues.push(`production trace line ${index + 1} is not valid JSON`);
						return null;
					}
				})
				.filter(Boolean);
			const parsed = parseTraceJsonl(raw);
			const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, traceFile);
			if (!traceReportIsComplete(report)) {
				issues.push(`production trace structural gate failed: ${report.incompleteTraces} incomplete, ${report.structurallyInvalidTraces} structurally invalid, ${report.parseErrors} parse errors, ${report.duplicateSpans} duplicates, ${report.malformedSpans} malformed`);
			}
		} catch (error) {
			issues.push(`production trace could not be read: ${error.message}`);
		}
	}
	const roots = rows.filter((row) => row.trace_id === traceLink?.traceId && row.span_id === traceLink?.rootSpanId);
	const root = roots[0];
	if (roots.length > 1) issues.push("production trace contains duplicate linked root spans");
	if (!root) {
		issues.push("production trace root span is absent");
	} else {
		const attributes = root.attributes ?? {};
		if (root.parent_span_id !== null
			|| attributes["flow.run_id"] !== traceLink.runId
			|| attributes["flow.case_id"] !== traceLink.caseId
			|| attributes["flow.trial_id"] !== traceLink.trialId) {
			issues.push("production trace root identity does not match the validated failure link");
		}
	}
	return {
		valid: issues.length === 0,
		issues,
		sha256: actualSha256,
		traceId: root?.trace_id ?? null,
		rootSpanId: root?.span_id ?? null,
	};
}
