import { formatFlowError, type CapturePolicy, type DiscoveryIssue, type FlowDetails, type FlowPreset, type FlowPresetDiscovery, type ModeOutput } from "./types.ts";
import { safePath, sanitizeText } from "./sanitize.ts";
import { summarizePresets } from "./presets.ts";

const defaultPolicy: CapturePolicy = { recordContent: true, redactSecrets: true };

/**
 * Directory paths are captured content like any other: `safePath` only abbreviates
 * the home prefix, so a checkout or preset dir whose own segments are secret-shaped
 * still has to go through the active capture policy before it is returned.
 */
function capturedPath(filePath: string | null | undefined, policy: CapturePolicy): string | null {
	if (!filePath) return null;
	return sanitizeText(safePath(filePath) ?? filePath, policy, 4 * 1024);
}

function capturedPreset(preset: FlowPreset, policy: CapturePolicy) {
	return {
		name: preset.name,
		description: sanitizeText(preset.description, policy, 4 * 1024),
		source: preset.source,
		filePath: capturedPath(preset.filePath, policy) ?? preset.filePath,
		overrides: preset.overrides.map((override) => sanitizeText(override, policy, 256)),
		result: preset.result === undefined ? undefined : sanitizeText(preset.result, policy, 256),
	};
}

function capturedIssue(issue: DiscoveryIssue, policy: CapturePolicy): DiscoveryIssue {
	return {
		...issue,
		filePath: issue.filePath === undefined ? undefined : capturedPath(issue.filePath, policy) ?? issue.filePath,
		message: sanitizeText(issue.message, policy, 4 * 1024),
		fix: issue.fix === undefined ? undefined : sanitizeText(issue.fix, policy, 4 * 1024),
	};
}

export function presetConfigSummary(discovery: FlowPresetDiscovery, policy: CapturePolicy = defaultPolicy): string {
	return [
		`presetsDir.package: ${capturedPath(discovery.packagePresetsDir, policy)}`,
		`presetsDir.user: ${capturedPath(discovery.userPresetsDir, policy)}`,
		`presetsDir.project: ${capturedPath(discovery.projectPresetsDir, policy) ?? "(none)"}`,
		"",
		"Presets:",
		summarizePresets(discovery, policy),
	].join("\n");
}

export function attachPresetDetails(
	details: FlowDetails,
	discovery: FlowPresetDiscovery,
	activePreset?: FlowPreset,
	policy: CapturePolicy = defaultPolicy,
): FlowDetails {
	details.presetsDir = {
		package: capturedPath(discovery.packagePresetsDir, policy) ?? discovery.packagePresetsDir,
		user: capturedPath(discovery.userPresetsDir, policy) ?? discovery.userPresetsDir,
		project: capturedPath(discovery.projectPresetsDir, policy),
	};
	details.presets = discovery.presets.map((preset) => capturedPreset(preset, policy));
	details.discoveryIssues = [...(details.discoveryIssues ?? []), ...discovery.issues.map((issue) => capturedIssue(issue, policy))];
	if (activePreset) {
		const captured = capturedPreset(activePreset, policy);
		details.preset = {
			name: captured.name,
			description: captured.description,
			source: captured.source,
			filePath: captured.filePath,
			result: captured.result,
		};
	}
	return details;
}

export function presetResolutionErrorOutput(
	error: FlowDetails["error"],
	discovery: FlowPresetDiscovery,
	details: FlowDetails,
	policy: CapturePolicy = defaultPolicy,
): ModeOutput {
	return {
		content: [{ type: "text", text: `${formatFlowError(error!)}\n\nAvailable presets:\n${summarizePresets(discovery, policy)}` }],
		details,
	};
}

export function attachPresetTraceAttributes(attributes: Record<string, unknown>, preset: FlowPreset | undefined, details: FlowDetails): Record<string, unknown> {
	if (!preset) return attributes;
	const attached: Record<string, unknown> = {
		...attributes,
		"flow.preset": preset.name,
		"flow.preset_source": preset.source,
		"flow.preset_outcome": details.presetOutcome,
	};
	if (details.presetOutcome === "CLEAN" || details.presetOutcome === "FINDINGS") {
		attached["flow.outcome_verified"] = true;
		attached["flow.outcome_success"] = details.presetOutcome === "CLEAN";
	} else if (details.presetOutcome === "PARTIAL") {
		attached["flow.outcome_verified"] = false;
		delete attached["flow.outcome_success"];
	}
	return attached;
}
