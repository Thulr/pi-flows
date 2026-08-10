/**
 * Which concrete model and thinking level each tier resolves to on this install.
 *
 * The problem this solves: a tier that resolves to nothing is a tier that does
 * nothing. Before this module, `fast` and `deep` fell back to the user's default
 * model unless they had exported PI_FLOWS_FAST_MODEL / PI_FLOWS_DEEP_MODEL — so
 * on an unconfigured install every child ran the parent's own model no matter
 * what the parent asked for, and right-sizing was a silent no-op.
 *
 * So the roster is *derived* rather than configured. pi hands the extension a
 * model registry (see `availableModelsFromRegistry` in runner.ts, the adapter
 * that translates it); this module ranks what that install can actually run and
 * assigns the rungs. No vendor model id is hard-coded here — that was the right
 * half of the original design and it still holds. What changed is the premise:
 * the registry carries per-model pricing, context, and reasoning support, so the
 * ranking can come from the provider's own metadata instead of from a list this
 * repo would have to maintain as providers ship models.
 *
 * Precedence, widest to narrowest — a narrower statement always wins:
 *
 *   flow call `model`/`thinking`  (per-task intent, resolved in runner.ts)
 *   flow call `tier`
 *   agent frontmatter `model` pin
 *   agent frontmatter `tier`/`thinking`
 *   .pi/pi-flows.json          (project, only when the project is trusted)
 *   ~/.pi/agent/pi-flows.json  (user)
 *   PI_FLOWS_FAST_MODEL / PI_FLOWS_DEEP_MODEL  (legacy env, still honored)
 *   derived roster             (this module)
 *   the user's pi default      (no --model passed)
 *
 * Everything here is a pure function over plain values. A live pi runtime is not
 * required to derive, describe, or test a roster.
 */
import { ROSTER_CONFIG_FILE, THINKING_LEVELS, USE_DEFAULT_MODEL, type AvailableModel, type ModelRoster, type RosterAssignment, type RosterConfig, type RosterLayer, type RosterOverride, type ThinkingLevel } from "./types.ts";

/**
 * Thinking level each tier asks for before clamping.
 *
 * `capable` is deliberately absent: it inherits the parent's current level, so
 * an ordinary delegated child thinks as hard as the session that delegated it.
 * Pinning a level here instead would silently override a user who just pressed
 * Shift+Tab.
 */
const TIER_THINKING: Record<"fast" | "deep", ThinkingLevel> = { fast: "low", deep: "max" };

/** A model too small to hold a delegated task plus its system prompt is not a cheap expert, it is a failed run. */
const MIN_CONTEXT_WINDOW = 32_000;

/** Rough share of a child's tokens that are output. Ranking on input price alone rates a cheap-in/expensive-out model as budget. */
export const OUTPUT_TOKEN_SHARE = 0.25;

const THINKING_RANK = new Map(THINKING_LEVELS.map((level, index) => [level, index]));

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_RANK.has(value as ThinkingLevel);
}

/**
 * Split pi's `provider/id:level` shorthand. pi accepts the suffix on `--model`,
 * and model ids may themselves contain colons (OpenRouter's `:exacto`), so only
 * a final segment that names a real level is treated as one.
 */
export function parseModelSpec(spec: string): { model: string; thinking?: ThinkingLevel } {
	const trimmed = spec.trim();
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon <= 0) return { model: trimmed };
	const suffix = trimmed.slice(lastColon + 1);
	if (!isThinkingLevel(suffix)) return { model: trimmed };
	return { model: trimmed.slice(0, lastColon), thinking: suffix };
}

/**
 * Lower a requested level to what the model supports.
 *
 * Asking a non-reasoning model to think `max` is not an error the user should
 * have to prevent — pi clamps it too. Clamping here as well keeps the reported
 * level honest: `details` and the trace state what the child actually ran at,
 * not what was wished for.
 */
export function clampThinking(level: ThinkingLevel | undefined, model: AvailableModel | undefined): ThinkingLevel | undefined {
	if (!level) return undefined;
	if (!model) return level;
	if (!model.reasoning) return "off";
	const supported = model.thinkingLevels.length ? model.thinkingLevels : [...THINKING_LEVELS];
	if (supported.includes(level)) return level;
	const rank = (candidate: ThinkingLevel) => THINKING_RANK.get(candidate) ?? 0;
	const wanted = rank(level);

	// Nearest supported level at or below the request.
	const below = supported.filter((candidate) => rank(candidate) <= wanted);
	if (below.length) return below.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best));

	// Nothing that low exists — a reasoning-only model may offer no `off`, no
	// `minimal`, no `low`. Take the *smallest* it does offer, not the largest: a
	// clamp exists to stop a level exceeding what a model can do, and one that
	// answered `low` with `max` would silently cost more than was asked for,
	// which is the exact inversion of what the fast rung is for.
	return supported.reduce((best, candidate) => (rank(candidate) < rank(best) ? candidate : best));
}

