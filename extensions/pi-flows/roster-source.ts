/**
 * Where a roster comes from: pi's live model registry and the user's config.
 *
 * The anti-corruption layer for model selection, kept apart from the child-run
 * adapter next door because it faces a different foreign surface. Everything
 * here turns a pi runtime into the plain values `model-roster.ts` ranks — which
 * is what lets the roster policy, and every test of it, run with no pi present.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ROSTER_CONFIG_FILE, THINKING_LEVELS, type AvailableModel, type ModelRoster, type ThinkingLevel } from "./types.ts";
import { OUTPUT_TOKEN_SHARE, isThinkingLevel, resolveModelRoster } from "./model-roster.ts";
import { envRosterConfig, loadRosterConfig } from "./roster-config.ts";

/** How the pi registry is read. Structural so the resolver stays testable without a live runtime. */
interface ModelRegistryLike {
	getAvailable(): ReadonlyArray<{
		id: string;
		provider: string;
		reasoning: boolean;
		contextWindow: number;
		maxTokens: number;
		cost?: { input?: number; output?: number };
		thinkingLevelMap?: Partial<Record<string, string | null>>;
	}>;
}

/**
 * Anti-corruption layer over pi's model registry: the one place a foreign model
 * shape is spoken. Everything above this sees `AvailableModel`, which is why the
 * roster can be derived and tested with no pi runtime present.
 *
 * `getAvailable()` rather than `getAll()` deliberately — a model whose provider
 * has no configured auth would be assigned a tier and then fail every child that
 * used it.
 */
export function availableModelsFromRegistry(registry: ModelRegistryLike | undefined): AvailableModel[] {
	if (!registry?.getAvailable) return [];
	let models: ReturnType<ModelRegistryLike["getAvailable"]>;
	try {
		models = registry.getAvailable();
	} catch {
		// A registry that cannot answer is a roster we do not derive, not a failed
		// flow: every tier falls back to the user's default model.
		return [];
	}
	return models.map((model) => {
		// A level the provider maps to null is unsupported; a level it omits uses
		// the provider default, so absence means available, not excluded.
		const levels = THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
		const input = model.cost?.input;
		const output = model.cost?.output;
		const costPerToken = input === undefined && output === undefined
			? undefined
			: (input ?? 0) * (1 - OUTPUT_TOKEN_SHARE) + (output ?? 0) * OUTPUT_TOKEN_SHARE;
		return {
			reference: `${model.provider}/${model.id}`,
			provider: model.provider,
			id: model.id,
			reasoning: model.reasoning,
			thinkingLevels: model.reasoning ? levels : ["off" as ThinkingLevel],
			contextWindow: model.contextWindow,
			costPerToken,
		};
	});
}

/**
 * Nearest ancestor whose pi config dir actually holds a roster config, or null.
 *
 * `stat` is injectable because the branches that matter most are I/O failures —
 * EACCES, ELOOP — which cannot be induced portably in a test, and a test that
 * silently does nothing under a root CI user is worse than none.
 *
 * Walked rather than joined onto cwd because project-agent discovery already
 * walks (`findNearestProjectAgentsDir`), and the two have to agree: starting pi
 * from `src/` would otherwise load the repo's project agents while silently
 * ignoring the model pins sitting beside them, which reads as the config file
 * not working rather than as a directory-depth rule nobody documented.
 *
 * The search is for the FILE, not for a `.pi` directory. Stopping at the first
 * `.pi` would let an unrelated nested one — a sub-package with its own config
 * dir but no roster pins — shadow the repository's, producing the same silent
 * miss one level down. `findNearestProjectAgentsDir` looks for `.pi/flow-agents`
 * for exactly this reason.
 */
export function nearestProjectConfigDir(cwd: string, stat: (file: string) => { isFile(): boolean } = fs.statSync): { dir: string | null; issues: string[] } {
	const issues: string[] = [];
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME);
		try {
			const entry = stat(path.join(candidate, ROSTER_CONFIG_FILE));
			if (entry.isFile()) return { dir: candidate, issues };
			// Something is there and it is not a file — a directory, a socket. The
			// walk stops rather than continuing: an ancestor's config loaded in its
			// place would apply settings from a project the user is not in, which is
			// worse than applying none.
			issues.push(`${CONFIG_DIR_NAME}/${ROSTER_CONFIG_FILE} in this project is not a file; its overrides were ignored, and no ancestor config was used in its place.`);
			return { dir: null, issues };
		} catch (error) {
			// "Not here" is the normal case and keeps the walk going. Anything else —
			// a directory where the file should be, a permissions failure, a broken
			// symlink — means something IS there and could not be read. Walking past
			// it silently would ignore the project's pins and, worse, could load an
			// unrelated ancestor's config in their place.
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				// Same reasoning as the non-file case above: something is there and
				// cannot be read, so continuing would substitute an unrelated
				// ancestor's pins — possibly another provider — for the project's.
				issues.push(`${CONFIG_DIR_NAME}/${ROSTER_CONFIG_FILE} in this project could not be read (${code ?? "unknown error"}); its overrides were ignored, and no ancestor config was used in its place.`);
				return { dir: null, issues };
			}
		}
		const parent = path.dirname(current);
		if (parent === current) return { dir: null, issues };
		current = parent;
	}
}

