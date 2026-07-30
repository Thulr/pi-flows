import { emptyUsage, flowError, type FlowError, type FlowMode, type FlowRunResult, type FlowTraceLink, type ModeOutput, type UsageStats } from "./types.ts";
import { isFailed } from "./sanitize.ts";
import { parseVerdict } from "./parse.ts";
import { debateRounds, searchTopology, successfulRuns } from "./topology.ts";
import { integrationControlText } from "./delegation.ts";
import { formatTokens } from "./trace-report.ts";

// trace.ts is the trace facade: sink, report, and the root-span summary all
// reach consumers from here, while the implementations live in focused modules.
export { makeTraceSink, stableTraceIds, type TraceSink } from "./trace-sink.ts";
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

function runDuration(result: FlowRunResult | undefined): number {
	return Math.max(0, result?.durationMs ?? 0);
}

function fanoutThenTailCriticalPath(results: FlowRunResult[], fanoutCount: number): number {
	const fanout = results.slice(0, Math.max(0, fanoutCount));
	const tail = results.slice(fanout.length);
	return Math.max(0, ...fanout.map(runDuration)) + tail.reduce((sum, result) => sum + runDuration(result), 0);
}

function graphCriticalPath(params: any, results: FlowRunResult[]): number | undefined {
	const nodes = Array.isArray(params.graph?.nodes) ? params.graph.nodes : [];
	if (nodes.length === 0 || results.length < nodes.length) return undefined;
	const remaining = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
	const completed = new Set<string>();
	const pathById = new Map<string, number>();
	let resultIndex = 0;
	while (remaining.size > 0 && resultIndex < Math.min(nodes.length, results.length)) {
		const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dependency: string) => completed.has(dependency)));
		if (ready.length === 0) return undefined;
		for (const node of ready) {
			const dependencyPath = Math.max(0, ...(node.dependsOn ?? []).map((dependency: string) => pathById.get(dependency) ?? 0));
			pathById.set(node.id, dependencyPath + runDuration(results[resultIndex]));
			resultIndex += 1;
			remaining.delete(node.id);
		}
		for (const node of ready) completed.add(node.id);
	}
	const nodePath = Math.max(0, ...pathById.values());
	return nodePath + results.slice(resultIndex).reduce((sum, result) => sum + runDuration(result), 0);
}

function debateCriticalPath(params: any, results: FlowRunResult[]): number | undefined {
	const participantCount = Array.isArray(params.debate?.participants) ? params.debate.participants.length : 0;
	const rounds = debateRounds(params.debate);
	if (participantCount < 2 || results.length !== participantCount * rounds + 1) return undefined;
	let path = runDuration(results.at(-1));
	for (let round = 0; round < rounds; round += 1) {
		path += Math.max(...results.slice(round * participantCount, (round + 1) * participantCount).map(runDuration));
	}
	return path;
}

function searchCriticalPath(params: any, results: FlowRunResult[]): number | undefined {
	const { candidateCount: candidates, rounds } = searchTopology(params.search);
	let offset = 0;
	let path = 0;
	for (let round = 0; round < rounds; round += 1) {
		const generated = results.slice(offset, offset + candidates);
		if (generated.length !== candidates) return undefined;
		path += Math.max(...generated.map(runDuration));
		offset += candidates;
		const scoredCount = successfulRuns(generated).length;
		const scored = results.slice(offset, offset + scoredCount);
		if (scoredCount === 0 || scored.length !== scoredCount) return undefined;
		path += Math.max(...scored.map(runDuration));
		offset += scoredCount;
	}
	return results.length === offset + 1 ? path + runDuration(results[offset]) : undefined;
}

export function criticalPathForMode(mode: FlowMode, params: any, results: FlowRunResult[]): number | undefined {
	if (results.length === 0) return undefined;
	if (mode === "parallel") return Math.max(...results.map(runDuration));
	if (["single", "chain", "route", "loop", "workflow"].includes(mode)) return results.reduce((sum, result) => sum + runDuration(result), 0);
	if (mode === "evaluate") {
		if (typeof params.evaluate?.checkCommand === "string" && params.evaluate.checkCommand.trim()) return undefined;
		return !Array.isArray(params.evaluate?.redteam) || params.evaluate.redteam.length <= 1 ? results.reduce((sum, result) => sum + runDuration(result), 0) : undefined;
	}
	if (mode === "graph") return graphCriticalPath(params, results);
	if (mode === "debate") return debateCriticalPath(params, results);
	if (mode === "search") return searchCriticalPath(params, results);
	if (mode === "vote") {
		const voterCount = Array.isArray(params.vote?.voters) && params.vote.voters.length > 0 ? params.vote.voters.length : Math.floor(params.vote?.count ?? 3);
		return voterCount > 0 ? fanoutThenTailCriticalPath(results, voterCount) : undefined;
	}
	if (mode === "dossier") {
		const sectionCount = Array.isArray(params.dossier?.sections) ? params.dossier.sections.length : 0;
		return sectionCount > 0 ? fanoutThenTailCriticalPath(results, sectionCount) : undefined;
	}
	if (mode === "worktree") {
		const workerCount = Array.isArray(params.worktree?.tasks) ? params.worktree.tasks.length : 0;
		return workerCount > 0 ? fanoutThenTailCriticalPath(results, workerCount) : undefined;
	}
	return undefined;
}

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

export function traceSummaryAttributes(mode: FlowMode, params: any, output: ModeOutput): Record<string, unknown> {
	const results = output.details.results.filter((result) => result.exitCode !== -1);
	const usage = flowUsageTotals(results);
	const failed = results.filter(isFailed);
	const workerTimeMs = results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0);
	const criticalPathMs = criticalPathForMode(mode, params, results);
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
	if (link.health === "recorded") return null;
	const spans = link.spans;
	const counts = spans ? `${spans.observedSpans}/${spans.expectedSpans} spans observed, ${spans.droppedSpans} dropped, ${spans.failedExports} failed export(s)` : "span accounting unavailable";
	return `trace ${link.traceId} is ${link.health} (${counts})${link.error ? `: ${link.error}` : ""}`;
}

/**
 * The strict-mode refusal, in one place so the dispatch core and anything that
 * models it (the fault-injection suite) cannot drift apart. Returns null when
 * strict mode is off or the evidence is complete.
 */
export function strictTraceError(link: FlowTraceLink | undefined, strict: boolean): FlowError | null {
	if (!strict) return null;
	const issue = traceEvidenceIssue(link);
	if (!issue) return null;
	return flowError(
		"TRACE_INCOMPLETE",
		"Flow completed but its coordination trace is incomplete, and strict tracing is on.",
		`${issue}. Under traceStrict the run cannot be reported as evidence-backed.`,
		"Check that the trace path is writable and has space, then rerun. This gate sees what the exporter failed to write; for spans lost after a successful write, read the file back with `npm run trace:report -- --strict`. Set traceStrict:false to accept best-effort tracing.",
	);
}
