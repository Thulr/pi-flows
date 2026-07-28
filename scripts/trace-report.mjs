#!/usr/bin/env node
// Source-repo wrapper around the extension's canonical trace parser/formatter.
//
// Usage:
//   npm run trace:report -- flow-trace.jsonl
//   npm run trace:report -- --strict flow-trace.jsonl   # exit 1 on incomplete evidence
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatTraceReport, parseTraceJsonl, summarizeTraceSpans, traceReportIsComplete } from "../extensions/pi-flows/trace.ts";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const target = args.find((arg) => !arg.startsWith("--"));
const traceFile = path.resolve(process.cwd(), target ?? process.env.PI_FLOWS_TRACE_FILE ?? "flow-trace.jsonl");
try {
	const parsed = parseTraceJsonl(readFileSync(traceFile, "utf8"));
	const report = summarizeTraceSpans(parsed.spans, parsed.parseErrors, traceFile);
	console.log(formatTraceReport(report));
	if (strict && !traceReportIsComplete(report)) {
		console.error(`✗ Trace evidence is incomplete: ${report.incompleteTraces} of ${report.traces} run(s) lost spans and ${report.parseErrors} line(s) failed to parse. Strict mode treats that as a gate failure.`);
		process.exit(1);
	}
} catch (error) {
	console.error(`Could not read flow trace report: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
