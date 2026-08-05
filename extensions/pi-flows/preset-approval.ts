import { safePath, sanitizeText } from "./sanitize.ts";
import { flowError, type AgentScope, type CapturePolicy, type FlowError, type FlowPreset, type RecordEvent } from "./types.ts";

export interface ProjectPresetApproval {
	error: FlowError | null;
	/** Record the completed approval only after preset-owned trace settings are trusted. */
	record: (recordEvent?: RecordEvent) => void;
}

export async function approveProjectPreset(
	preset: FlowPreset | undefined,
	agentScope: AgentScope,
	confirmProjectAgents: boolean | undefined,
	ctx: any,
	policy: CapturePolicy = { recordContent: true, redactSecrets: true },
): Promise<ProjectPresetApproval> {
	let approved = false;
	const record = (recordEvent?: RecordEvent) => {
		if (!approved || !preset) return;
		recordEvent?.({
			kind: "approval",
			name: "project_preset",
			ok: true,
			attributes: { "flow.approval.decision": "approved", "flow.approval.interactive": true, "flow.preset": preset.name },
		});
	};
	if ((agentScope !== "project" && agentScope !== "all") || !(confirmProjectAgents ?? true) || preset?.source !== "project") return { error: null, record };
	// The refusal is returned to the model, so the repo-controlled path it names is
	// captured content. The interactive prompt below is not: it is the human's own
	// trust decision, and redacting the path there would hide what they are judging.
	const capturedFilePath = sanitizeText(safePath(preset.filePath) ?? preset.filePath, policy, 4 * 1024);
	if (!ctx.hasUI) {
		return { error: flowError(
			"PROJECT_PRESET_APPROVAL_REQUIRED",
			"Project-local flow presets require explicit trust in non-UI/headless runs.",
			`Preset "${preset.name}" comes from ${capturedFilePath} and is controlled by the repository.`,
			"Run in an interactive UI to approve, or pass confirmProjectAgents:false only after reviewing the project-local preset.",
		), record };
	}
	const ok = await ctx.ui.confirm(
		"Run project-local flow preset?",
		`Preset: ${preset.name}\nSource: ${safePath(preset.filePath)}\n\nProject-local presets are repo-controlled workflow parameters. Continue only for trusted repositories.`,
	);
	if (ok) {
		approved = true;
		return { error: null, record };
	}
	return { error: flowError(
		"PROJECT_PRESET_APPROVAL_DENIED",
		"Canceled: project-local flow preset was not approved.",
		"The interactive approval prompt was denied.",
		"Review the project-local preset and retry if you trust it.",
	), record };
}
