// Offline integration tests for the flow execution path.
//
// These exercise the real spawn/parse/orchestrate machinery in
// extensions/pi-flows/index.ts against a stub `pi` (tests/fixtures/stub-pi.mjs)
// instead of a live model. pi-flows spawns a child agent by re-running its own
// entrypoint (process.argv[1]) via the current runtime — see getPiInvocation() —
// so pointing argv[1] at the stub makes pi-flows spawn the stub. No production
// code change and no network/model is involved.
//
// The stub keys its reply off the agent name and logs every invocation, so each
// test asserts on the wiring it cares about: which agents ran, in what order,
// and what task text each received (i.e. that handoffs actually propagated).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerPiFlows from "../extensions/pi-flows/index.ts";

const stubPi = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));
process.argv[1] = stubPi;

function flowTool(api: Record<string, any> = {}) {
	const tools = new Map<string, any>();
	registerPiFlows({ ...api, registerCommand() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	return tools.get("flow");
}

type Call = { agent: string; callIndex: number; task: string; systemPrompt: string; args: string[] };

async function runFlow(
	params: any,
	plan: Record<string, string | string[]>,
	options: { api?: Record<string, any>; ui?: Record<string, any> } = {},
) {
	const stubDir = await mkdtemp(path.join(tmpdir(), "stub-pi-"));
	process.env.PI_STUB_DIR = stubDir;
	process.env.PI_STUB_PLAN = JSON.stringify(plan);
	const result = await flowTool(options.api).execute(
		"tool-call-id",
		params,
		new AbortController().signal,
		undefined,
		{ cwd: stubDir, hasUI: false, ui: { confirm: async () => true, notify: () => undefined, ...(options.ui ?? {}) } },
	);
	const log = await readFile(path.join(stubDir, "calls.jsonl"), "utf8").catch(() => "");
	const calls: Call[] = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { result, calls, text: result.content[0]?.text ?? "", stubDir };
}

const byAgent = (calls: Call[], name: string) => calls.filter((call) => call.agent === name);

test("single: spawns the stub child, returns its text, and accumulates usage", async () => {
	const { result, calls, text } = await runFlow({ agent: "recon", task: "find the billing routes" }, { recon: "ROUTES: /charge /refund" });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].agent, "recon");
	assert.match(calls[0].task, /find the billing routes/);

	assert.match(text, /ROUTES: \/charge \/refund/);
	assert.equal(result.details.results.length, 1);
	assert.ok(result.details.results[0].usage.cost > 0, "usage.cost should be accumulated from the child JSONL");
});