/** What resolving a roster needs from a live pi context. Structural, so the shape stays visible here rather than imported wholesale. */
interface RosterContext {
	cwd?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	modelRegistry?: ModelRegistryLike;
	/**
	 * The session's effective model scope (`/scoped-models`, `--models`), as pi
	 * reports it. Structural and tolerant on purpose: older pi runtimes have no
	 * such property, and an absent or empty list means no scoping is configured.
	 */
	scopedModels?: ReadonlyArray<{ model?: { provider?: unknown; id?: unknown } | null } | null | undefined> | null;
	isProjectTrusted?: () => boolean;
}

/**
 * Stands in for a scope entry whose shape this version could not read. It can
 * match no registry reference (those are always `provider/id`), so a scope
 * that decodes to nothing still constrains derivation — the stranded-scope
 * branch anchors the automatic tiers to the session model — instead of
 * silently widening back to the full registry.
 */
export const UNREADABLE_SCOPED_MODEL = "(unreadable scoped-model entry)";

/**
 * The scope's model references, in the `provider/id` form the roster ranks by.
 *
 * Entries whose shape is foreign are skipped rather than trusted — this reads a
 * property that only newer pi runtimes expose. An absent or empty list means no
 * scoping is configured. A NON-empty list whose entries all fail to decode is
 * different: the user configured a scope, this version just cannot read it, and
 * returning [] would fail open — ranking the full registry and dispatching
 * automatic tiers to models the scope may exclude. The sentinel keeps the scope
 * fact alive while decoding nothing.
 */
export function scopedModelReferences(scopedModels: RosterContext["scopedModels"]): string[] {
	if (!Array.isArray(scopedModels) || scopedModels.length === 0) return [];
	const references: string[] = [];
	for (const entry of scopedModels) {
		const model = entry?.model;
		if (model && typeof model.provider === "string" && typeof model.id === "string") {
			references.push(`${model.provider}/${model.id}`);
		}
	}
	return references.length ? references : [UNREADABLE_SCOPED_MODEL];
}

/**
 * What each tier resolves to for one run, read off the live pi context.
 *
 * The second half of the anti-corruption layer: this is where a pi runtime is
 * turned into plain roster inputs, so `model-roster.ts` stays a pure policy
 * module and the composition root stays wiring. Project config is read only for
 * a trusted project — a repo-controlled file choosing which model runs also
 * chooses which vendor sees the task, the same class of decision project trust
 * already gates for agent prompts.
 *
 * Every input is optional by construction. A context that cannot answer one of
 * them — a headless mode with no loaded registry, an unreadable config dir —
 * yields a roster that falls back to the user's default model rather than
 * throwing: failing a whole flow call because a *preference* could not be read
 * would be a worse answer than running the default.
 */
export function currentModelRoster(ctx: RosterContext): ModelRoster {
	let projectTrusted = false;
	try {
		projectTrusted = ctx.isProjectTrusted?.() === true;
	} catch {
		projectTrusted = false;
	}
	// Both halves of the load are carried forward: a pi-flows.json that failed to
	// parse has silently *not* applied the user's pins, and dropping the issue
	// here would leave the resulting model choice with no explanation anywhere.
	const discovered = ctx.cwd ? nearestProjectConfigDir(ctx.cwd) : { dir: null, issues: [] };
	const loaded = loadRosterConfig({
		userDir: getAgentDir(),
		projectDir: discovered.dir,
		projectTrusted,
	});
	return resolveModelRoster({
		available: availableModelsFromRegistry(ctx.modelRegistry),
		scoped: scopedModelReferences(ctx.scopedModels),
		parent: {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinking: isThinkingLevel(ctx.thinkingLevel) ? ctx.thinkingLevel : undefined,
		},
		env: envRosterConfig(),
		config: loaded.config,
		project: loaded.project,
		// Discovery failures matter as much as load failures: both end with the
		// project's pins unapplied, and only one of them was previously visible.
		issues: [...(projectTrusted ? discovered.issues : []), ...loaded.issues],
	});
}
