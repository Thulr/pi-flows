import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CALIBRATION_CASES, CASES } from "../evals/cases.mjs";
import { codexModelFromPi, runCodex } from "../evals/baseline-codex.mjs";
import { injectModel } from "../evals/model-injection.mjs";
import { PATTERN_CASES } from "../evals/pattern-cases.mjs";
import { answerWithArtifacts, armBudgetSignal, exclusionForRun, infraError, scoreObjective, shouldJudgeProductSpans, timeoutPlanForCase } from "../evals/lib.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";
import { collectSelectionEvent, flowCallIdsFromMessage, flowCallsFromMessage, flowCallMatchesExpectation, scoreSelection } from "../evals/select.mjs";

test("Codex baseline maps the Pi model id and parses JSONL without putting the task in argv", async () => {
	assert.equal(codexModelFromPi("openai-codex/gpt-5.4-mini"), "gpt-5.4-mini");
	assert.throws(() => codexModelFromPi("anthropic/claude-haiku-4-5"), /non-Codex provider/);
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-codex-adapter-test-"));
	const stub = path.join(cwd, "codex-stub.mjs");
	await writeFile(stub, `#!/usr/bin/env node
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (process.argv.includes("SECRET_TASK_TEXT")) process.exit(9);
process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"ANSWER:" + input.trim()}}) + "\\n");
process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:12,cached_input_tokens:3,output_tokens:4,reasoning_output_tokens:2}}) + "\\n");
`);
	await chmod(stub, 0o755);
	const result = await runCodex({ task: "SECRET_TASK_TEXT", cwd, model: "gpt-5.4-mini", reportedModel: "openai-codex/gpt-5.4-mini", codexBin: stub, timeoutMs: 5_000 });
	assert.equal(result.content[0].text, "ANSWER:SECRET_TASK_TEXT");
	assert.equal(result.details.results[0].usage.input, 12);
	assert.equal(result.details.results[0].usage.costKnown, false);
	assert.equal(result.details.results[0].model, "openai-codex/gpt-5.4-mini");
	assert.equal(result.details.results[0].stopReason, "endTurn");
});

test("pattern A/B cases give both arms the same user task", () => {
	for (const testCase of PATTERN_CASES) assert.equal(typeof testCase.params.task, "string", testCase.name);
	for (const testCase of CASES) assert.equal(testCase.baselinePrompt, undefined, `${testCase.name} must use params.task for both arms`);
});

test("arm budget aborts the whole measurement arm at the case deadline", async () => {
	const budget = armBudgetSignal(new AbortController().signal, 10);
	await new Promise((resolve) => budget.signal.addEventListener("abort", resolve, { once: true }));
	assert.equal(budget.timedOut, true);
	assert.match(String(budget.signal.reason), /arm timed out after 10ms/);
	budget.dispose();
});

test("artifact-producing A/B cases attach only bounded files inside the arm workspace", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-artifact-answer-test-"));
	await writeFile(path.join(cwd, "runbook.md"), "source-backed gate\n");
	const answer = answerWithArtifacts("summary", cwd, ["runbook.md", "../outside.md"]);
	assert.match(answer, /Produced artifact: runbook\.md/);
	assert.match(answer, /source-backed gate/);
	assert.doesNotMatch(answer, /outside\.md/);
});

test("workflow objective accepts compact operational units used by valid runbooks", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-workflow-score-test-"));
	await writeFile(path.join(cwd, "checkout-ledger-migration-runbook.md"), "Backfill 1,500 rows/s; mismatch 0.5%; max 24h; rollback under 5 minutes; Release Manager approval; nullable region.\n");
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-workflow-train-release");
	const scored = testCase.score({ content: [{ type: "text", text: "created" }] }, { flowCtx: { cwd } });
	assert.equal(scored.pass, true);
});

test("workflow holdout objective accepts named regions and compact time units", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-workflow-holdout-score-test-"));
	await writeFile(path.join(cwd, "signing-key-rotation-runbook.md"), "48-hour overlap; old key verify-only; us-east, us-west, eu-central each at 99.9% for 6h; Security approval; clock-skew check.\n");
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-workflow-holdout-keys");
	const scored = testCase.score({ content: [{ type: "text", text: "created" }] }, { flowCtx: { cwd } });
	assert.equal(scored.pass, true);
});

