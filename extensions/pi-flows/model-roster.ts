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
import * as fs from "node:fs";
import * as path from "node:path";
import { THINKING_LEVELS, type AvailableModel, type ModelRoster, type RosterAssignment, type ThinkingLevel } from "./types.ts";

/** Config file name, looked for under the user agent dir and the project config dir. */
export const ROSTER_CONFIG_FILE = "pi-flows.json";

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
	const wanted = THINKING_RANK.get(level) ?? 0;
	// Nearest supported level at or below the request, else the smallest offered:
	// stepping *down* keeps a clamp from silently costing more than was asked for.
	const below = supported.filter((candidate) => (THINKING_RANK.get(candidate) ?? 0) <= wanted);
	const pool = below.length ? below : supported;
	return pool.reduce((best, candidate) => ((THINKING_RANK.get(candidate) ?? 0) > (THINKING_RANK.get(best) ?? 0) ? candidate : best));
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
 * Most expensive *known-priced* model.
 *
 * Reading the far end of the sort would pick an unpriced model instead, since
 * those sort last — which would quietly hand the deep rung to whichever model
 * the registry happened to report no cost for. Price is only a capability proxy
 * when there is a price.
 */
function strongest(pool: AvailableModel[]): AvailableModel {
	const priced = pool.filter((model) => model.costPerToken !== undefined);
	const ranked = [...(priced.length ? priced : pool)].sort(cheaperFirst);
	return ranked[ranked.length - 1];
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
	const pool = usableModels(inputs.available);
	const parentModel = inputs.parent.model;
	const byReference = new Map(pool.map((model) => [model.reference, model]));
	const parent = parentModel ? byReference.get(parentModel) : undefined;

	const capable: RosterAssignment = {
		model: undefined,
		thinking: inputs.parent.thinking,
		why: inputs.parent.thinking
			? `your pi default model, at the session's current thinking level (${inputs.parent.thinking})`
			: "your pi default model, at pi's own thinking level",
	};

	if (pool.length === 0) {
		const unknown = "no model registry was available, so every tier runs your pi default";
		return { fast: { why: unknown }, capable: { ...capable, why: unknown }, deep: { why: unknown }, available: pool, source: "unavailable" };
	}

	const sameProvider = parent ? pool.filter((model) => model.provider === parent.provider) : [];
	const fastPool = sameProvider.length > 1 ? sameProvider : pool;
	const cheapModel = cheapest(fastPool);

	// Reasoning capability outranks price for the deep rung: an expensive model
	// that cannot think longer is not the right adjudicator, and the whole point
	// of the rung is the hardest reasoning.
	const reasoningPool = pool.filter((model) => model.reasoning);
	const strongModel = strongest(reasoningPool.length ? reasoningPool : pool);

	const fast: RosterAssignment = sameOrDefault(cheapModel, parentModel, {
		model: cheapModel.reference,
		thinking: clampThinking(TIER_THINKING.fast, cheapModel),
		why: `cheapest model this install can run${sameProvider.length > 1 ? ` on ${cheapModel.provider}` : ""}`,
	}, `your pi default is already the cheapest model available, so fast reruns it at ${TIER_THINKING.fast} thinking`);

	const deep: RosterAssignment = sameOrDefault(strongModel, parentModel, {
		model: strongModel.reference,
		thinking: clampThinking(TIER_THINKING.deep, strongModel),
		why: `most capable model this install can run${strongModel.reasoning ? " that supports extended thinking" : ""}`,
	}, `your pi default is already the most capable model available, so deep differs by thinking level (${TIER_THINKING.deep}), not by model`);

	return { fast, capable, deep, available: pool, source: "derived" };
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
	return { model: undefined, thinking: assignment.thinking, why: sameWhy };
}

/** A tier override as written in config or env: a model spec, a level, or both. */
export interface RosterOverride {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface RosterConfig {
	fast?: RosterOverride;
	capable?: RosterOverride;
	deep?: RosterOverride;
}

/**
 * Read one override, accepting either the shorthand a user would type into a
 * `--model` flag or the explicit object form.
 *
 *   "fast": "anthropic/claude-haiku-4-5:low"
 *   "fast": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" }
 */
function readOverride(raw: unknown): RosterOverride | undefined {
	const pair = (model: string | undefined, thinking: ThinkingLevel | undefined): RosterOverride | undefined => {
		// Only the keys actually set: an override carrying `thinking: undefined`
		// reads as "no level" everywhere it is merged, which is true, but it also
		// makes an override that set nothing indistinguishable from one that did.
		if (!model && !thinking) return undefined;
		return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
	};
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		if (isThinkingLevel(trimmed)) return { thinking: trimmed };
		const { model, thinking } = parseModelSpec(trimmed);
		return pair(model, thinking);
	}
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	return pair(
		typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined,
		isThinkingLevel(record.thinking) ? record.thinking : undefined,
	);
}

