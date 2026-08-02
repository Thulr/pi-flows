import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPlainPi } from "../evals/baseline-pi.mjs";
import { armExecutionTiming, buildPairedAnalysis, evaluatePairConstraint, pairedArmOrder, studentTCritical95 } from "../evals/paired-experiment.mjs";
import { pairedCaseWorkspaces } from "../evals/paired-workspace.mjs";
import { comparisonTotals, formatCostComparison } from "../evals/compare-report.mjs";

function runCompare(...args: string[]) {
	return spawnSync(process.execPath, ["--import", "tsx", "evals/compare.mjs", "--dry-run", "--filter=route-classifies", ...args], {
		cwd: process.cwd(),
		encoding: "utf8",
	});
}

test("comparison CLI requires a positive binding constraint and one promotion rule", () => {
	const invalidConstraint = runCompare("--constraint=cost:0");
	assert.equal(invalidConstraint.status, 2);
	assert.match(invalidConstraint.stderr, /--constraint must be cost\|generated_tokens\|deadline:<positive value>/);

	const conflictingMargins = runCompare(
		"--constraint=deadline:90000",
		"--improvement-margin=0.05",
		"--non-inferiority-margin=0.02",
	);
	assert.equal(conflictingMargins.status, 2);
	assert.match(conflictingMargins.stderr, /choose only one promotion margin/);

	const conflictingConstraints = runCompare("--constraint=deadline:120000", "--cap=0.50");
	assert.equal(conflictingConstraints.status, 2);
	assert.match(conflictingConstraints.stderr, /choose exactly one binding constraint/);
});

test("comparison CLI requires an explicit shared model and a baseline that can enforce the constraint", () => {
	const agentModel = runCompare("--model=agent");
	assert.equal(agentModel.status, 2);
	assert.match(agentModel.stderr, /requires an explicit model/);

	const unsupportedCodexBudget = runCompare("--constraint=generated_tokens:100");
	assert.equal(unsupportedCodexBudget.status, 2);
	assert.match(unsupportedCodexBudget.stderr, /requires --baseline=pi/);
});

test("comparison CLI writes paired repeated trials with stable identities and snapshots", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "pi-flow-paired-compare-"));
	const artifactPath = path.join(outputDir, "comparison.json");
	const run = runCompare(
		"--constraint=deadline:90000",
		"--trials=2",
		`--write=${artifactPath}`,
	);

	assert.equal(run.status, 0, run.stderr);
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
	assert.equal(artifact.schemaVersion, "pi-flows.paired-comparison.v1");
	assert.equal(typeof artifact.runId, "string");
	assert.ok(artifact.runId.length > 0);
	assert.equal(artifact.runtimeTraceFile, ".thulr/runs/ab-runtime.dry-run.trace.jsonl");
	assert.deepEqual(artifact.constraint, { kind: "deadline", value: 90000, unit: "ms", source: "cli" });
	assert.equal(artifact.subjectTrials, 2);
	assert.equal(artifact.rawRows.length, 2);
	assert.equal(artifact.analysis.overall.quality.method, "case-clustered paired mean with 95% t interval");
	assert.equal(artifact.analysis.overall.reliability.analysis, "case-clustered paired binary sign test");
	assert.equal(artifact.analysis.slices.bySuite.regression.quality.pairedRows, 2);
	assert.equal(artifact.analysis.slices.byTaskFamily.routing.quality.pairedRows, 2);
	assert.equal(artifact.analysis.promotion.decision, "not_requested");
	assert.deepEqual(artifact.rawRows.map((row) => row.trialIndex), [1, 2]);
	assert.deepEqual(artifact.rawRows.map((row) => row.caseId), ["route-classifies-bug-to-recon", "route-classifies-bug-to-recon"]);
	assert.notEqual(artifact.rawRows[0].trialId, artifact.rawRows[1].trialId);
	assert.deepEqual(artifact.rawRows.map((row) => row.armOrder), [
		["flows", "baseline"],
		["baseline", "flows"],
	]);
	for (const row of artifact.rawRows) {
		assert.equal(row.flows.task, row.baseline.task);
		assert.equal(row.flows.model, row.baseline.model);
		assert.equal(row.flows.workspaceSnapshotId, row.baseline.workspaceSnapshotId);
		assert.equal(row.flows.timeoutMs, 90000);
		assert.equal(row.baseline.timeoutMs, 90000);
		assert.equal(row.flows.runtimeTrace.context.runId, artifact.runId);
		assert.equal(row.baseline.runtimeTrace.context.runId, artifact.runId);
		assert.equal(row.flows.runtimeTrace.context.trialId, row.trialId);
		assert.equal(row.baseline.runtimeTrace.context.trialId, row.trialId);
		assert.notEqual(row.flows.runtimeTrace.context.arm, row.baseline.runtimeTrace.context.arm);
		assert.equal(row.flows.runtimeTrace.health, "missing");
		assert.equal(row.baseline.runtimeTrace.health, "missing");
		assert.equal(row.flows.scoreFamilies.traceHealth.pass, false);
		assert.equal(row.baseline.scoreFamilies.traceHealth.pass, false);
	}
});

