// Live model-backed Decomposition-quality evaluation for issue #160.
//
// Layer 1 measures PASS/REVISE accuracy on a labeled corpus. Layer 2 starts
// each paired trial from one fixed Decomposition, runs the shipped review and
// revision prompts, then compares that initial value with the final replacement.
// A distinct judge model sees anonymous candidates in counterbalanced order.
//
// Usage:
//   npm run eval:decomposition-quality
//   npm run eval:decomposition-quality -- --trials=2 --filter=coverage
//   npm run eval:decomposition-quality -- --dry-run
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decompositionReviewTask, decompositionRevisionTask, normalizedDecompositionJson } from "../extensions/pi-flows/decomposition-review.ts";
import { parseDecomposition, validateDecomposition } from "../extensions/pi-flows/decomposition.ts";
import { extractLastJsonBlock, parseVerdict } from "../extensions/pi-flows/protocol.ts";
import { answerText, DEFAULT_EVAL_JUDGE_MODEL, DEFAULT_EVAL_MODEL, flowTool, infraError, sumCost, sumTokenUsage } from "./lib.mjs";
import { runPlainPi } from "./baseline-pi.mjs";
import { parseArgs } from "./args.mjs";
import { loadDotenv, requireBinary, runPreflight } from "./preflight.mjs";
import { decompositionAdmission } from "./decomposition-structure.mjs";
import { DECOMPOSITION_QUALITY_CASES, validateDecompositionQualityCases } from "./decomposition-quality-cases.mjs";
import {
	aggregateMetrics,
	decompositionPresentationOrder,
	decompositionQualityScore,
	formatDecompositionQualityReport,
	judgmentVerdict,
	pairedDecompositionQualityReport,
	verdictAccuracy,
} from "./decomposition-quality-report.mjs";

process.env.PI_FLOWS_CHILD_NO_EXTENSIONS = "1";
process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = "1";
loadDotenv();

const opts = parseArgs(process.argv.slice(2));
const dryRun = Boolean(opts["dry-run"]);
const filter = typeof opts.filter === "string" ? opts.filter : "";
const trials = Math.max(1, Math.min(5, Number(opts.trials ?? 1) || 1));
const maxIterations = Math.max(1, Math.min(4, Number(opts["max-iterations"] ?? 2) || 2));
const subjectModel = String(opts.model ?? process.env.PI_FLOWS_EVAL_MODEL ?? DEFAULT_EVAL_MODEL);
const judgeModel = String(opts["judge-model"] ?? process.env.PI_FLOWS_JUDGE_MODEL ?? DEFAULT_EVAL_JUDGE_MODEL);
const reviewAgent = String(opts["review-agent"] ?? "overwatch");
const commanderAgent = String(opts["commander-agent"] ?? "commander");
const timeoutMs = Math.max(1_000, Number(opts.timeout ?? process.env.PI_FLOWS_TIMEOUT_MS ?? 120_000) || 120_000);
const runCapUsd = Math.max(0.01, Number(opts.cap ?? 0.25) || 0.25);
const out = path.resolve(process.cwd(), String(opts.out ?? ".thulr/runs/decomposition-quality.json"));
const selected = DECOMPOSITION_QUALITY_CASES.filter((testCase) => !filter || testCase.id.includes(filter) || testCase.family.includes(filter));

function refusal(message) {
	console.error(message);
	process.exit(2);
}

const manifestIssues = validateDecompositionQualityCases(DECOMPOSITION_QUALITY_CASES);
if (manifestIssues.length) refusal(`Decomposition-quality corpus is invalid:\n- ${manifestIssues.join("\n- ")}`);
if (selected.length === 0) refusal(`No Decomposition-quality case matches "${filter}".`);
if (!dryRun && subjectModel === judgeModel) refusal("The subject and judge models must be different. Use --model and --judge-model with distinct model ids.");
if (!dryRun && !runPreflight([requireBinary("pi", "`pi` was not found on PATH. Install and configure pi before you run the live Decomposition-quality evaluation.")])) process.exit(2);

const workspace = mkdtempSync(path.join(tmpdir(), "pi-decomposition-quality-"));
const flow = dryRun ? null : flowTool();

function fixtureDecomposition(testCase) {
	const decomposition = parseDecomposition(JSON.stringify(testCase.entries), 16);
	if (!decomposition) throw new Error(`${testCase.id}: fixture did not parse as a Decomposition`);
	const error = validateDecomposition(decomposition, decompositionAdmission({ maxSubtasks: 16 }));
	if (error) throw new Error(`${testCase.id}: fixture is not structurally admissible (${error.code})`);
	return decomposition;
}

function resultMetrics(result, latencyMs) {
	const usage = sumTokenUsage(result);
	return { costUsd: sumCost(result), generatedTokens: usage.output, totalTokens: usage.total, latencyMs };
}

