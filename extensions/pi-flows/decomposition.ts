import { Type } from "typebox";
import { MAX_SUBTASKS, flowError, type FlowDiscovery, type FlowError } from "./types.ts";
import { concurrentSubtasks, findCycle } from "./decomposition-graph.ts";
import { extractLastJsonBlock, parseSubtasks, readIntegrationControl } from "./protocol.ts";
import { validateSharedWriteCwd } from "./validate.ts";

/**
 * The Decomposition (CONTEXT.md): the breakdown a commander returns for a goal —
 * subtasks, plus any dependency edges between them. This module is the one home
 * for the type, the parser that normalizes both emission paths into it, and the
 * deterministic validator that runs after the commander settles and before any
 * worker spawns.
 *
 * Why one module rather than a few lines inside orchestrate: a Decomposition
 * arrives as untrusted model output and then decides how many children spawn,
 * in what order, and in which working directory. That is the same class of
 * admission decision the flow's other gates make, so it is stated once, as a
 * total function over raw model output, rather than as handler branches a second
 * mode would have to re-derive. Orchestrate is the only consumer today.
 *
 * The split between parsing and validating is deliberate and mirrors the Return
 * taxonomy (return-types.ts): the parser is tolerant and total — it normalizes
 * whatever the commander wrote, retaining defects such as an `agent` field or a
 * malformed `dependsOn` rather than dropping them — and the validator is the one
 * place a defect becomes a refusal. A dropped field cannot be refused.
 *
 * Deliberately not called a "plan": that word names a mode's declared pre-spawn
 * waves (modes/plan.ts) and the admitted dispatch capability (integration.ts).
 * Subtasks are deliberately not "nodes": that word names graph mode's
 * author-supplied units.
 */

/** How the commander emitted the Decomposition. The shape decides two things nothing else does: whether the ceiling slices (only a flat list may lose entries, because it has no edges to sever) and how a subtask's span key is derived. */
export type DecompositionShape = "flat" | "structured";

/**
 * One subtask of a Decomposition, normalized. `id` and `objective` are required
 * of a valid subtask but are typed as plain strings and left empty when the
 * commander wrote none, so the parser stays total and the validator reports
 * which entry was defective.
 *
 * A subtask never names its agent: every subtask of one Decomposition runs the
 * orchestrate worker role. `declaredAgent` exists only so an attempt to name one
 * survives parsing far enough to be refused.
 */
export interface DecompositionSubtask {
	/** Unique within the Decomposition. Synthesized positionally for a flat list; author-supplied for a structured one. */
	readonly id: string;
	/** What this subtask is to achieve. Empty when the commander declared none. */
	readonly objective: string;
	/** Ids of the subtasks whose output this subtask needs. Empty for a flat list. */
	readonly dependsOn: readonly string[];
	/** Prose bounds on the subtask, carried into the worker prompt. */
	readonly scope?: string;
	/** What the subtask must not do, carried into the worker prompt. */
	readonly nonGoals?: string;
	/** Starting material the worker is given, carried into the worker prompt. */
	readonly inputs?: string;
	/** Per-subtask prose return requirements, composed with the mode's workerReturnRequirements. */
	readonly expectedReturn?: string;
	/** What evidence makes this subtask's return acceptable, carried into the worker prompt. */
	readonly acceptanceEvidence?: string;
	/** An `agent` the entry named. Retained for refusal, never dispatched. */
	readonly declaredAgent?: string;
	/** True when the entry declared `dependsOn` in a shape that is not a list of subtask ids. */
	readonly malformedDependsOn: boolean;
	/**
	 * The commander's relative effort estimate for this subtask, an integer
	 * {@link MIN_EFFORT_WEIGHT}..{@link MAX_EFFORT_WEIGHT}. Absent means 1. The
	 * budget headroom projection multiplies the remaining weight by the observed
	 * spend per unit of weight, so a weight ranks subtasks against each other —
	 * it is never a token or cost figure itself.
	 */
	readonly effortWeight?: number;
	/** True when the entry declared `effortWeight` in a shape that is not an integer in the accepted range. */
	readonly malformedEffortWeight: boolean;
}

