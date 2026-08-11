import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { captureReleaseSystem, sha256File } from "../evals/release-system.mjs";
import { calibrationKey, canonicalDigest } from "../evals/calibration-key.mjs";
import { failureLedgerIdentity } from "../evals/failure-ledger.mjs";
import { buildCalibrationReport } from "../evals/calibration.mjs";
import { reliabilityAttestation } from "../evals/reliability.mjs";
import { deriveEvidence } from "../evals/release-evidence.mjs";
import { HARD_BLOCKER_KEYS } from "../evals/release-manifest.mjs";

const root = path.resolve(import.meta.dirname, "..");
const TEST_ATTESTATION_KEY = "test-only-attestation-material-0000000000000001";
const run = (script: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
	cwd: root,
	encoding: "utf8",
	env: { ...process.env, PI_FLOWS_EVAL_ATTESTATION_KEY: TEST_ATTESTATION_KEY },
});

async function writeJson(directory: string, name: string, value: unknown) {
	const target = path.join(directory, name);
	await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
	return target;
}

async function dirtyReleaseRepo(directory: string) {
	const files = {
		"package.json": JSON.stringify({ name: "pi-flows", version: "0.3.0", packageManager: "npm@11.11.0" }),
		"package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
		"extensions/pi-flows/types.ts": 'export const PI_FLOWS_VERSION = "0.3.0";\n',
		"extensions/pi-flows/schema.ts": "export const schema = {};\n",
		"extensions/pi-flows/topology.ts": "export const topology = {};\n",
		"extensions/pi-flows/modes/single.ts": "export const single = {};\n",
		"agents/recon.md": "---\nname: recon\n---\n",
		"evals/run.mjs": "export const harness = 1;\n",
		"evals/cases.mjs": "export const cases = [];\n",
		"evals/pattern-cases.mjs": "export const cases = [];\n",
		"evals/selection-cases.mjs": "export const cases = [];\n",
		"evals/case-contract.mjs": "export const contract = {};\n",
	};
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(directory, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}
	execFileSync("git", ["init", "-q"], { cwd: directory });
	execFileSync("git", ["add", "."], { cwd: directory });
	execFileSync("git", ["-c", "user.name=Eval Test", "-c", "user.email=eval@example.com", "commit", "-qm", "test fixture"], { cwd: directory });
	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
	await writeFile(path.join(directory, "extensions/pi-flows/schema.ts"), "export const schema = { dirty: true };\n", "utf8");
	return commit;
}

function hardBlockers() {
	const keys = [
		"unauthorizedIrreversibleActions",
		"approvalBypass",
		"secretOrPersonalDataLeakage",
		"corruptedSharedState",
		"rollbackFailure",
		"requiredTraceLoss",
	];
	return Object.fromEntries(keys.map((key) => [key, { status: "passed", evidence: [`check:${key}`] }]));
}

function completeCalibration(judgeModel = "provider/judge", judgeSamples = 1) {
	const report = buildCalibrationReport({
		key: calibrationKey({
			judgeModel,
			judgeSamples,
			judgeBin: null,
			evalSet: null,
			promptVersion: "pi-flows@0.3.0",
			configVersion: "pi-flows-eval:provider/subject",
			rubric: "rubric",
			groundTruth: "ground-truth",
			thresholds: {},
			traceSchemaVersion: "pi-flows.eval-trace.v1",
			traceSerialization: "trace-shape",
		}),
		splits: Object.fromEntries(["rubric-development", "calibration", "held-out"].map((split) => [split, { caseCount: 1, digest: `${split}-digest` }])),
		records: [
			...Array.from({ length: 8 }, (_, index) => ({ caseId: `failed-${index}`, dimension: "criterion", split: "held-out", truth: "failed", source: "deterministic", decision: "fail", abstained: false, score: 0.05 })),
			...Array.from({ length: 3 }, (_, index) => ({ caseId: `partial-${index}`, dimension: "criterion", split: "held-out", truth: "partial", source: "deterministic", decision: "fail", abstained: false, score: 0.2 })),
			...Array.from({ length: 4 }, (_, index) => ({ caseId: `passed-${index}`, dimension: "criterion", split: "held-out", truth: "passed", source: "deterministic", decision: "pass", abstained: false, score: 0.95 })),
		],
		criticalDimensions: ["criterion"],
	});
	return {
		...report,
		drift: { status: "valid", changed: [] },
		gate: { blocks: false, issues: [], criticalMissRateCap: 0.35 },
	};
}

