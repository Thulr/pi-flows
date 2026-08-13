import { readFileSync } from "node:fs";
import path from "node:path";
import { parseTraceJsonl, summarizeTraceSpans, traceReportIsComplete } from "../extensions/pi-flows/trace-report.ts";
import { sha256Bytes } from "./release-system.mjs";

function resolved(repoRoot, candidate) {
	return typeof candidate === "string" && candidate.length > 0
		? path.resolve(repoRoot, candidate)
		: null;
}

export function validateReleaseRuntimeTrace(traceFile, reliability, { repoRoot = process.cwd() } = {}) {
	const issues = [];
	const expectedFile = resolved(repoRoot, reliability?.runtimeTraceFile);
	const actualFile = path.resolve(traceFile);
	if (!expectedFile) issues.push("reliability artifact does not identify its runtime trace file");
	else if (expectedFile !== actualFile) issues.push("supplied runtime trace file differs from reliability.runtimeTraceFile");

	let rows = [];
	let traceSha256 = null;
	try {
		const bytes = readFileSync(actualFile);
		const raw = bytes.toString("utf8");
		traceSha256 = sha256Bytes(bytes);
		rows = raw
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line, index) => {
				try {
					return JSON.parse(line);
				} catch {
					issues.push(`runtime trace line ${index + 1} is not valid JSON`);
					return null;
				}
			})
			.filter(Boolean);
		const parsed = parseTraceJsonl(raw);
		const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, actualFile);
		if (!traceReportIsComplete(report)) {
			issues.push(`runtime trace structural gate failed: ${report.incompleteTraces} incomplete, ${report.structurallyInvalidTraces} structurally invalid, ${report.parseErrors} parse errors, ${report.duplicateSpans} duplicates, ${report.malformedSpans} malformed`);
		}
	} catch (error) {
		issues.push(`runtime trace could not be read: ${error.message}`);
	}
	if (rows.length === 0) issues.push("runtime trace contains no spans");

	// Duplicates are judged per invocation: a stable trace id is deliberately
	// reusable (a traced refusal and the retry after it share one, #127), so two
	// invocations legitimately write the same root span id under it, each row
	// carrying its own flow.invocation_id stamp. Two rows sharing all three are
	// still corruption. The lookup map prefers the invocation the trial's link
	// names, falling back to the last trace:span row for links (and rows) that
	// predate the stamp.
	const spans = new Map();
	const seenRows = new Set();
	for (const row of rows) {
		const invocation = row.attributes?.["flow.invocation_id"] ?? "";
		const key = `${row.trace_id ?? ""}:${row.span_id ?? ""}`;
		const rowKey = `${key}:${invocation}`;
		if (seenRows.has(rowKey)) issues.push(`runtime trace contains duplicate span ${rowKey}`);
		seenRows.add(rowKey);
		spans.set(key, row);
		if (invocation) spans.set(rowKey, row);
	}

	let matchedTrials = 0;
	const matchedRoots = new Set();
	const matchedTrialIds = new Set();
	for (const entry of reliability?.cases ?? []) {
		for (const trial of entry.trials ?? []) {
			const label = trial.trialId ?? entry.caseId ?? "<unknown>";
			if (matchedTrialIds.has(trial.trialId)) {
				issues.push(`${label} duplicates a reliability trial identity`);
				continue;
			}
			matchedTrialIds.add(trial.trialId);
			const link = trial.runtimeTrace;
			if (link?.health !== "recorded" || !link.traceId || !link.rootSpanId) {
				issues.push(`${label} lacks an exact recorded runtime-trace root link`);
				continue;
			}
			if (resolved(repoRoot, link.traceFile) !== actualFile) issues.push(`${label} points at a different runtime trace file`);
			if (link.context?.runId !== reliability.runId
				|| link.context?.caseId !== entry.caseId
				|| link.context?.trialId !== trial.trialId) {
				issues.push(`${label} runtime-trace context does not match reliability identity`);
			}
			const root = (link.invocationId ? spans.get(`${link.traceId}:${link.rootSpanId}:${link.invocationId}`) : undefined)
				?? spans.get(`${link.traceId}:${link.rootSpanId}`);
			if (!root) {
				issues.push(`${label} linked runtime root span is absent`);
				continue;
			}
			const attributes = root.attributes ?? {};
			if (root.parent_span_id !== null
				|| attributes["flow.run_id"] !== reliability.runId
				|| attributes["flow.case_id"] !== entry.caseId
				|| attributes["flow.trial_id"] !== trial.trialId) {
				issues.push(`${label} linked span is not the matching runtime root`);
				continue;
			}
			const rootKey = `${link.traceId}:${link.rootSpanId}:${link.invocationId ?? ""}`;
			if (matchedRoots.has(rootKey)) {
				issues.push(`${label} reuses another reliability trial's runtime root`);
				continue;
			}
			matchedRoots.add(rootKey);
			matchedTrials += 1;
		}
	}
	const expectedTrials = (reliability?.cases ?? []).reduce((count, entry) => count + (entry.trials?.length ?? 0), 0);
	if (matchedTrials !== expectedTrials) issues.push(`runtime trace matched ${matchedTrials}/${expectedTrials} reliability trials`);
	return { valid: issues.length === 0, issues, matchedTrials, sha256: traceSha256 };
}
