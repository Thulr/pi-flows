import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { flowAgentDir, isDirectory, parseFlowFrontmatter } from "./agents.ts";
import { preparePresetRun, type CodeReviewRange } from "./preset-review.ts";
import { safePath, sanitizeText } from "./sanitize.ts";
import { FlowParams, flowParamsSchemaError } from "./schema.ts";
import {
	flowError,
	type AgentScope,
	type CapturePolicy,
	type DiscoveryIssue,
	type FlowError,
	type FlowMode,
	type FlowPreset,
	type FlowPresetDiscovery,
	type FlowPresetSelection,
	type ModeOutput,
} from "./types.ts";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
export const packagePresetsDir = path.resolve(baseDir, "../../presets");
const PRESET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PASSTHROUGH_KEYS = new Set([
	"why",
	"agentScope",
	"confirmProjectAgents",
	// A caller must always be able to narrow the aggregate monetary authority of
	// a preset without the preset opting in. Like capture/tracing controls below,
	// this does not replace workflow shape.
	"maxCostUsd",
	"checkpoint",
	"reflexion",
	"traceFile",
	"traceLabel",
	"traceContext",
	"traceStrict",
	"handoffPolicy",
	"modeHandoffPolicy",
	"incompleteHandoffPolicy",
	"recordContent",
	"redactSecrets",
	"allowSharedWriteCwd",
]);
/**
 * A preset may not supply its own delegation justification, opt its source into
 * trust, or grant itself the shared-write exception: that last one is the raw
 * mode's explicit acknowledgement that concurrent children may mutate one
 * checkout, and a template must not make it on the caller's behalf.
 */
const CALLER_ONLY_KEYS = ["why", "agentScope", "confirmProjectAgents", "allowSharedWriteCwd"] as const;

function commaList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
	if (typeof value !== "string") return [];
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function issue(source: FlowPreset["source"], code: string, filePath: string, message: string, fix: string): DiscoveryIssue {
	return { severity: "warning", code, source, filePath: safePath(filePath) ?? filePath, message, fix };
}

export function loadPresetsFromDir(dir: string, source: FlowPreset["source"]): { presets: FlowPreset[]; issues: DiscoveryIssue[] } {
	if (!fsSync.existsSync(dir)) return { presets: [], issues: [] };
	let entries: fsSync.Dirent[];
	try {
		entries = fsSync.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return {
			presets: [],
			issues: [issue(source, "PRESET_DIR_UNREADABLE", dir, `Could not read flow-preset directory: ${error instanceof Error ? error.message : String(error)}`, "Check directory permissions or remove the unreadable directory.")],
		};
	}

	const presets: FlowPreset[] = [];
	const issues: DiscoveryIssue[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fsSync.readFileSync(filePath, "utf8");
		} catch (error) {
			issues.push(issue(source, "PRESET_FILE_UNREADABLE", filePath, `Could not read flow-preset file: ${error instanceof Error ? error.message : String(error)}`, "Fix file permissions or remove the unreadable preset."));
			continue;
		}
		const { frontmatter, body } = parseFlowFrontmatter<Record<string, unknown>>(content);
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
		const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
		if (!name || !description || !PRESET_NAME.test(name)) {
			issues.push(issue(source, "PRESET_FRONTMATTER_INVALID", filePath, "Skipped flow-preset file because name/description is missing or name is not lowercase kebab-case.", "Add name and description frontmatter; use a name like `code-review`."));
			continue;
		}
		let template: unknown;
		try {
			template = JSON.parse(body.trim());
		} catch (error) {
			issues.push(issue(source, "PRESET_TEMPLATE_INVALID", filePath, `Skipped flow-preset file because its body is not JSON: ${error instanceof Error ? error.message : String(error)}`, "Make the Markdown body one JSON object containing flow parameters."));
			continue;
		}
		if (!template || typeof template !== "object" || Array.isArray(template)) {
			issues.push(issue(source, "PRESET_TEMPLATE_INVALID", filePath, "Skipped flow-preset file because its JSON body is not an object.", "Use one JSON object containing flow parameters."));
			continue;
		}
		const schemaError = flowParamsSchemaError(template);
		if (schemaError) {
			issues.push(issue(source, "PRESET_TEMPLATE_SCHEMA_INVALID", filePath, `Skipped flow-preset file because its template is outside the public flow schema: ${schemaError}.`, "Correct the named field so the template is valid FlowParams JSON."));
			continue;
		}
		presets.push({
			name,
			description,
			source,
			filePath,
			overrides: commaList(frontmatter.overrides),
			result: typeof frontmatter.result === "string" ? frontmatter.result.trim() || undefined : undefined,
			template: template as Record<string, unknown>,
		});
	}
	return { presets, issues };
}

