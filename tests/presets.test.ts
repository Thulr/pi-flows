import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { attachPresetTraceAttributes } from "../extensions/pi-flows/preset-catalog.ts";
import {
	discoverFlowPresets,
	formatPresetResult,
	loadPresetsFromDir,
	packagePresetsDir,
	preparePresetRun,
	presetCapturePolicy,
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

test("preset metadata is redacted in list, config, and run details", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-preset-metadata-"));
	const projectDir = path.join(repo, ".pi", "flow-presets");
	await mkdir(projectDir, { recursive: true });
	const secret = "metadata-secret-value";
	await writeFile(
		path.join(projectDir, "metadata.md"),
		`---
name: metadata
description: Contact owner@example.com with token=${secret}
overrides: timeoutMs,password=${secret}
result: token=${secret}
---
{"agent":"recon","task":"{task}","timeoutMs":1000,"maxGeneratedTokens":10}
`,
	);

	const tools = new Map<string, any>();
	registerPiFlows({ registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const flow = tools.get("flow");
	const context = { cwd: repo, hasUI: false, ui: { confirm: async () => false, notify() {} } };
	const listed = await flow.execute("preset-list-redaction", { list: true, agentScope: "project" }, new AbortController().signal, undefined, context);
	const configured = await flow.execute("preset-config-redaction", { showConfig: true, agentScope: "project" }, new AbortController().signal, undefined, context);
	const run = await runFlow(
		{ preset: "metadata", task: "Inspect one file.", agentScope: "project", confirmProjectAgents: false },
		{ recon: ["Reviewed."] },
		{ cwd: repo },
	);

	for (const output of [listed, configured, run.result]) {
		const serialized = JSON.stringify(output);
		assert.doesNotMatch(serialized, /metadata-secret-value|owner@example\.com/);
		assert.match(serialized, /\[REDACTED_SECRET\]|\[REDACTED_EMAIL\]/);
	}
	assert.equal(run.result.details.preset.description, "Contact [REDACTED_EMAIL] with token=[REDACTED_SECRET]");
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

	const literalTask = "Review replacement examples $& $$ $` $' without changing them.";
	const literal = resolveFlowPreset(
		{ preset: "code-review", task: literalTask, why: "test" },
		discovery,
	);
	assert.ok(!("error" in literal));
	assert.ok((literal.params.tasks as any[]).every((item) => item.task.includes(literalTask)));

	const costBounded = resolveFlowPreset(
		{ preset: "code-review", task: "Review.", why: "test", maxCostUsd: 0.25 },
		discovery,
	);
	assert.ok(!("error" in costBounded));
	assert.equal(costBounded.params.maxCostUsd, 0.25);

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

test("a rejected preset name is echoed under the capture policy", () => {
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const unknown = resolveFlowPreset({ preset: "token=echoed-secret-value", task: "Inspect.", why: "test" }, discovery);
	assert.ok("error" in unknown);
	assert.equal(unknown.error.code, "UNKNOWN_PRESET");
	assert.doesNotMatch(JSON.stringify(unknown.error), /echoed-secret-value/);

	const override = resolveFlowPreset({ preset: "scout", task: "Inspect.", why: "test", "password=echoed-secret-value": 1 } as any, discovery);
	assert.ok("error" in override);
	assert.equal(override.error.code, "PRESET_OVERRIDE_INVALID");
	assert.doesNotMatch(JSON.stringify(override.error), /echoed-secret-value/);
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

test("a run captures role labels under the active redaction policy", async () => {
	const { result, text } = await runFlow(
		{ tasks: [{ agent: "recon", role: "standards token=role-secret-value", task: "Inspect one file." }], concurrency: 1 },
		{ recon: ["Reviewed."] },
	);
	assert.equal(result.details.results[0].role, "standards token=[REDACTED_SECRET]");
	assert.match(text, /standards token=\[REDACTED_SECRET\] \(recon\)/);
	assert.doesNotMatch(JSON.stringify(result), /role-secret-value/);
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
	const traceFile = path.join(repo, "untrusted-trace.jsonl");
	await mkdir(projectDir, { recursive: true });
	await writeFile(path.join(projectDir, "local.md"), `---\nname: local-review\ndescription: repo-controlled preset\n---\n${JSON.stringify({ agent: "recon", task: "{task}", timeoutMs: 1000, maxGeneratedTokens: 10, traceFile })}\n`);
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
	await assert.rejects(readFile(traceFile), "an unapproved preset must not create its configured trace file");
});

test("a preset template cannot loosen the caller's capture policy", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-preset-capture-"));
	const projectDir = path.join(repo, ".pi", "flow-presets");
	await mkdir(projectDir, { recursive: true });
	await writeFile(
		path.join(projectDir, "loose.md"),
		`---\nname: loose\ndescription: Contact owner@example.com with token=preset-capture-secret\n---\n${JSON.stringify({ agent: "recon", task: "{task}", timeoutMs: 1000, maxGeneratedTokens: 10, redactSecrets: false })}\n`,
	);
	const tools = new Map<string, any>();
	registerPiFlows({ registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const flow = tools.get("flow");
	const refused = await flow.execute(
		"preset-capture",
		{ preset: "loose", task: "Inspect one file.", why: "test", agentScope: "project" },
		new AbortController().signal,
		undefined,
		{ cwd: repo, hasUI: false, ui: { confirm: async () => false, notify() {} } },
	);
	assert.equal(refused.details.error.code, "PROJECT_PRESET_APPROVAL_REQUIRED");
	assert.doesNotMatch(JSON.stringify(refused), /preset-capture-secret|owner@example\.com/, "refusal details must keep the caller's redaction");

	const approved = await runFlow(
		{ preset: "loose", task: "Inspect one file.", agentScope: "project", confirmProjectAgents: false },
		{ recon: ["Reviewed."] },
		{ cwd: repo },
	);
	assert.doesNotMatch(JSON.stringify(approved.result), /preset-capture-secret|owner@example\.com/, "approval does not let a template turn redaction off");

	const tightened = await runFlow(
		{ preset: "loose", task: "Inspect one file.", agentScope: "project", confirmProjectAgents: false, redactSecrets: false },
		{ recon: ["Reviewed."] },
		{ cwd: repo },
	);
	assert.match(tightened.result.details.preset.description, /token=preset-capture-secret/, "the caller still owns turning redaction off");
});

test("a preset template cannot turn strict tracing off", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-flow-preset-strict-"));
	const template = { agent: "recon", task: "{task}", timeoutMs: 1000, maxGeneratedTokens: 10 };
	await writeFile(path.join(dir, "lax.md"), `---\nname: lax\ndescription: Turns strict tracing off\n---\n${JSON.stringify({ ...template, traceStrict: false })}\n`);
	await writeFile(path.join(dir, "strict.md"), `---\nname: strict\ndescription: Turns strict tracing on\n---\n${JSON.stringify({ ...template, traceStrict: true })}\n`);
	const loaded = loadPresetsFromDir(dir, "user");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: dir, projectPresetsDir: null };

	const lax = resolveFlowPreset({ preset: "lax", task: "Inspect.", why: "test" }, discovery);
	assert.ok(!("error" in lax));
	assert.equal(lax.params.traceStrict, undefined, "PI_FLOWS_TRACE_STRICT must still decide");
	const strict = resolveFlowPreset({ preset: "strict", task: "Inspect.", why: "test" }, discovery);
	assert.ok(!("error" in strict));
	assert.equal(strict.params.traceStrict, true, "a template may tighten the evidence gate");
	const callerOptOut = resolveFlowPreset({ preset: "strict", task: "Inspect.", why: "test", traceStrict: false }, discovery);
	assert.ok(!("error" in callerOptOut));
	assert.equal(callerOptOut.params.traceStrict, false, "the caller keeps its own opt-out");
});

test("a caller opt-out survives a preset that says nothing about redaction", () => {
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: "scout", task: "Inspect.", why: "test", redactSecrets: false, recordContent: false }, discovery);
	assert.ok(!("error" in resolved));
	assert.deepEqual(
		presetCapturePolicy({ recordContent: false, redactSecrets: false }, resolved.params),
		{ recordContent: false, redactSecrets: false },
		"bundled presets set neither control, so the caller's choice is the effective policy",
	);
	assert.deepEqual(
		presetCapturePolicy({ recordContent: true, redactSecrets: true }, { redactSecrets: false, recordContent: false }),
		{ recordContent: false, redactSecrets: true },
		"a template may omit content but may not turn redaction off",
	);
});

test("a caller cannot loosen capture a preset template deliberately tightened", () => {
	const tight: FlowPreset = {
		name: "tight",
		description: "test",
		source: "user",
		filePath: "tight.md",
		overrides: [],
		template: { agent: "recon", task: "{task}", timeoutMs: 1000, maxGeneratedTokens: 10, recordContent: false, redactSecrets: true },
	};
	const discovery = { presets: [tight], issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const loosened = resolveFlowPreset({ preset: "tight", task: "Inspect.", why: "test", recordContent: true, redactSecrets: false }, discovery);
	assert.ok(!("error" in loosened));
	assert.equal(loosened.params.recordContent, false, "a template that withholds child content keeps withholding it");
	assert.equal(loosened.params.redactSecrets, true, "a template that requires redaction keeps requiring it");
	assert.deepEqual(
		presetCapturePolicy({ recordContent: true, redactSecrets: false }, loosened.params),
		{ recordContent: false, redactSecrets: true },
	);
});

test("nested preset roles and code-review Git verification honor the preset cwd override", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-flow-preset-cwd-"));
	const repo = path.join(root, "review-target");
	await mkdir(path.join(repo, "src"), { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	await writeFile(path.join(repo, "src", "a.ts"), "before\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repo });
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	execFileSync("git", ["branch", "review-base"], { cwd: repo });
	await writeFile(path.join(repo, "src", "a.ts"), "after\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head"], { cwd: repo });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const reviewTask = "Review HEAD against review-base.";

	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset(
		{ preset: "code-review", task: reviewTask, why: "independent verification", cwd: "review-target" },
		discovery,
	);
	assert.ok(!("error" in resolved));
	const tasks = resolved.params.tasks as any[];
	const envelope = (index: number, axis: "standards" | "spec") => JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(tasks[index].contract),
		status: "completed",
		summary: `${axis} complete`,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: {
			axis,
			base,
			head,
			coverage: [{ path: "src/a.ts", status: "reviewed", evidence: "src/a.ts:1" }],
			findings: [],
		},
	});
	const { result, calls } = await runFlow(
		{ preset: "code-review", task: reviewTask, cwd: "review-target" },
		{ overwatch: [envelope(0, "standards"), envelope(1, "spec")] },
		{ cwd: root },
	);
	const canonicalRepo = await realpath(repo);
	assert.deepEqual(calls.map((call) => call.cwd), [canonicalRepo, canonicalRepo]);
	assert.ok(calls.every((call) => call.task.includes(`Harness-pinned review range: base ${base}, head ${head}.`)));
	assert.equal(result.details.presetOutcome, "CLEAN");

	const mapped = await runFlow(
		{ preset: "map-codebase", task: "Map one area.", cwd: "review-target" },
		{ commander: JSON.stringify(["inspect one area"]), recon: "mapped", debrief: "summary" },
		{ cwd: root },
	);
	assert.deepEqual(mapped.calls.slice(-3).map((call) => call.cwd), [canonicalRepo, canonicalRepo, canonicalRepo]);
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
	const clean = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range)]), policy, repo, range);
	assert.equal(clean.details.presetOutcome, "CLEAN");
	assert.equal(clean.content[0].text, "Code review: CLEAN");

	const finding = { path: "src/a.ts", startLine: 7, endLine: 7, severity: "high", claim: "Broken invariant", evidence: "src/a.ts:7", suggestion: "Restore it" };
	const found = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range, [finding]), reviewRun("spec", range)]), policy, repo, range);
	assert.equal(found.details.presetOutcome, "FINDINGS");
	assert.match(found.content[0].text, /HIGH src\/a\.ts:7/);

	const partial = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], [{ path: "src/b.ts", status: "reviewed", evidence: "src/b.ts:1" }])]), policy, repo, range);
	assert.equal(partial.details.presetOutcome, "PARTIAL");
	assert.match(partial.content[0].text, /could not be proven complete/);

	const unresolved = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], undefined, ["Issue context unavailable"])]), policy, repo, range);
	assert.equal(unresolved.details.presetOutcome, "PARTIAL");
	assert.match(unresolved.content[0].text, /unresolved: Issue context unavailable/, "the caller needs to know what to supply");

	const skippedPath = [{ path: "src/a.ts", status: "skipped", evidence: "unreadable" }];
	const skipped = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], skippedPath)]), policy, repo, range);
	assert.equal(skipped.details.presetOutcome, "PARTIAL");
	assert.match(skipped.content[0].text, /skipped coverage: src\/a\.ts \(skipped\)/);
	const quiet = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], skippedPath)]), { recordContent: false, redactSecrets: true }, repo, range);
	assert.doesNotMatch(quiet.content[0].text, /src\/a\.ts/, "gap detail is child content and follows the capture policy");

	await writeFile(path.join(repo, "src", "b.ts"), "new\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second head"], { cwd: repo });
	const secondHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const omitted = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", { base, head: secondHead }), reviewRun("spec", { base, head: secondHead })]),
		policy,
		repo,
		{ base, head: secondHead },
	);
	assert.equal(omitted.details.presetOutcome, "PARTIAL");

	const wrongRange = { base: head, head: secondHead };
	const wrongCoverage = [{ path: "src/b.ts", status: "reviewed", evidence: "src/b.ts:1" }];
	const mismatched = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", wrongRange, [], wrongCoverage), reviewRun("spec", wrongRange, [], wrongCoverage)]),
		policy,
		repo,
		range,
	);
	assert.equal(mismatched.details.presetOutcome, "PARTIAL", "reviewer agreement on a different valid range must not produce CLEAN");

	const anchored = { id: "salvaged", path: "src/a.ts", startLine: 1, endLine: 1, severity: "high", category: "correctness", claim: "partial-envelope-claim", evidence: "src/a.ts:1" };
	const partialRun = reviewRun("spec", range, [anchored]);
	partialRun.envelope!.status = "partial";
	const salvaged = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), partialRun]), policy, repo, range);
	assert.equal(salvaged.details.presetOutcome, "PARTIAL", "an unproven axis cannot settle the verdict");
	assert.match(salvaged.content[0].text, /partial-envelope-claim/, "a finding anchored by a partial reviewer must still be reported");
});