/**
 * Ascending by blended per-token price, unpriced models last.
 *
 * "Last" is the safe end for the cheap rung — an unpriced model is unknown, not
 * free — but it is the *wrong* end to read the expensive rung from, so
 * `cheapest`/`strongest` below select rather than index blindly.
 */
function cheaperFirst(a: AvailableModel, b: AvailableModel): number {
	const priceA = a.costPerToken;
	const priceB = b.costPerToken;
	if (priceA === undefined && priceB === undefined) return a.reference.localeCompare(b.reference);
	if (priceA === undefined) return 1;
	if (priceB === undefined) return -1;
	if (priceA !== priceB) return priceA - priceB;
	// Same price: prefer the larger context, then a stable name order so a
	// derived roster does not shuffle between sessions.
	if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
	return a.reference.localeCompare(b.reference);
}

/** Cheapest known-priced model, falling back to the pool when nothing is priced. */
function cheapest(pool: AvailableModel[]): AvailableModel {
	return [...pool].sort(cheaperFirst)[0];
}

/**
 * Most expensive *known-priced* model, breaking ties toward the larger context.
 *
 * Its own comparator rather than the far end of `cheaperFirst`, for two separate
 * reasons. Unpriced models sort last there, so indexing the end would quietly
 * hand the deep rung to whichever model the registry reported no cost for —
 * price is only a capability proxy when there *is* a price. And `cheaperFirst`
 * breaks price ties toward the larger context window, so reading it backwards
 * inverts that preference and picks the smaller one, which is the opposite of
 * what this rung is for.
 */
function strongest(pool: AvailableModel[]): AvailableModel {
	const priced = pool.filter((model) => model.costPerToken !== undefined);
	return [...(priced.length ? priced : pool)].sort((a, b) => {
		if (a.costPerToken !== b.costPerToken) return (b.costPerToken ?? 0) - (a.costPerToken ?? 0);
		if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow;
		return a.reference.localeCompare(b.reference);
	})[0];
}

/** Levels that mean "think substantially longer", used to tell real extended thinking from a nominal reasoning flag. */
const EXTENDED_LEVELS: ThinkingLevel[] = ["high", "xhigh", "max"];

/** Whether a model actually offers extended thinking, rather than merely setting `reasoning`. */
function supportsExtendedThinking(model: AvailableModel): boolean {
	return model.reasoning && model.thinkingLevels.some((level) => EXTENDED_LEVELS.includes(level));
}

/**
 * Models worth assigning a tier. Embedding models and toy context windows are in
 * the registry but cannot run a delegated task, and offering them as the "fast"
 * expert would trade a real answer for a truncated one.
 */
export function usableModels(models: AvailableModel[]): AvailableModel[] {
	return models.filter((model) => model.contextWindow >= MIN_CONTEXT_WINDOW && !/embedding/i.test(model.id));
}

export interface RosterInputs {
	/** Every model this install can run, already translated out of pi's registry. */
	available: AvailableModel[];
	/** The parent's own model reference and current thinking level. */
	parent: { model?: string; thinking?: ThinkingLevel };
	/**
	 * Model references in the session's effective scope (`/scoped-models`,
	 * `--models`). Non-empty constrains which models automatic derivation may
	 * assign to `fast`/`deep`; empty or absent means no scoping is configured.
	 * `available` stays the full registry — capability metadata and the clamping
	 * of explicit pins still need models the scope excludes.
	 */
	scoped?: string[];
}

/**
 * Rank the install's own models into the three rungs.
 *
 * `capable` is the parent's model: an ordinary delegated child should behave
 * like the session that delegated it, and anchoring the middle rung there is
 * also what makes `fast` and `deep` mean something relative to it.
 *
 * `fast` is the cheapest usable model, preferring the parent's provider so a
 * scout does not silently move work to a second vendor. `deep` is the most
 * capable — reasoning-capable first, then price as the capability proxy.
 */
