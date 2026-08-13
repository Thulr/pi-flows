// The refusal-footer half of the Settle seam. A mode registers its recovery
// pointer once (decorateFooter) and every refusal from then on carries it —
// including refusals written later, which is how two worktree refusals shipped
// pointing users at "the retained integration branch" without naming it. The
// model-visible cap is refuse's own: it applies over the formatted error and
// the per-call footer together (what loop and orchestrate previously
// hand-assembled with a cap-then-slice trick), while the registered pointer is
// appended after the cap so truncation cannot swallow the one line that names
// where recovery lives.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import { capModelVisibleText } from "../extensions/pi-flows/sanitize.ts";
import { flowError, formatFlowError, makeSettle, type FlowDiscovery } from "../extensions/pi-flows/types.ts";

const stubPi = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));
process.argv[1] = stubPi;

// --- settle.decorateFooter ----------------------------------------------------

const discovery: FlowDiscovery = {
	agents: [{ name: "recon", description: "read-only scout", tools: ["read"], systemPrompt: "", source: "package", filePath: "/pkg/recon.md" }],
	projectAgentsDir: null,
	userAgentsDir: "/tmp/user-agents",
	packageAgentsDir: "/tmp/package-agents",
	issues: [],
};

function worktreeSettle() {
	return makeSettle("worktree", createAgentCatalog(discovery, "user").makeDetails("worktree"));
}

const refusal = () => flowError("WORKTREE_INTEGRATION_FAILED", "Could not commit.", "git commit failed", "Inspect the retained integration branch.");

test("settle: a registered footer decoration reaches every subsequent refusal, after the per-call footer", () => {
	const settle = worktreeSettle();
	const before = settle.refuse(refusal());
	assert.equal(before.content[0].text, formatFlowError(refusal()), "before registration a refusal carries only its own text");

	settle.decorateFooter(() => "\n\nIntegration branch: `pi-flow/x/integration`");
	const bare = settle.refuse(refusal());
	assert.equal(bare.content[0].text, `${formatFlowError(refusal())}\n\nIntegration branch: \`pi-flow/x/integration\``);

	const withOwn = settle.refuse(refusal(), { footer: "\n\nWorker state retained." });
	assert.equal(withOwn.content[0].text, `${formatFlowError(refusal())}\n\nWorker state retained.\n\nIntegration branch: \`pi-flow/x/integration\``);
});

test("settle: the latest footer registration wins, and the decoration reads live state through its closure", () => {
	const settle = worktreeSettle();
	let branch = "pi-flow/a/integration";
	settle.decorateFooter(() => `\n\nIntegration branch: \`${branch}\``);
	branch = "pi-flow/b/integration";
	assert.match(settle.refuse(refusal()).content[0].text, /pi-flow\/b\/integration/);
	settle.decorateFooter(() => "\n\nlatest wins");
	assert.equal(settle.refuse(refusal()).content[0].text, `${formatFlowError(refusal())}\n\nlatest wins`);
});

test("settle: the footer is refusal vocabulary — complete's text stays the mode's own", () => {
	const settle = worktreeSettle();
	settle.decorateFooter(() => "\n\nIntegration branch: `pi-flow/x/integration`");
	assert.equal(settle.complete("Flow worktree: 2/2 workers integrated.").content[0].text, "Flow worktree: 2/2 workers integrated.");
});

test("settle: refuse caps the model-visible text over the whole message, formatted error and per-call footer together", () => {
	const settle = worktreeSettle();
	const error = refusal();
	const footer = `\n\n## Last output\n\n${"x".repeat(64 * 1024)}`;
	const output = settle.refuse(error, { footer });
	// The exact text loop and orchestrate previously hand-assembled with
	// capModelVisibleText(`${formatted}${footer}`).slice(formatted.length).
	assert.equal(output.content[0].text, capModelVisibleText(`${formatFlowError(error)}${footer}`));
	assert.match(output.content[0].text, /truncated: \d+ bytes omitted/);
});