export function findNearestProjectPresetsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "flow-presets");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverFlowPresets(cwd: string, scope: AgentScope): FlowPresetDiscovery {
	const userPresetsDir = path.join(flowAgentDir(), "flow-presets");
	const projectPresetsDir = findNearestProjectPresetsDir(cwd);
	const packageOnly = process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY === "1";
	const packageLoad = loadPresetsFromDir(packagePresetsDir, "package");
	const userLoad = packageOnly || scope === "project" ? { presets: [], issues: [] } : loadPresetsFromDir(userPresetsDir, "user");
	const projectLoad = packageOnly || scope === "user" || !projectPresetsDir ? { presets: [], issues: [] } : loadPresetsFromDir(projectPresetsDir, "project");
	const issues = [...packageLoad.issues, ...userLoad.issues, ...projectLoad.issues];
	const byName = new Map<string, FlowPreset>();
	for (const preset of [...packageLoad.presets, ...userLoad.presets, ...projectLoad.presets]) {
		const previous = byName.get(preset.name);
		if (previous) {
			issues.push(issue(preset.source, "PRESET_NAME_SHADOWED", preset.filePath, `Flow preset "${preset.name}" from ${preset.source} shadows ${previous.source} preset at ${safePath(previous.filePath)}.`, "Rename one preset or use a narrower agentScope."));
		}
		byName.set(preset.name, preset);
	}
	return {
		presets: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
		projectPresetsDir,
		userPresetsDir,
		packagePresetsDir,
		issues,
	};
}

function substitute(value: unknown, task: string): unknown {
	if (typeof value === "string") return value.replaceAll("{task}", () => task);
	if (Array.isArray(value)) return value.map((item) => substitute(item, task));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, substitute(nested, task)]));
}

function containsTaskPlaceholder(value: unknown): boolean {
	if (typeof value === "string") return value.includes("{task}");
	if (Array.isArray(value)) return value.some(containsTaskPlaceholder);
	return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(containsTaskPlaceholder));
}

export interface ResolvedPreset {
	params: Record<string, unknown>;
	preset: FlowPreset;
	selection: FlowPresetSelection;
}

/** Resolve the base directory for presets whose runnable roles are nested refs. */
export function presetRunCwd(preset: FlowPreset | undefined, mode: FlowMode, callerCwd: string, requestedCwd: unknown): string {
	return preset && (mode === "parallel" || mode === "orchestrate") && typeof requestedCwd === "string"
		? path.resolve(callerCwd, requestedCwd)
		: callerCwd;
}

/**
 * Preset-owned run preparation: the nested-role working directory and the frozen
 * review range. It shells out to git inside a preset-named directory, so a caller
 * must not reach it until that preset has passed the project trust gate.
 */
export function preparePresetDispatch(
	preset: FlowPreset | undefined,
	params: Record<string, unknown>,
	task: string,
	mode: FlowMode,
	callerCwd: string,
): { params: Record<string, unknown>; runDefaultCwd: string; codeReviewRange?: CodeReviewRange } {
	const runDefaultCwd = presetRunCwd(preset, mode, callerCwd, params.cwd);
	return { runDefaultCwd, ...preparePresetRun(preset, params, task, runDefaultCwd) };
}

