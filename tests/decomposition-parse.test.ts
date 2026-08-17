// The Decomposition parser matrix (issue #148): every shape a commander can
// emit, over both emission paths, normalized into one Decomposition.
//
// The parser is deliberately tolerant and total — it never refuses. A defect it
// finds is retained on the subtask so the validator can name it, which is what
// the "retained, not dropped" assertions below pin. The refusals themselves
// live in tests/decomposition-refusals.test.ts; the smoke coverage of the happy
// shapes lives in tests/decomposition.test.ts and is not repeated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FlowDecompositionReturn, parseDecomposition } from "../extensions/pi-flows/decomposition.ts";
import { ResolvedDelegationContract } from "../extensions/pi-flows/delegation.ts";

/** The legacy emission path: prose with a trailing fenced JSON block. */
const legacy = (value: unknown) => `Here is the breakdown.\n\n\`\`\`json\n${typeof value === "string" ? value : JSON.stringify(value)}\n\`\`\``;
/** The contracted emission path: validated return-envelope data. */
const contracted = (data: unknown) => ({ source: "contract" as const, data });

test("a structured Decomposition parses identically from validated envelope data and from a fenced JSON block", () => {
	const entries = [
		{ id: "survey", objective: "List the auth entry points" },
		{ id: "trace", objective: "Trace token refresh", dependsOn: ["survey"], scope: "server only" },
	];
	const fromEnvelope = parseDecomposition(contracted(entries), 8);
	const fromProse = parseDecomposition(legacy(entries), 8);

	assert.equal(fromEnvelope?.shape, "structured", "envelope data carrying subtask objects is a structured Decomposition");
	assert.deepEqual(fromEnvelope, fromProse, "the two emission paths normalize to the same Decomposition");
	assert.deepEqual(fromEnvelope?.subtasks.map((subtask) => subtask.id), ["survey", "trace"]);
	assert.deepEqual(fromEnvelope?.subtasks[1].dependsOn, ["survey"]);
});

test("a flat subtask list keeps positional ids and the silent slice on both emission paths", () => {
	// The flat path is legacy behavior and must not shift: ids are synthesized
	// from position, and a list over the ceiling loses its tail without comment,
	// because a list with no edges has none to sever.
	const slicedFromEnvelope = parseDecomposition(contracted(["one", "two", "three"]), 2);
	assert.equal(slicedFromEnvelope?.shape, "flat");
	assert.deepEqual(slicedFromEnvelope?.subtasks.map((subtask) => [subtask.id, subtask.objective]), [["1", "one"], ["2", "two"]]);

	const slicedFromProse = parseDecomposition(legacy(["one", "two", "three"]), 2);
	assert.deepEqual(slicedFromProse, slicedFromEnvelope);
	assert.deepEqual(
		parseDecomposition(legacy(["one", "two", "three"]), 8)?.subtasks.map((subtask) => subtask.id),
		["1", "2", "3"],
		"ids count positions, not surviving entries",
	);
});

test("an array mixing subtask strings and subtask objects parses as structured, keeping the bare string as a defective entry", () => {
	// One structured entry makes the whole array structured, so the bare string
	// becomes an entry with neither id nor objective. Dropping it here would hide
	// the mix; the validator refuses it and names its position.
	const trailing = parseDecomposition(legacy([{ id: "survey", objective: "List entry points" }, "trace the refresh"]), 8);
	assert.equal(trailing?.shape, "structured");
	assert.equal(trailing?.subtasks.length, 2, "the offending entry survives parsing so it can be named");
	assert.deepEqual([trailing?.subtasks[1].id, trailing?.subtasks[1].objective], ["", ""]);

	const leading = parseDecomposition(legacy(["survey the entry points", { id: "trace", objective: "Trace the refresh" }]), 8);
	assert.deepEqual([leading?.subtasks[0].id, leading?.subtasks[0].objective], ["", ""]);
});