test("single: appends return contracts, updates UI status, and writes a session summary entry", async () => {
	const statuses: string[] = [];
	const widgets: string[][] = [];
	const entries: Array<{ customType: string; data: any }> = [];
	const { calls } = await runFlow(
		{ agent: "recon", task: "find MAGIC_TOKEN", returnContract: "Return one sentence with value and evidence path.", requireEvidence: true },
		{ recon: "MAGIC_TOKEN=xyzzy-42 in settings.txt" },
		{
			api: { appendEntry: (customType: string, data: any) => entries.push({ customType, data }) },
			ui: {
				setStatus: (_key: string, text: string | undefined) => { if (text) statuses.push(text); },
				setWidget: (_key: string, content: string[] | undefined) => { if (content) widgets.push(content); },
			},
		},
	);

	assert.match(calls[0].task, /## Return contract/);
	assert.match(calls[0].task, /Return one sentence with value and evidence path/);
	assert.match(calls[0].task, /file:line references/);
	assert.ok(statuses.some((status) => /flow single: ok/.test(status)), "completion status should reach the UI");
	assert.ok(widgets.some((widget) => widget.some((line) => /recon/.test(line))), "widget should show child agent status");
	assert.equal(entries[0]?.customType, "pi-flows.run");
	assert.equal(entries[0]?.data.mode, "single");
});

test("parallel: fans out every task to its own child", async () => {
	const { calls } = await runFlow(
		{ tasks: [{ agent: "recon", task: "frontend auth" }, { agent: "recon", task: "backend auth" }], concurrency: 2 },
		{ recon: "found it" },
	);

	assert.equal(calls.length, 2);
	const tasks = calls.map((call) => call.task).join("\n");
	assert.match(tasks, /frontend auth/);
	assert.match(tasks, /backend auth/);
});

test("parallel: shared write-capable cwd is refused before spawning workers", async () => {
	const { result, calls, text } = await runFlow(
		{ tasks: [{ agent: "operator", task: "edit a" }, { agent: "operator", task: "edit b" }], concurrency: 2 },
		{ operator: "should not run" },
	);

	assert.equal(calls.length, 0, "guard should prevent any mutating children from spawning");
	assert.equal(result.details.error.code, "SHARED_WRITE_CWD");
	assert.match(text, /SHARED_WRITE_CWD/);
});

test("chain: the previous step's output is handed to the next step", async () => {
	const { calls, text } = await runFlow(
		{
			task: "add redis caching",
			chain: [
				{ agent: "recon", task: "research this: {task}" },
				{ agent: "strategist", task: "make a plan from:\n{previous}" },
			],
		},
		{ recon: "RECON_FINDINGS", strategist: "STRATEGY_PLAN" },
	);

	assert.deepEqual(calls.map((call) => call.agent), ["recon", "strategist"]);
	assert.match(calls[0].task, /add redis caching/, "step 1 receives the {task} substitution");
	assert.match(calls[1].task, /RECON_FINDINGS/, "step 2 receives step 1's output via {previous}");
	assert.match(text, /STRATEGY_PLAN/, "chain returns the final step's output");
});

test("evaluate: REVISE re-runs the operator with the critique, then PASS ends the loop", async () => {
	const { calls } = await runFlow(
		{ task: "add a /health endpoint", evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 3 } },
		{ operator: ["DRAFT_ONE", "DRAFT_TWO"], redteam: ["VERDICT: REVISE\nneeds a test", "VERDICT: PASS\nlooks good"] },
	);

	assert.deepEqual(calls.map((call) => call.agent), ["operator", "redteam", "operator", "redteam"], "two generator/critic rounds");
	assert.match(byAgent(calls, "redteam")[0].task, /DRAFT_ONE/, "critic judges the operator's artifact");
	assert.match(byAgent(calls, "operator")[1].task, /needs a test/, "operator is re-shown the critique on REVISE");
});

test("evaluate: a failing checkCommand gate forces REVISE and skips the LLM critic", async () => {
	const { calls } = await runFlow(
		{ task: "x", evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, checkCommand: "exit 1", maxIterations: 2 } },
		{ operator: ["A", "B"], redteam: "VERDICT: PASS" },
	);

	assert.equal(byAgent(calls, "operator").length, 2, "operator revises each round until maxIterations");
	assert.equal(byAgent(calls, "redteam").length, 0, "a non-zero gate is an automatic REVISE — the critic never runs");
});

test("route: the controller's ROUTE choice is dispatched and nothing else runs", async () => {
	const { calls, text } = await runFlow(
		{ task: "billing webhook returns 500s", route: { candidates: ["recon", "strategist"], fallback: "recon" } },
		{ controller: "ROUTE: recon", recon: "ROOT_CAUSE_FOUND" },
	);

	assert.deepEqual(calls.map((call) => call.agent), ["controller", "recon"], "classify, then dispatch the one chosen candidate");
	assert.match(text, /ROOT_CAUSE_FOUND/);
});

test("vote: every voter runs the same task and the aggregator sees all ballots", async () => {
	const { calls, text } = await runFlow(
		{ task: "is /^(a+)+$/ catastrophic backtracking?", vote: { voters: [{ agent: "recon" }, { agent: "overwatch" }], debrief: { agent: "debrief" } } },
		{ recon: "RECON_SAYS_YES", overwatch: "OVERWATCH_SAYS_YES", debrief: "CONSENSUS_YES" },
	);

	assert.equal(byAgent(calls, "recon").length, 1);
	assert.equal(byAgent(calls, "overwatch").length, 1);
	const debrief = byAgent(calls, "debrief")[0];
	assert.ok(debrief, "the aggregator runs");
	assert.match(debrief.task, /RECON_SAYS_YES/);
	assert.match(debrief.task, /OVERWATCH_SAYS_YES/);
	assert.match(text, /CONSENSUS_YES/);
});

