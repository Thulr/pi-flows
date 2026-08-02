import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import {
	discoverFlowPresets,
	formatPresetResult,
	loadPresetsFromDir,
	packagePresetsDir,
	resolveFlowPreset,
} from "../extensions/pi-flows/presets.ts";
import { emptyUsage, type FlowPreset, type FlowRunResult } from "../extensions/pi-flows/types.ts";
import { runFlow } from "./stub-harness.ts";

test("bundled presets load as data and each expands to one bounded raw mode", () => {
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	assert.deepEqual(loaded.issues, []);
	assert.deepEqual(loaded.presets.map((preset) => preset.name), ["code-review", "map-codebase", "scout"]);

	const discovery = {
		presets: loaded.presets,
		issues: [],
		packagePresetsDir,
		userPresetsDir: "/tmp/user-presets",
		projectPresetsDir: null,
	};
	for (const preset of loaded.presets) {
		const resolved = resolveFlowPreset({ preset: preset.name, task: "Inspect HEAD against main.", why: "test" }, discovery);
		assert.ok(!("error" in resolved), preset.name);
		const params = resolved.params as any;
		const activeShapes = [params.agent && params.task, params.tasks, params.orchestrate].filter(Boolean);
		assert.equal(activeShapes.length, 1, `${preset.name} should expand to one mode shape`);
		assert.ok(params.timeoutMs <= 1_800_000, `${preset.name} should have a bounded timeout`);
		assert.ok(params.maxGeneratedTokens > 0, `${preset.name} should bound generated tokens`);
	}
});

test("flow list and showConfig expose preset discovery and provenance", async () => {
	const tools = new Map<string, any>();
	registerPiFlows({ registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const flow = tools.get("flow");
	const context = { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => false, notify() {} } };
	const listed = await flow.execute("preset-list", { list: true }, new AbortController().signal, undefined, context);
	assert.match(listed.content[0].text, /code-review/);
	assert.ok(listed.details.presets.some((preset: any) => preset.name === "code-review"));
	const configured = await flow.execute("preset-config", { showConfig: true }, new AbortController().signal, undefined, context);
	assert.match(configured.content[0].text, /presetsDir\.package/);
	assert.ok(configured.details.presetsDir.package);
});

test("preset expansion substitutes the complete task and rejects undeclared shape overrides", () => {
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset(
		{ preset: "code-review", task: "Review PR #293 against main.", why: "independent verification", timeoutMs: 42_000, thinking: "medium" },
		discovery,
	);
	assert.ok(!("error" in resolved));
	assert.equal(resolved.params.timeoutMs, 42_000);
	assert.equal(resolved.params.thinking, "medium");
	assert.match((resolved.params.tasks as any[])[0].task, /PR #293 against main/);
	assert.equal((resolved.params.tasks as any[])[0].role, "standards");
	assert.equal((resolved.params.tasks as any[])[1].role, "spec");
	assert.equal((resolved.params.tasks as any[])[0].agent, "overwatch");

	const invalid = resolveFlowPreset(
		{ preset: "code-review", task: "Review.", why: "test", evaluate: {} },
		discovery,
	);
	assert.equal("error" in invalid ? invalid.error.code : undefined, "PRESET_OVERRIDE_INVALID");

	const invalidExpanded = resolveFlowPreset(
		{ preset: "code-review", task: "Review.", why: "test", timeoutMs: 0 },
		discovery,
	);
	assert.equal("error" in invalidExpanded ? invalidExpanded.error.code : undefined, "PRESET_EXPANSION_INVALID");
});

test("presets requiring {task} fail closed when task is absent", () => {
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const result = resolveFlowPreset({ preset: "scout", why: "test" }, discovery);
	assert.equal("error" in result ? result.error.code : undefined, "PRESET_TASK_REQUIRED");
});

test("preset templates cannot supply the caller's delegation justification", () => {
	const preset: FlowPreset = {
		name: "self-justifying",
		description: "invalid trust boundary",
		source: "user",
		filePath: "/tmp/self-justifying.md",
		overrides: [],
		template: { agent: "recon", task: "{task}", why: "the preset says so" },
	};
	const discovery = { presets: [preset], issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: preset.name, task: "Inspect." }, discovery);
	assert.ok(!("error" in resolved));
	assert.equal(resolved.params.why, undefined);
});

test("preset discovery reports templates outside the public flow schema", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-invalid-preset-"));
	await writeFile(path.join(directory, "invalid.md"), "---\nname: invalid\ndescription: invalid tasks shape\n---\n{\"tasks\":{\"length\":1}}\n");
	const loaded = loadPresetsFromDir(directory, "user");
	assert.deepEqual(loaded.presets, []);
	assert.equal(loaded.issues[0]?.code, "PRESET_TEMPLATE_SCHEMA_INVALID");
	assert.match(loaded.issues[0]?.message ?? "", /tasks.*must be array/);
});

