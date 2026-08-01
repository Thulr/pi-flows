// The roster: which concrete model and thinking level each tier resolves to on
// an install, derived from the models that install can actually run.
//
// The regression these guard against is the one that motivated the module: a
// tier that resolves to nothing is a tier that does nothing, and before this the
// only way `fast`/`deep` differed from `capable` was an environment variable the
// user had to know to export. So the assertions below are mostly about tiers
// producing *different* answers with no configuration at all.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { availableModelsFromRegistry } from "../extensions/pi-flows/roster-source.ts";
import {
	clampThinking,
	deriveModelRoster,
	describeModelRoster,
	envRosterConfig,
	loadRosterConfig,
	parseModelSpec,
	parseRosterConfig,
	resolveModelRoster,
	saveRosterOverride,
	usableModels,
} from "../extensions/pi-flows/model-roster.ts";

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function model(id, overrides = {}) {
	return {
		reference: `acme/${id}`,
		provider: "acme",
		id,
		reasoning: true,
		thinkingLevels: ALL_LEVELS,
		contextWindow: 200_000,
		costPerToken: 1,
		...overrides,
	};
}

const INSTALL = [
	model("mini", { costPerToken: 0.5, thinkingLevels: ["off", "low", "medium"] }),
	model("standard", { costPerToken: 3 }),
	model("flagship", { costPerToken: 15 }),
];

test("a tier resolves to a different model with no configuration at all", () => {
	const roster = deriveModelRoster({ available: INSTALL, parent: { model: "acme/standard", thinking: "medium" } });

	assert.equal(roster.source, "derived");
	assert.equal(roster.fast.model, "acme/mini", "fast takes the cheapest model this install can run");
	assert.equal(roster.deep.model, "acme/flagship", "deep takes the most capable");
	assert.equal(roster.capable.model, undefined, "capable is the user's own default, so no --model is passed");
	// The whole point: three tiers, three different behaviors, zero env vars.
	assert.notEqual(roster.fast.model, roster.deep.model);
});

test("capable inherits the parent session's thinking level rather than pinning one", () => {
	const inherited = deriveModelRoster({ available: INSTALL, parent: { model: "acme/standard", thinking: "high" } });
	assert.equal(inherited.capable.thinking, "high", "a plain delegated child thinks as hard as the session that delegated it");

	// Nothing to inherit: pi's own configured level applies, and pi-flows does not
	// invent one. Passing --thinking here would override a user preference we
	// were never told about.
	const unset = deriveModelRoster({ available: INSTALL, parent: { model: "acme/standard" } });
	assert.equal(unset.capable.thinking, undefined);
});

test("tiers carry a thinking level, clamped to what their model supports", () => {
	const roster = deriveModelRoster({ available: INSTALL, parent: { model: "acme/standard" } });
	assert.equal(roster.deep.thinking, "max", "deep asks for the most reasoning the model offers");
	// mini caps out at "medium", so the fast rung's "low" is unaffected — but the
	// clamp is what stops a rung asking for a level its model would reject.
	assert.equal(roster.fast.thinking, "low");
	assert.equal(clampThinking("max", INSTALL[0]), "medium", "an unsupported level steps down to the nearest supported one");
	assert.equal(clampThinking("max", model("plain", { reasoning: false })), "off", "a non-reasoning model always runs off");
	assert.equal(clampThinking(undefined, INSTALL[0]), undefined, "no request stays no request");
});

test("when the default model is already the best available, deep differs by thinking level, not by model", () => {
	// The common case on a single-provider install whose default is the top model.
	// Pinning --model to the model pi would have loaded anyway reads as
	// right-sizing that is not happening, so the rung says so instead.
	const roster = deriveModelRoster({ available: INSTALL, parent: { model: "acme/flagship", thinking: "medium" } });
	assert.equal(roster.deep.model, undefined, "no redundant pin to the model already loaded");
	assert.equal(roster.deep.thinking, "max", "the rung still means something: it thinks harder");
	assert.match(roster.deep.why, /thinking level/, "and the disclosure says exactly that");
});

test("fast prefers the parent's own provider so a scout does not silently change vendor", () => {
	const mixed = [...INSTALL, model("budget", { reference: "other/budget", provider: "other", costPerToken: 0.1 })];
	const roster = deriveModelRoster({ available: mixed, parent: { model: "acme/standard" } });
	assert.equal(roster.fast.model, "acme/mini", "the cheaper foreign model is not chosen over the parent's provider");

	// Unless the parent's provider has nothing else to offer, in which case a
	// second vendor beats no fast tier at all.
	const lonely = [model("only"), model("budget", { reference: "other/budget", provider: "other", costPerToken: 0.1 })];
	assert.equal(deriveModelRoster({ available: lonely, parent: { model: "acme/only" } }).fast.model, "other/budget");
});