/** A commander's breakdown of one goal, normalized from either emission path. A flat subtask list is a Decomposition with no edges. */
export interface Decomposition {
	readonly shape: DecompositionShape;
	readonly subtasks: readonly DecompositionSubtask[];
}

/** Build the established no-subtasks refusal for an initial or replacement commander result. */
export function unusableDecompositionError(attempt: "initial" | "replacement" = "initial"): FlowError {
	return flowError(
		"ORCHESTRATE_NO_SUBTASKS",
		"Decomposer did not return a usable subtask list.",
		"The decomposer output contained no non-empty usable JSON array of subtasks.",
		attempt === "initial"
			? "Tighten the decomposer task to require a JSON array of either subtask strings or subtask objects, or use chain/single mode for work that does not decompose."
			: "For a Decomposition, require a JSON array of subtask strings or objects. For work that does not decompose, use chain or single mode.",
	);
}

/** Map every prose field while preserving the admitted ids, shape, and dependency edges. */
export function mapDecompositionProse(decomposition: Decomposition, map: (text: string) => string): Decomposition {
	const optional = (text: string | undefined) => text === undefined ? undefined : map(text);
	return {
		...decomposition,
		subtasks: decomposition.subtasks.map((subtask) => ({
			...subtask,
			objective: map(subtask.objective),
			scope: optional(subtask.scope),
			nonGoals: optional(subtask.nonGoals),
			inputs: optional(subtask.inputs),
			expectedReturn: optional(subtask.expectedReturn),
			acceptanceEvidence: optional(subtask.acceptanceEvidence),
		})),
	};
}

/**
 * The charset a commander-chosen subtask id must match, and the length it must
 * stay under.
 *
 * An id is not prose: it addresses a dependency edge, it becomes a span unit
 * key, and it is written into the headings of a dependent worker's prompt and
 * of the debrief's not-completed manifest. Commander output is untrusted there,
 * so an id carrying a newline could forge a heading — a whole "## Output of
 * subtask x" section the commander never earned — inside a prompt the worker
 * reads as the flow's own words.
 *
 * The charset is the one `PROTOCOL.route` already fixes for a model-supplied
 * control token (protocol.ts), plus the rule that an id opens on a letter or a
 * digit, so no id can read as a flag or a separator.
 */
const SUBTASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_SUBTASK_ID_LENGTH = 64;

/**
 * The range an effort weight must sit in. Five steps, because the weight is a
 * relative ranking the headroom projection scales an *observed* spend by:
 * uniform misestimation cancels out entirely, so extra resolution would only
 * invite false precision the commander does not have.
 */
export const MIN_EFFORT_WEIGHT = 1;
export const MAX_EFFORT_WEIGHT = 5;

/** The total effort weight of these subtasks, with an absent weight counting as 1. */
export function decompositionEffortWeight(subtasks: readonly DecompositionSubtask[]): number {
	return subtasks.reduce((total, subtask) => total + (subtask.effortWeight ?? MIN_EFFORT_WEIGHT), 0);
}

/** A prose subtask field, in either form the parser reads: one string, or the lines a model split it into. */
const ProseField = (description: string) => Type.Union([Type.String(), Type.Array(Type.String())], { description });

/**
 * The published return schema for a contracted commander: set it as
 * `orchestrate.commander.contract.returnSchema` and the commander's envelope
 * `data` is checked against it before {@link parseDecomposition} ever sees it.
 * The same validator runs on both emission paths, so a contracted commander
 * gains earlier, schema-level feedback rather than different rules.
 *
 * Both accepted shapes are named here because both are accepted back: an array
 * of subtask strings, or an array of subtask objects. Every prose field admits
 * the list form as well as the string, because {@link parseDecomposition} reads
 * both: a schema narrower than the parser would refuse a contracted commander
 * for writing what an uncontracted one may write.
 *
 * `agent` is not forbidden by the schema — a subtask that names one is refused
 * by {@link validateDecomposition}, which can say why. An unusable id is
 * refused there too: the charset is stated here so a contracted commander reads
 * it in the schema, but only the validator can name the offending subtask.
 */
