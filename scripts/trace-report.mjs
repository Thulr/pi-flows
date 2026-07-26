#!/usr/bin/env node
// Source-repo wrapper around the extension's canonical trace parser/formatter.
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatTraceReport, parseTraceJsonl, summarizeTraceSpans } from "../extensions/pi-flows/trace.ts";

const traceFile = path.resolve(process.cwd(), process.argv[2] ?? process.env.PI_FLOWS_TRACE_FILE ?? "flow-trace.jsonl");
try {
	const parsed = parseTraceJsonl(readFileSync(traceFile, "utf8"));
	console.log(formatTraceReport(summarizeTraceSpans(parsed.spans, parsed.parseErrors, traceFile)));
} catch (error) {
	console.error(`Could not read flow trace report: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
