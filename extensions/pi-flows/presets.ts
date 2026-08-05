import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
import { flowAgentDir, isDirectory, parseFlowFrontmatter } from "./agents.ts";
import { isFailed, safePath, sanitizeText, takeValidatedReturnEnvelope } from "./sanitize.ts";
import { FlowParams } from "./schema.ts";
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
const checkFlowParams = Compile(FlowParams);
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

function flowParamsSchemaError(value: unknown): string | null {
	for (const item of checkFlowParams.Errors(value)) {
		return `${item.instancePath || "/"} ${item.message}`;
	}
	return null;
}

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

function findingLine(finding: any): string {
	const line = Number.isFinite(finding?.startLine) ? `:${finding.startLine}${Number.isFinite(finding?.endLine) && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ""}` : "";
	const severity = typeof finding?.severity === "string" ? finding.severity.toUpperCase() : "FINDING";
	const identity = [finding?.id, finding?.category].filter((item) => typeof item === "string" && item).join("/");
	return `- ${severity} ${finding?.path ?? "(unknown path)"}${line}${identity ? ` [${identity}]` : ""} — ${finding?.claim ?? "(missing claim)"}${finding?.evidence ? ` Evidence: ${finding.evidence}` : ""}${finding?.suggestion ? ` Suggested fix: ${finding.suggestion}` : ""}`;
}

function gitOutput(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
}

export interface CodeReviewRange {
	base: string;
	head: string;
}

/**
 * `symmetric` records the requested range kind. `base...head` is the proposed
 * branch change set (diff from the merge base), which is not the same file set as
 * the two-endpoint `base head` diff once the branches have diverged.
 */
function requestedReviewRefs(task: string): { base: string; head: string; symmetric: boolean } | null {
	const base = task.match(/\bbase(?:\s+(?:commit|sha))?\s*(?:is|=|:)?\s*([0-9a-f]{40,64})\b/i)?.[1];
	const head = task.match(/\bhead(?:\s+(?:commit|sha))?\s*(?:is|=|:)?\s*([0-9a-f]{40,64})\b/i)?.[1];
	if (base && head) return { base, head, symmetric: false };
	// `~` and `^` belong to the ref: `HEAD~1..HEAD` is the range people actually
	// type, and stopping short of the suffix pins the wrong commit or nothing.
	const gitRef = "[A-Za-z0-9][A-Za-z0-9._/^~-]*";
	// A ref may contain dots but never ends in one, and without that boundary a
	// greedy match reads `base...head` as a two-dot range off `base.`.
	const range = task.match(new RegExp(`\\b(${gitRef})(?<!\\.)\\s*(\\.{2,3})\\s*(${gitRef})\\b`, "i"));
	if (range) return { base: range[1], head: range[3], symmetric: range[2].length === 3 };
	const against = task.match(new RegExp(`\\b(${gitRef})\\s+against\\s+(${gitRef})\\b`, "i"));
	return against ? { base: against[2], head: against[1], symmetric: false } : null;
}

function resolveCommit(cwd: string, ref: string): string | null {
	const commit = gitOutput(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])?.trim();
	return commit && /^[0-9a-f]{40,64}$/i.test(commit) ? commit.toLowerCase() : null;
}

/** Both arguments are already-resolved commit hashes, so they cannot be read as options. */
function mergeBaseCommit(cwd: string, base: string, head: string): string | null {
	const commit = gitOutput(cwd, ["merge-base", base, head])?.trim();
	return commit && /^[0-9a-f]{40,64}$/i.test(commit) ? commit.toLowerCase() : null;
}

/**
 * Freeze a code-review request before dispatch. Ref syntax remains caller-facing
 * prose, but children and the formatter receive immutable commit identities.
 */
export function preparePresetRun(
	preset: FlowPreset | undefined,
	params: Record<string, unknown>,
	task: string,
	cwd: string,
): { params: Record<string, unknown>; codeReviewRange?: CodeReviewRange } {
	if (preset?.result !== "code-review-v1") return { params };
	const refs = requestedReviewRefs(task);
	const requestedBase = refs && resolveCommit(cwd, refs.base);
	const head = refs && resolveCommit(cwd, refs.head);
	if (!requestedBase || !head) return { params };
	// Freezing a three-dot request at its merge base keeps the pinned pair equal to
	// the change set the caller asked for, so the manifest diff below stays honest.
	const base = refs.symmetric ? mergeBaseCommit(cwd, requestedBase, head) : requestedBase;
	if (!base) return { params };
	const codeReviewRange = { base, head };
	const instruction = `Harness-pinned review range: base ${base}, head ${head}. Review and report exactly these commit identities; do not substitute another range.`;
	const tasks = Array.isArray(params.tasks)
		? params.tasks.map((item) => item && typeof item === "object" && typeof (item as any).task === "string"
			? { ...(item as Record<string, unknown>), task: `${(item as any).task}\n\n${instruction}` }
			: item)
		: params.tasks;
	return { params: { ...params, tasks }, codeReviewRange };
}