export const FlowDecompositionReturn = Type.Array(
	Type.Union([
		Type.String({ minLength: 1, description: "One independent subtask, stated as prose. Use this shape when no subtask needs another subtask's output." }),
		Type.Object({
			id: Type.String({
				minLength: 1,
				maxLength: MAX_SUBTASK_ID_LENGTH,
				pattern: SUBTASK_ID_PATTERN.source,
				description: `Unique subtask id. Other subtasks reference it through dependsOn. Start it with a letter or a digit, then use letters, digits, "_", "." or "-" only, up to ${MAX_SUBTASK_ID_LENGTH} characters.`,
			}),
			objective: Type.Union([Type.String({ minLength: 1 }), Type.Array(Type.String(), { minItems: 1 })], { description: "What this subtask is to achieve." }),
			dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Ids of the subtasks whose output this subtask needs. Omit for independent work." })),
			effortWeight: Type.Optional(Type.Integer({
				minimum: MIN_EFFORT_WEIGHT,
				maximum: MAX_EFFORT_WEIGHT,
				description: `Relative effort of this subtask against its siblings, integer ${MIN_EFFORT_WEIGHT}..${MAX_EFFORT_WEIGHT}. Omitted means ${MIN_EFFORT_WEIGHT}. Not a token or cost figure.`,
			})),
			scope: Type.Optional(ProseField("Prose bounds on this subtask.")),
			nonGoals: Type.Optional(ProseField("What this subtask must not do.")),
			inputs: Type.Optional(ProseField("Starting material for this subtask.")),
			expectedReturn: Type.Optional(ProseField("Prose return requirements for this subtask alone.")),
			acceptanceEvidence: Type.Optional(ProseField("The evidence that makes this subtask's return acceptable.")),
		}),
	]),
	{ description: "A Decomposition: either a flat array of subtask strings, or an array of subtask objects that may declare dependency edges. Do not mix the two shapes." },
);

