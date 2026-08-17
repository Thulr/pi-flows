// Pins the Decomposition structure eval (issue #148) inside `npm test`, the way
// tests/admissibility-scoring.test.ts pins the selection eval's admissibility
// seam. The eval itself is deterministic and model-free, so the whole manifest
// runs here: a change to the shipped gate that moves any structural outcome
// fails this file rather than waiting for someone to run `npm run
// eval:decomposition` by hand.
//
// The eval scores against the extension's own `parseDecomposition` /
// `validateDecomposition`, so there is no mirrored predicate to drift. What
// needs pinning instead is that the manifest stays well-formed, that every case
// still matches, and that the gate is able to say no.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DECOMPOSITION_CASES,
	decompositionStructureExitCode,
	decompositionStructureReport,
	runDecompositionStructureEval,
	scoreDecompositionCase,
	validateDecompositionCases,
} from "../evals/decomposition-structure.mjs";

test("the seeded Decomposition manifest is well-formed", () => {
	assert.deepEqual(validateDecompositionCases(DECOMPOSITION_CASES), []);

	// A mistyped expectation must stop a run instead of scoring as evidence.
	assert.ok(validateDecompositionCases([{ name: "x", family: "f", entries: [], expect: { outcome: "accepted" } }]).length > 0);
	assert.ok(validateDecompositionCases([{ name: "x", family: "f", entries: [], expect: { outcome: "refused" } }]).length > 0);
});

test("every seeded case matches the shipped Decomposition gate", () => {
	const { rows } = runDecompositionStructureEval();
	const failures = rows.filter((row) => !row.pass).map((row) => `${row.name}: ${row.notes}`);
	assert.deepEqual(failures, []);
	assert.equal(decompositionStructureExitCode(decompositionStructureReport(rows)), 0);
});

test("the eval measures both sides: admitted controls and refused defects, over every declared code", () => {
	const { rows } = runDecompositionStructureEval();
	const report = decompositionStructureReport(rows);

	assert.ok(report.admission.controls > 0, "the admission rate needs a control denominator");
	assert.equal(report.admission.rate, 1);
	assert.equal(report.falseRefusal.refused, 0);
	assert.ok(report.edges.cases > 0, "dependency-edge usage needs cases that declare edges");
	assert.equal(report.edges.correct, report.edges.cases);
	assert.ok(report.refusal.defects > 0, "refusal correctness needs a defect denominator");
	assert.equal(report.refusal.expectedCode, report.refusal.defects);

	// Each refusal the module can produce is exercised by at least one defect.
	const codes = new Set(rows.filter((row) => row.expect.outcome === "refused").map((row) => row.expect.code));
	assert.deepEqual([...codes].sort(), ["DECOMPOSITION_CYCLE", "DECOMPOSITION_INVALID", "SHARED_WRITE_CWD"]);

	// The case families the issue's brief requires, all present.
	const families = new Set(rows.map((row) => row.family));
	for (const family of ["flat", "structured-no-edges", "chain", "mixed-dag", "coverage-gap", "overlapping-scope", "ceiling", "shared-write", "cycle", "entry-defect", "edge-defect", "unsafe-id"]) {
		assert.ok(families.has(family), `missing case family: ${family}`);
	}
});

test("the gate fails when a structural outcome moves", () => {
	// An expected edge set the parser does not produce must fail the case.
	const seeded = DECOMPOSITION_CASES.find((testCase) => testCase.name === "structured-chain");
	assert.ok(seeded);
	const mutated = scoreDecompositionCase({ ...seeded!, expect: { ...seeded!.expect, edges: { trace: ["report"] } } });
	assert.equal(mutated.pass, false);
	assert.match(mutated.notes, /expected edges/);

	const wrongCode = scoreDecompositionCase({
		...DECOMPOSITION_CASES.find((testCase) => testCase.name === "cycle-between-two-subtasks")!,
		expect: { outcome: "refused", code: "DECOMPOSITION_INVALID", shape: "structured" },
	});
	assert.equal(wrongCode.pass, false);
	assert.match(wrongCode.notes, /expected code DECOMPOSITION_INVALID/);

	assert.equal(decompositionStructureExitCode(decompositionStructureReport([mutated, wrongCode])), 1);
});