test("debate objective accepts compact measurements and equivalent constraint wording", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-debate-train-queue");
	const scored = testCase.score({ content: [{ type: "text", text: "Choose B/CDC: the 14-day app freeze blocks A; measured 75s p99 lag is under the 2-minute cap. Mitigate schema drift and reverse above 2 minutes for 10 continuous minutes." }] });
	assert.equal(scored.pass, true);
});

test("debate holdout objective accepts qualified reversal durations", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-debate-holdout-audit");
	const scored = testCase.score({ content: [{ type: "text", text: "Choose A/outbox for atomic capture because credentials cannot enter logs. Its 8% cost fits 11% headroom; reverse above 180ms for 15 continuous minutes." }] });
	assert.equal(scored.pass, true);
});

test("hard debate train objective requires conservative feasibility and citations", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-debate-train-publication-review");
	const scored = testCase.score({ content: [{ type: "text", text: `DECISION: B
Use upper bounds and lower bounds. A's cohort is 0.86% > 0.80%. B overall is 0.70% * (1 - 35%) = 0.455% <= 0.50%; cohort is 1.05% * (1 - 25%) = 0.7875% <= 0.80%. B review is 22% + 6pp = 28%, so 8.96h <= 10h. The strongest case for A is 0.48% overall and 7.68h. Its post-publication audit does not count. Move all publication to manual hold above 0.50% overall or 0.80% cohort in rolling 2,000, or if review demand exceeds 10h for 3 consecutive days. decision.md:3 trial.csv:2 operations.md:3 policy.md:3` }] });
	assert.equal(scored.pass, true, scored.notes);
});

test("hard debate holdout objective rejects unavailable mitigations", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-debate-holdout-regional-writes");
	const scored = testCase.score({ content: [{ type: "text", text: `DECISION: A
Use the conservative envelope of upper bound measurements and lower bound controls. A duplicates: 1.60% * (1 - 90%) = 0.16% <= 0.25%; latency 164ms + 9ms = 173ms < 175ms; cost 25 + 2 = $27k <= $28k, and it deploys in 6 days <= 10. Its 42s failover and 12s lag pass. B is 68% + 24pp = 92% > 90%. The add-on yields 68% + 24pp - 8pp = 84%, but 21 + 8 = $29k > $28k. Batch eviction yields 86% but is unavailable until day 31. The strongest case for B is zero duplicates, 158ms, and $21k. Disable secondary writes and return to single-primary above 0.25% for two consecutive 15-minute windows; also reverse at >=175ms for 10 continuous minutes. architecture.md:3 measurements.csv:2 change-window.md:3 constraints.md:3 incident.md:3` }] });
	assert.equal(scored.pass, true, scored.notes);
});

test("simple debate and worktree cases are threshold controls", () => {
	for (const name of ["pattern-debate-train-queue", "pattern-debate-holdout-audit", "pattern-worktree-train-library", "pattern-worktree-holdout-library"]) {
		const testCase = PATTERN_CASES.find((candidate) => candidate.name === name);
		assert.equal(testCase?.control, true, name);
		assert.match(testCase?.controlReason ?? "", /threshold negative/i, name);
	}
});

test("dossier objective accepts explicit absent-record and retention language", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-dossier-train-deploy");
	const scored = testCase.score({ content: [{ type: "text", text: "runbook.md caps at 4; change-ticket.md approved 6; config.yaml set 8. There is no review record for the change, and host-level metrics were not retained." }] });
	assert.equal(scored.pass, true);
});

test("dossier holdout objective accepts configuration keys and null ownership", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-dossier-holdout-auth");
	const scored = testCase.score({ content: [{ type: "text", text: "Policy is 15 minutes; access_token_ttl_minutes is 60. Clock skew was 4 seconds, but stale acceptance lasted 59 minutes. change_owner is null." }] });
	assert.equal(scored.pass, true);
});

test("monitor objective accepts markdown-formatted numeric gates", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-monitor-train-queue");
	const scored = testCase.score({ content: [{ type: "text", text: "Captured s7 trace t-41 at depth 912. Worker w3 clock-skew caused lease expiry; verify depth below `100`." }] });
	assert.equal(scored.pass, true);
});

test("monitor holdout objective accepts markdown-formatted percentage gates", () => {
	const testCase = PATTERN_CASES.find((candidate) => candidate.name === "pattern-monitor-holdout-disk");
	const scored = testCase.score({ content: [{ type: "text", text: "Captured d-88 on n2/v9 at 97%. Pause j17, delete snapshots older than 7 days, and verify below `80%`." }] });
	assert.equal(scored.pass, true);
});

