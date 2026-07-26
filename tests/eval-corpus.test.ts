import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { corpusPreflightStep, formatPortfolioReport, portfolioReport, validateCaseCorpus } from "../evals/case-contract.mjs";
import { EVAL_CORPUS } from "../evals/corpus.mjs";
import { runPreflight } from "../evals/preflight.mjs";

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

	const cases = ["measurement", "calibration", "selection"].flatMap((group) => EVAL_CORPUS[group]);
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
	const ok = runPreflight([
		corpusPreflightStep(corpus, { repoRoot, onValid: () => undefined }),
		() => {
			modelCalls += 1;
			return null;
		},
	], { log: (message) => errors.push(message) });
	assert.equal(ok, false);
	assert.equal(modelCalls, 0);
	assert.match(errors.join("\n"), /Eval corpus preflight failed/);
});

test("fixture snapshots reject drift anywhere in the source corpus", async () => {
	const repoRoot = await mkdtemp(path.join(tmpdir(), "pi-flow-fixtures-"));
	const fixtures = path.join(repoRoot, "evals", "fixtures");
	await mkdir(fixtures, { recursive: true });
	await writeFile(path.join(fixtures, "settings.txt"), "SAMPLE_IDENTIFIER=changed\n");
	const corpus = {
		measurement: [evalCase()],
		calibration: [],
		selection: [],
		sourceSnapshots: [{
			id: "eval-fixtures",
			path: "evals/fixtures",
			sha256: "0000000000000000000000000000000000000000000000000000000000000000",
		}],
	};

	const validation = validateCaseCorpus(corpus, { repoRoot });
	assert.match(validation.issues.join("\n"), /source snapshot eval-fixtures is stale/);
});

test("fixture snapshots canonicalize CRLF checkouts before hashing", async () => {
	const repoRoot = await mkdtemp(path.join(tmpdir(), "pi-flow-crlf-fixtures-"));
	const fixtures = path.join(repoRoot, "evals", "fixtures");
	await mkdir(fixtures, { recursive: true });
	await writeFile(path.join(fixtures, "sample.txt"), "first\r\nsecond\r\n");
	const digest = createHash("sha256")
		.update("sample.txt")
		.update("\0")
		.update("first\nsecond\n")
		.update("\0")
		.digest("hex");
	const corpus = {
		measurement: [evalCase()],
		calibration: [],
		selection: [],
		sourceSnapshots: [{ id: "eval-fixtures", path: "evals/fixtures", sha256: digest }],
	};

	assert.deepEqual(validateCaseCorpus(corpus, { repoRoot }).issues, []);
});

test("agent validation accepts CRLF checkouts", async () => {
	const repoRoot = await mkdtemp(path.join(tmpdir(), "pi-flow-crlf-agents-"));
	await mkdir(path.join(repoRoot, "agents"), { recursive: true });
	await writeFile(
		path.join(repoRoot, "agents", "analyst.md"),
		"---\r\nname: analyst\r\ndescription: Analyze evidence\r\ntier: capable\r\n---\r\n\r\nPrompt\r\n",
	);
	const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "..", "scripts", "validate-agents.mjs")], {
		cwd: repoRoot,
		encoding: "utf8",
	});

	assert.equal(run.status, 0, run.stderr);
	assert.match(run.stdout, /agents ok: 1 bundled agents/);
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
		["evals/run.mjs", "--dry-run", "--trace-only", "--filter=route-classifies"],
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
		assert.match(`${run.stdout}\n${run.stderr}`, /suite: regression 1 \(0 excluded\)/, script);
	}
});
