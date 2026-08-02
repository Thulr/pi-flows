// Roster configuration: how a user states a tier override, where those
// statements are read from, and what happens when the file is not what it
// claims to be. The ranking policy those overrides narrow lives in
// model-roster.test.ts — the same split the source modules use.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { deriveModelRoster, describeModelRoster, resolveModelRoster } from "../extensions/pi-flows/model-roster.ts";
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

test("loading reports a config whose JSON is valid but is not a config file", () => {
	// The save side already refused these; the read side returned an empty config
	// with nothing reported, because `typeof [] === "object"`. Every intended
	// override dropped, children routed to a derived model, no issue to explain it.
	for (const [contents, pattern] of [
		['{"models": []}', /"models" must be an object \(found an array\)/],
		['{"models": 5}', /"models" must be an object \(found a number\)/],
		["[1, 2]", /must contain a JSON object \(found an array\)/],
		['"a string"', /must contain a JSON object \(found a string\)/],
	] as const) {
		const parsed = parseRosterConfig(contents);
		assert.equal(parsed.error, undefined, `${contents} parses; it is the shape that is wrong`);
		assert.deepEqual(parsed.config, {});
		assert.match(parsed.invalid.join("\n"), pattern, contents);
	}

	// A file with no `models` key at all is a valid, empty config — not an error.
	const empty = parseRosterConfig('{"somethingElse": 42}');
	assert.deepEqual(empty.config, {});
	assert.deepEqual(empty.invalid, []);
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

test("project discovery stops at an unreadable config rather than falling back to an ancestor", async () => {
	// The non-file branch already stopped the walk; the read-error branch recorded
	// an issue and kept going, so an ancestor's pins could still stand in for a
	// project's — possibly selecting another provider. Injected rather than
	// induced: EACCES and ELOOP are not portable to provoke, and a test that
	// silently does nothing under a root CI user is worse than none.
	const { nearestProjectConfigDir } = await import("../extensions/pi-flows/roster-source.ts");
	const denied = path.join("/repo", "packages", "web", ".pi", "pi-flows.json");
	const stat = (file: string) => {
		if (file === denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
		return { isFile: () => true };
	};

	const found = nearestProjectConfigDir(path.join("/repo", "packages", "web"), stat as any);
	assert.equal(found.dir, null, "an ancestor must not stand in for a config that exists and cannot be read");
	assert.match(found.issues.join("\n"), /could not be read \(EACCES\)/);

	// An ordinary "not here" still walks, which is the whole point of the search.
	const walked = nearestProjectConfigDir(path.join("/repo", "packages", "web"), ((file: string) => {
		if (file.includes(`${path.sep}web${path.sep}`)) throw Object.assign(new Error("nope"), { code: "ENOENT" });
		return { isFile: () => true };
	}) as any);
	assert.ok(walked.dir?.endsWith(path.join("packages", ".pi")) || walked.dir?.endsWith(path.join("repo", ".pi")));
	assert.deepEqual(walked.issues, []);
});

test("project discovery stops at a config path that exists but is not a file", async () => {
	// statSync succeeds for a directory, so the catch never fires and the walk
	// would continue — applying an ancestor's config in place of the project's,
	// which is worse than applying none.
	const { currentModelRoster } = await import("../extensions/pi-flows/roster-source.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "pi-flows.json"), JSON.stringify({ models: { deep: { model: "acme/mini" } } }));
	const nested = path.join(root, "packages", "web");
	fs.mkdirSync(path.join(nested, ".pi", "pi-flows.json"), { recursive: true });

	const registry = { getAvailable: () => INSTALL.map((entry) => ({ id: entry.id, provider: entry.provider, reasoning: true, contextWindow: entry.contextWindow, maxTokens: 4096, cost: { input: entry.costPerToken, output: entry.costPerToken } })) };
	const roster = currentModelRoster({ cwd: nested, modelRegistry: registry, isProjectTrusted: () => true });
	assert.notEqual(roster.deep.model, "acme/mini", "the ancestor's pins must not stand in for the project's");
	assert.match(roster.issues.join("\n"), /is not a file/, "and the reason is reported rather than silent");

	fs.rmSync(root, { recursive: true, force: true });
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

test("saving refuses a config file whose JSON is valid but is not an object", () => {
	// Valid JSON is not the same as a config file. Each of these parses cleanly
	// and would be silently rewritten as an object — the same destruction the
	// syntax-error refusal prevents, reached by a different route.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-flows-roster-"));
	const file = path.join(dir, "pi-flows.json");
	for (const contents of ['["a","b"]', '"just a string"', "42", "null"]) {
		fs.writeFileSync(file, contents);
		assert.throws(() => saveRosterOverride(dir, "fast", { model: "acme/mini" }), /does not contain a JSON object/, contents);
		assert.equal(fs.readFileSync(file, "utf8"), contents, `${contents} must be left exactly as it was`);
	}

	// Same for a "models" key that is not an object: replacing it with {} would
	// drop whatever the user actually had there.
	const badModels = '{ "somethingElse": 42, "models": "oops" }';
	fs.writeFileSync(file, badModels);
	assert.throws(() => saveRosterOverride(dir, "fast", { model: "acme/mini" }), /"models" value that is not an object/);
	assert.equal(fs.readFileSync(file, "utf8"), badModels);

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
