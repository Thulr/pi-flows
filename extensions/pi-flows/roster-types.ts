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
export interface RosterAssignment {
	model?: string | null;
	thinking?: ThinkingLevel;
	/** Plain-English reason, shown by `flow showConfig:true` and `/flows models` so a surprising choice is inspectable. */
	why: string;
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
	/** The models the rungs were ranked from. Carried so a level named at the call site can still be clamped to the model it will run on. */
	available: AvailableModel[];
	/**
	 * The model a child runs when no `--model` is passed — the parent's own.
	 *
	 * Carried separately because "run the pi default" is expressed as an *absent*
	 * model reference, and a clamp keyed only on the reference would therefore
	 * skip every default-model child. Without this, `tier:"capable"` with
	 * `thinking:"max"` on a model that stops at `medium` would be reported as
	 * `max` — the one thing the reported level is supposed to never do.
	 */
	defaultModel?: string;
	/** How the roster was arrived at, for disclosure. */
	source: "derived" | "configured" | "unavailable";
	/** Config that could not be read, surfaced so an ignored override is diagnosable rather than silent. */
	issues: string[];
}