/** Fields that only a structured entry carries. One of them present anywhere in the array is what makes the array structured. */
const STRUCTURED_FIELDS = ["id", "objective", "dependsOn", "agent", "scope", "nonGoals", "inputs", "expectedReturn", "acceptanceEvidence", "effortWeight"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Does this entry belong to a structured Decomposition? A bare string and the
 * legacy `{ task }` wrapper do not: `parseSubtasks` has always read both as
 * plain subtask text, and reading them any other way now would change what
 * today's commanders mean.
 */
function isStructuredEntry(entry: unknown): boolean {
	return isRecord(entry) && STRUCTURED_FIELDS.some((field) => Object.hasOwn(entry, field));
}

/** A prose field as the commander may write it: a string, or a list of strings a model split into bullets. */
function prose(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (Array.isArray(value)) {
		const lines = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
		return lines.length > 0 ? lines.join("\n") : undefined;
	}
	return undefined;
}

function structuredSubtask(entry: unknown): DecompositionSubtask {
	const record = isRecord(entry) ? entry : {};
	const declaredDependsOn = record.dependsOn;
	const dependsOn = Array.isArray(declaredDependsOn)
		? declaredDependsOn.filter((dep): dep is string => typeof dep === "string" && Boolean(dep.trim())).map((dep) => dep.trim())
		: [];
	// A null dependsOn is JSON's way of writing "none", not a defect; anything
	// else that is not a list of ids is one, and stays visible for refusal.
	const malformedDependsOn = declaredDependsOn !== undefined && declaredDependsOn !== null
		&& (!Array.isArray(declaredDependsOn) || declaredDependsOn.length !== dependsOn.length);
	// The same null rule as dependsOn: null means "unweighted", anything else
	// outside an integer in range is a defect the validator names.
	const declaredWeight = record.effortWeight;
	const effortWeight = typeof declaredWeight === "number" && Number.isInteger(declaredWeight)
		&& declaredWeight >= MIN_EFFORT_WEIGHT && declaredWeight <= MAX_EFFORT_WEIGHT
		? declaredWeight
		: undefined;
	const malformedEffortWeight = declaredWeight !== undefined && declaredWeight !== null && effortWeight === undefined;
	return {
		// An id is a key, not prose: only a string can be one.
		id: typeof record.id === "string" ? record.id.trim() : "",
		// `task` is accepted as an objective alias: it is the field name the
		// legacy protocol taught commanders, and a structured entry that keeps it
		// is stating an objective, not a defect.
		objective: prose(record.objective) ?? prose(record.task) ?? "",
		dependsOn,
		scope: prose(record.scope),
		nonGoals: prose(record.nonGoals),
		inputs: prose(record.inputs),
		expectedReturn: prose(record.expectedReturn),
		acceptanceEvidence: prose(record.acceptanceEvidence),
		declaredAgent: prose(record.agent),
		malformedDependsOn,
		...(effortWeight !== undefined ? { effortWeight } : {}),
		malformedEffortWeight,
	};
}

/**
 * Read a commander's output as one Decomposition, from either emission path
 * (validated envelope data, or the legacy fenced JSON block) and in either shape.
 *
 * A flat list keeps today's behavior exactly, by delegating to
 * {@link parseSubtasks}: the same tolerance for `{ task }` entries, and the same
 * silent slice to `maxSubtasks`. Slicing is safe there and only there, because a
 * flat list has no edges to sever; a structured list over the ceiling is left
 * whole for {@link validateDecomposition} to refuse.
 *
 * Ids for a flat list are synthesized positionally ("1", "2", …) so every
 * Decomposition is addressable by id regardless of shape.
 *
 * Returns null when the output carries no usable array at all — the caller's
 * ORCHESTRATE_NO_SUBTASKS case, not a defect this module refuses.
 */
export function parseDecomposition(value: unknown, maxSubtasks: number): Decomposition | null {
	const control = readIntegrationControl(value);
	const array = control.legacy ? extractLastJsonBlock(control.data as string) : control.data;
	if (!Array.isArray(array) || array.length === 0) return null;
	if (!array.some(isStructuredEntry)) {
		const tasks = parseSubtasks(value, maxSubtasks);
		if (!tasks) return null;
		return {
			shape: "flat",
			subtasks: tasks.map((objective, index) => ({ id: String(index + 1), objective, dependsOn: [], malformedDependsOn: false, malformedEffortWeight: false })),
		};
	}
	return { shape: "structured", subtasks: array.map(structuredSubtask) };
}

/** What the shared-write half of validation needs: the single worker role every subtask runs, and the call's own gate inputs. */
export interface DecompositionAdmission {
	readonly discovery: FlowDiscovery;
	readonly defaultCwd: string;
	/** The one worker role every subtask of this Decomposition runs. */
	readonly workerRef: { agent: string; cwd?: string; tools?: string };
	readonly allowSharedWriteCwd?: boolean;
	readonly concurrency: number;
	/** Total subtask ceiling for this call. */
	readonly maxSubtasks: number;
	/**
	 * Ids of subtasks that already succeeded when this Decomposition is a
	 * mid-flow revision. A revision subtask may depend on one — the dependency
	 * resolves as satisfied and its output hands off — but may not redefine one:
	 * the work already ran, and a second subtask under its id would make every
	 * edge naming it ambiguous. Absent for an initial Decomposition.
	 */
	readonly satisfiedIds?: ReadonlySet<string>;
}

function invalid(message: string, cause: string, fix: string): FlowError {
	return flowError("DECOMPOSITION_INVALID", message, cause, fix);
}

/**
 * An id as a refusal may quote it: JSON-escaped, so the id that earned the
 * refusal cannot forge a line of the message that reports it, and shortened, so
 * a runaway id cannot crowd out the cause and the fix beside it.
 */
function quoteId(id: string): string {
	return JSON.stringify(id.length > MAX_SUBTASK_ID_LENGTH ? `${id.slice(0, MAX_SUBTASK_ID_LENGTH)}…` : id);
}

/**
 * Refuse an inadmissible Decomposition, deterministically, after the commander
 * settles and before any worker spawns. Returns null when the Decomposition may
 * be dispatched.
 *
 * What it refuses, and why each is a refusal rather than a repair:
 * - a defective subtask (no id, an id outside {@link SUBTASK_ID_PATTERN},
 *   duplicate id, no objective, a named agent, a malformed dependsOn, a
 *   malformed effortWeight) —
 *   DECOMPOSITION_INVALID. Repairing any of these would invent work the
 *   commander did not ask for; repairing an id in particular would rewrite the
 *   key its own dependency edges are addressed by.
 * - a dependsOn naming a subtask that is not in the Decomposition —
 *   DECOMPOSITION_INVALID. The edge cannot be honored and dropping it would
 *   run the dependent subtask without the input it declared it needs.
 * - any dependency cycle — DECOMPOSITION_CYCLE. Detected in full, not merely as
 *   "no first wave exists": a cycle among later subtasks would otherwise strand
 *   them after their peers had already spent their budget.
 * - a structured Decomposition over the ceiling — DECOMPOSITION_INVALID. Only a
 *   flat list may be sliced; slicing a structured one severs edges.
 * - an inadmissible shared-write topology across the whole Decomposition. Every
 *   subtask runs the one worker role, so this reduces to: that role is
 *   write-capable, two subtasks are dependency-independent, concurrency permits
 *   parallelism, and allowSharedWriteCwd is unset. The rule itself is
 *   {@link validateSharedWriteCwd}'s, called with one ref per concurrent
 *   subtask, so the refusal a caller reads here is the same refusal the wave
 *   gate produces. That per-wave gate stays in place as the backstop; this check
 *   exists so a topology that can never be admitted is refused before the first
 *   wave spends anything.
 *
 * Coverage gaps and overlapping subtask scope are deliberately not refused:
 * neither is decidable without reading the goal, and a deterministic gate that
 * guesses at them would refuse good decompositions.
 */
export function validateDecomposition(decomposition: Decomposition, admission: DecompositionAdmission): FlowError | null {
	// An empty Decomposition never reaches here: parseDecomposition returns null
	// for output carrying no usable entries, which is the caller's
	// ORCHESTRATE_NO_SUBTASKS case rather than a defect this validator names.
	const { subtasks } = decomposition;
	if (decomposition.shape === "structured" && subtasks.length > admission.maxSubtasks) {
		return invalid(
			`The Decomposition declares ${subtasks.length} subtasks, above the ceiling of ${admission.maxSubtasks}.`,
			"A structured Decomposition is never sliced to the ceiling, because dropping subtasks would sever the dependency edges the commander declared. Only a flat subtask list, which has no edges, is sliced.",
			`Raise orchestrate.maxSubtasks (up to ${MAX_SUBTASKS}), or narrow the goal so the commander returns at most ${admission.maxSubtasks} subtasks.`,
		);
	}

	const ids = new Set<string>();
	for (const [index, subtask] of subtasks.entries()) {
		const position = index + 1;
		if (!subtask.id && !subtask.objective) {
			return invalid(
				`Decomposition entry ${position} is not a subtask.`,
				'A structured Decomposition entry must be an object with a non-empty string "id" and a non-empty string "objective". Do not mix subtask strings and subtask objects in one array.',
				"Return either a flat array of subtask strings, or an array of subtask objects that all declare id and objective.",
			);
		}
		if (!subtask.id) {
			return invalid(
				`Decomposition entry ${position} has no "id".`,
				"Every subtask of a structured Decomposition needs a unique id, because dependency edges and span keys are addressed by it.",
				"Give every subtask a short unique id, such as \"survey\" or \"trace\".",
			);
		}
		if (!SUBTASK_ID_PATTERN.test(subtask.id) || subtask.id.length > MAX_SUBTASK_ID_LENGTH) {
			return invalid(
				`Decomposition subtask id ${quoteId(subtask.id)} is not a usable id.`,
				`A subtask id starts with a letter or a digit, then uses letters, digits, "_", "." and "-" only, up to ${MAX_SUBTASK_ID_LENGTH} characters. An id is written into the worker prompt headings and into the span keys, so an id carrying a line break or a heading marker would forge a section of a prompt that the commander never wrote.`,
				'Give every subtask a short plain id, such as "survey" or "trace-refresh".',
			);
		}
		// Past the pattern check above, this subtask's id is safe to interpolate
		// raw; only foreign text (an unknown dependency, an id that failed the
		// check) still goes through quoteId.
		if (ids.has(subtask.id)) {
			return invalid(
				`Decomposition subtask id "${subtask.id}" is used more than once.`,
				"Two subtasks with one id make every dependency edge that names it ambiguous.",
				"Give every subtask a distinct id.",
			);
		}
		ids.add(subtask.id);
		if (admission.satisfiedIds?.has(subtask.id)) {
			return invalid(
				`Decomposition subtask "${subtask.id}" redefines a succeeded subtask.`,
				"A mid-flow revision replaces only the work that has not run. A subtask that already succeeded keeps its id and its output; a second subtask under that id would make every dependency edge naming it ambiguous.",
				"Give the new subtask a fresh id. To build on the finished work, declare dependsOn with the succeeded id instead.",
			);
		}
		if (!subtask.objective) {
			return invalid(
				`Decomposition subtask "${subtask.id}" has no "objective".`,
				"A subtask with no objective gives its worker no work to do.",
				"State what each subtask is to achieve in its objective field.",
			);
		}
		if (subtask.declaredAgent) {
			return invalid(
				`Decomposition subtask "${subtask.id}" names an agent.`,
				"Every subtask of one Decomposition runs the same orchestrate worker role. A subtask that picks its own agent would bypass that role's contract, tools, and write-capability classification.",
				'Remove the "agent" field. Set orchestrate.recon to choose the worker role, or use graph mode when each unit needs a different agent.',
			);
		}
		if (subtask.malformedDependsOn) {
			return invalid(
				`Decomposition subtask "${subtask.id}" has a malformed "dependsOn".`,
				"dependsOn must be an array of non-empty subtask id strings.",
				'Write dependsOn as an array of ids, such as ["survey"], or omit it for independent work.',
			);
		}
		if (subtask.malformedEffortWeight) {
			return invalid(
				`Decomposition subtask "${subtask.id}" has a malformed "effortWeight".`,
				`effortWeight must be an integer from ${MIN_EFFORT_WEIGHT} to ${MAX_EFFORT_WEIGHT}. It ranks a subtask's effort against its siblings; the budget headroom projection scales observed spend by it, so a value outside the range would be a guess the projection cannot honor.`,
				`Write effortWeight as an integer from ${MIN_EFFORT_WEIGHT} to ${MAX_EFFORT_WEIGHT}, or omit it for an ordinary subtask (weight ${MIN_EFFORT_WEIGHT}).`,
			);
		}
	}

	for (const subtask of subtasks) {
		for (const dep of subtask.dependsOn) {
			if (!ids.has(dep) && !admission.satisfiedIds?.has(dep)) {
				return invalid(
					`Decomposition subtask ${quoteId(subtask.id)} depends on unknown subtask ${quoteId(dep)}.`,
					"Every dependsOn entry must name another subtask of the same Decomposition, or a subtask that already succeeded when the Decomposition is a mid-flow revision.",
					"Correct the dependsOn ids, or add the missing subtask.",
				);
			}
		}
	}

	const cycle = findCycle(subtasks);
	if (cycle) {
		return flowError(
			"DECOMPOSITION_CYCLE",
			"The Decomposition has a dependency cycle.",
			`These subtasks depend on each other in a loop: ${cycle.join(" -> ")}. No subtask in the loop can ever start.`,
			"Remove one edge from the loop. Every dependsOn chain must reach a subtask that depends on nothing.",
		);
	}

	const concurrent = concurrentSubtasks(subtasks);
	if (concurrent.length > 1) {
		return validateSharedWriteCwd(
			admission.discovery,
			admission.defaultCwd,
			concurrent.map(() => admission.workerRef),
			admission.allowSharedWriteCwd,
			admission.concurrency,
		);
	}
	return null;
}