test("eval injectModel expands vote.agent/count into modeled explicit voters", () => {
	const params = injectModel(
		{ task: "x", vote: { agent: "recon", count: 2, debrief: { agent: "debrief" } } },
		"provider/model",
	);

	assert.equal(params.vote.agent, undefined);
	assert.equal(params.vote.count, undefined);
	assert.deepEqual(params.vote.voters, [
		{ agent: "recon", model: "provider/model" },
		{ agent: "recon", model: "provider/model" },
	]);
	assert.equal(params.vote.debrief.model, "provider/model");
});

test("eval injectModel preserves explicit voter model overrides", () => {
	const params = injectModel(
		{
			task: "x",
			vote: {
				voters: [{ agent: "recon" }, { agent: "overwatch", model: "already-set" }],
			},
		},
		"provider/model",
	);

	assert.deepEqual(params.vote.voters, [
		{ agent: "recon", model: "provider/model" },
		{ agent: "overwatch", model: "already-set" },
	]);
});

test("eval injectModel applies one subject model to every flow mode while preserving role overrides", () => {
	const injected = injectModel({
		model: undefined,
		graph: { nodes: [{ id: "a", agent: "recon", task: "a" }], debrief: { agent: "debrief" } },
		workflow: { phases: [{ id: "scan", agent: "recon", task: "scan" }], debrief: { agent: "debrief", model: "pinned" } },
		worktree: { tasks: [{ id: "a", agent: "operator", task: "a" }, { id: "b", agent: "operator", task: "b" }] },
		debate: { participants: [{ agent: "analyst" }, { agent: "strategist" }] },
		dossier: { sections: [{ agent: "recon", task: "a" }, { agent: "analyst", task: "b" }] },
		monitor: { command: "probe", reactor: { agent: "analyst" } },
	}, "openai-codex/gpt-5.4-mini");
	assert.equal(injected.model, "openai-codex/gpt-5.4-mini");
	assert.equal(injected.graph.nodes[0].model, "openai-codex/gpt-5.4-mini");
	assert.equal(injected.workflow.phases[0].model, "openai-codex/gpt-5.4-mini");
	assert.equal(injected.workflow.debrief.model, "pinned");
	assert.equal(injected.worktree.tasks[1].model, "openai-codex/gpt-5.4-mini");
	assert.equal(injected.debate.participants[1].model, "openai-codex/gpt-5.4-mini");
	assert.equal(injected.dossier.sections[1].model, "openai-codex/gpt-5.4-mini");
	assert.equal(injected.monitor.reactor.model, "openai-codex/gpt-5.4-mini");
});

test("eval infraError does not flag normal security-review API key wording", () => {
	assert.equal(
		infraError({ content: [{ type: "text", text: "The handler lacks API key or webhook signature verification, so forged requests can be accepted." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "Missing authentication and API key checks let unauthorized webhook callers submit forged payments." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "No authentication required means anyone can invoke the webhook." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "Authentication required is missing from this handler." }], details: { results: [] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "The CommonJS API surface is preserved; authentication is required before idempotency." }], details: { results: [{ exitCode: 0 }] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "The authentication provider is required before the cache layer." }], details: { results: [{ exitCode: 0, stopReason: "endTurn" }] } }),
		null,
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "Error: authentication required" }], details: { results: [] } }),
		"provider/API error",
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "provider failed: API key missing" }], details: { results: [] } }),
		"provider/API error",
	);
});

test("eval infraError preserves typed child causes for actionable exclusions", () => {
	assert.match(infraError({ details: { results: [{ error: { code: "CHILD_EXIT_NONZERO", message: "child exited", cause: "provider throttled" } }] } }), /CHILD_EXIT_NONZERO: child exited: provider throttled/);
});

test("eval treats post-model deterministic flow failures as quality, not infrastructure", () => {
	for (const code of ["WORKTREE_VERIFY_FAILED", "WORKTREE_INTEGRATION_FAILED", "WORKFLOW_GATE_FAILED"]) {
		assert.equal(infraError({ details: { error: { code, message: "produced result failed its gate" }, results: [{ exitCode: 0 }] } }), null, code);
	}
	assert.match(infraError({ details: { error: { code: "WORKTREE_SETUP_FAILED", message: "git unavailable" }, results: [] } }), /git unavailable/);
});

