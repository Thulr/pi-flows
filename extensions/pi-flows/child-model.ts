/**
 * Which model and thinking level one child runs at, resolved from the call,
 * the agent's frontmatter, and the per-install roster. Split from runner.ts —
 * the process adapter stays about the subprocess; this module is pure policy
 * over plain values, the same kind as model-roster.ts one layer up.
 */
import { clampThinking, knownModel, parseModelSpec, rosterAssignment } from "./model-roster.ts";
import type { ModelRoster, ThinkingLevel } from "./types.ts";

/** What one child will actually run as. */
export interface ChildModelChoice {
	/** undefined = omit --model, so the child uses the user's default. */
	model?: string;
	/** The level passed on `--thinking`. undefined = omit it, so pi's configured level applies. */
	thinking?: ThinkingLevel;
	/**
	 * Whether that level was checked against the model it will run on.
	 *
	 * False when the child names no model: it then loads pi's *configured*
	 * default, which an extension cannot read, so pi may lower the level
	 * internally and this value is a request rather than an outcome. Reporting it
	 * as the effective level would corrupt any experiment that reads the field as
	 * what actually ran.
	 */
	thinkingVerified: boolean;
	/**
	 * Set when the deciding tier rung REFUSED (model scope unsatisfiable — see
	 * RosterAssignment.refusal) and no explicit pin overrode it. The dispatcher
	 * must not spawn: an unpinned child would load pi's configured default,
	 * possibly a model the session scope excludes.
	 */
	refusal?: string;
}

/**
 * Model and thinking level for a child run.
 *
 * Model: flow model override > flow tier > agent pin > agent tier > pi default.
 * A call-site tier beats an agent's pinned model because the parent is
 * expressing per-task intent. A tier the roster could not resolve at all (no
 * registry) still falls through to the agent pin, so flows keep working when the
 * roster is unavailable.
 *
 * The fall-through tests whether the rung *answered*, not whether it named a
 * model, because "run the pi default" is an answer. Treating it as silence would
 * mean a `deep` call landing on an install whose default is already the
 * strongest model would fall through to a fast agent's pin and run the cheap
 * one — the exact inversion of what was asked for.
 *
 * Thinking follows the same shape one rung at a time, so a call that names only
 * a tier still gets that tier's level, and a call that names only a level keeps
 * whatever model the tier chose. The result is clamped to the resolved model:
 * what is reported is what the child ran at, not what was wished for.
 */
export function resolveChildModel(
	agent: { model?: string; tier?: string; thinking?: ThinkingLevel },
	options: { model?: string; tier?: string; thinking?: ThinkingLevel; flowThinking?: ThinkingLevel },
	roster: ModelRoster | undefined,
): ChildModelChoice {
	const optionsTier = rosterAssignment(roster, options.tier);
	const agentTier = rosterAssignment(roster, agent.tier);
	const optionsPin = options.model ? parseModelSpec(options.model) : undefined;
	const agentPin = agent.model ? parseModelSpec(agent.model) : undefined;

	// `null` from any rung means "the pi default", and is normalized to undefined
	// only here, at the point the answer becomes argv.
	const answered = (assignment: { model?: string | null } | undefined) => assignment?.model !== undefined;
	const model = optionsPin?.model
		?? (answered(optionsTier)
			? optionsTier?.model ?? undefined
			: agentPin?.model ?? (answered(agentTier) ? agentTier?.model ?? undefined : undefined));

	// One ordered list rather than nested conditionals: every source of a level,
	// narrowest first. The tier rungs sit below the explicit statements so naming
	// a level never gets overruled by the rung that supplied the model.
	const requested = [
		options.thinking,
		optionsPin?.thinking,
		options.flowThinking,
		optionsTier?.thinking,
		agent.thinking,
		agentPin?.thinking,
		agentTier?.thinking,
	].find((level) => level !== undefined);

	// A refused rung is a third state, distinct from answered and silent — but
	// the refusal exists for exactly one outcome: the chain ending UNPINNED,
	// where the child would load pi's configured default outside the scope. Any
	// concrete model the chain lands on (pin, config-answered rung) is a
	// deliberate statement and clears it; a chain that resolves to "the default"
	// through or below a refused rung keeps it.
	const refusal = model !== undefined
		? undefined
		: optionsTier?.refusal ?? (answered(optionsTier) ? undefined : agentTier?.refusal);

	const resolved = knownModel(roster, model);
	return {
		model,
		thinking: clampThinking(requested, resolved),
		thinkingVerified: requested === undefined || resolved !== undefined,
		...(refusal ? { refusal } : {}),
	};
}
