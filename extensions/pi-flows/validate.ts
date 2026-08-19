import { accessSync, constants, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONCURRENCY, DEFAULT_EVALUATE_ITERATIONS, DEFAULT_LOOP_ITERATIONS, DEFAULT_TIMEOUT_MS, MAX_EVALUATE_ITERATIONS, MAX_GRAPH_NODES, MAX_LOOP_ITERATIONS, MAX_PARALLEL_TASKS, flowError, type FlowDiscovery, type FlowError } from "./types.ts";
import { redactText, safePath } from "./sanitize.ts";

// The workflow phase predicates live in validate-workflow.ts; re-exported here
// so this module stays the one seam callers validate a call through.
export { isWorkflowWorkPhase, workflowHeadlessApprovalRefusal, workflowPhasesRefusal } from "./validate-workflow.ts";

export function parseToolsOverride(tools: string | undefined, fallback: string[] | undefined): string[] | undefined {
	if (!tools) return fallback;
	if (tools.trim().toLowerCase() === "default") return undefined;
	if (tools.trim().toLowerCase() === "none") return [];
	return tools
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

export const RETURN_EVIDENCE_REQUIREMENT = "Ground every load-bearing claim in concrete evidence: file:line references, command output, citations, or explicit gaps when evidence is unavailable.";

export function appendReturnRequirements(task: string, requirements: string | undefined, requireEvidence: boolean | undefined): string {
	const sections: string[] = [];
	if (requirements?.trim()) sections.push(requirements.trim());
	if (requireEvidence) sections.push(RETURN_EVIDENCE_REQUIREMENT);
	if (sections.length === 0) return task;
	return [task, "\n## Return requirements", ...sections.map((section) => `- ${section}`)].join("\n");
}

/**
 * Params keys retired by rename, refused loudly (PARAM_RENAMED) so a call
 * written against the old vocabulary is never silently weaker: the public
 * schema does not reject unknown keys, so without this gate an old
 * `returnContract` would pass validation and its requirements would simply
 * never reach a child.
 */
const RENAMED_PARAMS: Record<string, string> = {
	returnContract: "returnRequirements",
	workerReturnContract: "workerReturnRequirements",
};

/**
 * A path segment safe to echo into returned content: a short plain-token key
 * name the standard redactor leaves unchanged. Params accept unknown keys, so
 * an ancestor key can carry anything — and a secret can be a plain token
 * (`sk-…`), which is why the charset test alone is not enough and the same
 * redactText that guards returned content vets the segment. The retired keys
 * themselves are constants and always pass.
 */
const safeKeySegment = (key: string): string => (/^[A-Za-z0-9_.$-]{1,64}$/.test(key) && redactText(key) === key ? key : "(unrecognized key)");

/**
 * Find a retired key anywhere in the call's params. Skips `contract` subtrees:
 * a delegation contract's returnSchema may legitimately declare a data field
 * by any name, and the retired keys never lived inside a contract.
 */
export function renamedParamError(value: unknown, path = ""): FlowError | null {
	if (!value || typeof value !== "object") return null;
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const error = renamedParamError(item, `${path}[${index}]`);
			if (error) return error;
		}
		return null;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (key === "contract") continue;
		const where = path ? `${path}.${safeKeySegment(key)}` : safeKeySegment(key);
		const renamed = RENAMED_PARAMS[key];
		if (renamed) {
			return flowError(
				"PARAM_RENAMED",
				`Flow call refused: \`${where}\` was renamed to \`${renamed}\`.`,
				`The prose return-requirements params were renamed (returnContract -> returnRequirements); refusing is deliberate, because the old key would otherwise pass schema validation and be silently ignored.`,
				`Re-issue the call with \`${renamed}\` in place of \`${key}\`. The value is unchanged.`,
			);
		}
		const nested = renamedParamError(entry, where);
		if (nested) return nested;
	}
	return null;
}

export function effectiveTools(discovery: FlowDiscovery, ref: { agent: string; tools?: string }): string[] | undefined | null {
	const agent = discovery.agents.find((candidate) => candidate.name === ref.agent);
	if (!agent) return null;
	return parseToolsOverride(ref.tools, agent.tools);
}

const MUTATING_TOOLS = ["bash", "edit", "write"];

export function canMutateWorkspace(discovery: FlowDiscovery, ref: { agent: string; tools?: string }): boolean {
	const tools = effectiveTools(discovery, ref);
	if (tools === null) return false;
	// Undefined means "pi defaults", which include bash/edit/write in the coding agent.
	if (tools === undefined) return true;
	return tools.some((tool) => MUTATING_TOOLS.includes(tool.toLowerCase()));
}

