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
import { resolveChildModel } from "../extensions/pi-flows/runner.ts";
import {
	clampThinking,
	deriveModelRoster,
	describeModelRoster,
	knownModel,
	parseModelSpec,
	resolveModelRoster,
	usableModels,
} from "../extensions/pi-flows/model-roster.ts";
import { envRosterConfig, loadRosterConfig, parseRosterConfig, saveRosterOverride } from "../extensions/pi-flows/roster-config.ts";

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
	// Pinned to the concrete model this session runs, not left as "the default":
	// a child spawns with no inherited state, so an omitted --model would load
	// pi's *configured* default, which need not be what the parent is on.
	assert.equal(roster.capable.model, "acme/standard");
	// The whole point: three tiers, three different behaviors, zero env vars.
	assert.notEqual(roster.fast.model, roster.deep.model);
});

test("capable names the session's model, because a child does not inherit it", () => {
	// A child spawns with `--no-session` and no inherited state, so omitting
	// `--model` loads pi's *configured* default. A parent started with `--model`
	// or switched interactively is running something else, and `capable` promises
	// the session's model — so it has to name it, or the child quietly runs
	// somewhere else, possibly on another provider.
	const roster = deriveModelRoster({ available: INSTALL, parent: { model: "acme/mini" } });
	assert.equal(roster.capable.model, "acme/mini", "not null — null would mean pi's configured default, which may differ");
	assert.match(roster.capable.why, /this session is running/);

	// Only an unknown parent leaves it as the configured default, because then
	// there is no concrete model to name.
	assert.equal(deriveModelRoster({ available: INSTALL, parent: {} }).capable.model, null);
});

test("the parent's provider is found even when its model is too small to be assigned a tier", () => {
	// The provider preference reads the parent out of the registry, not out of the
	// assignable pool. Losing it to the context-window filter would empty the
	// same-provider set and send `fast` to whatever is globally cheapest — the
	// vendor move the preference exists to prevent.
	const tinyDefault = model("local-8k", { contextWindow: 8_000, costPerToken: 0.01 });
	const available = [tinyDefault, model("standard", { costPerToken: 3 }), model("budget", { reference: "other/budget", provider: "other", costPerToken: 0.1 })];
	const roster = deriveModelRoster({ available, parent: { model: "acme/local-8k" } });
	assert.equal(roster.fast.model, "acme/standard", "stays on the parent's provider despite a cheaper foreign model");
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

	// A reasoning-only model may offer nothing at or below the request — no off,
	// no minimal, no low. Clamping exists to stop a level exceeding what a model
	// can do, so it must never answer a small request with a large one: `low`
	// against ["medium","high"] is `medium`, and answering `high` would cost more
	// than was asked for, inverting the fast rung's whole purpose.
	const reasoningOnly = model("floor", { thinkingLevels: ["medium", "high"] });
	assert.equal(clampThinking("low", reasoningOnly), "medium");
	assert.equal(clampThinking("off", reasoningOnly), "medium");
	assert.equal(clampThinking("high", reasoningOnly), "high", "a level it does offer is untouched");
});

test("when the default model is already the best available, deep differs by thinking level, not by model", () => {
	// The common case on a single-provider install whose default is the top model.
	// Pinning --model to the model pi would have loaded anyway reads as
	// right-sizing that is not happening, so the rung says so instead.
	const roster = deriveModelRoster({ available: INSTALL, parent: { model: "acme/flagship", thinking: "medium" } });
	assert.equal(roster.deep.model, "acme/flagship", "still pinned — dropping it would load pi's configured default, not this session's model");
	assert.equal(roster.deep.thinking, "max", "the rung still means something: it thinks harder");
	assert.match(roster.deep.why, /thinking level/, "and the disclosure says exactly that");
});

