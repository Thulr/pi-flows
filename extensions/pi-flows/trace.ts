import { emptyUsage, flowError, type CoordinationEventKind, type FlowError, type FlowMode, type FlowRunResult, type FlowTraceLink, type ModeOutput, type UsageStats } from "./types.ts";
import { runSettled } from "./run.ts";
import { isFailed } from "./sanitize.ts";
import { parseVerdict } from "./parse.ts";
import { integrationControlText } from "./delegation.ts";
import { formatTokens } from "./trace-report.ts";

// trace.ts is the trace facade: sink, report, and the root-span summary all
// reach consumers from here, while the implementations live in focused modules.
export { makeTraceSink, stableTraceIds, type TraceSink } from "./trace-sink.ts";
export { traceHealthStatus } from "./trace-scope.ts";
export {
	addTraceBucket,
	boolAttr,
	emptyTraceBucket,
	formatRate,
	formatTokens,
	formatTpso,
	formatTraceReport,
	numericAttr,
	optionalBoolAttr,
	optionalNumericAttr,
	parseTraceJsonl,
	stringAttr,
	summarizeTraceSpans,
	traceReportIsComplete,
	type TraceReport,
	type TraceReportBucket,
	type TraceSpanRecord,
} from "./trace-report.ts";

export function formatUsage(usage: UsageStats, model?: string, durationMs?: number): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (durationMs !== undefined) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function flowUsageTotals(results: FlowRunResult[]): UsageStats {
	const total = emptyUsage();
	for (const result of results) {
		total.input += result.usage.input || 0;
		total.output += result.usage.output || 0;
		total.cacheRead += result.usage.cacheRead || 0;
		total.cacheWrite += result.usage.cacheWrite || 0;
		total.cost += result.usage.cost || 0;
		total.contextTokens += result.usage.contextTokens || 0;
		total.turns += result.usage.turns || 0;
	}
	return total;
}

/**
 * Resolves a settled flow's critical path from its mode's declared
 * arithmetic. The per-mode arithmetic lives beside each handler and is wired
 * through the mode table (modes/contract.ts: criticalPathForMode) — mode
 * topology is Supporting, and Core may not import it, so trace summaries
 * receive this resolver as an argument from the composition root instead.
 */
export type CriticalPathResolver = (mode: FlowMode, params: any, results: FlowRunResult[]) => number | undefined;

/**
 * Resolves which coordination-event kinds a mode's handler records by its own
 * hand. The per-mode declaration lives beside each handler and is wired
 * through the mode table (modes/contract.ts: owedEventKindsForMode) — mode
 * topology is Supporting, and Core may not import it, so the trace sink
 * receives this resolver's answer from the composition root instead.
 * Undefined means no declaration (a non-run surface, or a barebones caller),
 * and the trace stays exempt from the owed-kinds read-back.
 */
export type OwedEventKindsResolver = (mode: FlowMode) => readonly CoordinationEventKind[] | undefined;

function acceptedVerifierResult(params: any, output: ModeOutput): FlowRunResult | undefined {
	if (!params.orchestrate?.verify?.agent) return undefined;
	const verifier = output.details.results.at(-1);
	return verifier
		&& verifier.agent === params.orchestrate.verify.agent
		&& !isFailed(verifier)
		&& verifier.handoff
		? verifier
		: undefined;
}

function verifiedOutcome(mode: FlowMode, params: any, output: ModeOutput): { verified: boolean; success?: boolean } {
	const text = output.content[0]?.type === "text" ? output.content[0].text : "";
	if (mode === "evaluate") {
		if (/^Flow evaluate: PASS\b/.test(text)) return { verified: true, success: true };
		if (/^Flow evaluate: did not pass\b/.test(text)) return { verified: true, success: false };
	}
	if (mode === "orchestrate" && params.orchestrate?.verify?.agent) {
		const verifier = acceptedVerifierResult(params, output);
		if (verifier) {
			return { verified: true, success: parseVerdict(integrationControlText(verifier)) === "pass" };
		}
	}
	return { verified: false };
}

/** Refusals that mean "a human decision stopped this run" — surfaced on the trace so an audit can tell a blocked flow from a failed one. */
const APPROVAL_BLOCKING_CODES = new Set<string>([
	"WORKFLOW_APPROVAL_REQUIRED",
	"WORKFLOW_APPROVAL_DENIED",
	"CHECKPOINT_APPROVAL_REQUIRED",
	"CHECKPOINT_APPROVAL_DENIED",
	"PROJECT_AGENT_APPROVAL_REQUIRED",
	"PROJECT_AGENT_APPROVAL_DENIED",
	"APPROVAL_RECEIPT_INVALID",
	"APPROVAL_RECEIPT_STALE",
	"APPROVAL_RECEIPT_EXPIRED",
	"APPROVAL_RECEIPT_CONSUMED",
]);