export function deriveModelRoster(inputs: RosterInputs): ModelRoster {
	// A non-empty session scope (`/scoped-models`, `--models`) is the model set
	// the user actually enabled, so automatic derivation ranks within it rather
	// than the whole catalogue — otherwise `fast`/`deep` dispatch children to
	// models the user explicitly disabled. Filtered here and not in the registry
	// adapter because only *derivation* is scoped: explicit pins and clamping
	// still read the full registry.
	const scoped = inputs.scoped?.length ? new Set(inputs.scoped) : undefined;
	const usable = usableModels(inputs.available);
	const pool = scoped ? usable.filter((model) => scoped.has(model.reference)) : usable;
	// Where a rung says its candidates came from. Naming the scope matters: a
	// user reading `/flows models` after narrowing the session should see that
	// the narrowing took effect.
	const poolLabel = scoped ? "in this session's model scope" : "this install can run";
	const parentModel = inputs.parent.model;
	// Identified from the FULL registry, not the assignable pool. A parent model
	// too small to be assigned a tier is still the parent, and losing it here
	// would empty `sameProvider` and send the fast rung to whatever is globally
	// cheapest — the vendor move the provider preference exists to prevent.
	const parent = parentModel ? inputs.available.find((model) => model.reference === parentModel) : undefined;

	// Pinned to the parent's CONCRETE model, not left as "the default".
	//
	// Those are not the same thing. A child spawns with `--no-session` and no
	// inherited state, so omitting `--model` loads whatever pi's *configured*
	// default is — but the parent may be running something else entirely, having
	// been started with `--model` or switched interactively. `capable` promises
	// the model the session is on, so it has to name it. `null` is reserved for a
	// config that explicitly asks for the configured default.
	const capable: RosterAssignment = {
		model: parentModel ?? USE_DEFAULT_MODEL,
		thinking: inputs.parent.thinking,
		why: inputs.parent.thinking
			? `the model this session is running, at its current thinking level (${inputs.parent.thinking})`
			: "the model this session is running, at pi's own thinking level",
		origin: { model: "derived", thinking: "derived" },
	};

	if (pool.length === 0) {
		// A scope whose models are all unusable must NOT widen back to the
		// registry — that would run the exact models the user scoped out — and it
		// must not leave the tiers unresolved either: an unanswered tier falls
		// through to a child with no `--model`, which loads pi's *configured*
		// default, a model the scope may exclude. The session's own model is the
		// one anchor that is always a deliberate choice (the same argument that
		// justifies `capable`), so the automatic tiers stay on it.
		if (scoped && parentModel) {
			const stranded = (tier: "fast" | "deep"): RosterAssignment => ({
				model: parentModel,
				thinking: clampThinking(TIER_THINKING[tier], parent),
				why: `no usable model is inside this session's model scope, so ${tier} stays on the model this session is running`,
				origin: { model: "derived", thinking: "derived" },
			});
			return { fast: stranded("fast"), capable, deep: stranded("deep"), available: inputs.available, sessionModel: parentModel, source: "derived", issues: [] };
		}
		// Two distinct empty states share this fallback but not the explanation.
		const unknown = scoped
			? "no usable model is inside this session's model scope and the session model is unknown, so every tier runs your pi default"
			: "no model registry was available, so every tier runs your pi default";
		return { fast: { why: unknown }, capable: { ...capable, why: unknown }, deep: { why: unknown }, available: inputs.available, sessionModel: parentModel, source: "unavailable", issues: [] };
	}

	// Any same-provider model at all keeps the rung there, not just a *cheaper*
	// one. When the parent's provider offers only the parent's own model, the fast
	// rung is still meaningful — that model at `low` thinking — and that is a
	// better answer than silently sending a scout's task to a second vendor. The
	// documented guarantee is about where the work goes, and cost is the tiebreak
	// within it rather than a reason to leave.
	const sameProvider = parent ? pool.filter((model) => model.provider === parent.provider) : [];
	const cheapModel = cheapest(sameProvider.length ? sameProvider : pool);

	// Extended thinking outranks price for the deep rung: an expensive model that
	// cannot think longer is not the right adjudicator, and the whole point of the
	// rung is the hardest reasoning. Tested on the levels the model actually
	// offers, not on its `reasoning` flag — a provider that maps xhigh/max to null
	// leaves a model that reasons but cannot be pushed, and picking it would make
	// `deep` resolve to a rung it cannot deliver.
	//
	// Three tiers of preference, not two. Dropping straight to the whole pool when
	// nothing offers extended levels would let a pricier *non-reasoning* model beat
	// a reasoning one capped at medium — and then deep's `max` clamps to `off`,
	// which is the least deep answer available.
	const extendedPool = pool.filter(supportsExtendedThinking);
	const reasoningPool = pool.filter((model) => model.reasoning);
	const strongModel = strongest(extendedPool.length ? extendedPool : reasoningPool.length ? reasoningPool : pool);

	const fast: RosterAssignment = sameOrDefault(cheapModel, parentModel, {
		model: cheapModel.reference,
		thinking: clampThinking(TIER_THINKING.fast, cheapModel),
		why: `cheapest model ${poolLabel}${sameProvider.length ? ` on ${cheapModel.provider}` : ""}`,
		origin: { model: "derived", thinking: "derived" },
	}, `the model this session is running is already the cheapest available, so fast reruns it at ${TIER_THINKING.fast} thinking`);

	const deep: RosterAssignment = sameOrDefault(strongModel, parentModel, {
		model: strongModel.reference,
		thinking: clampThinking(TIER_THINKING.deep, strongModel),
		why: supportsExtendedThinking(strongModel)
			? `most capable model ${poolLabel} that supports extended thinking`
			: `most capable model ${poolLabel} (none offer extended thinking)`,
		origin: { model: "derived", thinking: "derived" },
	}, supportsExtendedThinking(strongModel)
		? `the model this session is running is already the most capable available, so deep differs by thinking level (${TIER_THINKING.deep}), not by model`
		: "the model this session is running is already the most capable available, and none offer extended thinking, so deep matches it");

	return { fast, capable, deep, available: inputs.available, sessionModel: parentModel, source: "derived", issues: [] };
}