test("settle: a refusal over an unbounded cause keeps its Retryable/Fix/Code lines and the recovery pointer", () => {
	const settle = worktreeSettle();
	settle.decorateFooter(() => "\n\nIntegration branch: `pi-flow/x/integration`");
	// The one unbounded FlowError field: worktree passes raw git stderr (up to
	// 4 MiB) and failed-child report text as causes.
	const error = flowError("WORKTREE_INTEGRATION_FAILED", "Could not merge.", "g".repeat(256 * 1024), "Inspect the retained integration branch.");
	const text = settle.refuse(error).content[0].text;
	assert.match(text, /Cause truncated: \d+ bytes omitted/);
	assert.match(text, /Retryable unchanged: no/);
	assert.match(text, /Fix: Inspect the retained integration branch\./);
	assert.match(text, /Code: WORKTREE_INTEGRATION_FAILED/);
	assert.ok(text.endsWith("\n\nIntegration branch: `pi-flow/x/integration`"));
	// Model-visible only: the details keep the error object uncut.
	assert.equal(settle.refuse(error).details.error?.cause.length, 256 * 1024);
});

test("settle: a refusal whose message carries an unbounded interpolation keeps its suffix", () => {
	const settle = worktreeSettle();
	// The message path: schema.ts puts no length bound on worktree.baseRef, and
	// the handler interpolates the invalid value into the refusal message.
	const error = flowError("WORKTREE_SETUP_FAILED", `Could not resolve worktree base ref "${"b".repeat(128 * 1024)}".`, "unknown revision", "Use an existing commit, branch, or tag as worktree.baseRef.");
	const text = settle.refuse(error).content[0].text;
	assert.match(text, /Message truncated: \d+ bytes omitted/);
	assert.match(text, /Fix: Use an existing commit, branch, or tag as worktree\.baseRef\./);
	assert.match(text, /Code: WORKTREE_SETUP_FAILED/);
	assert.equal(settle.refuse(error).details.error?.message.length, error.message.length);
});

test("settle: the registered footer has its own small bound, so the refusal stays capped without trusting the registering mode", () => {
	const settle = worktreeSettle();
	settle.decorateFooter(() => `\n\n${"p".repeat(8 * 1024)}`);
	const text = settle.refuse(refusal(), { footer: `\n\n${"x".repeat(64 * 1024)}` }).content[0].text;
	assert.match(text, /Recovery pointer truncated: \d+ bytes omitted/);
	// Model-visible body plus the pointer allowance plus two truncation markers.
	assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024 + 2 * 1024 + 128, `refusal must stay bounded, got ${Buffer.byteLength(text, "utf8")} bytes`);
});

test("settle: the registered recovery pointer survives the cap that truncates the footer", () => {
	const settle = worktreeSettle();
	settle.decorateFooter(() => "\n\nIntegration branch: `pi-flow/x/integration`");
	const output = settle.refuse(refusal(), { footer: `\n\n${"x".repeat(64 * 1024)}` });
	assert.match(output.content[0].text, /truncated: \d+ bytes omitted/);
	assert.ok(output.content[0].text.endsWith("\n\nIntegration branch: `pi-flow/x/integration`"), "truncation must not swallow the recovery pointer");
});

// --- worktree: the two refusals that lost the pointer --------------------------

function flowTool() {
	const tools = new Map<string, any>();
	registerPiFlows({ registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	return tools.get("flow");
}

async function runFlow(params: any, plan: Record<string, unknown>, cwd: string) {
	process.env.PI_STUB_DIR = cwd;
	process.env.PI_STUB_PLAN = JSON.stringify(plan);
	const result = await flowTool().execute(
		"tool-call-id",
		{ why: "worktree recovery-pointer test driving a failing integration commit", ...params },
		new AbortController().signal,
		undefined,
		{ cwd, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } },
	);
	const log = await readFile(path.join(cwd, "calls.jsonl"), "utf8").catch(() => "");
	const calls: Array<{ agent: string; task: string }> = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { result, calls, text: result.content[0]?.text ?? "" };
}

/** A seeded repo whose pre-commit hook fails only inside the integration worktree, so worker commits land and the integration commit is the one that breaks. */
async function repoWithFailingIntegrationCommit() {
	const cwd = await mkdtemp(path.join(tmpdir(), "stub-pi-"));
	await writeFile(path.join(cwd, "shared.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd });
	const hook = path.join(cwd, ".git", "hooks", "pre-commit");
	await writeFile(hook, `#!/bin/sh\ncase "$PWD" in */integration) echo "integration commit rejected by hook" >&2; exit 1 ;; esac\nexit 0\n`);
	await chmod(hook, 0o755);
	return cwd;
}

async function cleanupRepo(cwd: string) {
	const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" })
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length))
		.slice(1);
	const tempRoot = worktrees[0] ? path.dirname(worktrees[0]) : undefined;
	for (const worktree of worktrees) execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd });
	for (const branch of execFileSync("git", ["branch", "--list", "pi-flow/*"], { cwd, encoding: "utf8" }).split("\n").map((line) => line.trim()).filter(Boolean)) {
		execFileSync("git", ["branch", "-D", branch], { cwd });
	}
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
}