/**
 * Why this ref counts as write-capable, stated in terms of its effective tools.
 * The refusal message must let a reader see that the toolset — not the agent's
 * name or prompt — is what classified it, so a name-only retry is visibly futile.
 */
export function writeCapabilityAttribution(discovery: FlowDiscovery, ref: { agent: string; tools?: string }): string {
	const tools = effectiveTools(discovery, ref);
	// Covers both an omitted tools field and an explicit tools:"default".
	if (tools === undefined) return `${ref.agent} (effective tools are pi defaults, which include ${MUTATING_TOOLS.join("/")})`;
	const mutating = (tools ?? []).filter((tool) => MUTATING_TOOLS.includes(tool.toLowerCase()));
	if (mutating.length === 0) {
		if ((tools ?? []).some((tool) => tool.toLowerCase() === "bash-ro")) return `${ref.agent} (not write-capable: bash-ro is bash under a child-enforced read-only allowlist)`;
		return `${ref.agent} (not write-capable by its effective tools)`;
	}
	return `${ref.agent} (effective tools include ${mutating.join("/")})`;
}

/**
 * The spawn gate's predicate: a call that spawns children must justify the
 * delegation with a non-empty `why`, or the tool refuses it (WHY_REQUIRED)
 * before any child starts. The selection eval imports this same function to
 * score admissibility, so the scored rule cannot drift from the enforced one.
 */
export function spawnJustificationMissing(why: unknown): boolean {
	return typeof why !== "string" || why.trim().length === 0;
}

/**
 * The surfaces that return before the spawn gate — this list must name exactly
 * the params the flow tool answers ahead of its WHY_REQUIRED check, so the
 * selection eval exempts the same calls the tool does. Adding a pre-gate
 * surface to the tool means adding it here too.
 */
export function nonSpawningFlowCall(params: { list?: unknown; showConfig?: unknown }): boolean {
	return Boolean(params?.list || params?.showConfig);
}

/** Canonical path and non-content filesystem identity bound by durable approval. */
export interface CwdTargetBinding {
	readonly path: string;
	readonly identity: string;
}

/** One cwd path plus whether it is a usable canonical directory target. */
export interface CwdTargetResolution {
	readonly path: string;
	readonly bindable: boolean;
	/** Device/inode identity hashed into approval bindings; null when no usable directory exists. */
	readonly identity: string | null;
}

/** Resolve the stable filesystem target, retaining lexical spawn behavior when no target exists. */
export function resolveCwdTarget(defaultCwd: string, cwd?: string): CwdTargetResolution {
	const lexical = path.resolve(defaultCwd, cwd ?? defaultCwd);
	let target = lexical;
	try {
		target = realpathSync.native(lexical);
		const stats = statSync(target, { bigint: true });
		const mode = Number(stats.mode);
		if (!stats.isDirectory() || (mode & 0o444) === 0 || (mode & 0o111) === 0) return { path: target, bindable: false, identity: null };
		accessSync(target, constants.R_OK | constants.X_OK);
		return { path: target, bindable: true, identity: `${stats.dev}:${stats.ino}` };
	} catch {
		// Preserve the existing spawn-time error for paths that do not yet exist.
		// Approval treats this fallback as unbound rather than authorizing a path
		// that could become a symlink before dispatch.
		return { path: target, bindable: false, identity: null };
	}
}

/** Refuse when a live cwd no longer identifies the target a receipt approved. */
export function cwdTargetDriftError(expected: CwdTargetBinding, actual: Pick<CwdTargetResolution, "path" | "identity">): FlowError | null {
	if (actual.path === expected.path && actual.identity === expected.identity) return null;
	return flowError(
		"APPROVAL_RECEIPT_STALE",
		"The approved working directory no longer identifies the same filesystem target.",
		"Its canonical path or filesystem identity changed after approval verification.",
		"Restore the approved directory target and resume, or start a fresh interactive approval.",
	);
}

/** The cwd path ordinary dispatch and containment use. */
export function resolvedCwd(defaultCwd: string, cwd?: string): string {
	return resolveCwdTarget(defaultCwd, cwd).path;
}

export function sharedWriteCwdError(discovery: FlowDiscovery, defaultCwd: string, refs: Array<{ agent: string; cwd?: string; tools?: string }>): FlowError | null {
	const byCwd = new Map<string, string[]>();
	for (const ref of refs) {
		const cwd = resolvedCwd(defaultCwd, ref.cwd);
		byCwd.set(cwd, [...(byCwd.get(cwd) ?? []), writeCapabilityAttribution(discovery, ref)]);
	}
	for (const [cwd, attributions] of byCwd) {
		if (attributions.length > 1) {
			return flowError(
				"SHARED_WRITE_CWD",
				"Multiple write-capable flow agents would share one working directory.",
				`These agents would run concurrently in ${safePath(cwd)}, which risks conflicting edits in the same checkout: ${attributions.join("; ")}. The effective toolset is what classifies a role as write-capable, so switching to a different agent name changes nothing unless its tools change too.`,
				`Serialize with concurrency:1, use agents whose effective tools exclude ${MUTATING_TOOLS.join("/")} (bash-ro, read-only-allowlisted bash, stays admissible), or give each writer a distinct cwd/worktree. Pass allowSharedWriteCwd:true only as a last resort, when concurrent writes in one shared checkout are actually intended.`,
			);
		}
	}
	return null;
}