test("comparison CLI records named topologies, configuration identity, and component lift", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "pi-flow-experiment-arms-"));
	const artifactPath = path.join(outputDir, "comparison.json");
	const run = runCompare(
		"--constraint=deadline:90000",
		"--arms=random-routing,oracle-routing",
		`--write=${artifactPath}`,
	);

	assert.equal(run.status, 0, run.stderr);
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
	assert.equal(artifact.arms.reference.name, "random-routing");
	assert.equal(artifact.arms.candidate.name, "oracle-routing");
	assert.equal(artifact.analysis.ablation.component, "routing");
	const row = artifact.rawRows[0];
	assert.deepEqual(new Set(row.armOrder), new Set(["random-routing", "oracle-routing"]));
	assert.equal(row.baseline.arm.topology, "random-routing");
	assert.equal(row.flows.arm.topology, "oracle-routing");
	assert.match(row.flows.arm.configurationIdentity, /deadline:90000/);
	assert.ok(row.flows.evidence.answer.length > 0);
});

test("comparison CLI excludes inapplicable named arms with a durable reason", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "pi-flow-inapplicable-arm-"));
	const artifactPath = path.join(outputDir, "comparison.json");
	const run = runCompare(
		"--constraint=deadline:90000",
		"--arms=full,no-integrator",
		`--write=${artifactPath}`,
	);

	assert.equal(run.status, 0, run.stderr);
	const row = JSON.parse(readFileSync(artifactPath, "utf8")).rawRows[0];
	assert.equal(row.comparable, false);
	assert.equal(row.flows.excluded.reason, "inapplicable");
	assert.match(row.flows.excluded.detail, /does not apply/);
});

test("comparison CLI binds eligibility to the declared constraint and retains other outcomes", () => {
	const outputDir = mkdtempSync(path.join(tmpdir(), "pi-flow-paired-constraint-"));
	const artifactPath = path.join(outputDir, "comparison.json");
	const run = runCompare(
		"--baseline=pi",
		"--constraint=generated_tokens:100",
		`--write=${artifactPath}`,
	);

	assert.equal(run.status, 0, run.stderr);
	const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
	const row = artifact.rawRows[0];
	assert.equal(row.comparable, false);
	assert.equal(row.constraint.pairEligible, false);
	assert.equal(row.constraint.flows.status, "unknown");
	assert.equal(row.constraint.baseline.status, "unknown");
	for (const arm of [row.flows, row.baseline]) {
		assert.equal(typeof arm.cost, "number");
		assert.equal(typeof arm.tokens.total, "number");
		assert.equal(typeof arm.durationMs, "number");
		assert.equal(typeof arm.workerTimeMs, "number");
	}
});

