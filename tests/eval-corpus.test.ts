import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatPortfolioReport, portfolioReport, runCorpusPreflight, validateCaseCorpus } from "../evals/case-contract.mjs";
import { EVAL_CORPUS } from "../evals/corpus.mjs";

const structure = {
	decomposability: "atomic",
	dependencyDepth: 0,
	sharedState: "none",
	risk: "low",
	reversibility: "not-applicable",
};

function evalCase(overrides = {}) {
	const testCase = {
		name: "valid-case",
		suite: "representative",
		taskFamily: "direct-answer",
		structure,
		...overrides,
	};
	return { ...testCase, id: testCase.name };
}

test("the checked-in eval corpus has unique stable ids and complete structural metadata", () => {
	const validation = validateCaseCorpus(EVAL_CORPUS);
	assert.deepEqual(validation.issues, []);

	const cases = Object.values(EVAL_CORPUS).flat();
	assert.ok(cases.length > 0);
	assert.equal(new Set(cases.map((testCase) => testCase.name)).size, cases.length);
	for (const testCase of cases) {
		assert.equal(typeof testCase.suite, "string", testCase.name);
		assert.equal(typeof testCase.taskFamily, "string", testCase.name);
		assert.equal(typeof testCase.structure?.dependencyDepth, "number", testCase.name);
	}
});

test("corpus validation rejects malformed portfolio and task-structure metadata", () => {
	const validation = validateCaseCorpus({
		measurement: [
			evalCase({
				suite: "smoke",
				taskFamily: "",
				structure: { ...structure, dependencyDepth: -1, sharedState: "sometimes" },
			}),
		],
		calibration: [],
		selection: [],
	});

	assert.match(validation.issues.join("\n"), /suite/);
	assert.match(validation.issues.join("\n"), /taskFamily/);
	assert.match(validation.issues.join("\n"), /dependencyDepth/);
	assert.match(validation.issues.join("\n"), /sharedState/);
});

test("source-backed expectations fail preflight when the workspace value drifts", async () => {
	const repoRoot = await mkdtemp(path.join(tmpdir(), "pi-flow-corpus-"));
	await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ version: "1.2.3" }));
	const stale = evalCase({
		name: "stale-version",
		answerPattern: "\\b0\\.3\\.0\\b",
		mock: { answer: "0.3.0" },
		sourceExpectation: {
			path: "package.json",
			jsonPath: ["version"],
			expectedPath: ["mock", "answer"],
			patternPath: ["answerPattern"],
		},
	});
	const corpus = { measurement: [], calibration: [], selection: [stale] };
	const validation = validateCaseCorpus(corpus, { repoRoot });

	assert.match(validation.issues.join("\n"), /stale-version/);
	assert.match(validation.issues.join("\n"), /1\.2\.3/);
	assert.match(validation.issues.join("\n"), /0\.3\.0/);

	let modelCalls = 0;
	const errors = [];
	const ok = runCorpusPreflight(corpus, { repoRoot, log: (message) => errors.push(message) });
	if (ok) modelCalls += 1;
	assert.equal(ok, false);
	assert.equal(modelCalls, 0);
	assert.match(errors.join("\n"), /Eval corpus preflight failed/);
});

test("portfolio reports count cases and exclusions by suite and task family", () => {
	const cases = [
		evalCase({ name: "one", suite: "representative", taskFamily: "lookup" }),
		evalCase({ name: "two", suite: "representative", taskFamily: "lookup" }),
		evalCase({ name: "three", suite: "adversarial", taskFamily: "decision" }),
	];
	const report = portfolioReport(cases, { excluded: ["two", "three"] });

	assert.deepEqual(report.bySuite, {
		adversarial: { cases: 1, excluded: 1 },
		representative: { cases: 2, excluded: 1 },
	});
	assert.deepEqual(report.byTaskFamily, {
		decision: { cases: 1, excluded: 1 },
		lookup: { cases: 2, excluded: 1 },
	});
	assert.match(formatPortfolioReport(report), /suite.*adversarial 1 \(1 excluded\).*representative 2 \(1 excluded\)/s);
	assert.match(formatPortfolioReport(report), /task family.*decision 1 \(1 excluded\).*lookup 2 \(1 excluded\)/s);
});

test("eval, comparison, and selection dry-runs execute the shared corpus preflight", () => {
	const commands = [
		["evals/run.mjs", "--dry-run", "--filter=route-classifies"],
		["evals/compare.mjs", "--dry-run", "--filter=route-classifies"],
		["evals/select.mjs", "--dry-run", "--filter=package-version"],
	];
	for (const [script, ...args] of commands) {
		const run = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
			cwd: path.resolve(import.meta.dirname, ".."),
			encoding: "utf8",
		});
		assert.equal(run.status, 0, `${script}\n${run.stderr}\n${run.stdout}`);
		assert.match(`${run.stdout}\n${run.stderr}`, /Eval corpus:/, script);
	}
});