test("fast prefers the parent's own provider so a scout does not silently change vendor", () => {
	const mixed = [...INSTALL, model("budget", { reference: "other/budget", provider: "other", costPerToken: 0.1 })];
	const roster = deriveModelRoster({ available: mixed, parent: { model: "acme/standard" } });
	assert.equal(roster.fast.model, "acme/mini", "the cheaper foreign model is not chosen over the parent's provider");

	// Including when the parent's provider offers nothing cheaper than the model
	// already loaded. The rung is still meaningful — that model at `low` thinking
	// — and that beats silently sending a scout's task to a second vendor. The
	// guarantee is about where the work goes; cost is the tiebreak within it.
	const lonely = [model("only"), model("budget", { reference: "other/budget", provider: "other", costPerToken: 0.1 })];
	const loyal = deriveModelRoster({ available: lonely, parent: { model: "acme/only" } });
	assert.equal(loyal.fast.model, "acme/only", "the parent's own model at low thinking, not another vendor's cheaper one");
	assert.equal(loyal.fast.thinking, "low");

	// With no parent model there is nothing to stay loyal to, so price decides.
	assert.equal(deriveModelRoster({ available: lonely, parent: {} }).fast.model, "other/budget");
});

test("deep prefers a reasoning model over a merely expensive one", () => {
	const available = [model("mini", { costPerToken: 0.5 }), model("pricey", { costPerToken: 99, reasoning: false })];
	const roster = deriveModelRoster({ available, parent: { model: "acme/mini" } });
	assert.equal(roster.deep.model, "acme/mini", "the only reasoning model is the parent's own, so deep differs by level");
	assert.match(roster.deep.why, /thinking level/);
});

test("deep judges extended thinking by the levels a model offers, not by its reasoning flag", () => {
	// A provider that maps xhigh/max to null leaves a model that reasons but
	// cannot be pushed. Picking it would make `deep` resolve to a rung it cannot
	// deliver, and describe itself as supporting thinking it does not have.
	const capped = model("capped", { costPerToken: 99, thinkingLevels: ["off", "low", "medium"] });
	const real = model("real", { costPerToken: 20, thinkingLevels: ["off", "low", "medium", "high", "max"] });
	const roster = deriveModelRoster({ available: [model("mini", { costPerToken: 0.5 }), capped, real], parent: {} });
	assert.equal(roster.deep.model, "acme/real", "the pricier model that cannot think longer is not the adjudicator");
	assert.equal(roster.deep.thinking, "max");

	// When nothing offers extended thinking the rung still resolves, but it must
	// not claim a capability the install does not have.
	const none = deriveModelRoster({ available: [model("a", { costPerToken: 1, thinkingLevels: ["off", "low"] }), model("b", { costPerToken: 5, thinkingLevels: ["off", "low"] })], parent: {} });
	assert.equal(none.deep.model, "acme/b");
	assert.match(none.deep.why, /none offer extended thinking/);
	assert.equal(none.deep.thinking, "low", "and the level it reports is one that model can actually run");
});

test("deep breaks a price tie toward the larger context window", () => {
	// cheaperFirst puts the larger context first on a tie, so reading its far end
	// would invert the preference and hand deep the smaller-context model.
	const small = model("small-ctx", { costPerToken: 10, contextWindow: 200_000 });
	const large = model("large-ctx", { costPerToken: 10, contextWindow: 1_000_000 });
	const roster = deriveModelRoster({ available: [model("mini", { costPerToken: 0.5 }), small, large], parent: {} });
	assert.equal(roster.deep.model, "acme/large-ctx");
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
	// fast and deep genuinely did not resolve — undefined, so a call naming one
	// still falls through to whatever the agent pinned. capable did resolve: "the
	// pi default" is knowable without a registry.
	assert.equal(roster.fast.model, undefined, "fast must not invent a model it cannot verify");
	assert.equal(roster.deep.model, undefined, "deep must not invent a model it cannot verify");
	assert.equal(roster.capable.model, "acme/standard", "capable still names the session's model, which needs no registry to know");
	assert.match(describeModelRoster(roster).join("\n"), /no model registry/, "and says so rather than reporting a roster it does not have");
});

test("deep falls back to a reasoning model before a pricier one that cannot reason at all", () => {
	// Nothing offers high/xhigh/max, so the extended pool is empty. Dropping
	// straight to the whole pool would let the pricier non-reasoning model win —
	// and then deep's `max` clamps to `off`, the least deep answer available.
	const cheapCapped = model("mini", { costPerToken: 0.5, thinkingLevels: ["off", "low"] });
	const reasoningCapped = model("capped", { costPerToken: 10, thinkingLevels: ["off", "low", "medium"] });
	const pricierPlain = model("plain", { costPerToken: 50, reasoning: false });
	const roster = deriveModelRoster({ available: [cheapCapped, reasoningCapped, pricierPlain], parent: {} });
	assert.equal(roster.deep.model, "acme/capped", "a model that can still think beats one that cannot");
	assert.equal(roster.deep.thinking, "medium", "clamped to what it offers, rather than collapsed to off");
});

