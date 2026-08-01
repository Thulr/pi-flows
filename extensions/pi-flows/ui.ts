import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PI_FLOWS_VERSION, THINKING_LEVELS, flowError, type AgentScope, type FlowDetails, type FlowError, type FlowMode, type ModelRoster, type RecordEvent, type ThinkingLevel } from "./types.ts";
import { USE_DEFAULT_MODEL, describeModelRoster, saveRosterOverride } from "./model-roster.ts";
import { isFailed, safePath, sanitizeText } from "./sanitize.ts";

/**
 * What a caller knows about the flow beyond its results. `live` means the flow
 * itself has not settled — see {@link flowProgressText} for why that is not the
 * same question as whether its runs have.
 */
export interface FlowProgressOptions {
	live?: boolean;
}

/**
 * The header state text the live board surfaces share, so neither can drift into
 * its own vocabulary. A bare `settled/total` was ambiguous in both directions:
 * `0/2` read as "no runs have started" and `2/2` read as "both runs succeeded"
 * even when both failed. So the ratio names what it counts (**settled** runs —
 * see CONTEXT.md) while any run is outstanding, then gives way to the verdict,
 * because `N/N` is the exact string that reads as a success total while carrying
 * nothing the verdict and the per-run rows do not.
 *
 * `results` alone cannot date that handover. A multi-stage mode settles every run
 * of one stage before spawning the next — `evaluate` emits an update after its
 * generator returns, ahead of the check command and the critic panel — so
 * `settled === total` there means "this stage is done", not "the flow is". A
 * caller that knows the flow is still `live` keeps the labeled ratio, which is
 * safe to hold at `2/2` precisely because the label says what it counts.
 *
 * A flow-level error is a separate fact that the board surfaces render beside
 * this progress text.
 */
export function flowProgressText(details: FlowDetails, options: FlowProgressOptions = {}): string {
	const total = details.results.length;
	// A dispatched flow reaches the live row before its first run registers.
	// Reporting that as `0 ok` would be the same false success the ratio was.
	if (total === 0) return "starting";
	const settled = details.results.filter((result) => result.exitCode !== -1).length;
	if (options.live || settled < total) return `${settled}/${total} settled`;
	const failed = details.results.filter((result) => isFailed(result)).length;
	return failed ? `${failed} failed` : `${total} ok`;
}

/** Remove progress surfaces superseded by the live inline tool row. */
export function clearFlowUi(ctx: any): void {
	ctx.ui?.setStatus?.("pi-flows", undefined);
	ctx.ui?.setWidget?.("pi-flows", undefined);
}

export function appendFlowSessionEntry(pi: ExtensionAPI, details: FlowDetails): void {
	pi.appendEntry?.("pi-flows.run", {
		version: details.version,
		mode: details.mode,
		status: details.error ? "error" : details.results.some((result) => result.exitCode !== -1 && isFailed(result)) ? "partial" : "ok",
		errorCode: details.error?.code,
		budgetCeilings: details.budgetCeilings,
		// Trace pointer travels with the entry so the flow card can link evidence
		// after session reload, when the in-memory details are gone.
		trace: details.trace ? { traceFile: details.trace.traceFile, health: details.trace.health } : undefined,
		results: details.results.map((result) => ({
			agent: result.agent,
			agentSource: result.agentSource,
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorCode: result.error?.code,
			budgetCeiling: result.error?.budgetCeiling,
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

export function parseFlowsCommandArgs(rawArgs: string): { kind: "list" | "help" | "version" | "status" | "inspect" | "models"; scope: AgentScope } | { kind: "report"; traceFile?: string } | { kind: "error"; message: string } {
	const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { kind: "list", scope: "user" };
	const [first, second] = parts;
	const validScopes = new Set(["user", "project", "all"]);
	const validKinds = new Set(["help", "version", "status", "inspect", "list", "report", "models"]);

	if (validKinds.has(first)) {
		if (first === "help") return { kind: "help", scope: "user" };
		if (first === "version") return { kind: "version", scope: "user" };
		if (first === "models") {
			if (second) return { kind: "error", message: "Use: /flows models" };
			return { kind: "models", scope: "user" };
		}
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
	return { kind: "error", message: `Unknown /flows argument "${first}". Use: /flows [user|project|all], /flows models, /flows inspect, /flows help, /flows version, or /flows status [scope].` };
}

const KEEP_DERIVED = "Reset to derived (let pi-flows choose)";
const PI_DEFAULT_MODEL = "(your pi default model)";
const INHERIT_THINKING = "(inherit — tier default)";

/**
 * Show what each tier currently resolves to, then let the user pin one.
 *
 * Reading comes first and always: the common reason to open this is "why did
 * that child run on that model?", which the rationale line answers without
 * changing anything. Editing is the follow-on, and it writes to the user's
 * `pi-flows.json` — inside pi, where the setting is visible and revisable, not
 * to a shell variable exported once and forgotten.
 */
export async function showModelRoster(ctx: ExtensionCommandContext, roster: ModelRoster, userDir: string): Promise<void> {
	const summary = [`pi-flows model roster (${roster.source})`, "", ...describeModelRoster(roster)];
	if (!ctx.hasUI) {
		ctx.ui.notify(summary.join("\n"), "info");
		return;
	}

	const tier = await ctx.ui.select(`${summary.join("\n")}\n\nOverride which tier?`, ["fast", "capable", "deep"]);
	if (tier !== "fast" && tier !== "capable" && tier !== "deep") return;

	// Only models this install can actually run are offered. A free-text field
	// here would let a typo become a tier that fails every child that uses it.
	const modelChoice = await ctx.ui.select(`Model for tier "${tier}"`, [KEEP_DERIVED, PI_DEFAULT_MODEL, ...roster.available.map((model) => model.reference)]);
	if (!modelChoice) return;
	if (modelChoice === KEEP_DERIVED) {
		const file = saveRosterOverride(userDir, tier, undefined);
		ctx.ui.notify(`Tier "${tier}" reset to derived in ${safePath(file)}.`, "info");
		return;
	}

	// Choosing the pi default is a decision, so it is persisted as one (`null`)
	// rather than as an absent model. Saving `undefined` here would read back as
	// "no model stated" and leave the derived model — possibly another provider's
	// — quietly in force while this command reported the default.
	const model = modelChoice === PI_DEFAULT_MODEL ? USE_DEFAULT_MODEL : modelChoice;
	const supported = roster.available.find((candidate) => candidate.reference === (model ?? roster.defaultModel))?.thinkingLevels;
	const levels = supported?.length ? supported : [...THINKING_LEVELS];
	const thinkingChoice = await ctx.ui.select(`Thinking level for tier "${tier}"`, [INHERIT_THINKING, ...levels]);
	if (!thinkingChoice) return;
	const thinking = thinkingChoice === INHERIT_THINKING ? undefined : (thinkingChoice as ThinkingLevel);

	const file = saveRosterOverride(userDir, tier, { model, thinking });
	ctx.ui.notify(
		`Tier "${tier}" now runs ${model === USE_DEFAULT_MODEL ? PI_DEFAULT_MODEL : model}${thinking ? ` at ${thinking} thinking` : ""}.\nSaved to ${safePath(file)}. It applies to the next flow call.`,
		"info",
	);
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
		"  /flows models                   Show what each tier resolves to, and override a tier",
		"  /flows inspect                  Drill into one running child",
		"  F8                              Toggle the live fleet panel overlay",
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
