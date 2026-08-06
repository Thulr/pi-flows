// Offline tests for spawn-gate admissibility in selection scoring (issue #83):
// the flow tool refuses every spawning call whose `why` is missing or blank
// (WHY_REQUIRED) before any child spawns, so the selection matcher must not
// credit such a call as a correct selection — uniformly, in every spawning
// mode. The predicate is imported from the extension (spawnJustificationMissing)
// rather than re-derived, so the scored rule cannot drift from the enforced one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAdmissibilityFailure, flowCallMatchesExpectation } from "../evals/select.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";
import { spawnJustificationMissing } from "../extensions/pi-flows/validate.ts";

// One minimal call per spawning mode the matcher can detect. Each is shaped so
// that with a valid `why` it matches an empty expectation; without one, only
// the spawn gate stands between it and a pass.
const SPAWNING_CALLS: Record<string, Record<string, unknown>> = {
	single: { agent: "recon", task: "Inspect the repo" },
	parallel: { tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
	chain: { chain: [{ agent: "recon", task: "A" }, { agent: "analyst", task: "B" }] },
	evaluate: { task: "Draft and verify", evaluate: {} },
	vote: { task: "Pick one", vote: {} },
	route: { task: "Classify this", route: {} },
	orchestrate: { task: "Map modules", orchestrate: {} },
	graph: { graph: { nodes: [{ id: "a", agent: "recon", task: "A" }] } },
	loop: { task: "Iterate", loop: {} },
	search: { task: "Search designs", search: {} },
	workflow: { task: "Migrate", workflow: { phases: [{ id: "scan", agent: "recon", task: "Scan" }] } },
	worktree: { task: "Fix both", worktree: { tasks: [{ id: "a", agent: "operator", task: "A" }] } },
	debate: { task: "Decide", debate: { participants: [{ agent: "analyst" }, { agent: "strategist" }] } },
	dossier: { task: "Evidence", dossier: { sections: [{ agent: "recon", task: "A" }] } },
	monitor: { task: "Watch", monitor: { command: "./check", trigger: "match", pattern: "DOWN" } },
	preset: { preset: "code-review", task: "Review HEAD against main." },
};

test("a missing why fails the match in every spawning mode; a valid why restores it", () => {
	for (const [mode, args] of Object.entries(SPAWNING_CALLS)) {
		const refused = flowCallMatchesExpectation({ arguments: args }, {});
		assert.equal(refused.pass, false, `${mode}: a call the tool would refuse must not score as a selection`);
		assert.match(refused.notes, /spawn gate|WHY_REQUIRED/, `${mode}: the note must name the gate`);

		const admitted = flowCallMatchesExpectation({ arguments: { ...args, why: "eval justification" } }, {});
		assert.equal(admitted.pass, true, `${mode}: the same call with a valid why must still match — ${admitted.notes}`);
	}
});

test("whitespace-only and non-string why fail exactly as the tool's predicate says", () => {
	for (const why of [undefined, null, "", "   ", "\n\t", 42, true, { text: "because" }]) {
		assert.equal(spawnJustificationMissing(why), true, `tool predicate must refuse why=${JSON.stringify(why)}`);
		const match = flowCallMatchesExpectation({ arguments: { agent: "recon", task: "Inspect", why } }, { mode: "single" });
		assert.equal(match.pass, false, `matcher must refuse why=${JSON.stringify(why)}`);
	}
	assert.equal(spawnJustificationMissing("author-independent verification"), false);
});

test("a gate failure is diagnosable apart from a shape mismatch", () => {
	// Right shape, refused call: the note says the shape matched and names the gate.
	const gateFail = flowCallMatchesExpectation({ arguments: { agent: "recon", task: "Inspect auth" } }, { mode: "single", agents: ["recon"], taskPattern: "auth" });
	assert.equal(gateFail.pass, false);
	assert.match(gateFail.notes, /matches the expected shape/);
	assert.match(gateFail.notes, /WHY_REQUIRED/);
	// Wrong shape: the note reports the selection failure, not the gate.
	const shapeFail = flowCallMatchesExpectation({ arguments: { agent: "recon", task: "Inspect auth" } }, { mode: "parallel", minTasks: 2 });
	assert.equal(shapeFail.pass, false);
	assert.doesNotMatch(shapeFail.notes, /WHY_REQUIRED/);
	assert.match(shapeFail.notes, /expected mode parallel/);
});

test("non-spawning surfaces are exempt, exactly as in the tool", () => {
	assert.equal(callAdmissibilityFailure({ list: true }), null);
	assert.equal(callAdmissibilityFailure({ showConfig: true }), null);
	assert.equal(callAdmissibilityFailure({ agent: "recon", task: "Inspect" })?.code, "WHY_REQUIRED");
	assert.equal(callAdmissibilityFailure({ agent: "recon", task: "Inspect", why: "delegated scout" }), null);
});

test("every spawning selection fixture is already admissible — the gate needs no fixture edits", () => {
	for (const testCase of SELECTION_CASES.filter((c) => c.expectFlow)) {
		for (const args of testCase.mock.flowCallArgs ?? []) {
			assert.equal(
				callAdmissibilityFailure(args),
				null,
				`${testCase.name}: a dry-run mock the tool would refuse means the fixture (or the gate) is wrong`,
			);
		}
	}
});