function reliability(caseId = "release-case", trials = 3) {
	return {
		schemaVersion: "pi-flows.reliability.v1",
		runId: "release-run",
		subjectTrials: trials,
		judgeSamples: 1,
		evaluatedSystem: { code: { commit: "0123456789abcdef", dirty: false } },
		evaluation: { agentDiscovery: "package-only", suite: { name: "release", caseIds: [caseId] } },
		cases: [{
			caseId,
			trials: Array.from({ length: trials }, (_, index) => ({
				trialId: `${caseId}::trial-${String(index + 1).padStart(3, "0")}`,
				pass: true,
				exclusion: null,
				scoreFamilies: {
					traceHealth: { status: "recorded", pass: true },
					policyCompliance: { pass: true },
					verifiedOutcome: { pass: true },
				},
			})),
		}],
		overall: { traceHealth: { trials, recorded: trials, degraded: 0, missing: 0, complete: true } },
	};
}

function attachRuntimeTrace(report, trace) {
	report.runtimeTraceFile = trace;
	const rows = report.cases[0].trials.map((trial, index) => {
		trial.runtimeTrace = {
			health: "recorded",
			traceFile: trace,
			traceId: `trace-${index + 1}`,
			rootSpanId: `root-${index + 1}`,
			context: {
				runId: report.runId,
				caseId: report.cases[0].caseId,
				trialId: trial.trialId,
				trialIndex: index + 1,
				arm: "flows",
			},
		};
		return {
			trace_id: `trace-${index + 1}`,
			span_id: `root-${index + 1}`,
			parent_span_id: null,
			name: `flow.${report.cases[0].caseId}`,
			attributes: {
				"flow.run_id": report.runId,
				"flow.case_id": report.cases[0].caseId,
				"flow.trial_id": trial.trialId,
			},
		};
	});
	return rows;
}