test("paired analysis clusters trials by case, slices results, and applies predeclared margins", () => {
	const rawRows = [
		pairedRow("case-a", 1, { suite: "representative", taskFamily: "lookup", flowsScore: 0.9, baselineScore: 0.6, flowsPass: true, baselinePass: false }),
		pairedRow("case-a", 2, { suite: "representative", taskFamily: "lookup", flowsScore: 0.7, baselineScore: 0.6, flowsPass: true, baselinePass: true }),
		pairedRow("case-b", 1, { suite: "hard", taskFamily: "coding", flowsScore: 0.8, baselineScore: 0.7, flowsPass: false, baselinePass: true }),
		pairedRow("case-b", 2, { suite: "hard", taskFamily: "coding", flowsScore: 0.9, baselineScore: 0.7, flowsPass: true, baselinePass: true }),
		{ ...pairedRow("case-b", 3, { suite: "hard", taskFamily: "coding", flowsScore: 1, baselineScore: 0 }), comparable: false },
	];

	const improvement = buildPairedAnalysis(rawRows, { kind: "improvement", margin: 0.05 });
	assert.equal(improvement.overall.quality.caseClusters, 2);
	assert.equal(improvement.overall.quality.pairedRows, 4);
	assert.equal(improvement.overall.quality.meanDelta, 0.175);
	assert.ok(Number.isFinite(improvement.overall.quality.confidence95.lower));
	assert.deepEqual(improvement.overall.reliability.caseSignTest, {
		flowsFavoredCases: 1,
		baselineFavoredCases: 1,
		tiedCases: 0,
		nonTiedCases: 2,
		exactTwoSidedP: 1,
	});
	assert.equal(improvement.slices.bySuite.representative.quality.pairedRows, 2);
	assert.equal(improvement.slices.byTaskFamily.coding.quality.pairedRows, 2);
	assert.equal(improvement.invalidRuns.pairs, 1);
	assert.equal(improvement.promotion.rule.kind, "improvement");
	assert.equal(improvement.promotion.threshold, 0.05);

	const nonInferiority = buildPairedAnalysis(rawRows, { kind: "non_inferiority", margin: 0.1 });
	assert.equal(nonInferiority.promotion.threshold, -0.1);
});

test("paired analysis retains invalid executions for finite resource deltas only", () => {
	const infraBase = pairedRow("case-b", 1, { suite: "hard", taskFamily: "coding", flowsScore: 1, baselineScore: 0 });
	const constraintInvalid = {
		...pairedRow("case-a", 1, { suite: "hard", taskFamily: "coding", flowsScore: 1, baselineScore: 0 }),
		comparable: false,
		constraint: {
			pairEligible: false,
			flows: { status: "exceeded" },
			baseline: { status: "within" },
		},
	};
	const infraInvalid = {
		...infraBase,
		comparable: false,
		flows: {
			...infraBase.flows,
			excluded: { reason: "infra", detail: "provider failed after reporting usage" },
		},
	};

	const analysis = buildPairedAnalysis([constraintInvalid, infraInvalid]);
	assert.equal(analysis.overall.quality.pairedRows, 0);
	assert.equal(analysis.overall.reliability.pairedRows, 0);
	assert.equal(analysis.overall.costUsd.pairedRows, 2);
	assert.equal(analysis.overall.generatedTokens.pairedRows, 2);
	assert.equal(analysis.overall.totalTokens.pairedRows, 2);
	assert.equal(analysis.overall.endToEndLatencyMs.pairedRows, 2);
	assert.equal(analysis.overall.workerTimeMs.pairedRows, 2);
});

test("budget-stopped arms are ineligible at the exact declared ceiling", () => {
	const flows = {
		cost: 1,
		costKnown: true,
		exclusion: null,
		result: {
			details: {
				results: [{ stopReason: "budget_exceeded", error: { code: "BUDGET_EXCEEDED" } }],
			},
		},
	};
	const baseline = { cost: 0.5, costKnown: true, exclusion: null, result: { details: { results: [] } } };

	const evaluated = evaluatePairConstraint(flows, baseline, { kind: "cost", value: 1, unit: "USD" });
	assert.equal(evaluated.flows.observed, 1);
	assert.equal(evaluated.flows.status, "stopped");
	assert.equal(evaluated.baseline.status, "within");
	assert.equal(evaluated.pairEligible, false);
});