test("a rung names the layer that settled it, so an edit cannot be silently shadowed", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	const userDir = path.join(dir, "user");
	const projectDir = path.join(dir, "project");
	fs.mkdirSync(userDir);
	fs.mkdirSync(projectDir);
	fs.writeFileSync(path.join(userDir, "pi-flows.json"), JSON.stringify({ models: { fast: { model: "acme/mini" } } }));
	fs.writeFileSync(path.join(projectDir, "pi-flows.json"), JSON.stringify({ models: { deep: { model: "acme/flagship" } } }));

	const loaded = loadRosterConfig({ userDir, projectDir, projectTrusted: true });
	assert.deepEqual(Object.keys(loaded.project), ["deep"], "the project layer is reported separately from the merge");

	// `/flows models` writes the user's file, which a trusted project outranks.
	// Without the origin it would report an edit to `deep` as taking effect while
	// the project's value kept winning.
	const roster = resolveModelRoster({ available: INSTALL, parent: { model: "acme/standard" }, config: loaded.config, project: loaded.project });
	assert.equal(roster.deep.origin?.model, "project-config");
	assert.equal(roster.fast.origin?.model, "user-config");
	assert.equal(roster.capable.origin?.model, "derived", "a rung nobody configured says so");
});

test("precedence is tracked per field, so a project that sets only one does not claim both", () => {
	// The layers merge per field, so a project stating `thinking` still lets a
	// user's `model` take effect. Marking the whole rung project-owned made
	// /flows models warn that a model edit was inert when it was not — and stay
	// silent about the level, which the project really does replace.
	const roster = resolveModelRoster({
		available: INSTALL,
		parent: { model: "acme/standard" },
		config: { fast: { model: "acme/flagship", thinking: "low" } },
		project: { fast: { thinking: "low" } },
	});
	assert.equal(roster.fast.origin?.model, "user-config", "the model is still the user's to change");
	assert.equal(roster.fast.origin?.thinking, "project-config", "the level is the project's");
	assert.equal(roster.fast.model, "acme/flagship", "and the user's model is what actually runs");
});

