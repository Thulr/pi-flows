import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import registerPiFlows from "../extensions/pi-flows/index.ts";

const stubPi = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));
process.argv[1] = stubPi;

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
		{ why: "worktree conflict test exercising the delegation path", ...params },
		new AbortController().signal,
		undefined,
		{ cwd, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } },
	);
	const log = await readFile(path.join(cwd, "calls.jsonl"), "utf8").catch(() => "");
	const calls: Array<{ agent: string; task: string }> = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { result, calls, text: result.content[0]?.text ?? "" };
}

test("worktree: rejects a conflict resolution that aborts and drops the incoming branch", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "stub-pi-"));
	await writeFile(path.join(cwd, "shared.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd });

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
				{ whenTaskIncludes: "Merge conflict", reply: "ABORTED_MERGE", gitArgs: ["merge", "--abort"] },
				{ reply: "MUST_NOT_REVIEW" },
			],
		},
		cwd,
	);
	assert.equal(result.details.error.code, "WORKTREE_INTEGRATION_FAILED", text);
	assert.equal(calls.filter((call) => call.agent === "debrief").length, 1, "integration review must not run after a dropped worker branch");
	const conflictCall = calls.find((call) => call.agent === "debrief")!;
	assert.match(conflictCall.task, /Validated worker handoff provenance/);
	assert.match(conflictCall.task, /A_DONE/);
	assert.match(conflictCall.task, /B_DONE/);
	assert.match(text, /incoming worker branch was not preserved/i);

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
});
