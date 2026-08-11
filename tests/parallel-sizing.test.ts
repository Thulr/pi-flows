// Regression coverage for issue #121: raw heterogeneous fan-out must make
// model sizing visible before any child spends tokens. The real stub registry
// has distinct cheap/session/strong models, so the argv assertions pin both
// the refusal and the intentional sizing paths without a live model call.
import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveChildModel } from "../extensions/pi-flows/child-model.ts";
import { deriveModelRoster } from "../extensions/pi-flows/model-roster.ts";
import { availableModelsFromRegistry } from "../extensions/pi-flows/roster-source.ts";
import { runFlow, STUB_REGISTRY } from "./stub-harness.ts";

const mixedTasks = [
	{ agent: "analyst", task: "Mechanically extract the documented error codes." },
	{ agent: "analyst", task: "Adversarially review model-selection precedence." },
];

const modelOf = (call: { args: string[] }) => {
	const flag = call.args.indexOf("--model");
	return flag === -1 ? undefined : call.args[flag + 1];
};

test("omitted mixed analyst tasks would otherwise both resolve to the session model", () => {
	const roster = deriveModelRoster({
		available: availableModelsFromRegistry(STUB_REGISTRY),
		parent: { model: "test-provider/session-model" },
	});
	const choices = mixedTasks.map(() => resolveChildModel({ tier: "capable" }, {}, roster).model);
	assert.deepEqual(choices, ["test-provider/session-model", "test-provider/session-model"]);
});

test("raw multi-task parallel refuses omitted sizing before any child spends", async () => {
	const { calls, result, text } = await runFlow({ tasks: mixedTasks }, { analyst: "done" });

	assert.equal(calls.length, 0);
	assert.equal(result.details.error?.code, "PARALLEL_SIZING_REQUIRED");
	assert.match(text, /Parallel task sizing must be explicit/i);
	assert.match(text, /tier:'fast'\|'capable'\|'deep'/);
});

test("per-task tiers right-size mixed work through the roster", async () => {
	const { calls } = await runFlow({
		tasks: [
			{ ...mixedTasks[0], tier: "fast" },
			{ ...mixedTasks[1], tier: "deep" },
		],
	}, { analyst: "done" });

	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(modelOf).sort(), ["test-provider/cheap-model", "test-provider/strong-model"]);
});

test("a flow-wide tier explicitly acknowledges intentional uniform sizing", async () => {
	const { calls } = await runFlow({ tasks: mixedTasks, tier: "capable" }, { analyst: "done" });

	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(modelOf), ["test-provider/session-model", "test-provider/session-model"]);
});

test("per-task exact models remain an explicit sizing choice", async () => {
	const { calls } = await runFlow({
		tasks: mixedTasks.map((task) => ({ ...task, model: "test-provider/session-model", thinking: "low" })),
	}, { analyst: "done" });

	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(modelOf), ["test-provider/session-model", "test-provider/session-model"]);
	for (const call of calls) assert.equal(call.args[call.args.indexOf("--thinking") + 1], "low");
});
