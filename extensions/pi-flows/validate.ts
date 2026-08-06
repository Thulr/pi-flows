import * as path from "node:path";
import { DEFAULT_CONCURRENCY, DEFAULT_EVALUATE_ITERATIONS, DEFAULT_LOOP_ITERATIONS, DEFAULT_TIMEOUT_MS, MAX_EVALUATE_ITERATIONS, MAX_LOOP_ITERATIONS, MAX_PARALLEL_TASKS, flowError, type FlowDiscovery, type FlowError } from "./types.ts";
import { safePath } from "./sanitize.ts";
import { searchTopology } from "./topology.ts";

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

type SharedWriteRef = { agent: string; cwd?: string; tools?: string };

/**
 * Model-controlled params may put anything where a ref list belongs — a
 * non-array, or nulls and scalars among the refs. The mirror sees such args
 * before any schema validation, so it keeps only refs that actually name an
 * agent: a malformed list is a smaller (or empty) wave, never a crash, and
 * dropping agent-less entries changes no verdict because an unnamed ref can
 * never resolve to a write-capable toolset. The tool itself refuses these
 * calls at its schema layer — a refusal outside this seam's vocabulary.
 */
function refArray(value: unknown): SharedWriteRef[] {
	if (!Array.isArray(value)) return [];
	return value.filter((ref): ref is SharedWriteRef =>
		Boolean(ref) && typeof ref === "object" && !Array.isArray(ref) && typeof (ref as { agent?: unknown }).agent === "string");
}

/**
 * The concurrent ref waves a call would run before any child spawns, derived
 * from call params exactly as each guard-bearing mode handler derives the refs
 * it passes to validateSharedWriteCwd ahead of its first spawn. Modes that
 * never run concurrent same-cwd children (single, chain, route, loop,
 * workflow, monitor, worktree — each writer gets its own worktree) contribute
 * nothing, and so does orchestrate, whose guard fires only after its recon
 * child has already run. A call activating several modes at once is refused by
 * the tool (INVALID_MODE) — the selection eval's admissibility seam scores
 * that with detectRunMode itself; a standalone caller of this mirror gets
 * first-activator semantics, in modeOf's order. Refusals that land before a
 * handler's guard stay silent here rather than being mislabeled as the guard:
 * an oversized fan-out (TOO_MANY_TASKS) yields no wave, like an invalid
 * concurrency below. Remaining pre-guard refusals that cannot collide anyway
 * (TOO_FEW_VOTERS and kin) need no special case. Callers feed it
 * model-emitted args verbatim, so every derivation must be total — malformed
 * shapes yield empty waves, not throws. tests/admissibility-scoring.test.ts
 * pins each derivation against the real handler, so a handler edit that moves
 * or reshapes a guard fails a test instead of silently drifting from this
 * mirror.
 */
export function preSpawnSharedWriteWaves(params: Record<string, any>): SharedWriteRef[][] {
	if (Array.isArray(params?.tasks) && params.tasks.length > 0) {
		// The handler refuses TOO_MANY_TASKS before its guard; stay silent
		// behind that earlier refusal (and never iterate a hostile-length list).
		return params.tasks.length > MAX_PARALLEL_TASKS ? [] : [refArray(params.tasks)];
	}
	if (params?.evaluate !== undefined) {
		const spec = params.evaluate ?? {};
		const evaluators = (Array.isArray(spec.redteam) ? spec.redteam : [spec.redteam ?? { agent: "redteam" }])
			.filter((ref: any): ref is SharedWriteRef => Boolean(ref) && typeof ref.agent === "string")
			.slice(0, MAX_PARALLEL_TASKS);
		return [evaluators.length > 0 ? evaluators : [{ agent: "redteam" }]];
	}
	if (params?.vote !== undefined) {
		const spec = params.vote ?? {};
		if (Array.isArray(spec.voters) && spec.voters.length > 0) {
			// TOO_MANY_TASKS refuses an oversized voter list before the guard;
			// stay silent behind it, exactly as for parallel tasks.
			return spec.voters.length > MAX_PARALLEL_TASKS ? [] : [refArray(spec.voters)];
		}
		// Same ref hygiene as refArray: a non-string agent can never name a
		// toolset (the schema rejects it), so replicating it would only put
		// non-refs in the wave.
		if (typeof spec.agent === "string" && spec.agent) {
			// The handler builds voters before its TOO_MANY_TASKS check, but the
			// refusal still lands before the guard, so an over-cap count is
			// silent here too — and a hostile count never allocates.
			const count = Number.isFinite(spec.count) ? Math.floor(spec.count) : 3;
			if (count > MAX_PARALLEL_TASKS) return [];
			return [Array.from({ length: Math.max(count, 0) }, () => ({ agent: spec.agent as string }))];
		}
		return [];
	}
	if (params?.graph !== undefined) {
		// Only the first wave is knowable pre-spawn: nodes with no dependencies.
		return [(refArray(params.graph?.nodes) as Array<SharedWriteRef & { dependsOn?: string[] }>).filter((node) => (node?.dependsOn ?? []).length === 0)];
	}
	if (params?.search !== undefined) {
		const spec = params.search ?? {};
		// The same object-with-agent rule refArray applies: a garbage ref cannot
		// name a toolset, so falling back to the handler's default is
		// verdict-neutral and keeps the emitted waves actual refs.
		const generator = refArray([spec.generator])[0] ?? { agent: "strategist" };
		const scorer = refArray([spec.scorer])[0] ?? { agent: "redteam", tools: "none" };
		const { candidateCount } = searchTopology(spec);
		return [
			Array.from({ length: candidateCount }, () => generator),
			Array.from({ length: candidateCount }, () => scorer),
		];
	}
	if (params?.debate !== undefined) return [refArray(params.debate?.participants)];
	if (params?.dossier !== undefined) return [refArray(params.dossier?.sections)];
	return [];
}

/**
 * Would the shared-write guard refuse this call before any child spawns? The
 * selection eval imports this beside spawnJustificationMissing so "would the
 * tool have refused this call" stays one uniform question across refusal
 * codes, answered by the tool's own guard (validateSharedWriteCwd) over the
 * same waves the handlers check.
 */
export function preSpawnSharedWriteRefusal(discovery: FlowDiscovery, defaultCwd: string, params: Record<string, any>): FlowError | null {
	// The dispatch core refuses an invalid concurrency (INVALID_CONCURRENCY)
	// before any handler guard runs, so the guard can never fire behind one;
	// answering SHARED_WRITE_CWD for such a call would mislabel the refusal.
	// The concurrency bound itself is scored by the admissibility seam.
	if (validateConcurrency(params?.concurrency)) return null;
	const concurrency = params?.concurrency ?? DEFAULT_CONCURRENCY;
	for (const wave of preSpawnSharedWriteWaves(params)) {
		const error = validateSharedWriteCwd(discovery, defaultCwd, wave, params?.allowSharedWriteCwd, concurrency);
		if (error) return error;
	}
	return null;
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