test("deep prefers a reasoning model over a merely expensive one", () => {
	const available = [model("mini", { costPerToken: 0.5 }), model("pricey", { costPerToken: 99, reasoning: false })];
	const roster = deriveModelRoster({ available, parent: { model: "acme/mini" } });
	assert.equal(roster.deep.model, undefined, "the only reasoning model is the parent's own, so deep differs by level");
	assert.match(roster.deep.why, /thinking level/);
});

test("an unpriced model is treated as unknown, not as the cheapest or the strongest", () => {
	// Price is only a capability proxy when there is a price. A registry that
	// reports no cost for a model must not thereby hand it either rung — the cheap
	// end because unknown is not free, the deep end because unknown is not best.
	const available = [model("known-cheap", { costPerToken: 0.5 }), model("known-dear", { costPerToken: 20 }), model("unpriced", { costPerToken: undefined })];
	const roster = deriveModelRoster({ available, parent: { model: "acme/standard" } });
	assert.equal(roster.fast.model, "acme/known-cheap");
	assert.equal(roster.deep.model, "acme/known-dear");

	// Unless nothing is priced, in which case a stable pick beats no roster.
	const blind = deriveModelRoster({ available: [model("a", { costPerToken: undefined }), model("b", { costPerToken: undefined })], parent: {} });
	assert.ok(blind.fast.model && blind.deep.model);
});

test("models that cannot run a delegated task are not offered a tier", () => {
	const junk = [
		model("text-embedding-3", { costPerToken: 0.01 }),
		model("tiny", { costPerToken: 0.02, contextWindow: 8_000 }),
		model("real", { costPerToken: 5 }),
	];
	assert.deepEqual(usableModels(junk).map((entry) => entry.id), ["real"], "embeddings and toy context windows are excluded");
	// A cheap model that truncates the task is not a cheap expert, it is a failed
	// run, so fast must not pick one.
	assert.equal(deriveModelRoster({ available: junk, parent: {} }).fast.model, "acme/real");
});

test("an install with no readable registry falls back to the default model on every tier", () => {
	const roster = deriveModelRoster({ available: [], parent: { model: "acme/standard", thinking: "high" } });
	assert.equal(roster.source, "unavailable");
	for (const tier of ["fast", "capable", "deep"]) {
		assert.equal(roster[tier].model, undefined, `${tier} must not invent a model it cannot verify`);
	}
	assert.match(describeModelRoster(roster).join("\n"), /no model registry/, "and says so rather than reporting a roster it does not have");
});

test("config overrides the derived roster, and env is honored but outranked", () => {
	const base = { available: INSTALL, parent: { model: "acme/standard" } };
	const env = resolveModelRoster({ ...base, env: { fast: { model: "acme/flagship" } } });
	assert.equal(env.fast.model, "acme/flagship", "the legacy env mapping still works");
	assert.equal(env.source, "configured");

	// A file the user can open and revise beats a variable exported months ago:
	// the constraint is that pi-flows stays configurable inside pi.
	const both = resolveModelRoster({ ...base, env: { fast: { model: "acme/flagship" } }, config: { fast: { model: "acme/mini" } } });
	assert.equal(both.fast.model, "acme/mini");
});

test("an override may set a level without naming a model, and is clamped to the model in force", () => {
	const roster = resolveModelRoster({
		available: INSTALL,
		parent: { model: "acme/standard" },
		config: { fast: { thinking: "max" } },
	});
	assert.equal(roster.fast.model, "acme/mini", "the derived model survives a level-only override");
	assert.equal(roster.fast.thinking, "medium", "and the level is clamped to what that model supports");
});

test("parseModelSpec splits pi's :level shorthand without eating model ids that contain colons", () => {
	assert.deepEqual(parseModelSpec("anthropic/claude-haiku-4-5:low"), { model: "anthropic/claude-haiku-4-5", thinking: "low" });
	assert.deepEqual(parseModelSpec("openrouter/some-model:exacto"), { model: "openrouter/some-model:exacto" });
	assert.deepEqual(parseModelSpec("  acme/plain  "), { model: "acme/plain" });
});

test("config accepts the shorthand a user would type as well as the explicit form", () => {
	const shorthand = parseRosterConfig(JSON.stringify({ models: { fast: "acme/mini:low", deep: { model: "acme/flagship", thinking: "max" }, capable: "high" } }));
	assert.deepEqual(shorthand.config.fast, { model: "acme/mini", thinking: "low" });
	assert.deepEqual(shorthand.config.deep, { model: "acme/flagship", thinking: "max" });
	assert.deepEqual(shorthand.config.capable, { thinking: "high" }, "a bare level is a level, not a model named after one");

	// Malformed config is an ignored preference, not a broken flow: the roster
	// still resolves, and the caller is told what was skipped.
	const broken = parseRosterConfig("{ not json");
	assert.deepEqual(broken.config, {});
	assert.ok(broken.error);
});

