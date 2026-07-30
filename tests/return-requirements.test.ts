import assert from "node:assert/strict";
import { test } from "node:test";
import { appendReturnContract, appendReturnRequirements } from "../extensions/pi-flows/validate.ts";

test("return requirements append explicit output and evidence requirements", () => {
	const task = appendReturnRequirements("Map the auth flow.", "Return a table with path, purpose, and evidence.", true);

	assert.match(task, /Map the auth flow/);
	assert.match(task, /## Return requirements/);
	assert.match(task, /Return a table with path, purpose, and evidence/);
	assert.match(task, /file:line references/);
	assert.equal(appendReturnRequirements("plain", undefined, false), "plain");
});

test("the legacy return-contract helper remains a compatibility alias", () => {
	const args = ["Map the auth flow.", "Return a table.", true] as const;

	assert.equal(appendReturnContract(...args), appendReturnRequirements(...args));
});
