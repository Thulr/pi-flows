export type PresetSource = "package" | "user" | "project";

export interface FlowPreset {
	name: string;
	description: string;
	source: PresetSource;
	filePath: string;
	/** Top-level call parameters callers may replace after expansion. */
	overrides: string[];
	/** Optional harness-owned result formatter. */
	result?: string;
	template: Record<string, unknown>;
}

export interface FlowPresetDiscoveryIssue {
	severity: "warning" | "error";
	code: string;
	source: PresetSource;
	filePath?: string;
	message: string;
	fix?: string;
}

export interface FlowPresetDiscovery {
	presets: FlowPreset[];
	projectPresetsDir: string | null;
	userPresetsDir: string;
	packagePresetsDir: string;
	issues: FlowPresetDiscoveryIssue[];
}

export interface FlowPresetSelection {
	name: string;
	description: string;
	source: PresetSource;
	filePath: string;
	result?: string;
}
