import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { CALIBRATION_CASES, CASES } from "../evals/cases.mjs";
import { injectModel } from "../evals/model-injection.mjs";
import { exclusionForRun, infraError, scoreObjective, timeoutPlanForCase } from "../evals/lib.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";
import { collectSelectionEvent, flowCallIdsFromMessage, flowCallsFromMessage, flowCallMatchesExpectation, scoreSelection } from "../evals/select.mjs";

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
		infraError({ content: [{ type: "text", text: "Error: authentication required" }], details: { results: [] } }),
		"provider/API error",
	);
	assert.equal(
		infraError({ content: [{ type: "text", text: "provider failed: API key missing" }], details: { results: [] } }),
		"provider/API error",
	);
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
		debugBudget: false,
	});
});

test("eval exclusion classifier tags sub-budget timeouts as debug budget", () => {
	const timeoutPlan = timeoutPlanForCase({ params: { timeoutMs: 600_000 } }, { defaultTimeoutMs: 120_000, armTimeoutMs: 120_000 });
	assert.deepEqual(exclusionForRun({ reachedModel: "child timeout", timeoutPlan }), {
		reason: "debug_budget",
		detail: "arm-timeout 120000ms is below case budget 600000ms",
	});
	assert.equal(exclusionForRun({ reachedModel: 'Flow agent "recon" timed out after 120000ms.', timeoutPlan }).reason, "debug_budget");
	assert.deepEqual(exclusionForRun({ reachedModel: "provider/API error", timeoutPlan }), {
		reason: "infra",
		detail: "provider/API error",
	});
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
});

test("selection eval flow argument matcher recognizes implicit delegation modes", () => {
	assert.equal(flowCallMatchesExpectation({ arguments: { agent: "recon", task: "Find the flow tool" } }, { mode: "single", agents: ["recon", "analyst"], taskPattern: "flow" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Draft and verify", evaluate: {} } }, { mode: "evaluate", agent: "operator", taskPattern: "verify" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { evaluate: { operator: { agent: "operator", task: "Draft the release checklist for install, safety, and evals." } } } }, { mode: "evaluate", agent: "operator", taskPattern: "release checklist|install|safety|eval" }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { task: "Map modules", orchestrate: {} } }, { modes: ["orchestrate", "parallel"], agents: ["recon"] }).pass, true);
	assert.equal(flowCallMatchesExpectation({ arguments: { orchestrate: { returnContract: "Map agent discovery, schema validation, and child process running." } } }, { modes: ["orchestrate", "parallel"], agents: ["recon"], taskPattern: "agent discovery|schema|child process" }).pass, true);
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
});
