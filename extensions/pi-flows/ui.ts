import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_FLOWS_VERSION, flowError, type AgentScope, type FlowDetails, type FlowError, type FlowMode, type RecordEvent } from "./types.ts";
import { isFailed, sanitizeText } from "./sanitize.ts";
import { flowUsageTotals, formatTokens, formatUsage } from "./trace.ts";

export function flowStatusText(details: FlowDetails): string {
	const total = details.results.length;
	const done = details.results.filter((result) => result.exitCode !== -1).length;
	const failed = details.results.filter((result) => result.exitCode !== -1 && isFailed(result)).length;
	const usage = flowUsageTotals(details.results.filter((result) => result.exitCode !== -1));
	const state = details.error ? `error:${details.error.code}` : done < total ? `${done}/${total}` : failed ? `${failed} failed` : "ok";
	const cost = usage.cost ? ` $${usage.cost.toFixed(4)}` : "";
	const tokens = usage.input || usage.output ? ` ${formatTokens(usage.input + usage.output)} tok` : "";
	return `flow ${details.mode}: ${state}${cost}${tokens}`;
}

export function flowWidgetLines(details: FlowDetails): string[] {
	const lines = [flowStatusText(details)];
	for (const result of details.results.slice(0, 6)) {
		const status = result.exitCode === -1 ? "running" : isFailed(result) ? `failed${result.error?.code ? `:${result.error.code}` : ""}` : "ok";
		const usage = formatUsage(result.usage, result.model, result.durationMs);
		lines.push(`${status.padEnd(18)} ${result.agent}${usage ? `  ${usage}` : ""}`);
	}
	if (details.results.length > 6) lines.push(`... +${details.results.length - 6} more`);
	if (details.error) lines.push(`error: ${details.error.message}`);
	return lines;
}

export function updateFlowUi(ctx: any, details: FlowDetails | undefined): void {
	if (!details) return;
	ctx.ui?.setStatus?.("pi-flows", flowStatusText(details));
	ctx.ui?.setWidget?.("pi-flows", flowWidgetLines(details), { placement: "aboveEditor" });
}

export function appendFlowSessionEntry(pi: ExtensionAPI, details: FlowDetails): void {
	pi.appendEntry?.("pi-flows.run", {
		version: details.version,
		mode: details.mode,
		status: details.error ? "error" : details.results.some((result) => result.exitCode !== -1 && isFailed(result)) ? "partial" : "ok",
		errorCode: details.error?.code,
		results: details.results.map((result) => ({
			agent: result.agent,
			agentSource: result.agentSource,
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorCode: result.error?.code,
			model: result.model,
			durationMs: result.durationMs,
			usage: result.usage,
		})),
	});
}

/**
 * A human checkpoint, recorded on the trace like any other approval.
 *
 * `recordEvent` is not optional decoration: a checkpoint that is *approved*
 * changes nothing else about the run, so without the event a successful human
 * gate leaves no evidence it was ever asked for.
 */
export async function checkpointApproval(params: any, ctx: any, mode: FlowMode, when: "spawn" | "finalize", preview?: string, recordEvent?: RecordEvent): Promise<FlowError | null> {
	const checkpoint = params.checkpoint;
	if (!checkpoint) return null;
	const target = checkpoint.before ?? "spawn";
	if (target !== when) return null;
	const record = (decision: "approved" | "required" | "denied") => recordEvent?.({
		kind: "approval",
		name: `checkpoint.${when}`,
		ok: decision === "approved",
		scope: { key: `checkpoint.${when}` },
		attributes: { "flow.approval.decision": decision, "flow.approval.when": when, "flow.approval.interactive": ctx.hasUI === true },
	});
	const message = checkpoint.message ?? (when === "spawn" ? `Run flow mode "${mode}" now?` : `Return the final result from flow mode "${mode}"?`);
	if (!ctx.hasUI) {
		record("required");
		return flowError(
			"CHECKPOINT_APPROVAL_REQUIRED",
			`Human checkpoint required before ${when}.`,
			`This flow requested checkpoint.before="${when}", but the current context has no UI to collect approval.`,
			"Run in an interactive UI, remove the checkpoint, or choose a non-interactive gate such as checkCommand.",
		);
	}
	const ok = await ctx.ui.confirm(
		when === "spawn" ? "Approve flow run?" : "Approve final flow result?",
		preview ? `${message}\n\n${sanitizeText(preview, { recordContent: true, redactSecrets: true }, 2048)}` : message,
	);
	if (!ok) {
		record("denied");
		return flowError(
			"CHECKPOINT_APPROVAL_DENIED",
			`Human checkpoint denied before ${when}.`,
			"The interactive approval prompt was declined.",
			"Review the flow request/result and retry if it should proceed.",
		);
	}
	record("approved");
	return null;
}

export function parseFlowsCommandArgs(rawArgs: string): { kind: "list" | "help" | "version" | "status" | "inspect"; scope: AgentScope } | { kind: "report"; traceFile?: string } | { kind: "error"; message: string } {
	const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { kind: "list", scope: "user" };
	const [first, second] = parts;
	const validScopes = new Set(["user", "project", "all"]);
	const validKinds = new Set(["help", "version", "status", "inspect", "list", "report"]);

	if (validKinds.has(first)) {
		if (first === "help") return { kind: "help", scope: "user" };
		if (first === "version") return { kind: "version", scope: "user" };
		if (first === "inspect") {
			if (second) return { kind: "error", message: "Use: /flows inspect" };
			return { kind: "inspect", scope: "user" };
		}
		if (first === "report") {
			if (parts.length > 2) return { kind: "error", message: "Use: /flows report [trace-file]" };
			return { kind: "report", traceFile: second };
		}
		if (first === "status") {
			if (second && !validScopes.has(second)) return { kind: "error", message: `Unknown /flows status scope "${second}". Valid scopes: user, project, all.` };
			return { kind: "status", scope: (second as AgentScope) || "user" };
		}
		if (first === "list") {
			if (second && !validScopes.has(second)) return { kind: "error", message: `Unknown /flows list scope "${second}". Valid scopes: user, project, all.` };
			return { kind: "list", scope: (second as AgentScope) || "user" };
		}
	}

	if (validScopes.has(first)) return { kind: "list", scope: first as AgentScope };
	return { kind: "error", message: `Unknown /flows argument "${first}". Use: /flows [user|project|all], /flows inspect, /flows help, /flows version, or /flows status [scope].` };
}

export function flowsHelpText(): string {
	return [
		`pi-flows ${PI_FLOWS_VERSION}`,
		"",
		"Usage:",
		"  /flows                         List bundled + user flow agents",
		"  /flows project                 List bundled + project-local .pi/flow-agents",
		"  /flows all                     List package + user + project agents",
		"  /flows status [user|project|all] Show dirs, defaults, and discovery issues",
		"  /flows inspect                  Inspect a running child (F8)",
		"  /flows report [trace-file]       Summarize a flow trace JSONL file",
		"  /flows version                  Show pi-flows version",
		"",
		"Tool smoke tests:",
		"  { \"list\": true }",
		"  { \"showConfig\": true }",
		"",
		"Safety:",
		"  Project-local agents are repo-controlled prompts. In non-UI/headless runs, pi-flows refuses to run them unless confirmProjectAgents:false is explicitly set.",
	].join("\n");
}
