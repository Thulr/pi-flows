import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PI_FLOWS_VERSION, ROSTER_CONFIG_FILE, THINKING_LEVELS, USE_DEFAULT_MODEL, flowError, type AgentScope, type FlowDetails, type FlowError, type FlowMode, type ModelRoster, type RecordEvent, type ThinkingLevel } from "./types.ts";
import { describeModelRoster, usableModels } from "./model-roster.ts";
import { saveRosterOverride, type RosterOverride } from "./roster-config.ts";
import { runFailed, runSettled } from "./run.ts";
import { safePath, sanitizeText } from "./sanitize.ts";

/**
 * What a caller knows about the flow beyond its results. `live` means the flow
 * itself has not settled — see {@link flowProgressText} for why that is not the
 * same question as whether its runs have.
 */
export interface FlowProgressOptions {
	live?: boolean;
}

export function hasNonCleanPresetOutcome(details: Pick<FlowDetails, "presetOutcome">): boolean {
	return details.presetOutcome === "FINDINGS" || details.presetOutcome === "PARTIAL";
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
	const settled = details.results.filter(runSettled).length;
	if (options.live || settled < total) return `${settled}/${total} settled`;
	if (hasNonCleanPresetOutcome(details)) return details.presetOutcome!;
	const failed = details.results.filter(runFailed).length;
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
		preset: details.preset?.name,
		presetOutcome: details.presetOutcome,
		status: details.error ? "error" : hasNonCleanPresetOutcome(details) || details.results.some(runFailed) ? "partial" : "ok",
		errorCode: details.error?.code,
		budgetCeilings: details.budgetCeilings,
		// Trace pointer travels with the entry so the flow card can link evidence
		// after session reload, when the in-memory details are gone.
		trace: details.trace ? { traceFile: details.trace.traceFile, health: details.trace.health } : undefined,
		results: details.results.map((result) => ({
			agent: result.agent,
			role: result.role,
			agentSource: result.agentSource,
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorCode: result.error?.code,
			budgetCeiling: result.error?.budgetCeiling,
			error: result.error,
			providerFailure: result.providerFailure,
			model: result.model,
			thinking: result.thinking,
			durationMs: result.durationMs,
			startedAtMs: result.startedAtMs,
			usage: result.usage,
		})),
	});
}

/**
 * Does this call's checkpoint gate the given moment? "spawn" is the default
 * target, so a bare `checkpoint: {}` gates the spawn. checkpointApproval
 * consumes this, and the selection eval imports it to score the headless
 * refusal (CHECKPOINT_APPROVAL_REQUIRED) with the tool's own predicate.
 */
