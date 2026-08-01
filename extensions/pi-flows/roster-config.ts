/**
 * How a user states a tier override, and where those statements are read from.
 *
 * Split from the ranking policy next door because these are different jobs: that
 * module decides what a tier *would* resolve to, this one reads what the user
 * said it should. Keeping them apart is also what lets the derivation stay a
 * pure function with no filesystem or environment underneath it.
 *
 * Two sources, plus the legacy environment mapping:
 *
 *   ~/.pi/agent/pi-flows.json   the user's own
 *   <project>/.pi/pi-flows.json only when pi says the project is trusted
 *   PI_FLOWS_FAST_MODEL / PI_FLOWS_DEEP_MODEL
 *
 * A malformed file yields no overrides and an issue rather than an exception:
 * config is an opt-in, and failing a flow call because a *preference* could not
 * be read would be a worse answer than running without it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ROSTER_CONFIG_FILE, USE_DEFAULT_MODEL, type RosterConfig, type RosterOverride, type ThinkingLevel } from "./types.ts";
import { isThinkingLevel, parseModelSpec } from "./model-roster.ts";

export { ROSTER_CONFIG_FILE };
export type { RosterConfig, RosterOverride };

/**
 * Read one override, accepting either the shorthand a user would type into a
 * `--model` flag or the explicit object form.
 *
 *   "fast": "anthropic/claude-haiku-4-5:low"
 *   "fast": { "model": "anthropic/claude-haiku-4-5", "thinking": "low" }
 */
function readOverride(raw: unknown): RosterOverride | undefined {
	const pair = (model: string | null | undefined, thinking: ThinkingLevel | undefined): RosterOverride | undefined => {
		// Only the keys actually set: an override carrying `thinking: undefined`
		// reads as "no level" everywhere it is merged, which is true, but it also
		// makes an override that set nothing indistinguishable from one that did.
		// `model: null` is a statement, so it survives the check `undefined` fails.
		if (model === undefined && !thinking) return undefined;
		return { ...(model !== undefined ? { model } : {}), ...(thinking ? { thinking } : {}) };
	};
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		if (isThinkingLevel(trimmed)) return { thinking: trimmed };
		// The word a user would reach for to say "my own model" in the shorthand
		// form, with the same meaning as `"model": null` in the object form.
		if (trimmed.toLowerCase() === "default") return { model: USE_DEFAULT_MODEL };
		const { model, thinking } = parseModelSpec(trimmed);
		return pair(model || undefined, thinking);
	}
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const rawModel = record.model;
	const model = rawModel === null
		? USE_DEFAULT_MODEL
		: typeof rawModel === "string" && rawModel.trim()
			? rawModel.trim()
			: undefined;
	return pair(model, isThinkingLevel(record.thinking) ? record.thinking : undefined);
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
export function loadRosterConfig(source: RosterConfigSource): { config: RosterConfig; issues: string[]; project: RosterConfig } {
	const issues: string[] = [];
	const merged: RosterConfig = {};
	// The project layer is kept separately as well as merged. `/flows models`
	// writes to the *user* file, so it has to know which rungs a trusted project
	// has already claimed — otherwise it reports an edit as taking effect while
	// the project's higher-precedence value keeps winning.
	const project: RosterConfig = {};
	const projectDir = source.projectTrusted ? source.projectDir : null;
	const dirs = [source.userDir, projectDir];
	for (const dir of dirs) {
		if (!dir) continue;
		const file = path.join(dir, ROSTER_CONFIG_FILE);
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (error) {
			// Only "no such file" is silence — having no config is the normal case
			// and not worth reporting. Any other failure (permissions, EISDIR, a
			// bad symlink) means a file the user wrote is being ignored, which is
			// indistinguishable from their pins not working unless it is said out
			// loud.
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
				issues.push(`${ROSTER_CONFIG_FILE} could not be read (${(error as NodeJS.ErrnoException)?.code ?? "unknown error"}); its overrides were ignored.`);
			}
			continue;
		}
		const { config, error } = parseRosterConfig(text);
		if (error) {
			issues.push(`${ROSTER_CONFIG_FILE} could not be parsed (${error}); its overrides were ignored.`);
			continue;
		}
		// Field by field, not tier by tier. A shallow assign lets a project that
		// states only `fast.thinking` discard the user's `fast.model` entirely,
		// silently moving that tier back to the derived model — possibly another
		// vendor's. A higher-precedence source overrides what it actually says,
		// which is the same rule the env/config layering downstream applies.
		for (const tier of ["fast", "capable", "deep"] as const) {
			const override = config[tier];
			if (!override) continue;
			merged[tier] = { ...merged[tier], ...override };
			if (dir === projectDir) project[tier] = { ...project[tier], ...override };
		}
	}
	return { config: merged, issues, project };
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
	// `model` is written whenever the override states one, including the explicit
	// null that means "my pi default" — dropping it there would save the choice as
	// a bare thinking override and let the derived model quietly stay in force.
	if (override) models[tier] = { ...(override.model !== undefined ? { model: override.model } : {}), ...(override.thinking ? { thinking: override.thinking } : {}) };
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