test("a project override narrows the user's tier field by field, not wholesale", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	const userDir = path.join(dir, "user");
	const projectDir = path.join(dir, "project");
	fs.mkdirSync(userDir);
	fs.mkdirSync(projectDir);
	fs.writeFileSync(path.join(userDir, "pi-flows.json"), JSON.stringify({ models: { fast: { model: "acme/flagship" } } }));
	fs.writeFileSync(path.join(projectDir, "pi-flows.json"), JSON.stringify({ models: { fast: { thinking: "low" } } }));

	// A shallow tier-level assign would drop the user's model pin entirely and
	// silently return that tier to the derived model — possibly another vendor's.
	const loaded = loadRosterConfig({ userDir, projectDir, projectTrusted: true });
	assert.deepEqual(loaded.config.fast, { model: "acme/flagship", thinking: "low" });

	const roster = resolveModelRoster({ available: INSTALL, parent: { model: "acme/standard" }, config: loaded.config });
	assert.equal(roster.fast.model, "acme/flagship", "the user's pin survives a project override that never mentioned a model");
	assert.equal(roster.fast.thinking, "low");
	fs.rmSync(dir, { recursive: true, force: true });
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

test("an unpinned child's model is unknown, so no clamp is claimed for it", () => {
	// The majority of children run without --model. Keying the clamp only on a
	// stated reference would skip all of them, and `tier:"capable"` with
	// `thinking:"max"` on a model that stops at medium would be *reported* as max
	// — the one thing the recorded level must never do.
	const capped = model("standard", { thinkingLevels: ["off", "low", "medium"] });
	const roster = deriveModelRoster({ available: [capped, model("mini", { costPerToken: 0.1 })], parent: { model: "acme/standard" } });
	assert.equal(roster.sessionModel, "acme/standard", "the roster records the session's model");

	// An unpinned child loads pi's *configured* default, which this extension
	// cannot read — so its capabilities are unknown and no clamp is claimed.
	// Substituting the session model would report a limit the child never had.
	assert.equal(knownModel(roster, undefined), undefined);

	// `capable` avoids the problem entirely by naming the model, which is what
	// makes its level checkable.
	const override = resolveModelRoster({
		available: [capped, model("mini", { costPerToken: 0.1 })],
		parent: { model: "acme/standard" },
		config: { capable: { thinking: "max" } },
	});
	assert.equal(override.capable.model, "acme/standard", "capable still runs the session's model");
	assert.equal(override.capable.thinking, "medium", "and its level is lowered to what that concrete model supports");
});

test("a default model too small to be assigned a tier still has its limits respected", () => {
	// Ranking excludes models that cannot hold a delegated task — but the pi
	// default is whatever the user set, and a local 8k model is a real setup. If
	// the roster kept only the assignable pool, that default would have no
	// capabilities on record and a requested `max` would be reported unclamped.
	const tiny = model("local-8k", { contextWindow: 8_000, thinkingLevels: ["off", "low"] });
	const roster = deriveModelRoster({ available: [tiny, ...INSTALL], parent: { model: "acme/local-8k" } });

	assert.ok(!usableModels(roster.available).some((entry) => entry.id === "local-8k"), "it is still not assignable to a tier");
	// `capable` names it, and naming it is what makes its limits checkable — the
	// capabilities have to be on record even though ranking excluded it.
	assert.equal(roster.capable.model, "acme/local-8k");
	assert.equal(clampThinking("max", knownModel(roster, roster.capable.model)), "low", "so a level requested against it is lowered honestly");

	// Same for a config pin naming a model ranking excluded: the user chose it,
	// and it still has real limits.
	const pinned = resolveModelRoster({ available: [tiny, ...INSTALL], parent: { model: "acme/standard" }, config: { deep: { model: "acme/local-8k", thinking: "max" } } });
	assert.equal(pinned.deep.thinking, "low");
});

test("choosing the pi default is persisted as a decision, not as an absent model", () => {
	// `undefined` already means "keep the derived assignment", so collapsing the
	// two would leave a user who pinned fast to their own model still running the
	// derived cheap one — possibly from a different provider.
	const explicit = parseRosterConfig(JSON.stringify({ models: { fast: { model: null, thinking: "low" } } }));
	assert.deepEqual(explicit.config.fast, { model: null, thinking: "low" });

	const roster = resolveModelRoster({
		available: INSTALL,
		parent: { model: "acme/standard" },
		config: explicit.config,
	});
	assert.equal(roster.fast.model, null, "an explicit null clears the derived model rather than being ignored");
	assert.equal(roster.fast.thinking, "low");

	// A level-only override must still leave the derived model in force — that is
	// the distinction the null exists to preserve.
	const levelOnly = resolveModelRoster({ available: INSTALL, parent: { model: "acme/standard" }, config: { fast: { thinking: "low" } } });
	assert.equal(levelOnly.fast.model, "acme/mini");

	assert.deepEqual(parseRosterConfig(JSON.stringify({ models: { deep: "default" } })).config.deep, { model: null }, "the shorthand form says it with a word");
});

test("pinning a tier to a new model re-asks for that tier's level, not the old model's clamp", () => {
	// The derived level was clamped against the model derivation chose. Carrying
	// it onto a different model carries the *old* model's limits: a non-reasoning
	// fast rung clamps to `off`, so pinning fast to a reasoning model without
	// naming a level would keep `off` instead of the `low` the rung documents.
	const plainCheap = model("plain", { costPerToken: 0.1, reasoning: false });
	const thinker = model("thinker", { costPerToken: 5 });
	const derived = deriveModelRoster({ available: [plainCheap, thinker], parent: { model: "acme/thinker" } });
	assert.equal(derived.fast.thinking, "off", "the derived fast model cannot reason, so its level is off");

	const pinned = resolveModelRoster({
		available: [plainCheap, thinker],
		parent: { model: "acme/thinker" },
		config: { fast: { model: "acme/thinker" } },
	});
	assert.equal(pinned.fast.thinking, "low", "the tier's own level applies to the model that replaced it");

	// An explicitly stated level still wins over the tier default.
	const explicit = resolveModelRoster({
		available: [plainCheap, thinker],
		parent: { model: "acme/thinker" },
		config: { fast: { model: "acme/thinker", thinking: "high" } },
	});
	assert.equal(explicit.fast.thinking, "high");
});

test("a model-only override keeps a level a lower layer stated explicitly", () => {
	// Re-asking the tier default is right only when the level in hand *was* a tier
	// default. A level the user set is a decision about effort, not an artifact of
	// the model that layer happened to pick — and the per-field origin already
	// says the level is still theirs.
	const roster = resolveModelRoster({
		available: INSTALL,
		parent: { model: "acme/standard" },
		config: { fast: { model: "acme/flagship", thinking: "high" } },
		project: { fast: { model: "acme/flagship" } },
	});
	assert.equal(roster.fast.thinking, "high", "the user's explicit level survives a project model change");
	assert.equal(roster.fast.origin?.thinking, "user-config", "and the origin agrees it is still theirs");

	// A level that was only the tier's default is still re-asked for the new model.
	const derivedLevel = resolveModelRoster({
		available: [model("plain", { costPerToken: 0.1, reasoning: false }), model("thinker", { costPerToken: 5 })],
		parent: { model: "acme/thinker" },
		config: { fast: { model: "acme/thinker" } },
	});
	assert.equal(derivedLevel.fast.thinking, "low");
});

test("a stated-but-unusable override field is reported, not silently dropped", () => {
	// Dropping `{"model": 42}` to undefined leaves the tier derived, so a user who
	// pinned a model watches work go elsewhere with nothing to explain it. A
	// rejected field is a mistake, not an omission.
	const bad = parseRosterConfig(JSON.stringify({ models: { fast: { model: 42 }, deep: { thinking: "mx" }, capable: 7 } }));
	assert.equal(bad.error, undefined, "the file itself parsed; only the values are wrong");
	assert.equal(bad.invalid.length, 3);
	assert.match(bad.invalid.join("\n"), /models\.fast "model" must be/);
	assert.match(bad.invalid.join("\n"), /models\.deep "thinking" must be/);
	assert.match(bad.invalid.join("\n"), /models\.capable must be/);

	// A partially wrong override still applies the field that was usable, and the
	// rejection is still reported.
	const partial = parseRosterConfig(JSON.stringify({ models: { fast: { model: "acme/mini", thinking: "nope" } } }));
	assert.deepEqual(partial.config.fast, { model: "acme/mini" });
	assert.equal(partial.invalid.length, 1);

	const clean = parseRosterConfig(JSON.stringify({ models: { fast: "acme/mini:low" } }));
	assert.deepEqual(clean.invalid, []);
});

test("saving refuses to overwrite a config file it could not parse", () => {
	// A missing comma is recoverable; starting from `{}` and writing would turn it
	// into permanent loss of every unrelated setting, to record one menu choice.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	const file = path.join(dir, "pi-flows.json");
	const original = '{ "somethingElse": 42, "models": { "deep": "acme/flagship" } '; // missing brace
	fs.writeFileSync(file, original);

	assert.throws(() => saveRosterOverride(dir, "fast", { model: "acme/mini" }), /not valid JSON/);
	assert.equal(fs.readFileSync(file, "utf8"), original, "the file the user can still repair is left exactly as it was");

	// A file that simply does not exist is still a clean slate.
	const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	assert.ok(saveRosterOverride(fresh, "fast", { model: "acme/mini" }));

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(fresh, { recursive: true, force: true });
});

test("an explicit pi-default choice survives a round trip through the config file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	saveRosterOverride(dir, "fast", { model: null, thinking: "low" });
	const written = JSON.parse(fs.readFileSync(path.join(dir, "pi-flows.json"), "utf8"));
	assert.equal(written.models.fast.model, null, "the null must be written, not dropped as an absent key");

	const reloaded = loadRosterConfig({ userDir: dir, projectDir: null, projectTrusted: false });
	assert.deepEqual(reloaded.config.fast, { model: null, thinking: "low" });
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a config file that exists but cannot be read is reported, not treated as absent", () => {
	// A missing file is the normal case and stays silent. Any other read failure
	// means a file the user wrote is being ignored — indistinguishable from their
	// pins simply not working unless it is said out loud. `EISDIR` stands in for
	// the class here because it is reproducible without depending on running as a
	// non-root user, which would make a chmod-based test vacuous under CI.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	fs.mkdirSync(path.join(dir, "pi-flows.json"));

	const unreadable = loadRosterConfig({ userDir: dir, projectDir: null, projectTrusted: false });
	assert.equal(unreadable.issues.length, 1);
	assert.match(unreadable.issues[0], /could not be read/);

	// A directory with no config at all still reports nothing.
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	assert.deepEqual(loadRosterConfig({ userDir: empty, projectDir: null, projectTrusted: false }).issues, []);

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(empty, { recursive: true, force: true });
});