/**
 * When a rung lands on the parent's own model, say so and drop the pin.
 *
 * Passing `--model` for the model pi would have loaded anyway is not wrong, but
 * it reads as a fleet that is right-sizing when it is not. The honest form is a
 * rung that admits it only differs by thinking level — which is the common case
 * on an install whose default is already the best model it has.
 */
function sameOrDefault(chosen: AvailableModel, parentModel: string | undefined, assignment: RosterAssignment, sameWhy: string): RosterAssignment {
	if (chosen.reference !== parentModel) return assignment;
	// The model is still pinned, only the rationale changes. Dropping the pin
	// would not be "no change" — a child with no `--model` loads pi's configured
	// default, which is not necessarily what this session is running. What differs
	// on this rung is the thinking level, and the `why` says so.
	return { ...assignment, why: sameWhy };
}

/**
 * One layer's statement, folded into what the layers below already said.
 *
 * The level carried between layers is the one that was *requested*, never a
 * clamped result. Clamping mid-chain bakes one model's limits into a value that
 * a later layer may re-point at a different model: a user asking for `high` on a
 * rung whose derived model caps at `medium` would be lowered to `medium`, and a
 * project that then changed only the model would inherit `medium` even where
 * `high` is supported. The clamp happens once, at the end, against the model
 * that actually won.
 */
function applyLayer(base: LayeredAssignment, override: RosterOverride | undefined, label: string, origin: RosterLayer): LayeredAssignment {
	if (!override) return base;
	// An absent `model` keeps whatever the layers below resolved; a stated one —
	// including the null that means "the pi default" — replaces it.
	const said = override.model !== undefined;
	return {
		model: said ? override.model : base.model,
		requested: override.thinking ?? base.requested,
		why: said && override.thinking ? `${label} override` : said ? `${label} model override` : `${label} thinking override`,
		// Only the fields this layer actually stated change hands; the rest keep
		// whichever layer supplied them, so precedence stays readable per field.
		origin: {
			model: said ? origin : base.origin?.model,
			thinking: override.thinking !== undefined ? origin : base.origin?.thinking,
		},
	};
}

/**
 * The fields a merged override owes to the *user* layer: everything the project
 * did not state.
 *
 * The merged config already decided which value wins; this only splits it back
 * apart so each field can record the layer that supplied it. Without the split a
 * project stating one field would be credited with both.
 */
