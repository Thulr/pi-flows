// Structural eval for the orchestrate Decomposition (issue #148): does the
// deterministic admission gate accept the Decompositions it must accept, read
// the dependency edges the commander declared, and refuse the seeded defects
// with the code that names them?
//
// This eval measures STRUCTURE ONLY. It makes no claim that a Decomposition
// improves an answer; decomposition quality is judged elsewhere (issue #160).
// Nothing here spends a token: every case is a seeded fixture scored against
// the tool's own predicates — `parseDecomposition` and `validateDecomposition`
// imported from the extension, exactly as select-admissibility.mjs scores
// against the enforced pre-spawn refusal rather than a copy of it. A defect a
// case declares is therefore refused by the shipped gate or by nothing.
//
// The seeded cases are data and live in decomposition-cases.mjs; this module is
// the scorer, the report, and the gate over them.
//
// The .ts imports need the tsx loader (`node --import tsx`), like the other
// eval modules that read the extension directly.
//
// Usage:
//   npm run eval:decomposition
//   npm run eval:decomposition -- --filter=cycle
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDecomposition, validateDecomposition } from "../extensions/pi-flows/decomposition.ts";
import { discoverFlowAgents } from "../extensions/pi-flows/agents.ts";
import { DECOMPOSITION_CASES, READ_ONLY_WORKER, validateDecompositionCases } from "./decomposition-cases.mjs";

export { DECOMPOSITION_CASES, validateDecompositionCases };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The shared-write half of admission reads each role's effective toolset, so the
// verdict must be a property of the case rather than of whatever
// ~/.pi/flow-agents holds on this machine. Resolve the bundled roster only, and
// restore the toggle immediately so importing this module leaks nothing.
const packageOnlyPrevious = process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY;
process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = "1";
let bundledDiscovery;
try {
	bundledDiscovery = discoverFlowAgents(repoRoot, "user");
} finally {
	if (packageOnlyPrevious === undefined) delete process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY;
	else process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = packageOnlyPrevious;
}

/** The call-level gate inputs a case does not override. */
export function decompositionAdmission(overrides = {}) {
	return {
		discovery: bundledDiscovery,
		defaultCwd: repoRoot,
		workerRef: READ_ONLY_WORKER,
		concurrency: 4,
		maxSubtasks: 8,
		...overrides,
	};
}

/** The commander output for a case, over its declared emission path. */
export function commanderOutput(testCase) {
	if (Object.hasOwn(testCase, "raw")) return testCase.raw;
	if (testCase.emission === "contract") return { source: "contract", data: testCase.entries };
	return `Here is the breakdown.\n\n\`\`\`json\n${JSON.stringify(testCase.entries, null, 2)}\n\`\`\``;
}

/** The declared dependency edges, as the parser read them: subtask id -> the ids it needs. */
export function edgeSet(decomposition) {
	const edges = {};
	for (const subtask of decomposition.subtasks) {
		if (subtask.dependsOn.length > 0) edges[subtask.id] = [...subtask.dependsOn];
	}
	return edges;
}

const stableEdges = (edges) => JSON.stringify(Object.keys(edges).sort().map((id) => [id, edges[id]]));

/** Score one case against the shipped predicates. */
export function scoreDecompositionCase(testCase) {
	const admission = decompositionAdmission(testCase.admission);
	const decomposition = parseDecomposition(commanderOutput(testCase), admission.maxSubtasks);
	const refusal = decomposition ? validateDecomposition(decomposition, admission) : null;
	const actual = {
		outcome: !decomposition ? "no-decomposition" : refusal ? "refused" : "admitted",
		code: refusal?.code ?? null,
		shape: decomposition?.shape ?? null,
		edges: decomposition ? edgeSet(decomposition) : null,
		subtasks: decomposition?.subtasks.length ?? 0,
	};
	const expect = testCase.expect;
	const notes = [];
	if (actual.outcome !== expect.outcome) notes.push(`expected ${expect.outcome}, got ${actual.outcome}${actual.code ? ` (${actual.code})` : ""}`);
	if (expect.outcome === "refused" && actual.outcome === "refused" && actual.code !== expect.code) {
		notes.push(`expected code ${expect.code}, got ${actual.code}`);
	}
	if (expect.shape && actual.shape && actual.shape !== expect.shape) notes.push(`expected ${expect.shape} shape, got ${actual.shape}`);
	if (expect.edges && actual.edges && stableEdges(actual.edges) !== stableEdges(expect.edges)) {
		notes.push(`expected edges ${stableEdges(expect.edges)}, got ${stableEdges(actual.edges)}`);
	}
	if (Number.isInteger(expect.subtasks) && actual.subtasks !== expect.subtasks) {
		notes.push(`expected ${expect.subtasks} subtasks, got ${actual.subtasks}`);
	}
	return {
		name: testCase.name,
		family: testCase.family,
		expect,
		actual,
		pass: notes.length === 0,
		notes: notes.join("; ") || `${actual.outcome}${actual.code ? ` ${actual.code}` : ""}`,
	};
}