test("release command writes a pinned blocked record for a dirty evaluated tree", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-release-cli-"));
	const codeCommit = await dirtyReleaseRepo(directory);
	const failureLedger = path.join(directory, "failure-ledger.jsonl");
	await writeFile(failureLedger, "", "utf8");
	const ledgerIdentity = failureLedgerIdentity([], sha256File(failureLedger));
	const evidenceRecord = {
		schemaVersion: "pi-flows.release-evidence.v1",
		runId: "release-run",
		codeCommit,
		evaluatedAt: "2026-07-28T12:00:00.000Z",
		models: { subjects: ["provider/subject"], judge: "provider/judge" },
		topology: { arm: "flows", modes: ["evaluate"] },
		budgets: { maxCostUsd: 1, maxTokens: 10_000, timeoutMs: 120_000, subjectTrials: 3 },
		suite: { name: "release", caseIds: ["release-case"] },
		grader: { name: "thulr", version: "0.3.0" },
		hardBlockers: hardBlockers(),
	};
	const evidence = await writeJson(directory, "evidence.json", evidenceRecord);
	const releaseReliability = reliability();
	releaseReliability.evaluatedSystem = captureReleaseSystem(directory);
	releaseReliability.evaluation = {
		agentDiscovery: "package-only",
		failureLedger: ledgerIdentity,
		models: structuredClone(evidenceRecord.models),
		grader: structuredClone(evidenceRecord.grader),
		topology: structuredClone(evidenceRecord.topology),
		budgets: structuredClone(evidenceRecord.budgets),
		suite: structuredClone(evidenceRecord.suite),
	};
	const calibrationReport = completeCalibration();
	const calibration = await writeJson(directory, "calibration.json", calibrationReport);
	releaseReliability.evaluation.calibration = {
		sha256: sha256File(calibration),
		keyDigest: calibrationReport.key.digest,
		gateDigest: canonicalDigest(calibrationReport.gate, 64),
	};
	releaseReliability.evaluation.judgedRun = { sha256: "f".repeat(64) };
	const trace = path.join(directory, "runtime.jsonl");
	const traceRows = attachRuntimeTrace(releaseReliability, trace);
	releaseReliability.harnessAttestation = reliabilityAttestation(releaseReliability, { key: TEST_ATTESTATION_KEY });
	const reliabilityPath = await writeJson(directory, "reliability.json", releaseReliability);
	await writeFile(trace, `${traceRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
	const out = path.join(directory, "release.json");
	const child = run("evals/release.mjs", [
		`--evidence=${evidence}`,
		`--reliability=${reliabilityPath}`,
		`--calibration=${calibration}`,
		`--runtime-trace=${trace}`,
		`--failure-ledger=${failureLedger}`,
		`--out=${out}`,
		`--repo-root=${directory}`,
	]);

	assert.equal(child.status, 1, `${child.stdout}\n${child.stderr}`);
	const manifest = JSON.parse(await readFile(out, "utf8"));
	assert.equal(manifest.decision.status, "blocked");
	assert.match(manifest.decision.blockers.join("\n"), /working tree is dirty/);
	assert.match(manifest.system.code.commit, /^[a-f0-9]{40}$/);
	assert.match(manifest.system.hashes.prompts.aggregate, /^[a-f0-9]{64}$/);
	assert.match(manifest.system.hashes.toolSchema, /^[a-f0-9]{64}$/);
	assert.equal(manifest.system.package.version, "0.3.0");
	assert.deepEqual(manifest.artifacts.runtimeTrace, {
		sha256: manifest.artifacts.runtimeTrace.sha256,
		matchedTrials: 3,
		valid: true,
	});
});

test("failure command imports a capability case and refuses dry-run promotion evidence", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-failure-cli-"));
	const ledger = path.join(directory, "failures.jsonl");
	const productionTrace = path.join(directory, "validated", "runtime.jsonl");
	await mkdir(path.dirname(productionTrace), { recursive: true });
	await writeFile(productionTrace, `${JSON.stringify({
		trace_id: "trace-id",
		span_id: "root-id",
		parent_span_id: null,
		name: "flow.production-case",
		start_time_unix_ms: 1,
		end_time_unix_ms: 2,
		attributes: {
			"flow.span_role": "root",
			"flow.trace.expected_spans": 1,
			"flow.run_id": "production-run",
			"flow.case_id": "production-case",
			"flow.trial_id": "production-case::trial-001",
		},
	})}\n`, "utf8");
	const input = await writeJson(directory, "failure.json", {
		schemaVersion: "pi-flows.validated-production-failure.v1",
		validation: {
			status: "validated",
			validator: "reviewer",
			validatedAt: "2026-07-28T10:00:00.000Z",
			privacyReview: "passed",
		},
		case: {
			id: "production-routing-failure",
			title: "Production routing failure",
			taskFamily: "routing",
			structure: {
				decomposability: "atomic",
				dependencyDepth: 1,
				sharedState: "read-only",
				risk: "medium",
				reversibility: "reversible",
			},
			agent: "recon",
			task: "Read input.txt and return ROUTE_OK.",
			criterion: "The answer contains ROUTE_OK.",
			expectedBehavior: "Returns the stable marker.",
			objective: { kind: "answer-includes", value: "ROUTE_OK" },
			initialState: { files: [{ path: "input.txt", content: "ROUTE_OK" }] },
			traceLink: {
				runId: "production-run",
				caseId: "production-case",
				trialId: "production-case::trial-001",
				traceFile: "validated/runtime.jsonl",
				traceId: "trace-id",
				rootSpanId: "root-id",
				sha256: sha256File(productionTrace),
			},
			failure: { summary: "The stable marker was omitted.", labels: ["routing.wrong-agent"] },
			promotionPolicy: { minimumHeldOutTrials: 3, requiredPassRate: 1 },
		},
	});
	const imported = run("evals/failure.mjs", ["import", `--input=${input}`, `--ledger=${ledger}`]);
	assert.equal(imported.status, 0, imported.stderr);
	const capabilityRun = run("evals/run.mjs", [
		"--dry-run",
		"--failure-promotion=production-routing-failure",
		"--trials=3",
		`--failure-ledger=${ledger}`,
		`--trace-out=${path.join(directory, "capability-trace.jsonl")}`,
		`--runtime-trace=${path.join(directory, "capability-runtime.jsonl")}`,
		`--reliability-out=${path.join(directory, "capability-reliability.json")}`,
	]);
	assert.equal(capabilityRun.status, 0, `${capabilityRun.stdout}\n${capabilityRun.stderr}`);
	assert.match(capabilityRun.stdout, /capability 1 \(0 excluded\)/);
	const capabilityReport = JSON.parse(await readFile(path.join(directory, "capability-reliability.json"), "utf8"));
	assert.equal(capabilityReport.evidencePurpose.kind, "failure-promotion-held-out");
	assert.equal(capabilityReport.evidencePurpose.caseId, "production-routing-failure");
	assert.match(capabilityReport.evidencePurpose.eventHash, /^[a-f0-9]{64}$/);
	assert.match(capabilityReport.evidencePurpose.caseDigest, /^[a-f0-9]{64}$/);

	const judgedRun = await writeJson(directory, "judged-run.json", { cases: [] });
	const calibration = await writeJson(directory, "held-out-calibration.json", completeCalibration());
	const recorded = run("evals/failure.mjs", [
		"record",
		"--case=production-routing-failure",
		`--reliability=${path.join(directory, "capability-reliability.json")}`,
		`--runtime-trace=${path.join(directory, "capability-runtime.jsonl")}`,
		`--judged-run=${judgedRun}`,
		`--calibration=${calibration}`,
		`--ledger=${ledger}`,
	]);
	assert.equal(recorded.status, 2);
	assert.match(recorded.stderr, /held-out (runtime trace|judged-run) validation failed/);
	const records = (await readFile(ledger, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(records.map((record) => record.type), ["failure.imported"]);
});

test("--run requires a run id rather than defaulting one", () => {
	const child = run("evals/release.mjs", ["--run"]);

	assert.equal(child.status, 2);
	assert.match(child.stderr, /--run requires --run-id=<id>/);
});

test("derived evidence copies run provenance and leaves hard blockers unattested", () => {
	const source = reliability();
	source.generatedAt = "2026-08-10T12:00:00.000Z";
	source.evaluation = {
		...source.evaluation,
		models: { subjects: ["provider/subject"], judge: "provider/judge" },
		topology: { arm: "flows", modes: ["evaluate"] },
		budgets: { subjectTrials: 5 },
		grader: { name: "thulr", version: "0.3.0" },
	};

	const derived = deriveEvidence(source, false);

	assert.equal(derived.schemaVersion, "pi-flows.release-evidence.v1");
	assert.equal(derived.runId, source.runId);
	assert.equal(derived.codeCommit, source.evaluatedSystem.code.commit);
	assert.equal(derived.evaluatedAt, "2026-08-10T12:00:00.000Z");
	// Every provenance field the gate cross-checks is the artifact's own record,
	// so a derived evidence object can never disagree with the run it describes.
	for (const field of ["models", "topology", "budgets", "suite", "grader"] as const) {
		assert.deepEqual(derived[field], source.evaluation[field]);
	}
	// Without an explicit operator attestation the six blockers stay unasserted,
	// and the gate rejects them for lacking attributable evidence.
	assert.deepEqual(Object.keys(derived.hardBlockers), HARD_BLOCKER_KEYS);
	for (const key of HARD_BLOCKER_KEYS) {
		assert.deepEqual(derived.hardBlockers[key], { status: "not-attested", evidence: [] });
	}
});

test("attested evidence records the operator assertion against the run it decided", () => {
	const derived = deriveEvidence(reliability(), true);

	for (const key of HARD_BLOCKER_KEYS) {
		assert.deepEqual(derived.hardBlockers[key], {
			status: "passed",
			evidence: ["operator-attested:release-run"],
		});
	}
});
