import { MAX_PARALLEL_TASKS, type FlowRunResult } from "../types.ts";

// The plan vocabulary (CONTEXT.md: Wave). A mode's topology used to be written
// five times — the handler, the requested-agents lambda, the shared-write
// mirror, the budget-disclosure switch, and the critical-path if-chain — with
// only two of the writings checked. Now each mode declares its plan once, next
// to its handler, and every reader derives from the declaration through the
// mode table (modes/contract.ts, which also holds the table-derived readers).
// This module holds only the vocabulary and the arithmetic the declarations
// share; it imports nothing above the kernel, so mode files can use it without
// an import cycle through the table.

/**
 * One planned role: the FlowAgentRefInput-shaped fields the pre-spawn readers
 * consume — sanitized to string-typed values by {@link plannedRefs} — plus any
 * delegation contract the ref carries. Kept bare (no plan-level markers) so a
 * planned ref compares equal to the ref a caller wrote.
 */
export interface PlannedRef {
	agent: string;
	cwd?: string;
	tools?: string;
	/** The delegation contract this ref carries, kept when object-shaped: the guard ignores it, but the disclosure and eval readers consume it. */
	contract?: Record<string, unknown>;
}

/**
 * One step of a mode's planned topology: the roles that would run at that step
 * (CONTEXT.md: Wave — the planned concurrent set; a stage is what the step
 * becomes in the trace). A wave lists roles, not spawns: a routing step lists
 * every candidate though one runs, and a debate wave repeats per round.
 */
export interface PlannedWave {
	refs: PlannedRef[];
	/**
	 * True when the handler passes exactly these refs to the shared-write guard
	 * (validateSharedWriteCwd) before its first spawn. False both for waves the
	 * guard never sees (sequential steps, debrief tails) and for waves an
	 * earlier refusal shadows — an over-cap fan-out is refused TOO_MANY_TASKS
	 * (or at the schema layer) before the guard runs, so its wave stays
	 * declared for the requested-agents and disclosure readers while the
	 * admissibility mirror stays silent behind the earlier refusal.
	 */
	guarded: boolean;
	/**
	 * Which delegation contract governs this wave's runs, when the mode
	 * enforces contract budgets on them: "own" — each ref's own contract only
	 * (the integrationRunPlan modes with no fallback) — or "resolved" — the
	 * ref's own contract else the call's fallback (resolveDelegationContract).
	 * Absent where the mode dispatches the wave with no contract limits, so an
	 * inactive contract-shaped field is never advertised as an enforcement
	 * boundary (budget-disclosure.ts).
	 */
	contracts?: "own" | "resolved";
}

/**
 * What one mode plans for one call, declared as a total function over
 * arbitrary params (an inactive or malformed call plans smaller waves, never a
 * throw — requested-agent scans union every mode's plan over the same raw
 * params).
 */
export interface ModePlan {
	/** The mode's roles in spawn order, grouped into waves where the grouping is pre-spawn-knowable. */
	waves: PlannedWave[];
	/**
	 * The refs statically certain to spawn before anything else — what the
	 * selection eval's roster rule judges. Empty where no spawn is certain:
	 * monitor's reactor waits on a probe that may never trip, worktree's
	 * writers wait on a repository scan, and a workflow resume reads persisted
	 * state this static plan cannot.
	 */
	opening: PlannedRef[];
}

/** A mode's plan declaration, wired into the table beside its handler. */
export type ModePlanFn = (params: any) => ModePlan;

/**
 * A mode's critical-path arithmetic over its settled runs, wired into the
 * table beside its handler. Returns undefined where the metric is not
 * derivable — a declared answer, not a fall-through.
 */
export type ModeCriticalPathFn = (params: any, results: FlowRunResult[]) => number | undefined;

/**
 * Model-controlled params may put anything where a ref list belongs — a
 * non-array, nulls and scalars among the refs, or garbage in a ref's own
 * fields. Plans see such args before any schema validation, so this keeps
 * only refs that actually name an agent and rebuilds each with only the
 * string-typed fields the guard path consumes (parseToolsOverride trims
 * tools; resolvedCwd resolves cwd): a malformed list is a smaller (or empty)
 * wave and a malformed field is an absent one, never a crash. Dropping
 * agent-less entries changes no verdict because an unnamed ref can never
 * resolve to a write-capable toolset. The tool itself refuses these calls at
 * its schema layer — a refusal outside the plan's vocabulary.
 */
/**
 * Whether a fan-out list stays inside MAX_PARALLEL_TASKS — the one shape of
 * every plan's guarded marker for a cap-refusable wave. An over-cap fan-out is
 * refused (TOO_MANY_TASKS, or at the schema layer) before the shared-write
 * guard runs, so its wave stays declared but unguarded.
 */
export function withinFanoutCap(list: unknown): boolean {
	return !(Array.isArray(list) && list.length > MAX_PARALLEL_TASKS);
}

export function plannedRefs(value: unknown): PlannedRef[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((ref): PlannedRef[] => {
		if (!ref || typeof ref !== "object" || Array.isArray(ref)) return [];
		const { agent, cwd, tools, contract } = ref as { agent?: unknown; cwd?: unknown; tools?: unknown; contract?: unknown };
		if (typeof agent !== "string") return [];
		return [{
			agent,
			...(typeof cwd === "string" ? { cwd } : {}),
			...(typeof tools === "string" ? { tools } : {}),
			...(contract && typeof contract === "object" && !Array.isArray(contract) ? { contract: contract as Record<string, unknown> } : {}),
		}];
	});
}

/** A run's non-negative duration; a missing measurement counts as zero rather than poisoning a sum. */
export function runDuration(result: FlowRunResult | undefined): number {
	return Math.max(0, result?.durationMs ?? 0);
}

/** Sequential topology: every run on the path, end to end. */
export function sumRunDurations(results: FlowRunResult[]): number {
	return results.reduce((sum, result) => sum + runDuration(result), 0);
}

/** Concurrent topology: the slowest run bounds the wave. */
export function maxRunDuration(results: FlowRunResult[]): number {
	return Math.max(0, ...results.map(runDuration));
}

/** Fan-out wave then a sequential tail: the slowest fan-out run plus every run after it. */
export function fanoutThenTailCriticalPath(results: FlowRunResult[], fanoutCount: number): number {
	const fanout = results.slice(0, Math.max(0, fanoutCount));
	return maxRunDuration(fanout) + sumRunDurations(results.slice(fanout.length));
}
