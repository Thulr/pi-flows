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

/** What one tier resolves to on this install, and how that was decided. */
export interface RosterAssignment {
	/** Concrete model, or undefined to run the user's pi default (no `--model` passed). */
	model?: string;
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
	/** How the roster was arrived at, for disclosure. */
	source: "derived" | "configured" | "unavailable";
}