test("code-review retains validated metadata privately when returned content is omitted", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-private-review-"));
	await writeFile(path.join(repo, "a.ts"), "before\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repo });
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	await writeFile(path.join(repo, "a.ts"), "after\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head"], { cwd: repo });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const codeReview = loaded.presets.find((preset) => preset.name === "code-review")!;
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: "code-review", task: `Review ${base}..${head}.`, recordContent: false }, discovery);
	assert.ok(!("error" in resolved));
	const tasks = resolved.params.tasks as any[];
	const finding = { id: "hidden", path: "a.ts", startLine: 1, endLine: 1, severity: "high", category: "correctness", claim: "private-review-claim", evidence: "a.ts:1", suggestion: "fix it" };
	const envelope = (index: number, axis: "standards" | "spec", findings: any[] = []) => JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(tasks[index].contract),
		status: "completed",
		summary: `${axis} complete`,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { axis, base, head, coverage: [{ path: "a.ts", status: "reviewed", evidence: "a.ts:1" }], findings },
	});
	const traceFile = path.join(repo, "review.jsonl");
	const { result } = await runFlow(
		{ preset: codeReview.name, task: `Review ${base}..${head}.`, recordContent: false, traceFile },
		{ overwatch: [envelope(0, "standards", [finding]), envelope(1, "spec")] },
		{ cwd: repo },
	);
	assert.equal(result.details.presetOutcome, "FINDINGS");
	assert.equal(result.content[0].text, "Code review: FINDINGS");
	assert.doesNotMatch(JSON.stringify(result), /private-review-claim/);
	assert.equal((result.details.results[0].envelope?.data as any).axis, "[content omitted: recordContent=false]");
	const trace = await readFile(traceFile, "utf8");
	const root = trace.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((span) => span.parent_span_id === null);
	assert.equal(root.attributes["flow.outcome_verified"], true);
	assert.equal(root.attributes["flow.outcome_success"], false);
	assert.doesNotMatch(trace, /private-review-claim/);
});

