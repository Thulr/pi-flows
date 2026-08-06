import * as path from "node:path";
import { DEFAULT_CONCURRENCY, DEFAULT_EVALUATE_ITERATIONS, DEFAULT_LOOP_ITERATIONS, DEFAULT_TIMEOUT_MS, MAX_EVALUATE_ITERATIONS, MAX_LOOP_ITERATIONS, MAX_PARALLEL_TASKS, flowError, type FlowDiscovery, type FlowError } from "./types.ts";
import { safePath } from "./sanitize.ts";

export function parseToolsOverride(tools: string | undefined, fallback: string[] | undefined): string[] | undefined {
	if (!tools) return fallback;
	if (tools.trim().toLowerCase() === "default") return undefined;
	if (tools.trim().toLowerCase() === "none") return [];
	return tools
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

export function appendReturnRequirements(task: string, requirements: string | undefined, requireEvidence: boolean | undefined): string {
	const sections: string[] = [];
	if (requirements?.trim()) sections.push(requirements.trim());
	if (requireEvidence) {
		sections.push("Ground every load-bearing claim in concrete evidence: file:line references, command output, citations, or explicit gaps when evidence is unavailable.");
	}
	if (sections.length === 0) return task;
	return [task, "\n## Return requirements", ...sections.map((section) => `- ${section}`)].join("\n");
}

/** Compatibility alias for the original helper name; prefer appendReturnRequirements. */
export const appendReturnContract = appendReturnRequirements;

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
	if (mutating.length === 0) return `${ref.agent} (not write-capable by its effective tools)`;
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

export function resolvedCwd(defaultCwd: string, cwd?: string): string {
	return path.resolve(defaultCwd, cwd ?? defaultCwd);
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
				`Serialize with concurrency:1, use agents whose effective tools exclude ${MUTATING_TOOLS.join("/")}, or give each writer a distinct cwd/worktree. Pass allowSharedWriteCwd:true only as a last resort, when concurrent writes in one shared checkout are actually intended.`,
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