test("eval scoreObjective treats flow error envelopes as infra exclusions, not answers", async () => {
	const result = {
		content: [{ type: "text", text: "Flow agent \"analyst\" exited with code 1." }],
		details: {
			error: { code: "CHILD_EXIT_NONZERO", message: "Flow agent \"analyst\" exited with code 1." },
		},
	};
	const scored = await scoreObjective({
		result,
		testCase: {
			score() {
				return { pass: true, score: 1, notes: "non-empty text produced" };
			},
		},
		ctx: {},
	});

	assert.equal(scored.objective.pass, false);
	assert.equal(scored.objective.score, 0);
	assert.equal(scored.objective.inconclusive, true);
	assert.match(scored.objective.notes, /infra exclusion/);
	assert.match(scored.reachedModel, /analyst/);
});

test("eval scoreObjective treats timeouts as inconclusive infra, not failed answers", async () => {
	const result = {
		content: [{ type: "text", text: "Flow agent \"recon\" timed out after 120000ms." }],
		details: {
			results: [{ agent: "recon", exitCode: 143, stopReason: "timeout", errorMessage: "Flow agent \"recon\" timed out after 120000ms." }],
		},
	};
	const scored = await scoreObjective({
		result,
		testCase: {
			score() {
				return { pass: false, score: 0, notes: "no defects listed" };
			},
		},
		ctx: {},
	});

	assert.equal(scored.objective.pass, false);
	assert.equal(scored.objective.inconclusive, true);
	assert.match(scored.objective.notes, /infra exclusion/);
	assert.match(scored.reachedModel, /timed out/);
});

test("eval timeout plans preserve per-case budgets unless arm-timeout is an explicit debug budget", () => {
	const hardCase = { params: { timeoutMs: 600_000 } };
	assert.deepEqual(timeoutPlanForCase(hardCase, { defaultTimeoutMs: 120_000, armTimeoutMs: null }), {
		caseTimeoutMs: 600_000,
		effectiveTimeoutMs: 600_000,
		armTimeoutMs: null,
		debugBudget: false,
	});
	assert.deepEqual(timeoutPlanForCase(hardCase, { defaultTimeoutMs: 120_000, armTimeoutMs: 120_000 }), {
		caseTimeoutMs: 600_000,
		effectiveTimeoutMs: 120_000,
		armTimeoutMs: 120_000,
		debugBudget: true,
	});
	assert.deepEqual(timeoutPlanForCase(hardCase, { defaultTimeoutMs: 120_000, armTimeoutMs: 900_000 }), {
		caseTimeoutMs: 600_000,
		effectiveTimeoutMs: 900_000,
		armTimeoutMs: 900_000,
		debugBudget: true,
	});
});

test("eval exclusion classifier excludes every arm-timeout run as debug budget", () => {
	const timeoutPlan = timeoutPlanForCase({ params: { timeoutMs: 600_000 } }, { defaultTimeoutMs: 120_000, armTimeoutMs: 120_000 });
	assert.deepEqual(exclusionForRun({ reachedModel: "child timeout", timeoutPlan }), {
		reason: "debug_budget",
		detail: "arm-timeout 120000ms is a smoke/debug override; case budget 600000ms",
	});
	assert.equal(exclusionForRun({ reachedModel: 'Flow agent "recon" timed out after 120000ms.', timeoutPlan }).reason, "debug_budget");
	assert.equal(exclusionForRun({ reachedModel: null, timeoutPlan }).reason, "debug_budget");
	assert.deepEqual(exclusionForRun({ reachedModel: "provider/API error", timeoutPlan }), {
		reason: "infra",
		detail: "provider/API error",
	});
});

test("eval judge eligibility requires at least one non-excluded product span", () => {
	assert.equal(shouldJudgeProductSpans({ productSpans: 0 }), false, "calibration canaries alone must not reach paid judging");
	assert.equal(shouldJudgeProductSpans({ productSpans: 1 }), true);
	assert.equal(shouldJudgeProductSpans({ productSpans: 1, dryRun: true }), false);
	assert.equal(shouldJudgeProductSpans({ productSpans: 1, traceOnly: true }), false);
});