test("a partial review axis returns PARTIAL carrying its findings, not a handoff error", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-partial-axis-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q");
	await writeFile(path.join(repo, "a.ts"), "before\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	await writeFile(path.join(repo, "a.ts"), "after\n");
	git("add", ".");
	git("commit", "-qm", "head");
	const head = git("rev-parse", "HEAD");
	const task = `Review ${base}..${head}.`;
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: "code-review", task }, discovery);
	assert.ok(!("error" in resolved));
	const tasks = resolved.params.tasks as any[];
	const finding = { id: "skipped-axis", path: "a.ts", startLine: 1, endLine: 1, severity: "high", category: "correctness", claim: "unproven-axis-claim", evidence: "a.ts:1", suggestion: "fix it" };
	const envelope = (index: number, axis: "standards" | "spec", status: string, findings: any[]) => JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(tasks[index].contract),
		status,
		summary: `${axis} ${status}`,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { axis, base, head, coverage: [{ path: "a.ts", status: "reviewed", evidence: "a.ts:1" }], findings },
	});
	const { result } = await runFlow(
		{ preset: "code-review", task },
		{ overwatch: [envelope(0, "standards", "completed", []), envelope(1, "spec", "partial", [finding])] },
		{ cwd: repo },
	);
	assert.equal(result.details.error, undefined, "an axis that could not finish is a PARTIAL verdict, not a flow failure");
	assert.equal(result.details.presetOutcome, "PARTIAL");
	assert.match(result.content[0].text, /unproven-axis-claim/);
	assert.match(result.content[0].text, /do not treat this result as clean/);
});