test("a run keeps its topology role distinct from its agent profile", async () => {
	const { result, text } = await runFlow(
		{ tasks: [{ agent: "recon", role: "standards", task: "Inspect one file." }], concurrency: 1 },
		{ recon: ["Reviewed."] },
	);
	assert.equal(result.details.results[0].agent, "recon");
	assert.equal(result.details.results[0].role, "standards");
	assert.match(text, /standards \(recon\)/);
});

test("project presets shadow bundled presets with a visible diagnostic", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-presets-"));
	const projectDir = path.join(repo, ".pi", "flow-presets");
	await mkdir(projectDir, { recursive: true });
	await writeFile(path.join(projectDir, "scout.md"), "---\nname: scout\ndescription: project scout\noverrides: timeoutMs\n---\n{\"agent\":\"recon\",\"task\":\"{task}\",\"timeoutMs\":1000,\"maxGeneratedTokens\":10}\n");
	const discovery = discoverFlowPresets(repo, "project");
	assert.equal(discovery.presets.find((preset) => preset.name === "scout")?.source, "project");
	assert.ok(discovery.issues.some((item) => item.code === "PRESET_NAME_SHADOWED"));
});

test("project presets use the project-agent trust gate in headless calls", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-preset-trust-"));
	const projectDir = path.join(repo, ".pi", "flow-presets");
	await mkdir(projectDir, { recursive: true });
	await writeFile(path.join(projectDir, "local.md"), "---\nname: local-review\ndescription: repo-controlled preset\n---\n{\"agent\":\"recon\",\"task\":\"{task}\",\"timeoutMs\":1000,\"maxGeneratedTokens\":10,\"confirmProjectAgents\":false}\n");
	const tools = new Map<string, any>();
	registerPiFlows({ registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const result = await tools.get("flow").execute(
		"preset-trust",
		{ preset: "local-review", task: "secret=must-not-leak", why: "test", agentScope: "project" },
		new AbortController().signal,
		undefined,
		{ cwd: repo, hasUI: false, ui: { confirm: async () => false, notify() {} } },
	);
	assert.equal(result.details.error.code, "PROJECT_PRESET_APPROVAL_REQUIRED");
	assert.equal(result.details.preset.name, "local-review");
	assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});

function reviewRun(
	role: "standards" | "spec",
	range: { base: string; head: string },
	findings: any[] = [],
	coverage = [{ path: "src/a.ts", status: "reviewed", evidence: "src/a.ts:1" }],
	unresolvedQuestions: string[] = [],
): FlowRunResult {
	return {
		agent: "overwatch",
		role,
		agentSource: "package",
		task: "review",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		envelope: {
			schemaVersion: "pi-flows.return-envelope.v1",
			status: "completed",
			summary: `${role} complete`,
			evidence: [],
			artifactReferences: [],
			digests: [],
			changedState: [],
			unresolvedQuestions,
			retry: { retryable: false },
			data: { axis: role, base: range.base, head: range.head, coverage, findings },
		},
	};
}

const reviewPreset: FlowPreset = {
	name: "code-review",
	description: "test",
	source: "package",
	filePath: "presets/code-review.md",
	overrides: [],
	result: "code-review-v1",
	template: {},
};

test("code-review formatter derives CLEAN, FINDINGS, and PARTIAL from Git-verified typed envelopes", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-review-manifest-"));
	await mkdir(path.join(repo, "src"), { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	await writeFile(path.join(repo, "src", "a.ts"), "before\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repo });
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	await writeFile(path.join(repo, "src", "a.ts"), "after\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head"], { cwd: repo });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const range = { base, head };
	const policy = { recordContent: true, redactSecrets: true };
	const makeOutput = (results: FlowRunResult[]) => ({
		content: [{ type: "text" as const, text: "raw" }],
		details: { mode: "parallel" as const, version: "test", agentScope: "user" as const, config: {} as any, agentsDir: {} as any, results },
	});
	const clean = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range)]), policy, repo);
	assert.equal(clean.details.presetOutcome, "CLEAN");
	assert.equal(clean.content[0].text, "Code review: CLEAN");

	const finding = { path: "src/a.ts", startLine: 7, endLine: 7, severity: "high", claim: "Broken invariant", evidence: "src/a.ts:7", suggestion: "Restore it" };
	const found = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range, [finding]), reviewRun("spec", range)]), policy, repo);
	assert.equal(found.details.presetOutcome, "FINDINGS");
	assert.match(found.content[0].text, /HIGH src\/a\.ts:7/);

	const partial = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], [{ path: "src/b.ts", status: "reviewed", evidence: "src/b.ts:1" }])]), policy, repo);
	assert.equal(partial.details.presetOutcome, "PARTIAL");
	assert.match(partial.content[0].text, /could not be proven complete/);

	const unresolved = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], undefined, ["Issue context unavailable"])]), policy, repo);
	assert.equal(unresolved.details.presetOutcome, "PARTIAL");

	await writeFile(path.join(repo, "src", "b.ts"), "new\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second head"], { cwd: repo });
	const secondHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const omitted = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", { base, head: secondHead }), reviewRun("spec", { base, head: secondHead })]),
		policy,
		repo,
	);
	assert.equal(omitted.details.presetOutcome, "PARTIAL");
});
