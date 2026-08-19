import assert from "node:assert/strict";
import { test } from "node:test";
import { appendReturnRequirements, renamedParamError } from "../extensions/pi-flows/validate.ts";

test("return requirements append explicit output and evidence requirements", () => {
	const task = appendReturnRequirements("Map the auth flow.", "Return a table with path, purpose, and evidence.", true);

	assert.match(task, /Map the auth flow/);
	assert.match(task, /## Return requirements/);
	assert.match(task, /Return a table with path, purpose, and evidence/);
	assert.match(task, /file:line references/);
	assert.equal(appendReturnRequirements("plain", undefined, false), "plain");
});

// The retired keys refuse loudly wherever they can appear, because the public
// schema does not reject unknown keys: without the tombstone an old call would
// pass validation and its requirements would silently never reach a child.
test("a retired returnContract key is refused, not silently ignored", () => {
	assert.equal(renamedParamError({ task: "x", returnRequirements: "shape" }), null, "the current vocabulary is admissible");
	assert.equal(renamedParamError({ task: "x", returnContract: "shape" })?.code, "PARAM_RENAMED", "the retired top-level key refuses");
	assert.equal(renamedParamError({ tasks: [{ agent: "recon", task: "x", returnContract: "shape" }] })?.code, "PARAM_RENAMED", "a retired per-task key refuses");
	assert.equal(renamedParamError({ orchestrate: { workerReturnContract: "shape" } })?.code, "PARAM_RENAMED", "the retired orchestrate worker key refuses");
	const error = renamedParamError({ workflow: { phases: [{ id: "a", returnContract: "shape" }] } });
	assert.match(error?.fix ?? "", /returnRequirements/, "the fix names the replacement key");
});

test("the tombstone path masks ancestor keys it cannot vouch for", () => {
	const error = renamedParamError({ "not a plain token!": { returnContract: "x" } });
	assert.equal(error?.code, "PARAM_RENAMED");
	assert.doesNotMatch(error?.message ?? "", /not a plain token/, "an arbitrary ancestor key never reaches returned content");
	assert.match(error?.message ?? "", /\(unrecognized key\)\.returnContract/, "the retired key itself stays named");

	// A secret can be a plain token, so the charset test alone is not enough:
	// the same redactor that guards returned content vets the segment.
	const secretShaped = `sk-${"a".repeat(30)}`;
	const shaped = renamedParamError({ [secretShaped]: { returnContract: "x" } });
	assert.equal(shaped?.code, "PARAM_RENAMED");
	assert.doesNotMatch(shaped?.message ?? "", new RegExp(secretShaped), "a secret-shaped plain ancestor key is masked too");
});

test("a contract's returnSchema may declare data fields by any name", () => {
	const params = { agent: "recon", task: "x", contract: { returnSchema: { properties: { returnContract: { type: "string" } } } } };
	assert.equal(renamedParamError(params), null, "contract subtrees are never scanned for retired keys");
});
