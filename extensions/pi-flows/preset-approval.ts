import { safePath } from "./sanitize.ts";
import { flowError, type AgentScope, type FlowError, type FlowPreset, type RecordEvent } from "./types.ts";

export async function approveProjectPreset(
	preset: FlowPreset | undefined,
	agentScope: AgentScope,
	confirmProjectAgents: boolean | undefined,
	ctx: any,
	recordEvent?: RecordEvent,
): Promise<FlowError | null> {
	if ((agentScope !== "project" && agentScope !== "all") || !(confirmProjectAgents ?? true) || preset?.source !== "project") return null;
	const event = (decision: "required" | "denied" | "approved", interactive: boolean) => recordEvent?.({
		kind: "approval",
		name: "project_preset",
		ok: decision === "approved",
		attributes: { "flow.approval.decision": decision, "flow.approval.interactive": interactive, "flow.preset": preset.name },
	});
	if (!ctx.hasUI) {
		event("required", false);
		return flowError(
			"PROJECT_PRESET_APPROVAL_REQUIRED",
			"Project-local flow presets require explicit trust in non-UI/headless runs.",
			`Preset "${preset.name}" comes from ${safePath(preset.filePath)} and is controlled by the repository.`,
			"Run in an interactive UI to approve, or pass confirmProjectAgents:false only after reviewing the project-local preset.",
		);
	}
	const ok = await ctx.ui.confirm(
		"Run project-local flow preset?",
		`Preset: ${preset.name}\nSource: ${safePath(preset.filePath)}\n\nProject-local presets are repo-controlled workflow parameters. Continue only for trusted repositories.`,
	);
	if (ok) {
		event("approved", true);
		return null;
	}
	event("denied", true);
	return flowError(
		"PROJECT_PRESET_APPROVAL_DENIED",
		"Canceled: project-local flow preset was not approved.",
		"The interactive approval prompt was denied.",
		"Review the project-local preset and retry if you trust it.",
	);
}