function userOnly(config: RosterOverride | undefined, project: RosterOverride | undefined): RosterOverride | undefined {
	if (!config) return undefined;
	const model = project?.model !== undefined ? undefined : config.model;
	const thinking = project?.thinking !== undefined ? undefined : config.thinking;
	if (model === undefined && thinking === undefined) return undefined;
	return { ...(model !== undefined ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/** A rung part-way through the layer chain: the level is still the one requested, not one clamped to a model a later layer may replace. */
interface LayeredAssignment {
	model?: string | null;
	requested?: ThinkingLevel;
	why: string;
	origin?: RosterAssignment["origin"];
}

export interface ResolveRosterInputs extends RosterInputs {
	config?: RosterConfig;
	/** The project-supplied subset of `config`, so a rung can name the layer that settled it. */
	project?: RosterConfig;
	env?: RosterConfig;
	/** Config that could not be read. Carried onto the roster so an ignored override is visible where the roster is shown. */
	issues?: string[];
}

/**
 * The roster this install runs with: derive, then let env and config narrow it.
 *
 * Config is applied after env so an explicit pi-flows.json wins over a shell
 * variable the user may have exported months ago and forgotten — the constraint
 * being honored here is that pi-flows must be configurable inside pi, and a
 * setting you can see in a file should beat one you cannot.
 */
export function resolveModelRoster(inputs: ResolveRosterInputs): ModelRoster {
	const derived = deriveModelRoster(inputs);
	let configured = false;
	const rungs = (["fast", "capable", "deep"] as const).map((tier) => {
		const env = inputs.env?.[tier];
		const config = inputs.config?.[tier];
		if (env || config) configured = true;
		const project = inputs.project?.[tier];

		// The tier's own requested level, before any model clamped it. The derived
		// rung's `thinking` is already clamped, so it cannot be the starting point.
		const start: LayeredAssignment = {
			model: derived[tier].model,
			requested: tier === "capable" ? inputs.parent.thinking : TIER_THINKING[tier],
			why: derived[tier].why,
			origin: derived[tier].origin,
		};
		// Project and user apply as separate passes so each field names its own
		// layer. The merged `config` already decided which value wins; splitting it
		// only records who supplied it — that is what tells /flows models whether a
		// user-file edit would be shadowed.
		const layered = [
			[env, "PI_FLOWS_*_MODEL", "env"] as const,
			[userOnly(config, project), ROSTER_CONFIG_FILE, "user-config"] as const,
			[project, ROSTER_CONFIG_FILE, "project-config"] as const,
		].reduce((carried, [override, label, origin]) => applyLayer(carried, override, label, origin), start);

		// Clamped once, against the model that won, and read from the full registry
		// rather than the assignable pool: a pin may name a model ranking excluded,
		// and it still has real limits.
		const known = layered.model ? inputs.available.find((candidate) => candidate.reference === layered.model) : undefined;
		return [tier, { model: layered.model, thinking: clampThinking(layered.requested, known), why: layered.why, origin: layered.origin }] as const;
	});
	const roster = Object.fromEntries(rungs) as Pick<ModelRoster, "fast" | "capable" | "deep">;
	return {
		...roster,
		available: inputs.available,
		sessionModel: derived.sessionModel,
		source: configured ? "configured" : derived.source,
		issues: inputs.issues ?? [],
	};
}

/**
 * Look one model up for clamping.
 *
 * An absent reference is not "no model" — it is the pi default, which is a
 * concrete model whose limits still apply. Resolving it here is what keeps the
 * reported thinking level honest for every child that runs without `--model`,
 * which is the majority of them.
 */
export function knownModel(roster: ModelRoster | undefined, reference: string | null | undefined): AvailableModel | undefined {
	// No reference means no `--model`, and therefore pi's *configured* default —
	// which this extension cannot read. Substituting the session model here would
	// clamp against limits the child does not have. Unknown is the honest answer,
	// and pi clamps the level itself on the way in.
	if (!roster || !reference) return undefined;
	return roster.available.find((candidate) => candidate.reference === reference);
}

/** The assignment a tier name resolves to, or undefined for an unknown tier. */
export function rosterAssignment(roster: ModelRoster | undefined, tier: string | undefined): RosterAssignment | undefined {
	if (!roster || !tier) return undefined;
	if (tier === "fast" || tier === "capable" || tier === "deep") return roster[tier];
	return undefined;
}

/** Human-readable roster, for `flow showConfig:true` and `/flows models`. */
export function describeModelRoster(roster: ModelRoster | undefined): string[] {
	if (!roster) return ["modelTier: (unresolved — no pi model registry was reachable from this context)"];
	const rungs = (["fast", "capable", "deep"] as const).map((tier) => {
		const assignment = roster[tier];
		const model = assignment.model ?? "(your pi default model)";
		const thinking = assignment.thinking ? `, thinking ${assignment.thinking}` : "";
		return `modelTier.${tier}: ${model}${thinking} — ${assignment.why}`;
	});
	// Ignored config is reported next to the roster it failed to change. A pin the
	// user believes is in force but which never parsed is exactly the state that
	// makes a surprising model choice undiagnosable.
	return [...rungs, ...roster.issues.map((issue) => `modelRoster.issue: ${issue}`)];
}