test("paired binary inference counts cases rather than repeated trials", () => {
	const repeated = [
		...Array.from({ length: 20 }, (_, index) => pairedRow("case-a", index + 1, {
			suite: "representative", taskFamily: "lookup", flowsScore: 1, baselineScore: 0, flowsPass: true, baselinePass: false,
		})),
		pairedRow("case-b", 1, {
			suite: "representative", taskFamily: "lookup", flowsScore: 0, baselineScore: 1, flowsPass: false, baselinePass: true,
		}),
	];
	const reliability = buildPairedAnalysis(repeated).overall.reliability;
	assert.equal(reliability.caseSignTest.nonTiedCases, 2);
	assert.equal(reliability.caseSignTest.exactTwoSidedP, 1);
});

test("paired arm order counterbalances treatment across cases and trials", () => {
	assert.deepEqual(pairedArmOrder(0, 1), ["flows", "plain"]);
	assert.deepEqual(pairedArmOrder(0, 2), ["plain", "flows"]);
	assert.deepEqual(pairedArmOrder(1, 1), ["plain", "flows"]);
	assert.deepEqual(pairedArmOrder(1, 2), ["flows", "plain"]);
});

test("95% intervals retain Student-t critical values above 30 case clusters", () => {
	assert.equal(studentTCritical95(30), 2.045);
	assert.ok(studentTCritical95(31) > 1.96);
	assert.ok(Math.abs(studentTCritical95(31) - 2.042272) < 0.00001);
	assert.ok(Math.abs(studentTCritical95(100) - 1.984217) < 0.00001);
});

test("arm timing uses the execution interval and child worker durations", () => {
	assert.deepEqual(armExecutionTiming({ details: { results: [] } }, 125), {
		durationMs: 125,
		workerTimeMs: 125,
	});
	assert.deepEqual(armExecutionTiming({ details: { results: [{ durationMs: 40 }, { durationMs: 60 }] } }, 75), {
		durationMs: 75,
		workerTimeMs: 100,
	});
});

test("plain Pi resource budgets terminate execution at a completed response boundary", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-flow-budget-baseline-"));
	const command = path.join(dir, "pi-stub.mjs");
	writeFileSync(command, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"partial"}],usage:{input:12,output:8,cost:{total:0.25},totalTokens:20},model:"stub"}})+"\\n");
await new Promise(resolve => setTimeout(resolve, 30_000));
`);
	chmodSync(command, 0o700);
	const startedAt = Date.now();
	const result = await runPlainPi({
		task: "bounded task",
		cwd: dir,
		model: "stub",
		command,
		maxGeneratedTokens: 4,
		// The claim under test is "the budget stopped it", so both the process
		// timeout and the stub's hold leave proportional headroom for startup on a
		// loaded machine. The assertions below still require the budget stop to
		// beat the hold by at least 15 seconds.
		timeoutMs: 45_000,
		killGraceMs: 10,
	});
	const child = result.details.results[0];
	assert.equal(child.stopReason, "budget_exceeded");
	assert.equal(child.exitCode, 1);
	assert.equal(child.error.code, "BUDGET_EXCEEDED");
	assert.equal(child.usage.output, 8);
	assert.ok(child.durationMs < 15_000, "budget should stop the child well before its 30s hold elapses");
	assert.ok(Date.now() - startedAt < 15_000, "budget should stop the held-open process before timeout");
});

test("plain Pi cost budgets fail closed when cost telemetry is absent", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-flow-unpriced-baseline-"));
	const command = path.join(dir, "pi-stub.mjs");
	writeFileSync(command, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"unpriced"}],usage:{input:12,output:8,totalTokens:20},model:"stub"}})+"\\n");
await new Promise(resolve => setTimeout(resolve, 5000));
`);
	chmodSync(command, 0o700);
	const result = await runPlainPi({ task: "bounded task", cwd: dir, model: "stub", command, maxCostUsd: 1, timeoutMs: 20_000, killGraceMs: 10 });
	const child = result.details.results[0];
	assert.equal(child.usage.costKnown, false);
	assert.equal(child.stopReason, "budget_unobservable");
	assert.equal(child.error.code, "BUDGET_UNOBSERVABLE");
});