test("a preset template cannot grant itself the shared-write exception", () => {
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const shared: FlowPreset = {
		name: "shared-write",
		description: "test",
		source: "user",
		filePath: "shared-write.md",
		overrides: [],
		template: { agent: "recon", task: "{task}", timeoutMs: 1000, maxGeneratedTokens: 10, allowSharedWriteCwd: true },
	};
	const withShared = { presets: [...discovery.presets, shared], issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const expanded = resolveFlowPreset({ preset: "shared-write", task: "Inspect.", why: "test" }, withShared);
	assert.ok(!("error" in expanded));
	assert.equal(expanded.params.allowSharedWriteCwd, undefined, "the guard is the caller's acknowledgement to make");
	const byCaller = resolveFlowPreset({ preset: "shared-write", task: "Inspect.", why: "test", allowSharedWriteCwd: true }, withShared);
	assert.ok(!("error" in byCaller));
	assert.equal(byCaller.params.allowSharedWriteCwd, true);
});

test("code-review reports why a review axis did not return", () => {
	const policy = { recordContent: true, redactSecrets: true };
	const failedRun: FlowRunResult = {
		agent: "overwatch",
		role: "spec",
		agentSource: "package",
		task: "review",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		stopReason: "timeout",
	};
	const output = formatPresetResult(
		reviewPreset,
		{
			content: [{ type: "text" as const, text: "raw" }],
			details: { mode: "parallel" as const, version: "test", agentScope: "user" as const, config: {} as any, agentsDir: {} as any, results: [reviewRun("standards", { base: "a".repeat(40), head: "b".repeat(40) }), failedRun] },
		},
		policy,
	);
	assert.equal(output.details.presetOutcome, "PARTIAL");
	assert.match(output.content[0].text, /Review axes that did not return: spec \(timeout\)/);
});

test("code-review trace attributes publish complete verdicts as verified outcomes", () => {
	const base = { "flow.outcome_verified": false };
	const clean = attachPresetTraceAttributes({ ...base }, reviewPreset, { presetOutcome: "CLEAN" } as any);
	const findings = attachPresetTraceAttributes({ ...base }, reviewPreset, { presetOutcome: "FINDINGS" } as any);
	const partial = attachPresetTraceAttributes({ ...base, "flow.outcome_success": true }, reviewPreset, { presetOutcome: "PARTIAL" } as any);
	assert.equal(clean["flow.outcome_verified"], true);
	assert.equal(clean["flow.outcome_success"], true);
	assert.equal(findings["flow.outcome_verified"], true);
	assert.equal(findings["flow.outcome_success"], false);
	assert.equal(partial["flow.outcome_verified"], false);
	assert.equal(partial["flow.outcome_success"], undefined);

	const refused = attachPresetTraceAttributes({ ...base }, reviewPreset, { presetOutcome: "CLEAN", error: { code: "CHECKPOINT_DENIED" } } as any);
	assert.equal(refused["flow.outcome_verified"], false, "a verdict the run never delivered is not a verified outcome");
	assert.equal(refused["flow.outcome_success"], undefined);
	assert.equal(refused["flow.preset_outcome"], "CLEAN");
});

test("a three-dot review request freezes at the merge base so the manifest is the branch change set", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-review-range-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();
	await mkdir(path.join(repo, "src"), { recursive: true });
	git("init", "-q");
	await writeFile(path.join(repo, "src", "a.ts"), "before\n");
	await writeFile(path.join(repo, "src", "b.ts"), "before\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const mergeBase = git("rev-parse", "HEAD");
	git("checkout", "-qb", "feature");
	await writeFile(path.join(repo, "src", "a.ts"), "after\n");
	git("add", ".");
	git("commit", "-qm", "feature");
	const featureHead = git("rev-parse", "HEAD");
	git("checkout", "-q", "-");
	// The base branch moves on independently: src/b.ts is not part of the branch's
	// change set, but it does differ between the two endpoints.
	await writeFile(path.join(repo, "src", "b.ts"), "moved on\n");
	git("add", ".");
	git("commit", "-qm", "base branch moves on");
	const baseHead = git("rev-parse", "HEAD");

	const runParams = { tasks: [{ task: "standards" }, { task: "spec" }] };
	const symmetric = preparePresetRun(reviewPreset, runParams, `Review ${baseHead}...${featureHead}.`, repo);
	assert.deepEqual(symmetric.codeReviewRange, { base: mergeBase, head: featureHead });
	assert.ok((symmetric.params.tasks as any[]).every((item) => item.task.includes(`base ${mergeBase}, head ${featureHead}`)));
	const twoDot = preparePresetRun(reviewPreset, runParams, `Review ${baseHead}..${featureHead}.`, repo);
	assert.deepEqual(twoDot.codeReviewRange, { base: baseHead, head: featureHead }, "a two-endpoint request must keep both endpoints");

	const policy = { recordContent: true, redactSecrets: true };
	const makeOutput = (results: FlowRunResult[]) => ({
		content: [{ type: "text" as const, text: "raw" }],
		details: { mode: "parallel" as const, version: "test", agentScope: "user" as const, config: {} as any, agentsDir: {} as any, results },
	});
	const range = symmetric.codeReviewRange!;
	const branchCoverage = [{ path: "src/a.ts", status: "reviewed", evidence: "src/a.ts:1" }];
	const reviewed = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", range, [], branchCoverage), reviewRun("spec", range, [], branchCoverage)]),
		policy,
		repo,
		range,
	);
	assert.equal(reviewed.details.presetOutcome, "CLEAN", "the branch change set is the whole manifest for a three-dot range");

	const endpointRange = twoDot.codeReviewRange!;
	const endpointReviewed = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", endpointRange, [], branchCoverage), reviewRun("spec", endpointRange, [], branchCoverage)]),
		policy,
		repo,
		endpointRange,
	);
	assert.equal(endpointReviewed.details.presetOutcome, "PARTIAL", "src/b.ts also differs between the endpoints, so that coverage is incomplete");
});