test("eval CLIs reject non-positive arm-timeout overrides", () => {
	for (const script of ["evals/run.mjs", "evals/compare.mjs"]) {
		const child = spawnSync(process.execPath, ["--import", "tsx", script, "--dry-run", "--arm-timeout=0"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		assert.equal(child.status, 2, script);
		assert.match(child.stderr, /--arm-timeout must be a positive number/);
	}
});

test("eval calibration canaries are fixed true-negative judge fixtures", () => {
	assert.ok(CALIBRATION_CASES.length >= 3, "TNR needs more than two negative data points");
	assert.ok(
		CALIBRATION_CASES.some((c) => c.objective.score > 0 && c.objective.score < 1),
		"at least one canary should be partial to give score-delta machinery headroom",
	);
	for (const testCase of CALIBRATION_CASES) {
		assert.equal(testCase.objective.pass, false, `${testCase.name} must remain a deterministic negative label`);
		assert.ok(testCase.task, `${testCase.name} carries judge task context`);
		assert.ok(testCase.answer, `${testCase.name} carries the answer thulr judges`);
		assert.ok(testCase.criterion, `${testCase.name} carries an inline criterion`);
	}
});

test("eval simple answer-quality case is marked as a control, not a default flow-positive", () => {
	const control = CASES.find((c) => c.name === "single-answer-quality-judged");
	assert.equal(control?.control, true);
	assert.match(control?.controlReason ?? "", /threshold\/control/);
});

test("selection eval parser detects flow tool calls in pi JSON messages", () => {
	const state = {
		flowCallIds: new Set(),
		flowCalls: [],
		answer: "",
		parseErrors: 0,
		stdoutSample: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
	const message = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "use flow" },
			{ type: "toolCall", id: "call-1", name: "flow", arguments: { list: true } },
		],
	};

	assert.deepEqual(flowCallIdsFromMessage(message), ["call-1"]);
	assert.deepEqual(flowCallsFromMessage(message), [{ id: "call-1", arguments: { list: true } }]);
	collectSelectionEvent(JSON.stringify({ type: "agent_end", messages: [message] }), state);
	assert.equal(state.flowCallIds.size, 1);
	assert.deepEqual(state.flowCalls.map((call) => call.arguments), [{ list: true }]);
});

test("selection eval parser replaces partial empty tool args with execution args", () => {
	const state = {
		flowCallIds: new Set(),
		flowCalls: [],
		answer: "",
		parseErrors: 0,
		stdoutSample: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};

	collectSelectionEvent(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "flow", arguments: {} }] } }), state);
	collectSelectionEvent(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "flow", args: { list: true } }), state);

	assert.equal(state.flowCallIds.size, 1);
	assert.deepEqual(state.flowCalls.map((call) => call.arguments), [{ list: true }]);
});

test("selection eval parser replaces partial empty agent args with execution args", () => {
	const state = {
		flowCallIds: new Set(),
		flowCalls: [],
		answer: "",
		parseErrors: 0,
		stdoutSample: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};

	collectSelectionEvent(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "flow", arguments: { agent: "" } }] } }), state);
	collectSelectionEvent(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "flow", args: { agent: "recon", task: "Inspect the package name." } }), state);

	assert.equal(state.flowCallIds.size, 1);
	assert.deepEqual(state.flowCalls.map((call) => call.arguments), [{ agent: "recon", task: "Inspect the package name." }]);
});

test("selection eval parser keeps the most complete streamed tool args", () => {
	const state = {
		flowCallIds: new Set(),
		flowCalls: [],
		answer: "",
		parseErrors: 0,
		stdoutSample: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};

	collectSelectionEvent(JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "flow", arguments: { agent: "recon", task: "Inspect" } }] } }), state);
	collectSelectionEvent(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "flow", arguments: { agent: "recon", task: "Inspect this repository and report the package name." } }] } }), state);

	assert.equal(state.flowCallIds.size, 1);
	assert.deepEqual(state.flowCalls.map((call) => call.arguments), [{ agent: "recon", task: "Inspect this repository and report the package name." }]);
});