test("orchestrate: commander decomposes, recon workers fan out, debrief merges", async () => {
	const { calls, text } = await runFlow(
		{ task: "document how auth works", orchestrate: { recon: { agent: "recon" }, maxSubtasks: 3 } },
		{ commander: '["map the login flow", "map token refresh"]', recon: "WORKER_FINDING", debrief: "MERGED_DOC" },
	);

	assert.ok(byAgent(calls, "commander").length >= 1, "commander decomposes the goal");
	const workerTasks = byAgent(calls, "recon").map((call) => call.task).join("\n");
	assert.match(workerTasks, /map the login flow/);
	assert.match(workerTasks, /map token refresh/);
	assert.ok(byAgent(calls, "debrief").length >= 1, "debrief merges the worker findings");
	assert.match(text, /MERGED_DOC/);
});

test("orchestrate: verifyPolicy fail returns a structured gate error on REVISE", async () => {
	const { result, calls, text } = await runFlow(
		{ task: "document how auth works", orchestrate: { recon: { agent: "recon" }, verify: { agent: "overwatch" }, verifyPolicy: "fail" } },
		{ commander: '["map login"]', recon: "WORKER_FINDING", debrief: "INCOMPLETE_DOC", overwatch: "VERDICT: REVISE\nmissing token refresh" },
	);

	assert.deepEqual(calls.map((call) => call.agent), ["commander", "recon", "debrief", "overwatch"]);
	assert.equal(result.details.error.code, "ORCHESTRATE_VERIFY_FAILED");
	assert.match(text, /missing token refresh/);
});

test("orchestrate: verifyPolicy revise reruns debrief until verifier passes", async () => {
	const { result, calls, text } = await runFlow(
		{ task: "document how auth works", orchestrate: { recon: { agent: "recon" }, verify: { agent: "overwatch" }, verifyPolicy: "revise", verifyMaxIterations: 2 } },
		{ commander: '["map login"]', recon: "WORKER_FINDING", debrief: ["INCOMPLETE_DOC", "COMPLETE_DOC"], overwatch: ["VERDICT: REVISE\nmissing token refresh", "VERDICT: PASS\nok"] },
	);

	assert.equal(result.details.error, undefined);
	assert.deepEqual(calls.map((call) => call.agent), ["commander", "recon", "debrief", "overwatch", "debrief", "overwatch"]);
	assert.match(byAgent(calls, "debrief")[1].task, /missing token refresh/, "revision receives verifier critique");
	assert.match(text, /COMPLETE_DOC/);
	assert.match(text, /Verification PASS/);
});

test("orchestrate: shared write-capable workers are refused after decomposition and before fan-out", async () => {
	const { result, calls } = await runFlow(
		{ task: "make two edits", orchestrate: { recon: { agent: "operator" }, maxSubtasks: 2 } },
		{ commander: '["edit auth", "edit billing"]', operator: "should not run" },
	);

	assert.deepEqual(calls.map((call) => call.agent), ["commander"]);
	assert.equal(result.details.error.code, "SHARED_WRITE_CWD");
});

test("traceFile records child/root spans with trace labels and reportable totals", async () => {
	const { stubDir } = await runFlow(
		{ agent: "recon", task: "find the billing routes", traceFile: "flow-trace.jsonl", traceLabel: "smoke-release" },
		{ recon: "ROUTES: /charge /refund" },
	);

	const trace = await readFile(path.join(stubDir, "flow-trace.jsonl"), "utf8");
	const spans = trace.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	assert.equal(spans.length, 2);
	assert.ok(spans.some((span) => span.parent_span_id === null && span.attributes["flow.trace_label"] === "smoke-release"));
	assert.ok(spans.some((span) => span.attributes["flow.agent"] === "recon" && span.attributes["flow.trace_label"] === "smoke-release"));
	assert.ok(spans.some((span) => span.attributes["flow.cost_usd_total"] > 0));
});