/** Parse a `pi-flows.json`. Malformed input yields no overrides rather than an exception: config is an opt-in, not a gate. */
export function parseRosterConfig(text: string): { config: RosterConfig; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { config: {}, error: error instanceof Error ? error.message : String(error) };
	}
	const models = (parsed as Record<string, unknown> | null)?.models;
	if (!models || typeof models !== "object") return { config: {} };
	const record = models as Record<string, unknown>;
	const config: RosterConfig = {};
	for (const tier of ["fast", "capable", "deep"] as const) {
		const override = readOverride(record[tier]);
		if (override) config[tier] = override;
	}
	return { config };
}

export interface RosterConfigSource {
	/** Where the user's own pi-flows.json lives (the pi agent dir). */
	userDir: string;
	/** Project config dir, or null when there is none. */
	projectDir: string | null;
	/** Project config is repo-controlled, so it is read only for a trusted project. */
	projectTrusted: boolean;
}

/**
 * Load overrides from disk. Project config wins over user config, but only when
 * pi says the project is trusted — a repo-controlled file choosing which model
 * runs (and therefore which vendor sees the task) is exactly the kind of thing
 * project trust exists to gate.
 */
export function loadRosterConfig(source: RosterConfigSource): { config: RosterConfig; issues: string[] } {
	const issues: string[] = [];
	const merged: RosterConfig = {};
	const dirs = [source.userDir, source.projectTrusted ? source.projectDir : null];
	for (const dir of dirs) {
		if (!dir) continue;
		const file = path.join(dir, ROSTER_CONFIG_FILE);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const { config, error } = parseRosterConfig(text);
		if (error) {
			issues.push(`${ROSTER_CONFIG_FILE} could not be parsed (${error}); its overrides were ignored.`);
			continue;
		}
		Object.assign(merged, config);
	}
	return { config: merged, issues };
}

/**
 * Persist one tier override to the user's `pi-flows.json`.
 *
 * Read-modify-write of the parsed file rather than a blind overwrite: the file
 * is the user's, may hold settings this build does not know about, and losing
 * them because a tier was changed would be the kind of quiet damage a config
 * surface must never do. Passing `undefined` clears the override and returns the
 * tier to derivation.
 */
export function saveRosterOverride(userDir: string, tier: "fast" | "capable" | "deep", override: RosterOverride | undefined): string {
	const file = path.join(userDir, ROSTER_CONFIG_FILE);
	let existing: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
	} catch {
		// No file yet, or one this build cannot parse. Either way the write below
		// establishes a valid one rather than failing the command.
	}
	const models = existing.models && typeof existing.models === "object" ? { ...(existing.models as Record<string, unknown>) } : {};
	if (override) models[tier] = override.model ? { model: override.model, ...(override.thinking ? { thinking: override.thinking } : {}) } : { thinking: override.thinking };
	else delete models[tier];
	fs.mkdirSync(userDir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ ...existing, models }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return file;
}

/** The legacy env mapping. Still honored, now as one override source among several rather than the only one. */
export function envRosterConfig(): RosterConfig {
	const config: RosterConfig = {};
	const fast = readOverride(process.env.PI_FLOWS_FAST_MODEL ?? "");
	const deep = readOverride(process.env.PI_FLOWS_DEEP_MODEL ?? "");
	if (fast) config.fast = fast;
	if (deep) config.deep = deep;
	return config;
}

function applyOverride(base: RosterAssignment, override: RosterOverride | undefined, label: string, available: AvailableModel[]): RosterAssignment {
	if (!override) return base;
	const model = override.model ?? base.model;
	const known = available.find((candidate) => candidate.reference === model);
	return {
		model,
		thinking: clampThinking(override.thinking ?? base.thinking, known),
		why: override.model && override.thinking ? `${label} override` : override.model ? `${label} model override` : `${label} thinking override`,
	};
}

export interface ResolveRosterInputs extends RosterInputs {
	config?: RosterConfig;
	env?: RosterConfig;
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
	const pool = usableModels(inputs.available);
	let configured = false;
	const rungs = (["fast", "capable", "deep"] as const).map((tier) => {
		const env = inputs.env?.[tier];
		const config = inputs.config?.[tier];
		if (env || config) configured = true;
		return [tier, applyOverride(applyOverride(derived[tier], env, "PI_FLOWS_*_MODEL", pool), config, ROSTER_CONFIG_FILE, pool)] as const;
	});
	const roster = Object.fromEntries(rungs) as Pick<ModelRoster, "fast" | "capable" | "deep">;
	return { ...roster, available: pool, source: configured ? "configured" : derived.source };
}

/** Look one model up by the reference a call site or config named, for clamping. */
export function knownModel(roster: ModelRoster | undefined, reference: string | undefined): AvailableModel | undefined {
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
	return (["fast", "capable", "deep"] as const).map((tier) => {
		const assignment = roster[tier];
		const model = assignment.model ?? "(your pi default model)";
		const thinking = assignment.thinking ? `, thinking ${assignment.thinking}` : "";
		return `modelTier.${tier}: ${model}${thinking} — ${assignment.why}`;
	});
}
