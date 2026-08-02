import { formatFlowError, type CapturePolicy, type DiscoveryIssue, type FlowDetails, type FlowPreset, type FlowPresetDiscovery, type ModeOutput } from "./types.ts";
import { safePath, sanitizeText } from "./sanitize.ts";
import { summarizePresets } from "./presets.ts";

const defaultPolicy: CapturePolicy = { recordContent: true, redactSecrets: true };

function capturedPreset(preset: FlowPreset, policy: CapturePolicy) {
	return {
		name: preset.name,
		description: sanitizeText(preset.description, policy, 4 * 1024),
		source: preset.source,
		filePath: sanitizeText(safePath(preset.filePath) ?? preset.filePath, policy, 4 * 1024),
		overrides: preset.overrides.map((override) => sanitizeText(override, policy, 256)),
		result: preset.result === undefined ? undefined : sanitizeText(preset.result, policy, 256),
	};
}

function capturedIssue(issue: DiscoveryIssue, policy: CapturePolicy): DiscoveryIssue {
	return {
		...issue,
		filePath: issue.filePath === undefined ? undefined : sanitizeText(safePath(issue.filePath) ?? issue.filePath, policy, 4 * 1024),
		message: sanitizeText(issue.message, policy, 4 * 1024),
		fix: issue.fix === undefined ? undefined : sanitizeText(issue.fix, policy, 4 * 1024),
	};
}

export function presetConfigSummary(discovery: FlowPresetDiscovery, policy: CapturePolicy = defaultPolicy): string {
	return [
		`presetsDir.package: ${safePath(discovery.packagePresetsDir)}`,
		`presetsDir.user: ${safePath(discovery.userPresetsDir)}`,
		`presetsDir.project: ${safePath(discovery.projectPresetsDir) ?? "(none)"}`,
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
		package: safePath(discovery.packagePresetsDir) ?? discovery.packagePresetsDir,
		user: safePath(discovery.userPresetsDir) ?? discovery.userPresetsDir,
		project: safePath(discovery.projectPresetsDir),
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