test("project config is read only for a trusted project", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	const userDir = path.join(dir, "user");
	const projectDir = path.join(dir, "project");
	fs.mkdirSync(userDir);
	fs.mkdirSync(projectDir);
	fs.writeFileSync(path.join(userDir, "pi-flows.json"), JSON.stringify({ models: { fast: "acme/mini" } }));
	fs.writeFileSync(path.join(projectDir, "pi-flows.json"), JSON.stringify({ models: { fast: "acme/flagship" } }));

	// A repo-controlled file choosing which model runs also chooses which vendor
	// sees the task — the same class of decision project trust already gates.
	const untrusted = loadRosterConfig({ userDir, projectDir, projectTrusted: false });
	assert.deepEqual(untrusted.config.fast, { model: "acme/mini" });

	const trusted = loadRosterConfig({ userDir, projectDir, projectTrusted: true });
	assert.deepEqual(trusted.config.fast, { model: "acme/flagship" }, "a trusted project may narrow the roster");

	fs.rmSync(dir, { recursive: true, force: true });
});

test("saving one tier override preserves the rest of the user's config file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	fs.writeFileSync(path.join(dir, "pi-flows.json"), JSON.stringify({ somethingElse: 42, models: { deep: "acme/flagship:max" } }));

	saveRosterOverride(dir, "fast", { model: "acme/mini", thinking: "low" });
	const saved = JSON.parse(fs.readFileSync(path.join(dir, "pi-flows.json"), "utf8"));
	assert.equal(saved.somethingElse, 42, "settings this build does not know about must survive");
	assert.deepEqual(saved.models.fast, { model: "acme/mini", thinking: "low" });
	assert.equal(saved.models.deep, "acme/flagship:max", "the other tiers are untouched");

	saveRosterOverride(dir, "fast", undefined);
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "pi-flows.json"), "utf8")).models.fast, undefined, "clearing returns the tier to derivation");

	// Establishing a config file where none existed must not fail the command.
	const fresh = path.join(dir, "nested", "agent");
	assert.ok(saveRosterOverride(fresh, "deep", { thinking: "max" }).startsWith(fresh));

	fs.rmSync(dir, { recursive: true, force: true });
});

test("the registry adapter keeps a foreign model shape out of the roster", () => {
	const models = availableModelsFromRegistry({
		getAvailable: () => [
			{ id: "thinker", provider: "acme", reasoning: true, contextWindow: 200_000, maxTokens: 64_000, cost: { input: 3, output: 15 }, thinkingLevelMap: { max: null } },
			{ id: "plain", provider: "acme", reasoning: false, contextWindow: 128_000, maxTokens: 16_000, cost: { input: 1, output: 2 } },
		],
	});

	assert.equal(models[0].reference, "acme/thinker", "provider/id is the form --model accepts");
	assert.ok(!models[0].thinkingLevels.includes("max"), "a level the provider maps to null is unsupported");
	assert.ok(models[0].thinkingLevels.includes("high"), "a level it simply omits uses the provider default, so absence means available");
	assert.deepEqual(models[1].thinkingLevels, ["off"], "a non-reasoning model offers only off");
	// Output tokens are priced higher than input almost everywhere, so ranking on
	// input alone would rate a cheap-in/expensive-out model as the budget option.
	assert.ok(models[0].costPerToken > 3 && models[0].costPerToken < 15);
});

test("a registry that cannot answer yields no roster rather than a failed flow", () => {
	assert.deepEqual(availableModelsFromRegistry(undefined), []);
	assert.deepEqual(availableModelsFromRegistry({}), []);
	assert.deepEqual(
		availableModelsFromRegistry({ getAvailable: () => { throw new Error("registry not loaded"); } }),
		[],
		"an unreadable registry falls back to the pi default model, it does not propagate",
	);
});

test("envRosterConfig reads the legacy variables, including their :level suffix", () => {
	const prevFast = process.env.PI_FLOWS_FAST_MODEL;
	const prevDeep = process.env.PI_FLOWS_DEEP_MODEL;
	try {
		process.env.PI_FLOWS_FAST_MODEL = "  openai-codex/gpt-5.4-mini:low  ";
		process.env.PI_FLOWS_DEEP_MODEL = "  anthropic/claude-fable-5  ";
		assert.deepEqual(envRosterConfig(), {
			fast: { model: "openai-codex/gpt-5.4-mini", thinking: "low" },
			deep: { model: "anthropic/claude-fable-5" },
		});
		delete process.env.PI_FLOWS_FAST_MODEL;
		delete process.env.PI_FLOWS_DEEP_MODEL;
		assert.deepEqual(envRosterConfig(), {}, "unset variables contribute nothing rather than an empty override");
	} finally {
		if (prevFast === undefined) delete process.env.PI_FLOWS_FAST_MODEL;
		else process.env.PI_FLOWS_FAST_MODEL = prevFast;
		if (prevDeep === undefined) delete process.env.PI_FLOWS_DEEP_MODEL;
		else process.env.PI_FLOWS_DEEP_MODEL = prevDeep;
	}
});