export function resolveFlowPreset(
	params: Record<string, unknown>,
	discovery: FlowPresetDiscovery,
	policy: CapturePolicy = { recordContent: true, redactSecrets: true },
): ResolvedPreset | { error: FlowError } {
	const name = typeof params.preset === "string" ? params.preset.trim() : "";
	// A rejected name never matched a discovered preset, so it is unvalidated caller
	// text on its way back into returned content and details.
	const echoedName = sanitizeText(name, policy, 256);
	const preset = discovery.presets.find((candidate) => candidate.name === name);
	if (!preset) {
		return { error: flowError("UNKNOWN_PRESET", `Unknown flow preset: "${echoedName}".`, "No discovered preset matched the requested name.", "Run `flow` with `{\"list\":true}` or `/flows` to inspect preset names and scopes.") };
	}
	const task = typeof params.task === "string" ? params.task : "";
	if (containsTaskPlaceholder(preset.template) && !task.trim()) {
		return { error: flowError("PRESET_TASK_REQUIRED", `Preset "${echoedName}" requires a task.`, "Its template contains a {task} placeholder, but the call supplied no non-empty task.", "Pass task:'<complete goal, fixed point, and relevant issue/spec context>'.") };
	}
	const allowedOverrides = new Set(preset.overrides);
	const reserved = new Set(["preset", "task", "list", "showConfig"]);
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || reserved.has(key) || PASSTHROUGH_KEYS.has(key) || allowedOverrides.has(key)) continue;
		const echoedKey = sanitizeText(key, policy, 256);
		return { error: flowError("PRESET_OVERRIDE_INVALID", `Preset "${echoedName}" does not allow overriding "${echoedKey}".`, "Preset expansion is data-driven and only frontmatter-declared top-level overrides may replace its workflow shape.", `Remove "${echoedKey}" or add it to the preset's overrides frontmatter after reviewing the trust and boundedness impact.`) };
	}
	const expanded = substitute(preset.template, task) as Record<string, unknown>;
	for (const key of CALLER_ONLY_KEYS) delete expanded[key];
	const templateCapture = { recordContent: expanded.recordContent, redactSecrets: expanded.redactSecrets };
	for (const key of PASSTHROUGH_KEYS) if (params[key] !== undefined) expanded[key] = params[key];
	for (const key of allowedOverrides) if (params[key] !== undefined) expanded[key] = params[key];
	// Capture is tighten-only in both directions: the passthrough above would
	// otherwise let a caller replace a template that deliberately withholds child
	// content, and a template must never undo the caller's own choice either.
	if (templateCapture.recordContent !== undefined || params.recordContent !== undefined) {
		expanded.recordContent = (params.recordContent ?? true) !== false && templateCapture.recordContent !== false;
	}
	if (templateCapture.redactSecrets !== undefined || params.redactSecrets !== undefined) {
		expanded.redactSecrets = (params.redactSecrets ?? true) === true || templateCapture.redactSecrets === true;
	}
	// Strict tracing is an evidence gate the caller or the environment sets, so a
	// template may turn it on but never off: dropping a template-authored `false`
	// lets PI_FLOWS_TRACE_STRICT decide again. The caller keeps its own opt-out.
	if (params.traceStrict === undefined && expanded.traceStrict === false) delete expanded.traceStrict;
	expanded.preset = preset.name;
	const schemaError = flowParamsSchemaError(expanded);
	if (schemaError) {
		return { error: flowError("PRESET_EXPANSION_INVALID", `Preset "${echoedName}" expanded outside the public flow schema.`, sanitizeText(schemaError, policy, 4 * 1024), "Remove or correct the invalid override, or fix the preset template reported by flow showConfig:true.") };
	}
	return {
		params: expanded,
		preset,
		selection: { name: preset.name, description: preset.description, source: preset.source, filePath: preset.filePath, result: preset.result },
	};
}

/**
 * Resolve the capture policy an expanded preset runs under. A template is data
 * from a source that may not have passed the project trust gate, and its
 * expansion already feeds the refusal details, so a preset may tighten capture
 * but never loosen it: only the caller can turn redaction off or keep child
 * content on.
 */
export function presetCapturePolicy(caller: CapturePolicy, expanded: Record<string, unknown>): CapturePolicy {
	return {
		recordContent: caller.recordContent && expanded.recordContent !== false,
		redactSecrets: caller.redactSecrets || expanded.redactSecrets !== false,
	};
}

/** Expand a preset for side-effect-free pre-run rendering; invalid/partial calls stay unchanged. */
export function previewFlowPreset(params: Record<string, unknown>, cwd: string): Record<string, unknown> {
	const scope = params.agentScope === "project" || params.agentScope === "all" ? params.agentScope : "user";
	const resolved = resolveFlowPreset(params, discoverFlowPresets(cwd, scope));
	return "error" in resolved ? params : resolved.params;
}

export function summarizePresets(
	discovery: FlowPresetDiscovery,
	policy: CapturePolicy = { recordContent: true, redactSecrets: true },
): string {
	const presetText = discovery.presets.length
		? discovery.presets.map((preset) => {
			const description = sanitizeText(preset.description, policy, 4 * 1024);
			const overrides = preset.overrides.map((override) => sanitizeText(override, policy, 256));
			return `- ${preset.name} (${preset.source}) — ${description}${overrides.length ? ` — overrides=${overrides.join(",")}` : ""}`;
		}).join("\n")
		: "No flow presets found.";
	const issueText = discovery.issues.map((item) => {
		const filePath = item.filePath ? sanitizeText(safePath(item.filePath) ?? item.filePath, policy, 4 * 1024) : "";
		const message = sanitizeText(item.message, policy, 4 * 1024);
		const fix = item.fix ? sanitizeText(item.fix, policy, 4 * 1024) : "";
		return `- ${item.severity.toUpperCase()} ${item.code}${filePath ? ` (${filePath})` : ""}: ${message}${fix ? ` Fix: ${fix}` : ""}`;
	}).join("\n");
	return issueText ? `${presetText}\n\nDiscovery issues:\n${issueText}` : presetText;
}

// The code-review freezing and formatting unit lives in preset-review.ts;
// re-exported here so callers keep one preset facade.
export { formatPresetResult, preparePresetRun, type CodeReviewRange } from "./preset-review.ts";