export function validateSharedWriteCwd(
	discovery: FlowDiscovery,
	defaultCwd: string,
	refs: Array<{ agent: string; cwd?: string; tools?: string }>,
	allowSharedWriteCwd: boolean | undefined,
	concurrency: number,
): FlowError | null {
	if (allowSharedWriteCwd) return null;
	if (concurrency <= 1) return null;
	const mutating = refs.filter((ref) => canMutateWorkspace(discovery, ref));
	if (mutating.length <= 1) return null;
	return sharedWriteCwdError(discovery, defaultCwd, mutating);
}

/** A present-but-non-array dependsOn is schema-refused before the handler runs; totality over raw model args means treating it as no deps, never iterating a non-iterable. Exported for graph's plan declaration (modes/graph.ts). */
export function graphDependsOn(node: any): string[] {
	return Array.isArray(node?.dependsOn) ? node.dependsOn : [];
}

/**
 * Structural validity of a graph, as the plan reads it: node count within
 * 1..MAX_GRAPH_NODES, every node carrying a string id/agent/task, no duplicated
 * id, no non-array dependsOn, and no dependsOn naming a node that is not there.
 * Yields the nodes, or null for a graph failing any of those — so the plan
 * declares an unguarded wave and no opening, and never iterates a
 * hostile-length list.
 *
 * This is the plan's predicate only. The refusal a caller sees comes from
 * graph's own pre-spawn declaration (modes/graph.ts), which reports which
 * defect was found rather than a boolean; Core may not import Supporting, so
 * the two cannot be one function. They agree on every input the public schema
 * admits — id/agent/task are typed strings and dependsOn a string array — so
 * the shapes on which their strictness differs are refused SCHEMA_INVALID
 * before either runs.
 */
export function validGraphNodes(params: Record<string, any>): any[] | null {
	const nodes = params.graph?.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_GRAPH_NODES) return null;
	const ids = new Set<string>();
	for (const node of nodes) {
		if (typeof node?.id !== "string" || !node.id || typeof node.agent !== "string" || !node.agent || typeof node.task !== "string" || !node.task || ids.has(node.id)) return null;
		if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) return null;
		ids.add(node.id);
	}
	for (const node of nodes) {
		for (const dep of graphDependsOn(node)) {
			if (typeof dep !== "string" || !ids.has(dep)) return null;
		}
	}
	return nodes;
}

// Per-mode pre-spawn refusals are declared by the modes themselves
// (`preSpawnRefusal` on the mode table); the Core-owned predicates those
// declarations build on stay here.

export function validateConcurrency(value: number | undefined): FlowError | null {
	if (value === undefined) return null;
	if (!Number.isInteger(value)) {
		return flowError(
			"INVALID_CONCURRENCY",
			`Invalid concurrency: ${value}.`,
			"Concurrency must be an integer so queueing is deterministic.",
			`Use an integer from 1 to ${MAX_PARALLEL_TASKS}, or omit concurrency to use ${DEFAULT_CONCURRENCY}.`,
		);
	}
	if (value < 1 || value > MAX_PARALLEL_TASKS) {
		return flowError(
			"INVALID_CONCURRENCY",
			`Invalid concurrency: ${value}.`,
			`Concurrency must be between 1 and ${MAX_PARALLEL_TASKS}.`,
			`Use an integer from 1 to ${MAX_PARALLEL_TASKS}, or omit concurrency to use ${DEFAULT_CONCURRENCY}.`,
		);
	}
	return null;
}

export function normalizeTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
	return Math.floor(timeoutMs);
}

export function clampIterations(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_EVALUATE_ITERATIONS;
	return Math.max(1, Math.min(MAX_EVALUATE_ITERATIONS, Math.floor(value)));
}

export function clampLoopIterations(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_LOOP_ITERATIONS;
	return Math.max(1, Math.min(MAX_LOOP_ITERATIONS, Math.floor(value)));
}

/** Current flow nesting depth from PI_FLOWS_DEPTH, clamped to a non-negative integer so hostile or garbage env values cannot disable the depth guard. */
export function currentFlowDepth(): number {
	const raw = Number(process.env.PI_FLOWS_DEPTH);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}