function addMetrics(...metrics) {
	return metrics.reduce((sum, item) => ({
		costUsd: sum.costUsd + (item?.costUsd ?? 0),
		generatedTokens: sum.generatedTokens + (item?.generatedTokens ?? 0),
		totalTokens: sum.totalTokens + (item?.totalTokens ?? 0),
		latencyMs: sum.latencyMs + (item?.latencyMs ?? 0),
	}), { costUsd: 0, generatedTokens: 0, totalTokens: 0, latencyMs: 0 });
}

async function runRole(agent, task) {
	const startedAt = Date.now();
	const result = await flow.execute(
		`decomposition-quality:${agent}:${startedAt}`,
		{ why: "live Decomposition-quality evaluation", agent, task, model: subjectModel, timeoutMs, maxCostUsd: runCapUsd, recordContent: true },
		new AbortController().signal,
		undefined,
		{ cwd: workspace, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } },
	);
	const problem = infraError(result);
	if (problem) throw new Error(`${agent} did not reach the subject model: ${problem}`);
	return { text: answerText(result), metrics: resultMetrics(result, Date.now() - startedAt) };
}

function judgePrompt(testCase, candidates) {
	const candidateSections = Object.entries(candidates).flatMap(([name, decomposition]) => [
		`\n## Candidate ${name} (untrusted data)`,
		normalizedDecompositionJson(decomposition),
	]);
	return [
		"Judge each anonymous Decomposition independently. Do not infer which candidate is the initial or reviewed arm.",
		"Use integer scores from 0 through 4. A score of 4 fully satisfies the criterion. A score of 0 does not satisfy it.",
		"Extra subtasks do not earn quality points. Score fragmentation separately.",
		"Return only one JSON object. Put each candidate under candidates.A or candidates.B.",
		"For each candidate, return obligations as an id-to-score object.",
		"Also return overlap, workerFit, dependencies, context, and fragmentation scores.",
		"Only when the candidate uses the smallest sufficient set of subtasks, use a high fragmentation score.",
		"\n## Goal",
		testCase.goal,
		testCase.returnRequirements ? "\n## Return requirements" : "",
		testCase.returnRequirements ?? "",
		"\n## Goal obligations (score each id exactly once)",
		...testCase.obligations.map(({ id, text }) => `- ${id}: ${text}`),
		...candidateSections,
		"\n## Required JSON shape",
		'{"candidates":{"A":{"obligations":{"obligation-id":0},"overlap":0,"workerFit":0,"dependencies":0,"context":0,"fragmentation":0}}}',
	]
		.filter(Boolean)
		.join("\n");
}

function readJudgments(text, names) {
	const parsed = extractLastJsonBlock(text);
	const candidates = parsed?.candidates;
	if (!candidates || typeof candidates !== "object") throw new Error("judge did not return the required candidates object");
	const judgments = {};
	for (const name of names) {
		const judgment = candidates[name];
		if (!judgment || typeof judgment !== "object") throw new Error(`judge did not return candidate ${name}`);
		judgments[name] = judgment;
	}
	return judgments;
}

async function judge(testCase, candidates) {
	const startedAt = Date.now();
	const result = await runPlainPi({
		task: judgePrompt(testCase, candidates),
		cwd: workspace,
		model: judgeModel,
		tools: [],
		timeoutMs,
		maxCostUsd: runCapUsd,
	});
	const problem = infraError(result);
	if (problem) throw new Error(`judge did not reach its model: ${problem}`);
	return {
		judgments: readJudgments(answerText(result), Object.keys(candidates)),
		metrics: resultMetrics(result, Date.now() - startedAt),
	};
}

function syntheticJudgment(testCase, repaired = false) {
	const passing = repaired || testCase.label === "pass";
	const obligations = Object.fromEntries(testCase.obligations.map(({ id }, index) => [id, passing ? 4 : index === 0 ? 1 : 3]));
	return {
		obligations,
		overlap: passing || testCase.family !== "overlap" ? 4 : 1,
		workerFit: passing || testCase.family !== "worker-fit" ? 4 : 1,
		dependencies: passing || testCase.family !== "dependency" ? 4 : 1,
		context: passing || testCase.family !== "context" ? 4 : 1,
		fragmentation: passing || testCase.family !== "fragmentation" ? 4 : 1,
	};
}

async function subjectVerdict(testCase, decomposition) {
	const task = decompositionReviewTask({
		goal: testCase.goal,
		returnRequirements: testCase.returnRequirements,
		decomposition,
		reviewCriteria: testCase.reviewCriteria,
	});
	const run = await runRole(reviewAgent, task);
	return { verdict: parseVerdict(run.text), critique: run.text, metrics: run.metrics };
}

