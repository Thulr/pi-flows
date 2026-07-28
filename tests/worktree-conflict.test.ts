import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import type { DelegationContract } from "../extensions/pi-flows/types.ts";

const stubPi = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));
process.argv[1] = stubPi;

const contract: DelegationContract = {
	objective: "Resolve integration conflicts.",
	constraints: [],
	nonGoals: [],
	dependencies: [],
	authority: { may: ["Edit conflicted files."], mustNot: [], requiresApproval: [] },
	sideEffectClass: "reversible",
	budget: {},
	acceptanceChecks: ["All conflicts are resolved."],
	returnSchema: {
		type: "object",
		required: ["resolved"],
		properties: { resolved: { type: "boolean" } },
		additionalProperties: false,
	},
	owner: "integrator",
};

function resolverEnvelope(kind: "missing" | "stale" | "invalid") {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		...(kind === "missing" ? {} : { contractId: kind === "stale" ? `sha256:${"0".repeat(64)}` : delegationContractId(contract) }),
		status: "completed",
		summary: "Resolved conflict.",
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: ["shared.txt"],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: kind === "invalid" ? { wrong: true } : { resolved: true },
	});
}

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

async function conflictRepo() {
	const cwd = await mkdtemp(path.join(tmpdir(), "stub-pi-"));
	await writeFile(path.join(cwd, "shared.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd });
	return cwd;
}

async function cleanupConflictRepo(cwd: string) {
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
}

test("worktree: rejects a conflict resolution that aborts and drops the incoming branch", async () => {
	const cwd = await conflictRepo();
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
	await cleanupConflictRepo(cwd);
});

test("worktree: validates typed conflict resolver envelopes before committing", async (t) => {
	const cases = [
		{ kind: "missing", error: "RETURN_CONTRACT_MISMATCH" },
		{ kind: "stale", error: "RETURN_CONTRACT_MISMATCH" },
		{ kind: "invalid", error: "RETURN_ENVELOPE_INVALID" },
	] as const;
	for (const { kind, error } of cases) {
		await t.test(kind, async () => {
			const cwd = await conflictRepo();
			const { result, calls } = await runFlow(
				{
					task: "Integrate both conflicting edits",
					contract,
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
					debrief: {
						whenTaskIncludes: "Merge conflict",
						reply: resolverEnvelope(kind),
						writes: { "shared.txt": "resolved\n" },
						gitArgs: ["add", "shared.txt"],
					},
				},
				cwd,
			);
			assert.equal(result.details.error?.code, error);
			assert.equal(calls.filter((call) => call.agent === "debrief").length, 1);
			const resolutionCommits = execFileSync("git", ["log", "--all", "--grep=pi-flow: resolve", "--format=%s"], { cwd, encoding: "utf8" }).trim();
			assert.equal(resolutionCommits, "");
			await cleanupConflictRepo(cwd);
		});
	}
});

test("worktree: a conflict resolver links every input whose merge state it edits", async () => {
	const cwd = await conflictRepo();
	const { result, text } = await runFlow(
		{
			task: "Integrate both conflicting edits",
			traceFile: "flow-trace.jsonl",
			worktree: {
				tasks: [
					{ id: "a", agent: "operator", task: "Apply variant A" },
					{ id: "b", agent: "operator", task: "Apply variant B" },
				],
				integrator: { agent: "debrief" },
				checkCommand: "node -e \"process.exit(0)\"",
			},
		},
		{
			operator: [
				{ whenTaskIncludes: "assignment (a)", reply: "A_DONE", writes: { "shared.txt": "variant a\n" } },
				{ whenTaskIncludes: "assignment (b)", reply: "B_DONE", writes: { "shared.txt": "variant b\n" } },
			],
			debrief: [
				// Writing the file is not resolving it: git keeps the path unmerged until
				// it is staged, and the harness checks for unmerged paths after the run.
				{ whenTaskIncludes: "Merge conflict", reply: "RESOLVED", writes: { "shared.txt": "variant a and b\n" }, gitArgs: ["add", "shared.txt"] },
				{ reply: "REVIEWED" },
			],
		},
		cwd,
	);
	assert.equal(result.details.error, undefined, text);
	const spans = (await readFile(path.join(cwd, "flow-trace.jsonl"), "utf8"))
		.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const conflict = spans.find((span) => span.attributes?.["flow.unit_key"] === "conflict-b")!;
	// The resolver's prompt carries both workers' reports and it edits their
	// combined merge state, so naming only the incoming branch would understate
	// what the resolution actually acted on.
	// The observation it was dispatched to answer, then both workers whose merge
	// state it edits.
	assert.equal(conflict.attributes["flow.depends_on"], "conflict-b.observed,worker-a.handoff,worker-b.handoff");
	assert.equal(String(conflict.attributes["flow.depends_on_span_ids"]).split(",").length, 3);

	// The reviewed branch contains the resolution, so the resolver belongs in the
	// reviewed result's provenance — and the gate that ran against that branch
	// belongs downstream of the review it would invalidate.
	const review = spans.find((span) => span.attributes?.["flow.unit_key"] === "integration-review")!;
	assert.equal(review.attributes["flow.depends_on"], "worker-a.handoff,worker-b.handoff,conflict-b");
	assert.equal(String(review.attributes["flow.depends_on_span_ids"]).split(",").length, 3);
	const check = spans.find((span) => span.attributes?.["flow.unit_key"] === "integration-check")!;
	assert.equal(check.attributes["flow.depends_on"], "integration-review");
	assert.equal(check.attributes["flow.depends_on_span_ids"], review.span_id);

	// The chain runs end to end with no unkeyed link in the middle: the worktrees
	// each worker ran in, the observed conflict the resolver answered, and the
	// resolver itself.
	const key = (name: string) => spans.find((span) => span.attributes?.["flow.unit_key"] === name)!;
	assert.equal(key("worker-a").attributes["flow.depends_on"], "worktrees-created");
	assert.equal(key("worker-a").attributes["flow.depends_on_span_ids"], key("worktrees-created").span_id);
	assert.equal(key("conflict-b.observed").attributes["flow.depends_on"], "worker-b");

	await cleanupConflictRepo(cwd);
});