test("`task` is read as an objective alias only on an entry that is already structured", () => {
	// `task` is the field name the legacy protocol taught commanders. On a
	// structured entry it states the objective; on its own it is the legacy
	// wrapper parseSubtasks has always read as plain subtask text.
	const aliased = parseDecomposition(legacy([{ id: "survey", task: "List the auth entry points" }]), 8);
	assert.equal(aliased?.shape, "structured");
	assert.equal(aliased?.subtasks[0].objective, "List the auth entry points");

	// An explicit objective wins over the alias rather than being concatenated.
	const both = parseDecomposition(legacy([{ id: "survey", objective: "The objective", task: "The alias" }]), 8);
	assert.equal(both?.subtasks[0].objective, "The objective");

	// The bare wrapper stays flat, so today's commanders keep meaning what they meant.
	const wrapper = parseDecomposition(legacy([{ task: "map login" }, { task: "map refresh" }]), 8);
	assert.equal(wrapper?.shape, "flat");
	assert.deepEqual(wrapper?.subtasks.map((subtask) => [subtask.id, subtask.objective]), [["1", "map login"], ["2", "map refresh"]]);
});

test("a null dependsOn reads as no dependencies, and any other non-list shape is retained as malformed", () => {
	// JSON has no way to omit a key a model decided to write, so `null` is how a
	// commander says "none". Everything else that is not a list of id strings is
	// a defect the validator must be able to see.
	const explicitNone = parseDecomposition(legacy([{ id: "a", objective: "a", dependsOn: null }]), 8);
	assert.deepEqual(explicitNone?.subtasks[0].dependsOn, []);
	assert.equal(explicitNone?.subtasks[0].malformedDependsOn, false, "null is an answer, not a defect");

	const omitted = parseDecomposition(legacy([{ id: "a", objective: "a" }]), 8);
	assert.equal(omitted?.subtasks[0].malformedDependsOn, false);

	const bareString = parseDecomposition(legacy([{ id: "a", objective: "a", dependsOn: "b" }]), 8);
	assert.equal(bareString?.subtasks[0].malformedDependsOn, true);
	assert.deepEqual(bareString?.subtasks[0].dependsOn, []);

	// A list that is partly ids loses nothing quietly: the shortfall is the defect.
	const partial = parseDecomposition(legacy([{ id: "a", objective: "a", dependsOn: ["b", 7, ""] }]), 8);
	assert.equal(partial?.subtasks[0].malformedDependsOn, true);
	assert.deepEqual(partial?.subtasks[0].dependsOn, ["b"]);

	// A whole list of ids is not malformed, and each id is trimmed.
	const clean = parseDecomposition(legacy([{ id: "a", objective: "a", dependsOn: [" b ", "c"] }]), 8);
	assert.equal(clean?.subtasks[0].malformedDependsOn, false);
	assert.deepEqual(clean?.subtasks[0].dependsOn, ["b", "c"]);
});

test("every prose field accepts a string or a list of strings, and a list joins into lines", () => {
	// Models split prose into bullets as readily as they write a paragraph. Both
	// reach the worker prompt as prose, so both are read.
	const asStrings = parseDecomposition(legacy([{
		id: "survey", objective: "List entry points",
		scope: "auth only", nonGoals: "no edits", inputs: "the router table",
		expectedReturn: "a list", acceptanceEvidence: "file:line",
	}]), 8);
	assert.deepEqual(
		[asStrings?.subtasks[0].scope, asStrings?.subtasks[0].nonGoals, asStrings?.subtasks[0].inputs, asStrings?.subtasks[0].expectedReturn, asStrings?.subtasks[0].acceptanceEvidence],
		["auth only", "no edits", "the router table", "a list", "file:line"],
	);

	const asLists = parseDecomposition(legacy([{
		id: "survey", objective: ["List entry points", "and their owners"],
		scope: ["auth only", "server side"], nonGoals: ["no edits", "no renames"], inputs: ["the router table"],
		expectedReturn: ["a list", "with owners"], acceptanceEvidence: ["file:line"],
	}]), 8);
	assert.equal(asLists?.subtasks[0].objective, "List entry points\nand their owners");
	assert.equal(asLists?.subtasks[0].scope, "auth only\nserver side");
	assert.equal(asLists?.subtasks[0].nonGoals, "no edits\nno renames");
	assert.equal(asLists?.subtasks[0].expectedReturn, "a list\nwith owners");

	// An empty or blank prose field is absent, not an empty section in the prompt.
	const blank = parseDecomposition(legacy([{ id: "a", objective: "a", scope: "   ", nonGoals: [], inputs: ["  "] }]), 8);
	assert.equal(blank?.subtasks[0].scope, undefined);
	assert.equal(blank?.subtasks[0].nonGoals, undefined);
	assert.equal(blank?.subtasks[0].inputs, undefined);
});

