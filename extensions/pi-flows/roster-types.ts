/**
 * The vocabulary of model selection: what a thinking level is, what one usable
 * model looks like once pi's registry shape has been translated away, and what a
 * tier resolves to on this install.
 *
 * Dependency-free on purpose, like trace-scope.ts: types.ts re-exports these as
 * part of its published surface, and the shared kernel may not reach into the
 * Generic module (`model-roster.ts`) that derives them. Terms live with the
 * concept that owns them; the policy that produces a roster lives there.
 */

/** Config file name, looked for under the user agent dir and the project config dir. */
export const ROSTER_CONFIG_FILE = "pi-flows.json";

/**
 * "Run my pi default model", as a decision rather than an absence.
 *
 * Both a roster rung and a config override carry a tri-state model: a concrete
 * reference, this null, or `undefined` for "nothing was stated / nothing
 * resolved". Collapsing the last two is what makes a deliberate default
 * indistinguishable from silence — and then a `deep` call on a `fast` agent
 * falls through to the cheap pin, and a user who pinned a tier to their own
 * model keeps silently getting the derived one.
 */
export const USE_DEFAULT_MODEL = null;

/** Which configuration layer supplied a value. */
export type RosterLayer = "derived" | "env" | "user-config" | "project-config";

/** A tier override as written in config or env: a model spec, a level, or both. */
export interface RosterOverride {
	model?: string | null;
	thinking?: ThinkingLevel;
}

export interface RosterConfig {
	fast?: RosterOverride;
	capable?: RosterOverride;
	deep?: RosterOverride;
}

/**
 * Reasoning effort a child runs at. pi's own vocabulary, kept verbatim so a
 * level written in an agent file or a flow call means the same thing it means
 * at `pi --thinking`. "off" is a level, not an absence: a non-reasoning model
 * clamps to it.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * One model this install can actually run, reduced to what tier assignment
 * needs. Translated from pi's model registry in runner.ts so nothing above the
 * adapter speaks the foreign shape — and so the roster can be derived, ranked,
 * and tested without a live pi runtime.
 */
export interface AvailableModel {
	/** Canonical `provider/id` reference, the form `--model` accepts. */
	reference: string;
	provider: string;
	id: string;
	reasoning: boolean;
	/** Levels this model supports, already excluding the ones its provider marks unsupported. */
	thinkingLevels: ThinkingLevel[];
	contextWindow: number;
	/** Blended per-token price used to rank capability. Undefined when the registry reports none. */
	costPerToken?: number;
}

/**
 * What one tier resolves to on this install, and how that was decided.
 *
 * `model` is deliberately tri-state, matching the vocabulary a config override
 * uses:
 *
 *   "provider/id"  this concrete model
 *   null           the user's pi default, chosen on purpose (no `--model` passed)
 *   undefined      this tier could not be resolved at all
 *
 * The middle and last case look identical if both are spelled `undefined`, and
 * conflating them is a live bug rather than a nicety: a resolved rung that means
 * "run the default" would read as "no answer" and fall through to whatever the
 * agent pinned — so asking for `deep` on a fast agent could run the cheap model.
 */
/**
 * Stands in for a session-scope entry whose shape could not be read (see
 * `scopedModelReferences` in roster-source.ts). It can match no registry
 * reference — those are always `provider/id` — so a scope that decodes to
 * nothing still constrains derivation instead of silently widening back to
 * the full registry. Vocabulary rather than policy: both the reader and the
 * empty-pool ranking branch on it.
 */
export const UNREADABLE_SCOPED_MODEL = "(unreadable scoped-model entry)";

export interface RosterAssignment {
	model?: string | null;
	thinking?: ThinkingLevel;
	/** Plain-English reason, shown by `flow showConfig:true` and `/flows models` so a surprising choice is inspectable. */
	why: string;
	/**
	 * Set when this rung REFUSES rather than answers or stays silent: the
	 * session's model scope admits nothing the rung could name, and there is no
	 * session model to anchor to — so falling through to an unpinned child
	 * (pi's configured default, possibly outside the scope) must not happen.
	 * A later layer or an explicit pin naming a model clears the refusal.
	 */
	refusal?: string;
	/**
	 * Which layer settled each field. Tracked per field, not per rung, because the
	 * layers merge per field: a project stating only `thinking` leaves `model` to
	 * the user. Marking the whole rung project-owned would make `/flows models`
	 * warn that a model change cannot apply when it can — and stay silent about
	 * the level, which the project really does replace.
	 */
	origin?: { model?: RosterLayer; thinking?: RosterLayer };
}

/**
 * The concrete model and thinking level each tier resolves to on this install.
 * Derived from the models the user can actually run, then overridden by pi-flows
 * config, legacy env mappings, and the call itself — see model-roster.ts for the
 * precedence.
 */
export interface ModelRoster {
	fast: RosterAssignment;
	capable: RosterAssignment;
	deep: RosterAssignment;
	/**
	 * Every model the registry reported, not just the ones a tier may be assigned.
	 *
	 * Capability lookup and tier assignment are different questions. Ranking uses
	 * {@link usableModels}, which drops embeddings and context windows too small
	 * to hold a delegated task — but a model excluded from *assignment* can still
	 * be the one a child runs, because the pi default is whatever the user set,
	 * and a config pin may name anything. Storing only the assignable pool means
	 * a small default model would have no capabilities on record, and a level
	 * requested against it would go unclamped and be misreported.
	 */
	available: AvailableModel[];
	/**
	 * The model this pi session is running, when known.
	 *
	 * Deliberately NOT "the model a child gets when no `--model` is passed". Those
	 * were the same thing until `capable` started naming the session model
	 * explicitly, and they are not: an unpinned child loads pi's *configured*
	 * default, which diverges the moment a session starts with `--model` or
	 * switches interactively. pi gives an extension no way to read that configured
	 * default, so the honest position is that an unpinned child's model is
	 * unknown — and clamping a level against the session model instead would
	 * report a limit the child never had.
	 *
	 * Used to identify the parent's provider and to derive `capable`, never as a
	 * stand-in for whatever an unpinned child will load.
	 */
	sessionModel?: string;
	/** How the roster was arrived at, for disclosure. */
	source: "derived" | "configured" | "unavailable";
	/** Config that could not be read, surfaced so an ignored override is diagnosable rather than silent. */
	issues: string[];
}