test("selection eval scores overuse, correct non-use, and wrong flow arguments", () => {
	assert.equal(scoreSelection({ expectFlow: false, answerPattern: "4" }, { flowCalls: 0, answer: "4" }).pass, true);
	const overused = scoreSelection({ expectFlow: false, answerPattern: "4" }, { flowCalls: 1, answer: "4" });
	assert.equal(overused.pass, false);
	assert.match(overused.notes, /expected flow=false/);

	const correct = scoreSelection(
		{ expectFlow: true, answerPattern: "done", expectedFlowCall: { mode: "parallel", minTasks: 2, taskPattern: "auth" } },
		{ flowCalls: 1, flowCallArgs: [{ tasks: [{ agent: "recon", task: "frontend auth" }, { agent: "recon", task: "backend auth" }] }], answer: "done" },
	);
	assert.equal(correct.pass, true);

	const stoppedAfterSelection = scoreSelection(
		{ expectFlow: true, answerPattern: "done", expectedFlowCall: { mode: "single", agent: "recon", taskPattern: "auth" } },
		{ flowCalls: 1, flowCallArgs: [{ agent: "recon", task: "inspect auth" }], answer: "", stoppedAfterFlowCall: true },
	);
	assert.equal(stoppedAfterSelection.pass, true);

	const wrongMode = scoreSelection(
		{ expectFlow: true, answerPattern: "done", expectedFlowCall: { mode: "parallel", minTasks: 2 } },
		{ flowCalls: 1, flowCallArgs: [{ agent: "recon", task: "auth" }], answer: "done" },
	);
	assert.equal(wrongMode.pass, false);
	assert.match(wrongMode.notes, /expected mode parallel/);

	const timedOut = scoreSelection(
		{ expectFlow: true, expectedFlowCall: { mode: "orchestrate" } },
		{ flowCalls: 0, timedOut: true, inconclusive: true, error: "selection eval timed out after 180000ms" },
	);
	assert.equal(timedOut.pass, false);
	assert.equal(timedOut.inconclusive, true);
	assert.equal(timedOut.selectionOk, null);
	assert.match(timedOut.notes, /timed out/);
});

test("selection eval flow argument matcher recognizes implicit delegation modes", () => {
	assert.equal(flowCallMatchesExpectation({ arguments: { agent: "recon", task: "Find the flow tool" } }, { mode: "single", agents: ["recon", "analyst"], taskPattern: "flow" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Draft and verify", evaluate: {} } }, { mode: "evaluate", agent: "operator", taskPattern: "verify" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { evaluate: { operator: { agent: "operator", task: "Draft the release checklist for install, safety, and evals." } } } }, { mode: "evaluate", agent: "operator", taskPattern: "release checklist|install|safety|eval" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Map modules", orchestrate: {} } }, { modes: ["orchestrate", "parallel"], agents: ["recon"] }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { orchestrate: { returnContract: "Map agent discovery, schema validation, and child process running." } } }, { modes: ["orchestrate", "parallel"], agents: ["recon"], taskPattern: "agent discovery|schema|child process" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Release migration", workflow: { phases: [{ id: "scan", agent: "recon", task: "Analyze migration" }, { id: "approve", approval: { message: "Approve release" } }] } } }, { mode: "workflow", agents: ["recon"], minTasks: 2, taskPattern: "migration|approve" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Integrate fixes", worktree: { tasks: [{ id: "ui", agent: "operator", task: "Fix frontend" }, { id: "api", agent: "operator", task: "Fix backend" }] } } }, { mode: "worktree", agents: ["operator"], minTasks: 2, taskPattern: "frontend|backend" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Choose queue design", debate: { participants: [{ agent: "analyst" }, { agent: "strategist" }] } } }, { mode: "debate", agents: ["analyst", "strategist"], minTasks: 2, taskPattern: "queue" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Build evidence", dossier: { sections: [{ agent: "recon", task: "Inspect runbook" }, { agent: "analyst", task: "Inspect incident" }] } } }, { mode: "dossier", agents: ["recon", "analyst"], minTasks: 2, taskPattern: "runbook|incident" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Diagnose event", monitor: { command: "./health-check", trigger: "match", pattern: "DEGRADED" } } }, { mode: "monitor", agents: ["analyst"], taskPattern: "health-check|DEGRADED" }).pass, true);
});

test("selection eval keeps simple use-cases as no-flow negatives", () => {
	const noFlow = SELECTION_CASES.filter((c) => c.expectFlow === false);
	const flow = SELECTION_CASES.filter((c) => c.expectFlow === true);

	assert.ok(noFlow.length >= 5, "simple prompts should dominate the no-flow selection suite");
	assert.ok(flow.length >= 6, "selection needs explicit and implicit positive flow controls");
	for (const testCase of noFlow) {
		assert.equal(testCase.mock.flowCalls, 0, `${testCase.name} mock must prove no sub-agent invocation`);
	}
	for (const testCase of flow) {
		assert.ok(testCase.expectedFlowCall ?? testCase.expectedFlowCalls, `${testCase.name} must assert the selected flow shape`);
		assert.ok(testCase.mock.flowCallArgs?.length > 0, `${testCase.name} mock must include flow arguments`);
	}
	for (const testCase of SELECTION_CASES.filter((c) => c.timeoutMs !== undefined)) {
		assert.ok(testCase.timeoutMs >= 90_000, `${testCase.name} must keep a full measurement budget`);
	}
});