function changedFileManifest(cwd: string, base: unknown, head: unknown): Set<string> | null {
	if (typeof base !== "string" || typeof head !== "string") return null;
	const repoRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	if (!repoRoot) return null;
	const resolvedBase = gitOutput(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])?.trim();
	const resolvedHead = gitOutput(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`])?.trim();
	if (resolvedBase?.toLowerCase() !== base.toLowerCase() || resolvedHead?.toLowerCase() !== head.toLowerCase()) return null;
	const names = gitOutput(repoRoot, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z", resolvedBase, resolvedHead, "--"]);
	if (names === null) return null;
	return new Set(names.split("\0").filter(Boolean));
}

/** Apply a harness-owned formatter after the ordinary mode has validated return envelopes. */
export function formatPresetResult(
	preset: FlowPreset,
	output: ModeOutput,
	policy: CapturePolicy,
	cwd = process.cwd(),
	expectedRange?: CodeReviewRange,
): ModeOutput {
	if (preset.result !== "code-review-v1" || output.details.error) return output;
	const completed = output.details.results.filter((result) => result.exitCode === 0 && result.envelope?.status === "completed");
	// A reviewer that skipped a file can still have anchored a real bug in the files
	// it did read. Its envelope cannot prove coverage, so it never counts toward the
	// verdict, but dropping its findings would hide the one thing worth acting on.
	const incomplete = output.details.results.filter((result) => result.exitCode === 0 && result.envelope && !completed.includes(result));
	const envelopes = completed.map((result) => takeValidatedReturnEnvelope(result) ?? result.envelope);
	const incompleteEnvelopes = incomplete.map((result) => takeValidatedReturnEnvelope(result) ?? result.envelope);
	const incompleteFindings = incompleteEnvelopes
		.flatMap((envelope) => Array.isArray((envelope?.data as any)?.findings) ? (envelope!.data as any).findings : []);
	const data = envelopes.map((envelope) => envelope?.data as any);
	const axes = new Set(data.map((item) => item?.axis));
	const coverage = data.map((item) => Array.isArray(item?.coverage) ? item.coverage : []);
	const coverageSets = coverage.map((items) => new Set(items.map((item: any) => item?.path).filter((item: unknown): item is string => typeof item === "string")));
	const sameCoverage = coverageSets.length === 2
		&& coverageSets.every((set, index) => set.size === coverage[index].length)
		&& coverageSets[0].size === coverageSets[1].size
		&& [...coverageSets[0]].every((file) => coverageSets[1].has(file));
	const hasSkipped = coverage.some((items) => items.some((item: any) => item?.status !== "reviewed"));
	const sameRange = data.length === 2
		&& typeof data[0]?.base === "string"
		&& typeof data[0]?.head === "string"
		&& data[0].base.toLowerCase() === data[1]?.base?.toLowerCase()
		&& data[0].head.toLowerCase() === data[1]?.head?.toLowerCase();
	const matchesExpectedRange = Boolean(expectedRange && data.length === 2 && data.every((item) =>
		typeof item?.base === "string"
		&& typeof item?.head === "string"
		&& item.base.toLowerCase() === expectedRange.base
		&& item.head.toLowerCase() === expectedRange.head
	));
	const manifest = expectedRange ? changedFileManifest(cwd, expectedRange.base, expectedRange.head) : null;
	const matchesGitManifest = manifest !== null
		&& coverageSets.length === 2
		&& coverageSets.every((set) => set.size === manifest.size && [...manifest].every((file) => set.has(file)));
	const findings = data.flatMap((item) => Array.isArray(item?.findings) ? item.findings : []);
	const findingsConsistent = findings.every((finding) =>
		typeof finding?.path === "string"
		&& coverageSets.every((set) => set.has(finding.path))
		&& Number.isFinite(finding?.startLine)
		&& Number.isFinite(finding?.endLine)
		&& finding.endLine >= finding.startLine
	);
	const noUnresolvedState = envelopes.every((envelope) => envelope?.unresolvedQuestions.length === 0 && envelope.changedState.length === 0);
	const complete = completed.length === 2 && axes.size === 2 && axes.has("standards") && axes.has("spec") && sameRange && matchesExpectedRange && sameCoverage && matchesGitManifest && !hasSkipped && findingsConsistent && noUnresolvedState;
	const status = !complete ? "PARTIAL" : findings.length ? "FINDINGS" : "CLEAN";
	output.details.presetOutcome = status;
	const reported = [...findings, ...incompleteFindings];
	const details = policy.recordContent && reported.length ? `\n\n${reported.map(findingLine).join("\n")}` : "";
	// Naming the concrete gap is what makes the verdict actionable: the caller can
	// supply the missing issue context, fix an unreadable path, or rerun narrower.
	const reviewedEnvelopes = [...envelopes, ...incompleteEnvelopes];
	const skipped = reviewedEnvelopes
		.flatMap((envelope) => Array.isArray((envelope?.data as any)?.coverage) ? (envelope!.data as any).coverage : [])
		.filter((item: any) => typeof item?.path === "string" && item.status !== "reviewed")
		.map((item: any) => `${item.path} (${item.status ?? "unknown"})`);
	const questions = reviewedEnvelopes.flatMap((envelope) => envelope?.unresolvedQuestions ?? []);
	const gapItems = policy.recordContent
		? [skipped.length ? `skipped coverage: ${skipped.join(", ")}` : "", questions.length ? `unresolved: ${questions.join("; ")}` : ""].filter(Boolean)
		: [];
	const gap = complete ? "" : `\n\nCoverage could not be proven complete across both review axes; do not treat this result as clean.${gapItems.length ? ` Gaps — ${gapItems.join(" · ")}.` : ""}`;
	// This formatter replaces the ordinary parallel summary, so a reviewer that
	// timed out or died would otherwise be reported as an unexplained PARTIAL.
	const failed = output.details.results.filter(isFailed)
		.map((result) => `${result.role ?? result.agent} (${result.error?.code ?? result.stopReason ?? `exit ${result.exitCode}`})`);
	const failureText = failed.length ? `\n\nReview axes that did not return: ${failed.join(", ")}.` : "";
	output.content = [{ type: "text", text: sanitizeText(`Code review: ${status}${details}${gap}${failureText}`, policy) }];
	return output;
}