test("plain Pi cost budgets fail closed when usage telemetry is absent", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-flow-unmetered-baseline-"));
	const command = path.join(dir, "pi-stub.mjs");
	writeFileSync(command, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"unmetered"}],model:"stub"}})+"\\n");
`);
	chmodSync(command, 0o700);
	const result = await runPlainPi({ task: "bounded task", cwd: dir, model: "stub", command, maxCostUsd: 1, timeoutMs: 20_000, killGraceMs: 10 });
	const child = result.details.results[0];
	assert.equal(child.usage.costKnown, false);
	assert.equal(child.stopReason, "budget_unobservable");
	assert.equal(child.error.code, "BUDGET_UNOBSERVABLE");
});

test("paired workspaces clone one immutable snapshot for both arms", () => {
	const source = mkdtempSync(path.join(tmpdir(), "pi-flow-pair-source-"));
	writeFileSync(path.join(source, "seed.txt"), "clean\n");
	const pair = pairedCaseWorkspaces({ name: "paired-case", cwd: source }, { trialId: "paired-case::trial-001" });
	try {
		assert.notEqual(pair.flows.cwd, pair.plain.cwd);
		writeFileSync(path.join(pair.flows.cwd, "seed.txt"), "mutated\n");
		assert.equal(readFileSync(path.join(pair.plain.cwd, "seed.txt"), "utf8"), "clean\n");
		const retry = pair.freshArm("flows");
		assert.equal(readFileSync(path.join(retry.cwd, "seed.txt"), "utf8"), "clean\n");
		assert.equal(readFileSync(path.join(source, "seed.txt"), "utf8"), "clean\n");
		assert.equal(pair.snapshotId.length, 64);
	} finally {
		pair.dispose();
	}
});

test("comparison totals suppress unknown treatment cost and ratios", () => {
	const row = {
		flowsTraceOk: false,
		plainTraceOk: false,
		flows: { cost: 0, costKnown: false, durationMs: 1, tokenUsage: { known: false } },
		plain: { cost: 1, costKnown: true, durationMs: 1, tokenUsage: { known: false } },
	};
	const totals = comparisonTotals([row]);
	assert.equal(totals.flowsCostKnown, false);
	assert.equal(totals.baselineCostKnown, true);
	assert.equal(formatCostComparison("flows", totals.flowsCost, totals.flowsCostKnown, "plain", totals.plainCost, totals.baselineCostKnown), "est. cost      flows n/a (model price unavailable)    plain $1.0000");
});

function pairedRow(caseId: string, trialIndex: number, options) {
	const arm = (score: number, pass: boolean, multiplier: number) => ({
		judgeScore: score,
		judgePass: pass,
		objPass: true,
		cost: multiplier,
		costKnown: true,
		generatedTokens: multiplier * 10,
		tokens: { total: multiplier * 20, known: true },
		durationMs: multiplier * 100,
		workerTimeMs: multiplier * 150,
		excluded: null,
	});
	return {
		caseId,
		trialId: `${caseId}::trial-${String(trialIndex).padStart(3, "0")}`,
		trialIndex,
		suite: options.suite,
		taskFamily: options.taskFamily,
		comparable: true,
		constraint: {
			pairEligible: true,
			flows: { status: "within" },
			baseline: { status: "within" },
		},
		flows: arm(options.flowsScore, options.flowsPass, 2),
		baseline: arm(options.baselineScore, options.baselinePass, 1),
	};
}