test("a non-string id is no id at all, and an entry naming an agent keeps the name for refusal", () => {
	// An id is a key that dependency edges and span keys are addressed by, so
	// only a string can be one. A number is not coerced into a key.
	const numericId = parseDecomposition(legacy([{ id: 7, objective: "a" }]), 8);
	assert.equal(numericId?.shape, "structured");
	assert.equal(numericId?.subtasks[0].id, "");

	const named = parseDecomposition(legacy([{ id: "a", objective: "a", agent: "operator" }]), 8);
	assert.equal(named?.subtasks[0].declaredAgent, "operator", "the attempt survives parsing so the refusal can quote it");

	// An entry whose only structured field is `agent` still makes the array
	// structured — otherwise the attempt would be silently read as flat prose.
	assert.equal(parseDecomposition(legacy([{ agent: "operator" }]), 8)?.shape, "structured");
});

test("the published return schema admits exactly the shapes the parser reads", () => {
	// FlowDecompositionReturn is what a contracted commander's envelope `data` is
	// checked against, through the same compiled validator the flow uses. A
	// schema narrower than the parser would refuse a contracted commander for
	// writing what an uncontracted one may write — different rules per emission
	// path, which is the one thing the two paths must not have.
	const contract = ResolvedDelegationContract.resolve({
		objective: "Break the goal into subtasks.",
		constraints: [],
		nonGoals: [],
		dependencies: [],
		authority: { may: ["Read the goal."], mustNot: [], requiresApproval: [] },
		sideEffectClass: "read-only",
		budget: {},
		acceptanceChecks: ["Return one Decomposition."],
		returnSchema: FlowDecompositionReturn,
		owner: "tests",
	}).resolved!;

	// Every prose field in its list form: models split prose into bullets as
	// readily as they write a paragraph, and the parser joins either into lines.
	const bulleted = [{
		id: "survey", objective: ["List entry points", "and their owners"],
		scope: ["auth only", "server side"], nonGoals: ["no edits"], inputs: ["the router table"],
		expectedReturn: ["a list", "with owners"], acceptanceEvidence: ["file:line"],
	}, {
		id: "trace", objective: "Trace token refresh", dependsOn: ["survey"], scope: "server only",
	}];
	assert.equal(contract.checkReturnData(bulleted), true, "the array form of a prose field is accepted by the schema");
	const parsed = parseDecomposition(contracted(bulleted), 8);
	assert.equal(parsed?.subtasks[0].scope, "auth only\nserver side", "and read by the parser as the lines it joined");
	assert.equal(parsed?.subtasks[0].objective, "List entry points\nand their owners");

	// The flat shape and the string form of every field stay accepted too.
	assert.equal(contract.checkReturnData(["Map the login flow", "Map token refresh"]), true);
	assert.equal(contract.checkReturnData([{ id: "survey", objective: "List entry points", scope: "auth only" }]), true);

	// And the schema states the id rule the validator enforces, so a contracted
	// commander is told before it spends a worker.
	assert.equal(contract.checkReturnData([{ id: "two words", objective: "List entry points" }]), false);
	assert.equal(contract.checkReturnData([{ id: "a".repeat(65), objective: "List entry points" }]), false);
	assert.equal(contract.checkReturnData([{ id: "auth.login-2", objective: "List entry points" }]), true);
});

test("output carrying no usable array at all is no Decomposition, on either emission path", () => {
	// The caller's ORCHESTRATE_NO_SUBTASKS case, distinct from a Decomposition
	// this module refuses.
	assert.equal(parseDecomposition(legacy("[]"), 8), null);
	assert.equal(parseDecomposition(contracted([]), 8), null);
	assert.equal(parseDecomposition(contracted("not an array"), 8), null);
	assert.equal(parseDecomposition(contracted({ subtasks: ["a"] }), 8), null, "an object wrapping the array is not the array");
	assert.equal(parseDecomposition("I could not break this down.", 8), null);
	assert.equal(parseDecomposition(undefined, 8), null);
	// A flat list of blanks has no subtask text in it either.
	assert.equal(parseDecomposition(legacy(["  ", ""]), 8), null);
});
