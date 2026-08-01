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
function nearestProjectConfigDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME);
		try {
			if (fs.statSync(path.join(candidate, ROSTER_CONFIG_FILE)).isFile()) return candidate;
		} catch {
			// No roster config at this level; keep walking.
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/** What resolving a roster needs from a live pi context. Structural, so the shape stays visible here rather than imported wholesale. */
interface RosterContext {
	cwd?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	modelRegistry?: ModelRegistryLike;
	isProjectTrusted?: () => boolean;
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
	const loaded = loadRosterConfig({
		userDir: getAgentDir(),
		projectDir: ctx.cwd ? nearestProjectConfigDir(ctx.cwd) : null,
		projectTrusted,
	});
	return resolveModelRoster({
		available: availableModelsFromRegistry(ctx.modelRegistry),
		parent: {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinking: isThinkingLevel(ctx.thinkingLevel) ? ctx.thinkingLevel : undefined,
		},
		env: envRosterConfig(),
		config: loaded.config,
		project: loaded.project,
		issues: loaded.issues,
	});
}