export function checkpointGates(checkpoint: any, when: "spawn" | "finalize"): boolean {
	return Boolean(checkpoint) && (checkpoint.before ?? "spawn") === when;
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
	if (!checkpointGates(checkpoint, when)) return null;
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

/**
 * What clearing a user override actually leaves in force.
 *
 * "Reset to derived" was a promise this command cannot keep: it only deletes the
 * user's entry, and a project override or a `PI_FLOWS_*_MODEL` mapping still
 * outranks derivation. Saying "reset to derived" while an environment variable
 * silently takes over is the same class of false report as claiming a save
 * applied when a project shadows it.
 */
function clearedMessage(tier: "fast" | "capable" | "deep", file: string): string {
	const env = tier === "fast" ? process.env.PI_FLOWS_FAST_MODEL : tier === "deep" ? process.env.PI_FLOWS_DEEP_MODEL : undefined;
	const lines = [`Cleared your override for tier "${tier}" in ${safePath(file)}.`];
	if (env?.trim()) {
		lines.push(`PI_FLOWS_${tier.toUpperCase()}_MODEL is still set, so that mapping now applies rather than the derived model. Unset it to fall back to derivation.`);
	} else {
		lines.push("The tier falls back to the derived model unless a trusted project's config sets it.");
	}
	return lines.join("\n");
}

/**
 * Persist one tier, reporting a refusal rather than letting it throw.
 *
 * The save refuses when the existing file cannot be read or parsed, because
 * overwriting it would destroy settings a user can still repair by hand. That
 * refusal is a normal outcome of an interactive command, not a crash, so it is
 * shown as an error message with the reason.
 */
function saveTierOverride(ctx: ExtensionCommandContext, userDir: string, tier: "fast" | "capable" | "deep", override: RosterOverride | undefined): string | null {
	try {
		return saveRosterOverride(userDir, tier, override);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return null;
	}
}

const CLEAR_OVERRIDE = "Clear my override for this tier";
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

	// This command writes the user's file, which a trusted project's config
	// outranks. Saving anyway would report an edit as taking effect while the
	// project's value kept winning on the next call — so say so, and let the
	// operator decide rather than silently doing nothing useful.
	// Per field, because the layers merge per field: a project stating only
	// `thinking` still lets a user's model change take effect. Warning about the
	// whole rung would claim a model edit is inert when it is not.
	const shadowed = (["model", "thinking"] as const).filter((field) => roster[tier].origin?.[field] === "project-config");
	if (shadowed.length > 0) {
		const proceed = await ctx.ui.confirm(
			`This project sets ${shadowed.join(" and ")} for tier "${tier}"`,
			`This project's ${ROSTER_CONFIG_FILE} sets ${shadowed.join(" and ")} for "${tier}", and project config outranks your user config.\n\nAnything you choose for ${shadowed.join(" or ")} will not change what runs until that project entry is removed or changed${shadowed.length === 1 ? `; your ${shadowed[0] === "model" ? "thinking level" : "model"} choice will still apply` : ""}.\n\nSave to your user config anyway?`,
		);
		if (!proceed) return;
	}

	// Only models this install can actually run are offered. A free-text field
	// here would let a typo become a tier that fails every child that uses it.
	// Only assignable models are offered: the roster carries the full registry for
	// capability lookup, but embeddings and context windows too small to hold a
	// delegated task are not tiers anyone should be able to pick by accident.
	const modelChoice = await ctx.ui.select(`Model for tier "${tier}"`, [CLEAR_OVERRIDE, PI_DEFAULT_MODEL, ...usableModels(roster.available).map((model) => model.reference)]);
	if (!modelChoice) return;
	if (modelChoice === CLEAR_OVERRIDE) {
		const file = saveTierOverride(ctx, userDir, tier, undefined);
		if (file) ctx.ui.notify(clearedMessage(tier, file), "info");
		return;
	}

	// Choosing the pi default is a decision, so it is persisted as one (`null`)
	// rather than as an absent model. Saving `undefined` here would read back as
	// "no model stated" and leave the derived model — possibly another provider's
	// — quietly in force while this command reported the default.
	const model = modelChoice === PI_DEFAULT_MODEL ? USE_DEFAULT_MODEL : modelChoice;
	// Only a named model has knowable levels. Choosing "the pi default" means the
	// child runs pi's *configured* default, which is not readable here — the
	// session's model is a different model, and offering its levels would both
	// advertise ones the default may reject and hide ones it supports.
	// Only a named model has knowable levels. Choosing "the pi default" means the
	// child runs pi's *configured* default, which is not readable here — the
	// session's model is a different model, and offering its levels would both
	// advertise ones the default may reject and hide ones it supports.
	const supported = model ? roster.available.find((candidate) => candidate.reference === model)?.thinkingLevels : undefined;
	const levels = supported?.length ? supported : [...THINKING_LEVELS];
	const thinkingChoice = await ctx.ui.select(`Thinking level for tier "${tier}"`, [INHERIT_THINKING, ...levels]);
	if (!thinkingChoice) return;
	const thinking = thinkingChoice === INHERIT_THINKING ? undefined : (thinkingChoice as ThinkingLevel);

	const file = saveTierOverride(ctx, userDir, tier, { model, thinking });
	if (!file) return;
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
		"  /flows                         List bundled + user presets and agents",
		"  /flows project                 List bundled + project-local presets and agents",
		"  /flows all                     List package + user + project presets and agents",
		"  /flows status [user|project|all] Show dirs, defaults, and discovery issues",
		"  /flows models                   Show what each tier resolves to, and override a tier",
		"  /flows inspect                  Drill into one running child",
		"  /flows report [trace-file]       Summarize a flow trace JSONL file",
		"  /flows version                  Show pi-flows version",
		"",
		"Tool smoke tests:",
		"  { \"list\": true }",
		"  { \"showConfig\": true }",
		"",
		"Safety:",
		"  Project-local presets and agents are repo-controlled. In non-UI/headless runs, pi-flows refuses them unless confirmProjectAgents:false is explicitly set after review.",
	].join("\n");
}
