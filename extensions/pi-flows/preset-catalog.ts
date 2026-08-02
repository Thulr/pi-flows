import { formatFlowError, type FlowDetails, type FlowPreset, type FlowPresetDiscovery, type ModeOutput } from "./types.ts";
import { safePath } from "./sanitize.ts";
import { summarizePresets } from "./presets.ts";

export function presetConfigSummary(discovery: FlowPresetDiscovery): string {
	return [
		`presetsDir.package: ${safePath(discovery.packagePresetsDir)}`,
		`presetsDir.user: ${safePath(discovery.userPresetsDir)}`,
		`presetsDir.project: ${safePath(discovery.projectPresetsDir) ?? "(none)"}`,
		"",
		"Presets:",
		summarizePresets(discovery),
	].join("\n");
}

export function attachPresetDetails(details: FlowDetails, discovery: FlowPresetDiscovery, activePreset?: FlowPreset): FlowDetails {
	details.presetsDir = {
		package: safePath(discovery.packagePresetsDir) ?? discovery.packagePresetsDir,
		user: safePath(discovery.userPresetsDir) ?? discovery.userPresetsDir,
		project: safePath(discovery.projectPresetsDir),
	};
	details.presets = discovery.presets.map((preset) => ({
		name: preset.name,
		description: preset.description,
		source: preset.source,
		filePath: safePath(preset.filePath) ?? preset.filePath,
		overrides: preset.overrides,
		result: preset.result,
	}));
	details.discoveryIssues = [...(details.discoveryIssues ?? []), ...discovery.issues];
	if (activePreset) {
		details.preset = {
			name: activePreset.name,
			description: activePreset.description,
			source: activePreset.source,
			filePath: safePath(activePreset.filePath) ?? activePreset.filePath,
			result: activePreset.result,
		};
	}
	return details;
}

export function presetResolutionErrorOutput(error: FlowDetails["error"], discovery: FlowPresetDiscovery, details: FlowDetails): ModeOutput {
	return {
		content: [{ type: "text", text: `${formatFlowError(error!)}\n\nAvailable presets:\n${summarizePresets(discovery)}` }],
		details,
	};
}

export function attachPresetTraceAttributes(attributes: Record<string, unknown>, preset: FlowPreset | undefined, details: FlowDetails): Record<string, unknown> {
	if (!preset) return attributes;
	return {
		...attributes,
		"flow.preset": preset.name,
		"flow.preset_source": preset.source,
		"flow.preset_outcome": details.presetOutcome,
	};
}