test("preset directory paths are sanitized under the capture policy", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-flow-preset-dirs-"));
	const repo = path.join(root, "token=directory-secret-value", "project");
	await mkdir(path.join(repo, ".pi", "flow-presets"), { recursive: true });
	await writeFile(
		path.join(repo, ".pi", "flow-presets", "local.md"),
		`---
name: local
description: Local preset
---
{"agent":"recon","task":"{task}","timeoutMs":1000,"maxGeneratedTokens":10}
`,
	);

	const tools = new Map<string, any>();
	registerPiFlows({ registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	const flow = tools.get("flow");
	const context = { cwd: repo, hasUI: false, ui: { confirm: async () => false, notify() {} } };
	const configured = await flow.execute("preset-dir-redaction", { showConfig: true, agentScope: "project" }, new AbortController().signal, undefined, context);
	assert.doesNotMatch(configured.content[0].text, /directory-secret-value/);
	assert.doesNotMatch(JSON.stringify(configured.details.presetsDir), /directory-secret-value/);
	assert.match(configured.details.presetsDir.project, /token=\[REDACTED_SECRET\]/);

	const refused = await flow.execute(
		"preset-dir-refusal",
		{ preset: "local", task: "Inspect one file.", why: "test", agentScope: "project" },
		new AbortController().signal,
		undefined,
		context,
	);
	assert.equal(refused.details.error.code, "PROJECT_PRESET_APPROVAL_REQUIRED");
	assert.doesNotMatch(JSON.stringify(refused), /directory-secret-value/, "the refusal names a repo-controlled path and must redact it");
});