/**
 * The three structural rates, over the manifest's own denominators. None of them
 * says a Decomposition is good: they say the gate read it as the fixture declares.
 */
export function decompositionStructureReport(rows) {
	const controls = rows.filter((row) => row.expect.outcome === "admitted");
	const defects = rows.filter((row) => row.expect.outcome === "refused");
	const edgeRows = controls.filter((row) => Object.keys(row.expect.edges ?? {}).length > 0);
	const admitted = controls.filter((row) => row.actual.outcome === "admitted");
	const falselyRefused = controls.filter((row) => row.actual.outcome === "refused");
	const refusedWithExpectedCode = defects.filter((row) => row.actual.code === row.expect.code);
	const families = [...new Set(rows.map((row) => row.family))].sort().map((family) => {
		const inFamily = rows.filter((row) => row.family === family);
		return { family, cases: inFamily.length, passed: inFamily.filter((row) => row.pass).length };
	});
	return {
		total: rows.length,
		passed: rows.filter((row) => row.pass).length,
		failed: rows.filter((row) => !row.pass),
		admission: { controls: controls.length, admitted: admitted.length, rate: controls.length === 0 ? 0 : admitted.length / controls.length },
		falseRefusal: { controls: controls.length, refused: falselyRefused.length, rate: controls.length === 0 ? 0 : falselyRefused.length / controls.length },
		edges: { cases: edgeRows.length, correct: edgeRows.filter((row) => row.pass).length },
		refusal: {
			defects: defects.length,
			expectedCode: refusedWithExpectedCode.length,
			wrongCode: defects.filter((row) => row.actual.outcome === "refused" && row.actual.code !== row.expect.code).length,
			notRefused: defects.filter((row) => row.actual.outcome !== "refused").length,
		},
		families,
	};
}

const percent = (rate) => `${(rate * 100).toFixed(1)}%`;

export function formatDecompositionStructureReport(report) {
	const lines = [
		"",
		`admission rate         ${report.admission.admitted}/${report.admission.controls} well-formed Decompositions admitted (${percent(report.admission.rate)})`,
		`false-refusal rate     ${report.falseRefusal.refused}/${report.falseRefusal.controls} defect-free controls refused (${percent(report.falseRefusal.rate)})`,
		`dependency-edge usage  ${report.edges.correct}/${report.edges.cases} structured cases parsed to the expected edge set`,
		`refusal correctness    ${report.refusal.expectedCode}/${report.refusal.defects} seeded defects refused with the expected code`
			+ ` (${report.refusal.wrongCode} wrong code, ${report.refusal.notRefused} not refused)`,
		"",
		"family                 cases  passed",
	];
	for (const family of report.families) {
		lines.push(`${family.family.padEnd(22)} ${String(family.cases).padStart(5)}  ${String(family.passed).padStart(6)}`);
	}
	lines.push("", `${report.passed}/${report.total} structural cases matched the shipped Decomposition gate`);
	return lines.join("\n");
}

/** The gate: any mismatched case fails the run. */
export function decompositionStructureExitCode(report) {
	return report.failed.length === 0 ? 0 : 1;
}

export function runDecompositionStructureEval({ filter = null } = {}) {
	const selected = filter ? DECOMPOSITION_CASES.filter((testCase) => testCase.name.includes(filter)) : DECOMPOSITION_CASES;
	return { selected, rows: selected.map((testCase) => scoreDecompositionCase(testCase)) };
}

function main() {
	const filterFlag = process.argv.find((arg) => arg.startsWith("--filter="));
	const filter = filterFlag ? filterFlag.slice("--filter=".length) : null;

	const issues = validateDecompositionCases(DECOMPOSITION_CASES);
	if (issues.length > 0) {
		for (const issue of issues) console.error(`✗ decomposition case manifest: ${issue}`);
		process.exit(2);
	}

	const { selected, rows } = runDecompositionStructureEval({ filter });
	if (selected.length === 0) {
		console.error(`No decomposition cases match --filter=${filter}. Available: ${DECOMPOSITION_CASES.map((testCase) => testCase.name).join(", ")}`);
		process.exit(2);
	}

	console.log(`pi-flows Decomposition structure eval - ${selected.length} seeded cases - deterministic, no model\n`);
	for (const row of rows) console.log(`${row.pass ? "PASS" : "FAIL"} ${row.name.padEnd(42)} ${row.family.padEnd(20)} ${row.notes}`);
	const report = decompositionStructureReport(rows);
	console.log(formatDecompositionStructureReport(report));
	process.exit(decompositionStructureExitCode(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