test("config that could not be read is reported next to the roster it failed to change", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	fs.writeFileSync(path.join(dir, "pi-flows.json"), "{ not json");
	const loaded = loadRosterConfig({ userDir: dir, projectDir: null, projectTrusted: false });
	assert.equal(loaded.issues.length, 1);

	// A pin the user believes is in force but which never parsed is exactly the
	// state that makes a surprising model choice undiagnosable.
	const roster = resolveModelRoster({ available: INSTALL, parent: {}, config: loaded.config, issues: loaded.issues });
	assert.match(describeModelRoster(roster).join("\n"), /modelRoster\.issue: .*could not be parsed/);
	fs.rmSync(dir, { recursive: true, force: true });
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

test("the project config search walks past a .pi directory that holds no roster config", async () => {
	// Searching for the directory rather than the file lets an unrelated nested
	// `.pi` — a sub-package with its own config dir but no model pins — shadow the
	// repository's, which is the same silent miss one level down.
	const { currentModelRoster } = await import("../extensions/pi-flows/roster-source.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	// Pinned to a model derivation would never choose for `deep` — the cheapest
	// one — so the assertion can only pass if the file was actually read. Pinning
	// the model derivation already picks would make this test vacuous.
	fs.writeFileSync(path.join(root, ".pi", "pi-flows.json"), JSON.stringify({ models: { deep: { model: "acme/mini" } } }));
	const nested = path.join(root, "packages", "web");
	fs.mkdirSync(path.join(nested, ".pi"), { recursive: true });

	const registry = { getAvailable: () => INSTALL.map((entry) => ({ id: entry.id, provider: entry.provider, reasoning: true, contextWindow: entry.contextWindow, maxTokens: 4096, cost: { input: entry.costPerToken, output: entry.costPerToken } })) };
	const roster = currentModelRoster({ cwd: nested, modelRegistry: registry, isProjectTrusted: () => true });
	assert.notEqual(roster.deep.model, "acme/flagship", "derivation's own pick would mean the file was never read");
	assert.equal(roster.deep.model, "acme/mini", "the repository's pins are found from a subdirectory with its own bare .pi");

	fs.rmSync(root, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Per-call resolution: how one child's model and level are picked from the
// roster, the agent's frontmatter, and the call itself. Lives here rather than
// in pi-flows.test.ts because it is the same subject as the roster above — and
// that file is at its line cap.
// ---------------------------------------------------------------------------

/** A roster shaped like a two-model install, without needing a pi runtime. */
function testRoster(overrides = {}) {
  return {
    fast: { model: "p/cheap", thinking: "low", why: "test" },
    // null, not undefined: this rung resolved, and what it resolved to is the pi
    // default. undefined would mean the tier had no answer at all.
    capable: { model: null, thinking: "medium", why: "test" },
    deep: { model: "p/strong", thinking: "max", why: "test" },
    defaultModel: "p/strong",
    available: [
      { reference: "p/cheap", provider: "p", id: "cheap", reasoning: true, thinkingLevels: ["off", "low", "medium"], contextWindow: 200_000, costPerToken: 1 },
      { reference: "p/strong", provider: "p", id: "strong", reasoning: true, thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"], contextWindow: 200_000, costPerToken: 9 },
    ],
    source: "derived",
    ...overrides,
  };
}

test("resolveChildModel: flow model > flow tier > agent pin > agent tier > pi default", () => {
  const roster = testRoster();
  // No default parameter here: the unresolvable-roster cases pass `undefined`
  // deliberately, and a default would silently substitute the roster back in.
  const model = (agent, options, ...rest) => resolveChildModel(agent, options, rest.length ? rest[0] : roster).model;
  assert.equal(model({ tier: "fast" }, { model: "override" }), "override", "a flow-call model override wins");
  assert.equal(model({ model: "pinned" }, { tier: "deep" }), "p/strong", "a flow-call tier expresses per-task intent and beats the agent pin");
  assert.equal(model({ model: "pinned", tier: "fast" }, {}), "pinned", "an explicit agent.model pin wins over its own tier");
  assert.equal(model({ tier: "fast" }, {}), "p/cheap", "fast resolves to the roster's fast rung");
  assert.equal(model({ tier: "deep" }, {}), "p/strong", "deep resolves to the roster's deep rung");
  assert.equal(model({ model: "pinned", tier: "deep" }, { tier: "capable" }), undefined, "a flow-call capable tier forces the default model even against an agent pin");
  assert.equal(model({ tier: "capable" }, {}), undefined, "capable defers to the user's pi default");
  assert.equal(model({}, {}), undefined, "no tier/model defers to the pi default");
  // The roster is unavailable (no registry): tiers stop resolving, but an agent
  // pin must still be honored rather than the flow silently losing its model.
  assert.equal(model({ model: "pinned" }, { tier: "deep" }, undefined), "pinned", "an unresolvable flow-call tier falls through to the agent pin");
  assert.equal(model({ tier: "fast" }, {}, undefined), undefined, "an unresolvable tier defers to the pi default");

  // A rung that resolved to the pi default is an ANSWER, not silence. Reading it
  // as silence would fall through to the agent pin — so asking for `deep` on an
  // install whose default is already the strongest model would run the *cheap*
  // model a fast agent pinned, the exact inversion of the request.
  const defaultIsStrongest = testRoster({ deep: { model: null, thinking: "max", why: "default is already strongest" } });
  assert.equal(model({ model: "p/cheap", tier: "fast" }, { tier: "deep" }, defaultIsStrongest), undefined, "a deep rung resolving to the default beats a fast agent's pin");
  assert.equal(
    resolveChildModel({ model: "p/cheap", tier: "fast" }, { tier: "deep" }, defaultIsStrongest).thinking,
    "max",
    "and the level comes from the tier that was actually asked for",
  );
});

test("resolveChildModel: a named thinking level outranks the tier's, and is clamped to the model", () => {
  const roster = testRoster();
  const pick = (agent, options) => resolveChildModel(agent, options, roster);
  assert.equal(pick({ tier: "fast" }, {}).thinking, "low", "a tier carries its own level");
  assert.equal(pick({ tier: "capable" }, {}).thinking, "medium", "capable inherits the parent session's level");
  assert.equal(pick({ tier: "fast" }, { thinking: "high" }).thinking, "medium", "a call-site level beats the tier's, clamped to what the fast model supports");
  assert.equal(pick({ tier: "deep" }, { thinking: "high" }).thinking, "high", "the deep model supports the named level unchanged");
  assert.equal(pick({ thinking: "xhigh" }, {}).thinking, "xhigh", "an agent's own level applies when nothing narrower is set");
  assert.equal(pick({ tier: "deep", thinking: "low" }, {}).thinking, "low", "an agent's explicit level outranks the level its tier would use");
  assert.equal(pick({}, {}).thinking, undefined, "no tier and no level leaves pi's own default alone");
});

test("resolveChildModel: a model pin may carry pi's :level shorthand", () => {
  const roster = testRoster();
  const pinned = resolveChildModel({}, { model: "p/strong:high" }, roster);
  assert.equal(pinned.model, "p/strong", "the level is parsed off rather than passed through as part of the model id");
  assert.equal(pinned.thinking, "high");
  // Model ids may legitimately contain a colon, so only a real level is a level.
  assert.equal(resolveChildModel({}, { model: "p/model:exacto" }, roster).model, "p/model:exacto");
  assert.equal(resolveChildModel({}, { model: "p/strong:high", thinking: "low" }, roster).thinking, "low", "an explicit thinking param outranks the shorthand");
});