/** Root-span summary attributes. `criticalPath` is the mode table's resolver, supplied where the table is reachable (the composition root); without it the metric reports unavailable. */
export function traceSummaryAttributes(mode: FlowMode, params: any, output: ModeOutput, criticalPath?: CriticalPathResolver): Record<string, unknown> {
	const results = output.details.results.filter(runSettled);
	const usage = flowUsageTotals(results);
	const failed = results.filter(isFailed);
	const workerTimeMs = results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0);
	const criticalPathMs = criticalPath?.(mode, params, results);
	const outcome = verifiedOutcome(mode, params, output);
	const attrs: Record<string, unknown> = {
		"flow.child_count": results.length,
		"flow.failed_child_count": failed.length,
		"flow.cost_usd_total": usage.cost,
		"flow.token_count_total": usage.input + usage.output,
		"flow.worker_time_ms": workerTimeMs,
		"flow.critical_path_available": criticalPathMs !== undefined,
		"flow.outcome_verified": outcome.verified,
		"flow.budget_exceeded": results.some((result) => result.error?.code === "BUDGET_EXCEEDED") || output.details.error?.code === "BUDGET_EXCEEDED",
	};
	if (criticalPathMs !== undefined) attrs["flow.critical_path_ms"] = criticalPathMs;
	if (outcome.success !== undefined) attrs["flow.outcome_success"] = outcome.success;
	// Approval identity and status, never the parameters an approval was granted
	// for — those stay inside the receipt's binding digest.
	const approvals = output.details.approvals ?? [];
	if (approvals.length) {
		attrs["flow.approval_receipt_count"] = approvals.length;
		attrs["flow.approval_receipt_ids"] = approvals.map((receipt) => receipt.receiptId).join(",");
		attrs["flow.approval_consumed_count"] = approvals.filter((receipt) => receipt.status === "consumed").length;
	}
	if (APPROVAL_BLOCKING_CODES.has(output.details.error?.code as string)) attrs["flow.approval_blocked"] = output.details.error!.code;
	if (mode === "vote") {
		const voterCount = Array.isArray(params.vote?.voters) && params.vote.voters.length > 0 ? params.vote.voters.length : Number.isFinite(params.vote?.count) ? Math.floor(params.vote.count) : results.length;
		const voters = results.slice(0, Math.max(0, voterCount));
		const models = new Set(voters.map((result) => result.model ?? "(default)"));
		attrs["flow.same_model_vote_warning"] = voters.length >= 2 && models.size <= 1;
	}
	if (mode === "route") {
		const routeChoice = results[1]?.agent;
		if (routeChoice) attrs["flow.route_choice"] = routeChoice;
	}
	if (mode === "orchestrate" && params.orchestrate?.verify) {
		const verifier = acceptedVerifierResult(params, output);
		if (verifier) attrs["flow.verify_verdict"] = parseVerdict(integrationControlText(verifier));
	}
	return attrs;
}

/**
 * Strict mode: an evaluation or release run must not treat an incomplete trace
 * as evidence. Default user flows stay best-effort — this only fires when a
 * caller explicitly asked for trace evidence to be a gate.
 */
export function traceEvidenceIssue(link: FlowTraceLink | undefined): string | null {
	if (!link) return "no trace file was configured, so the run produced no coordination evidence";
	if (link.health !== "recorded") {
		const spans = link.spans;
		const counts = spans ? `${spans.observedSpans}/${spans.expectedSpans} spans observed, ${spans.droppedSpans} dropped, ${spans.failedExports} failed export(s)` : "span accounting unavailable";
		return `trace ${link.traceId} is ${link.health} (${counts})${link.error ? `: ${link.error}` : ""}`;
	}
	// Complete by the writer's count and still not a span tree: health is what
	// the exporter knew while writing, so a strict run that asked for the file to
	// be read back is refused on what the reading found, not on the count.
	if (link.structure && !link.structure.valid) {
		return `trace ${link.traceId} exported completely but is not a readable span tree: ${link.structure.issue ?? "structure invalid"}`;
	}
	return null;
}

/**
 * The strict-mode refusal, in one place so the dispatch core and anything that
 * models it (the fault-injection suite) cannot drift apart. Returns null when
 * strict mode is off or the evidence is complete.
 */
/** The strict-mode refusal for a run that could never have produced evidence at all. */
export function strictTraceConfigError(strict: boolean, traceFile: string | undefined): FlowError | null {
	if (!strict || traceFile) return null;
	return flowError(
		"TRACE_INCOMPLETE",
		"Flow call refused: strict tracing is on but no trace file is configured.",
		"traceStrict (or PI_FLOWS_TRACE_STRICT) requires coordination evidence, and nothing would have been exported.",
		"Set traceFile (or PI_FLOWS_TRACE_FILE) to a writable JSONL path, or turn strict tracing off for ordinary best-effort runs.",
	);
}

export function strictTraceError(link: FlowTraceLink | undefined, strict: boolean): FlowError | null {
	if (!strict) return null;
	// The gate enforces the contract it documents instead of trusting the wiring
	// that upholds it: absent structure means unverified, and a strict run may
	// not certify what nothing read back. The wired path always verifies
	// (flow.ts passes verify: traceStrict), so this arm is reachable only by a
	// caller pairing strict with an unverifying sink — the pairing it exists to refuse.
	const issue = traceEvidenceIssue(link)
		?? (link && !link.structure ? `trace ${link.traceId} was never read back: an absent structural verdict is unverified evidence, not verified` : null);
	if (!issue) return null;
	return flowError(
		"TRACE_INCOMPLETE",
		"Flow completed but its coordination trace is incomplete, and strict tracing is on.",
		`${issue}. Under traceStrict the run cannot be reported as evidence-backed.`,
		"Check that the trace path is writable and has space, then rerun. This gate sees both what the exporter failed to write and what reading the finished file back proves about its shape; `npm run trace:report -- --strict` runs the same validator over a trace you still have, reading its expectation off the root span rather than from the run that wrote it. Set traceStrict:false to accept best-effort tracing.",
	);
}