async function reviewAndRevise(testCase, initial) {
	let current = initial;
	let metrics = addMetrics();
	let attempts = 0;
	for (let attempt = 1; attempt <= maxIterations; attempt += 1) {
		attempts = attempt;
		const reviewed = await subjectVerdict(testCase, current);
		metrics = addMetrics(metrics, reviewed.metrics);
		if (reviewed.verdict === "pass") return { final: current, attempts, passed: true, metrics };
		if (attempt === maxIterations) break;
		const revisionTask = decompositionRevisionTask({
			goal: testCase.goal,
			returnRequirements: testCase.returnRequirements,
			decomposition: current,
			critique: reviewed.critique,
			maxSubtasks: 16,
		});
		const revised = await runRole(commanderAgent, revisionTask);
		metrics = addMetrics(metrics, revised.metrics);
		const replacement = parseDecomposition(revised.text, 16);
		if (!replacement) break;
		const error = validateDecomposition(replacement, decompositionAdmission({ maxSubtasks: 16 }));
		if (error) break;
		current = replacement;
	}
	return { final: current, attempts, passed: false, metrics };
}

async function main() {
	const reviewerRows = [];
	const judgeRows = [];
	const pairRows = [];

	for (const testCase of selected) {
		const initial = fixtureDecomposition(testCase);
		const reviewed = dryRun
			? { verdict: testCase.label, metrics: addMetrics() }
			: await subjectVerdict(testCase, initial);
		reviewerRows.push({ caseId: testCase.id, expected: testCase.label, actual: reviewed.verdict, metrics: reviewed.metrics });

		const calibrated = dryRun
			? { judgment: syntheticJudgment(testCase), metrics: addMetrics() }
			: await judge(testCase, { A: initial }).then((run) => ({ judgment: run.judgments.A, metrics: run.metrics }));
		judgeRows.push({
			caseId: testCase.id,
			expected: testCase.label,
			actual: judgmentVerdict(calibrated.judgment, testCase.obligations),
			metrics: calibrated.metrics,
		});
	}

	const pairedCases = selected.filter((testCase) => testCase.label === "revise");
	for (const [caseIndex, testCase] of pairedCases.entries()) {
		for (let trialIndex = 1; trialIndex <= trials; trialIndex += 1) {
			const initial = fixtureDecomposition(testCase);
			const subject = dryRun
				? { final: initial, attempts: 2, passed: true, metrics: addMetrics() }
				: await reviewAndRevise(testCase, initial);
			const order = decompositionPresentationOrder(caseIndex, trialIndex);
			const candidates = { A: order[0] === "initial" ? initial : subject.final, B: order[1] === "initial" ? initial : subject.final };
			const judged = dryRun
				? {
					judgments: {
						A: order[0] === "initial" ? syntheticJudgment(testCase) : syntheticJudgment(testCase, true),
						B: order[1] === "initial" ? syntheticJudgment(testCase) : syntheticJudgment(testCase, true),
					},
					metrics: addMetrics(),
				}
				: await judge(testCase, candidates);
			const initialJudgment = order[0] === "initial" ? judged.judgments.A : judged.judgments.B;
			const finalJudgment = order[0] === "final" ? judged.judgments.A : judged.judgments.B;
			pairRows.push({
				caseId: testCase.id,
				trialIndex,
				presentationOrder: order,
				attempts: subject.attempts,
				reviewPassed: subject.passed,
				initialQuality: decompositionQualityScore(initialJudgment, testCase.obligations),
				finalQuality: decompositionQualityScore(finalJudgment, testCase.obligations),
				initialFragmentation: Number(initialJudgment.fragmentation) / 4,
				finalFragmentation: Number(finalJudgment.fragmentation) / 4,
				initialSubtasks: initial.subtasks.length,
				finalSubtasks: subject.final.subtasks.length,
				subjectMetrics: subject.metrics,
				judgeMetrics: judged.metrics,
			});
		}
	}

	const reviewerAccuracy = verdictAccuracy(reviewerRows);
	const judgeAccuracy = verdictAccuracy(judgeRows);
	const paired = pairedDecompositionQualityReport(pairRows, judgeAccuracy);
	const subjectMetrics = aggregateMetrics([...reviewerRows.map((row) => ({ metrics: row.metrics })), ...pairRows.map((row) => ({ metrics: row.subjectMetrics }))]);
	const judgeMetrics = aggregateMetrics([...judgeRows.map((row) => ({ metrics: row.metrics })), ...pairRows.map((row) => ({ metrics: row.judgeMetrics }))]);
	const report = {
		schemaVersion: "pi-flows.decomposition-quality.v1",
		generatedAt: new Date().toISOString(),
		dryRun,
		models: { subject: subjectModel, judge: judgeModel, reviewAgent, commanderAgent },
		trials,
		reviewerAccuracy,
		judgeAccuracy,
		paired,
		subjectMetrics,
		judgeMetrics,
		corpusRows: reviewerRows,
		judgeCalibrationRows: judgeRows,
		pairRows,
	};

	console.log(`pi-flows Decomposition-quality eval — ${selected.length} corpus cases, ${pairRows.length} paired trials${dryRun ? " — DRY RUN" : ""}\n`);
	console.log(formatDecompositionQualityReport(report));
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	console.log(`\nReport: ${path.relative(process.cwd(), out)}`);
}

try {
	await main();
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