function retainedIntegrationBranch(cwd: string): string {
	return execFileSync("git", ["branch", "--list", "pi-flow/*/integration", "--format=%(refname:short)"], { cwd, encoding: "utf8" }).trim();
}

test("worktree: a failed conflict-resolution commit names the retained integration branch", async () => {
	const cwd = await repoWithFailingIntegrationCommit();
	const { result, calls, text } = await runFlow(
		{
			task: "Integrate both conflicting edits",
			worktree: {
				tasks: [
					{ id: "a", agent: "operator", task: "Apply variant A" },
					{ id: "b", agent: "operator", task: "Apply variant B" },
				],
				integrator: { agent: "debrief" },
			},
		},
		{
			operator: [
				{ whenTaskIncludes: "assignment (a)", reply: "A_DONE", writes: { "shared.txt": "variant a\n" } },
				{ whenTaskIncludes: "assignment (b)", reply: "B_DONE", writes: { "shared.txt": "variant b\n" } },
			],
			debrief: [
				{ whenTaskIncludes: "Merge conflict", reply: "RESOLVED", writes: { "shared.txt": "variant a and b\n" }, gitArgs: ["add", "shared.txt"] },
				{ reply: "MUST_NOT_REVIEW" },
			],
		},
		cwd,
	);
	assert.equal(result.details.error?.code, "WORKTREE_INTEGRATION_FAILED", text);
	assert.match(result.details.error?.message ?? "", /Could not commit resolved integration conflicts/);
	assert.equal(calls.filter((call) => call.agent === "debrief").length, 1, "review must not run after the resolution commit failed");
	const retained = retainedIntegrationBranch(cwd);
	assert.ok(retained, "the failing commit must leave the integration branch on disk");
	assert.ok(text.includes(`Integration branch: \`${retained}\``), `the refusal must name the retained branch; got:\n${text}`);
	await cleanupRepo(cwd);
});

test("worktree: a failed review-fixes commit names the retained integration branch", async () => {
	const cwd = await repoWithFailingIntegrationCommit();
	const { result, text } = await runFlow(
		{
			task: "Integrate both edits",
			worktree: {
				tasks: [
					{ id: "a", agent: "operator", task: "Write file A" },
					{ id: "b", agent: "operator", task: "Write file B" },
				],
				integrator: { agent: "debrief" },
			},
		},
		{
			operator: [
				{ whenTaskIncludes: "assignment (a)", reply: "A_DONE", writes: { "a.txt": "a\n" } },
				{ whenTaskIncludes: "assignment (b)", reply: "B_DONE", writes: { "b.txt": "b\n" } },
			],
			// Disjoint files merge cleanly, so the review runs and leaves an edit the
			// harness then fails to commit.
			debrief: { reply: "REVIEWED", writes: { "review-note.txt": "reviewed\n" } },
		},
		cwd,
	);
	assert.equal(result.details.error?.code, "WORKTREE_INTEGRATION_FAILED", text);
	assert.match(result.details.error?.message ?? "", /Could not commit integration review fixes/);
	const retained = retainedIntegrationBranch(cwd);
	assert.ok(retained, "the failing commit must leave the integration branch on disk");
	assert.ok(text.includes(`Integration branch: \`${retained}\``), `the refusal must name the retained branch; got:\n${text}`);
	await cleanupRepo(cwd);
});
