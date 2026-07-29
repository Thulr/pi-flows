import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	HARD_BLOCKER_KEYS,
	RELEASE_EVIDENCE_SCHEMA_VERSION,
	buildReleaseManifest,
	evaluateRelease,
	releaseDigest,
} from "../evals/release-manifest.mjs";
import {
	FAILURE_INPUT_SCHEMA_VERSION,
	appendFailureEvent,
	buildFailureImport,
	buildHeldOutTrialEvents,
	buildPromotionDecision,
	evaluatedSystemDigest,
	failureCasesFromLedger,
	failureLedgerIdentity,
	readFailureLedger,
} from "../evals/failure-ledger.mjs";
import { buildEvaluationProvenance } from "../evals/evaluation-provenance.mjs";
import { discoverFlowAgents } from "../extensions/pi-flows/agents.ts";
import { calibrationKey, canonicalDigest } from "../evals/calibration-key.mjs";
import { validateReleaseRuntimeTrace } from "../evals/release-trace.mjs";
import { validateProductionTrace } from "../evals/failure-trace.mjs";
import { buildCalibrationReport } from "../evals/calibration.mjs";
import { reliabilityAttestation } from "../evals/reliability.mjs";
import { sha256File } from "../evals/release-system.mjs";
import { validateCalibrationArtifact } from "../evals/evaluation-artifacts.mjs";

const blockerEvidence = () => Object.fromEntries(HARD_BLOCKER_KEYS.map((key) => [
	key,
	{ status: "passed", evidence: [`check:${key}`] },
]));
const TEST_ATTESTATION_KEY = "test-only-attestation-material-0000000000000001";

function releaseInputs() {
	const calibrationInputs = {
		judgeModel: "provider/judge-v2",
		judgeSamples: 1,
		judgeBin: null,
		evalSet: null,
		promptVersion: "pi-flows@0.3.0",
		configVersion: "pi-flows-eval:provider/subject-v1",
		rubric: "rubric",
		groundTruth: "ground-truth",
		thresholds: {},
		traceSchemaVersion: "pi-flows.eval-trace.v1",
		traceSerialization: "trace-shape",
	};
	const ledgerIdentity = { sha256: "failure-ledger-hash", headHash: null, promotedCaseIds: [], importedCases: {} };
	const calibration = buildCalibrationReport({
		key: calibrationKey(calibrationInputs),
		splits: Object.fromEntries(["rubric-development", "calibration", "held-out"].map((split) => [split, { caseCount: 1, digest: `${split}-digest` }])),
		records: [
			...Array.from({ length: 8 }, (_, index) => ({ caseId: `failed-${index}`, dimension: "criterion", split: "held-out", truth: "failed", source: "deterministic", decision: "fail", abstained: false, score: 0.05 })),
			...Array.from({ length: 3 }, (_, index) => ({ caseId: `partial-${index}`, dimension: "criterion", split: "held-out", truth: "partial", source: "deterministic", decision: "fail", abstained: false, score: 0.2 })),
			...Array.from({ length: 4 }, (_, index) => ({ caseId: `passed-${index}`, dimension: "criterion", split: "held-out", truth: "passed", source: "deterministic", decision: "pass", abstained: false, score: 0.95 })),
		],
		criticalDimensions: ["criterion"],
	});
	calibration.drift = { status: "valid", changed: [] };
	calibration.gate = { blocks: false, issues: [], criticalMissRateCap: 0.35 };
	const inputs = {
		evidence: {
			schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
			runId: "release-run-123",
			codeCommit: "0123456789abcdef",
			evaluatedAt: "2026-07-28T12:00:00.000Z",
			models: { subjects: ["provider/subject-v1"], judge: "provider/judge-v2" },
			topology: { arm: "flows", modes: ["workflow", "evaluate"] },
			budgets: { maxCostUsd: 1, maxTokens: 20_000, timeoutMs: 120_000, subjectTrials: 5 },
			suite: { name: "release", caseIds: ["release-case"] },
			grader: { name: "thulr", version: "0.3.0" },
			hardBlockers: blockerEvidence(),
		},
		reliability: {
			schemaVersion: "pi-flows.reliability.v1",
			runId: "release-run-123",
			runtimeTraceFile: "release.runtime.jsonl",
			subjectTrials: 5,
			judgeSamples: 1,
			cases: [{
				caseId: "release-case",
				trials: Array.from({ length: 5 }, (_, index) => ({
					trialId: `release-case::trial-00${index + 1}`,
					traceCaseId: `release-case::trial-00${index + 1}`,
					model: "provider/subject-v1",
					pass: true,
					objective: { pass: true },
					judge: { criterion: { verdict: true, score: 1 } },
					exclusion: null,
					scoreFamilies: {
						traceHealth: { status: "recorded", pass: true },
						policyCompliance: { pass: true },
						verifiedOutcome: { pass: true },
					},
				})),
			}],
			overall: { traceHealth: { trials: 5, recorded: 5, degraded: 0, missing: 0, complete: true } },
		},
		calibration,
		system: {
			code: { commit: "0123456789abcdef", dirty: false },
			package: { name: "pi-flows", version: "0.3.0", extensionVersion: "0.3.0", lockfileVersion: 3 },
			hashes: {
				prompts: { aggregate: "prompt-hash", files: { "agents/recon.md": "recon-hash" } },
				toolSchema: "tool-schema-hash",
				topology: "topology-hash",
				harness: "harness-hash",
				suite: "suite-hash",
			},
			environment: { node: "v26.0.0", npm: "11.11.0", platform: "linux", arch: "x64", ci: true },
		},
		artifactHashes: {
			reliability: "reliability-hash",
			calibration: "4".repeat(64),
			runtimeTrace: "runtime-trace-hash",
			failureLedger: "failure-ledger-hash",
		},
		runtimeTraceValidation: { valid: true, issues: [], matchedTrials: 5, sha256: "runtime-trace-hash" },
		ledgerIdentity: structuredClone(ledgerIdentity),
		generatedAt: "2026-07-28T12:30:00.000Z",
	};
	inputs.reliability.evaluatedSystem = structuredClone(inputs.system);
	inputs.reliability.evaluation = {
		agentDiscovery: "package-only",
		failureLedger: structuredClone(ledgerIdentity),
		models: structuredClone(inputs.evidence.models),
		grader: structuredClone(inputs.evidence.grader),
		topology: structuredClone(inputs.evidence.topology),
		budgets: structuredClone(inputs.evidence.budgets),
		suite: structuredClone(inputs.evidence.suite),
		calibration: {
			sha256: inputs.artifactHashes.calibration,
			keyDigest: inputs.calibration.key.digest,
			gateDigest: canonicalDigest(inputs.calibration.gate, 64),
		},
		judgedRun: { sha256: "f".repeat(64) },
	};
	inputs.attestationKey = TEST_ATTESTATION_KEY;
	inputs.reliability.harnessAttestation = reliabilityAttestation(inputs.reliability, { key: TEST_ATTESTATION_KEY });
	return inputs;
}

test("release manifest pins the complete evaluated system and approves clean evidence", () => {
	const inputs = releaseInputs();
	const decision = evaluateRelease(inputs);
	assert.deepEqual(decision, { status: "approved", blockers: [] });

	const manifest = buildReleaseManifest(inputs);
	assert.equal(manifest.schemaVersion, "pi-flows.release-manifest.v1");
	assert.equal(manifest.decision.status, "approved");
	assert.equal(manifest.evaluation.runId, "release-run-123");
	assert.deepEqual(manifest.evaluation.models.subjects, ["provider/subject-v1"]);
	assert.equal(manifest.system.hashes.prompts.aggregate, "prompt-hash");
	assert.equal(manifest.system.hashes.toolSchema, "tool-schema-hash");
	assert.equal(manifest.evaluation.topology.modes[0], "workflow");
	assert.equal(manifest.evaluation.budgets.maxCostUsd, 1);
	assert.equal(manifest.evaluation.suite.name, "release");
	assert.equal(manifest.evaluation.grader.version, "0.3.0");
	assert.equal(manifest.evaluation.calibration.keyDigest, inputs.calibration.key.digest);
	assert.equal(manifest.artifacts.runtimeTrace.sha256, "runtime-trace-hash");
	assert.match(manifest.manifestDigest, /^[a-f0-9]{64}$/);
});

test("evaluation provenance records effective per-case flow budgets", () => {
	const provenance = buildEvaluationProvenance(
		[{ name: "budgeted", params: { agent: "recon", task: "inspect", timeoutMs: 600_000, maxTokens: 12_000, maxGeneratedTokens: 4_000 } }],
		[{ model: "provider/subject" }],
		{ capUsd: 0.5, timeoutMs: 120_000, armTimeoutMs: 90_000, subjectTrials: 3, judgeModel: "provider/judge" },
	);
	assert.deepEqual(provenance.budgets.cases.budgeted, {
		maxCostUsd: 0.5,
		maxTokens: 12_000,
		maxGeneratedTokens: 4_000,
		caseTimeoutMs: 600_000,
		effectiveTimeoutMs: 90_000,
	});
});

test("release eval prompt isolation ignores user prompt shadows", async () => {
	const agentRoot = await mkdtemp(path.join(tmpdir(), "pi-flow-agent-root-"));
	const userAgents = path.join(agentRoot, "flow-agents");
	await mkdir(userAgents, { recursive: true });
	await writeFile(path.join(userAgents, "recon.md"), "---\nname: recon\ndescription: shadow\n---\nuser shadow\n", "utf8");
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousIsolation = process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY;
	process.env.PI_CODING_AGENT_DIR = agentRoot;
	process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = "1";
	try {
		const discovery = discoverFlowAgents(process.cwd(), "user");
		assert.equal(discovery.agents.find((agent) => agent.name === "recon")?.source, "package");
		assert.equal(discovery.issues.some((issue) => issue.code === "AGENT_NAME_SHADOWED"), false);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousIsolation === undefined) delete process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY;
		else process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = previousIsolation;
	}
});

test("release evaluation fails closed on every catastrophic blocker and incomplete evidence", () => {
	for (const key of HARD_BLOCKER_KEYS) {
		const inputs = releaseInputs();
		inputs.evidence.hardBlockers[key] = { status: "failed", evidence: [`incident:${key}`] };
		const decision = evaluateRelease(inputs);
		assert.equal(decision.status, "blocked", key);
		assert.match(decision.blockers.join("\n"), new RegExp(key), key);
	}

	const missingTrace = releaseInputs();
	missingTrace.reliability.overall.traceHealth.complete = false;
	missingTrace.reliability.overall.traceHealth.missing = 1;
	assert.match(evaluateRelease(missingTrace).blockers.join("\n"), /required runtime trace evidence is incomplete/);

	const unrelatedTrace = releaseInputs();
	unrelatedTrace.runtimeTraceValidation = { valid: false, issues: ["release-case::trial-001 root span is absent"], matchedTrials: 4 };
	assert.match(evaluateRelease(unrelatedTrace).blockers.join("\n"), /runtime trace artifact does not match reliability evidence/);

	const staleCalibration = releaseInputs();
	staleCalibration.calibration.drift.status = "stale";
	assert.match(evaluateRelease(staleCalibration).blockers.join("\n"), /calibration key is stale/);

	const blockingCalibration = releaseInputs();
	blockingCalibration.calibration.gate = { blocks: true, issues: ["critical miss-rate bound exceeded"], criticalMissRateCap: 0.35 };
	assert.match(evaluateRelease(blockingCalibration).blockers.join("\n"), /critical miss-rate bound exceeded/);

	const dirty = releaseInputs();
	dirty.system.code.dirty = true;
	assert.match(evaluateRelease(dirty).blockers.join("\n"), /working tree is dirty/);

	const wrongCommit = releaseInputs();
	wrongCommit.evidence.codeCommit = "different-commit";
	assert.match(evaluateRelease(wrongCommit).blockers.join("\n"), /evaluated code commit does not match/);

	const missingRegression = releaseInputs();
	missingRegression.regressionCaseIds = ["promoted-production-failure"];
	assert.match(evaluateRelease(missingRegression).blockers.join("\n"), /promoted regression case promoted-production-failure is absent/);

	const wrongSuite = releaseInputs();
	wrongSuite.evidence.suite.caseIds = ["different-case"];
	assert.match(evaluateRelease(wrongSuite).blockers.join("\n"), /declared suite case ids do not match measured reliability cases/);

	for (const invalid of ["", null, {}]) {
		const weakBlocker = releaseInputs();
		weakBlocker.evidence.hardBlockers.approvalBypass.evidence = [invalid];
		assert.match(evaluateRelease(weakBlocker).blockers.join("\n"), /approvalBypass hard blocker did not pass with attributable evidence/);
	}

	const assertedModel = releaseInputs();
	assertedModel.evidence.models.subjects = ["operator/assertion"];
	assert.match(evaluateRelease(assertedModel).blockers.join("\n"), /model identifiers do not match evaluation-time provenance/);

	const assertedGrader = releaseInputs();
	assertedGrader.evidence.grader.version = "operator/assertion";
	assert.match(evaluateRelease(assertedGrader).blockers.join("\n"), /grader does not match evaluation-time provenance/);

	const shadowablePrompts = releaseInputs();
	shadowablePrompts.reliability.evaluation.agentDiscovery = "user";
	assert.match(evaluateRelease(shadowablePrompts).blockers.join("\n"), /did not isolate the package prompts/);

	const missingLedger = releaseInputs();
	delete missingLedger.artifactHashes.failureLedger;
	assert.match(evaluateRelease(missingLedger).blockers.join("\n"), /failureLedger artifact hash is missing/);

	const substitutedLedger = releaseInputs();
	substitutedLedger.ledgerIdentity.sha256 = "different-ledger";
	assert.match(evaluateRelease(substitutedLedger).blockers.join("\n"), /does not match evaluation-time ledger provenance/);

	const mismatchedArtifactHashes = releaseInputs();
	mismatchedArtifactHashes.artifactHashes.runtimeTrace = "different-trace";
	mismatchedArtifactHashes.artifactHashes.failureLedger = "different-ledger";
	assert.match(evaluateRelease(mismatchedArtifactHashes).blockers.join("\n"), /runtime trace artifact hash does not match validated trace bytes/);
	assert.match(evaluateRelease(mismatchedArtifactHashes).blockers.join("\n"), /failure ledger artifact hash does not match validated ledger bytes/);

	const forgedAttestation = releaseInputs();
	forgedAttestation.attestationKey = "different-test-attestation-material-000000000001";
	assert.match(evaluateRelease(forgedAttestation).blockers.join("\n"), /operator-authenticated harness attestation/);

	const duplicateTrial = releaseInputs();
	duplicateTrial.reliability.cases[0].trials[1] = structuredClone(duplicateTrial.reliability.cases[0].trials[0]);
	assert.match(evaluateRelease(duplicateTrial).blockers.join("\n"), /duplicate trial identity/);

	const incompleteCalibration = releaseInputs();
	delete incompleteCalibration.calibration.key.inputs.traceSerialization;
	assert.match(evaluateRelease(incompleteCalibration).blockers.join("\n"), /calibration key is missing, incomplete/);

	const extendedCalibration = releaseInputs();
	extendedCalibration.calibration.key.inputs.unboundInput = "not-part-of-the-key";
	extendedCalibration.calibration.key.digest = canonicalDigest(extendedCalibration.calibration.key.inputs);
	assert.match(evaluateRelease(extendedCalibration).blockers.join("\n"), /calibration key is missing, incomplete/);

	const skeletalCalibration = releaseInputs();
	skeletalCalibration.calibration.coverage = {};
	skeletalCalibration.calibration.statistics = {};
	skeletalCalibration.calibration.authority = { critical: [], authoritative: [], provisional: [] };
	skeletalCalibration.calibration.gate = { blocks: false, issues: [], criticalMissRateCap: 0.35 };
	assert.match(evaluateRelease(skeletalCalibration).blockers.join("\n"), /missing release-critical dimension/);

	const calibrationFromAnotherRun = releaseInputs();
	calibrationFromAnotherRun.reliability.evaluation.calibration.keyDigest = "different-calibration";
	assert.match(evaluateRelease(calibrationFromAnotherRun).blockers.join("\n"), /does not match evaluation-time calibration provenance/);

	const changedSystem = releaseInputs();
	changedSystem.reliability.evaluatedSystem.hashes.harness = "evaluated-harness";
	assert.match(evaluateRelease(changedSystem).blockers.join("\n"), /release-record system does not match the evaluated system/);
});

function failureInput() {
	return {
		schemaVersion: FAILURE_INPUT_SCHEMA_VERSION,
		validation: {
			status: "validated",
			validator: "incident-reviewer",
			validatedAt: "2026-07-28T10:00:00.000Z",
			privacyReview: "passed",
		},
		case: {
			id: "production-routing-failure",
			title: "Routing failure for customer@example.com",
			taskFamily: "routing",
			structure: {
				decomposability: "atomic",
				dependencyDepth: 1,
				sharedState: "read-only",
				risk: "medium",
				reversibility: "reversible",
			},
			agent: "recon",
			task: "Inspect input.txt and return the stable marker; token=example-placeholder",
			criterion: "The answer contains ROUTE_OK.",
			expectedBehavior: "Returns ROUTE_OK without exposing unrelated content.",
			objective: { kind: "answer-includes", value: "ROUTE_OK" },
			initialState: {
				files: [
					{ path: "input.txt", content: " ROUTE_OK for customer@example.com\n" },
					{ path: "empty.txt", content: "" },
				],
			},
			traceLink: {
				runId: "production-run-7",
				caseId: "production-case-7",
				trialId: "production-case-7::trial-001",
				traceFile: "/var/validated/runtime.jsonl",
				traceId: "trace-7",
				rootSpanId: "root-7",
				sha256: "a".repeat(64),
			},
			failure: { summary: "The route omitted ROUTE_OK for customer@example.com.", labels: ["routing.wrong-agent"] },
			promotionPolicy: { minimumHeldOutTrials: 3, requiredPassRate: 1 },
		},
	};
}

const validProductionTrace = () => ({
	valid: true,
	issues: [],
	sha256: "a".repeat(64),
	traceId: "trace-7",
	rootSpanId: "root-7",
});

const heldOutTrace = (reliability) => ({
	valid: true,
	issues: [],
	matchedTrials: reliability.cases.reduce((count, entry) => count + entry.trials.length, 0),
	sha256: "b".repeat(64),
});

const heldOutJudgedRun = () => ({ valid: true, issues: [], sha256: "f".repeat(64) });
const heldOutCalibration = () => ({
	valid: true,
	issues: [],
	sha256: "4".repeat(64),
	calibration: { gate: { blocks: false } },
});

const testImportBinding = () => ({
	eventHash: "c".repeat(64),
	caseDigest: "d".repeat(64),
	ledgerSha256: "e".repeat(64),
	ledgerHeadHash: "c".repeat(64),
});

const heldOutPurpose = (binding = testImportBinding()) => ({
	kind: "failure-promotion-held-out",
	caseId: "production-routing-failure",
	...binding,
});

function authenticateHeldOut(reliability, caseId = "production-routing-failure") {
	reliability.evaluation.topology = {
		arm: "flows",
		cases: { [caseId]: { mode: "single", paramsDigest: "8".repeat(64) } },
	};
	reliability.evaluation.budgets.cases = {
		[caseId]: {
			maxCostUsd: 1,
			maxTokens: 20_000,
			maxGeneratedTokens: null,
			caseTimeoutMs: 120_000,
			effectiveTimeoutMs: 120_000,
		},
	};
	reliability.harnessAttestation = reliabilityAttestation(reliability, { key: TEST_ATTESTATION_KEY });
}

test("validated production failures become sanitized executable capability cases", async () => {
	const imported = buildFailureImport(failureInput(), { importedAt: "2026-07-28T11:00:00.000Z", traceValidation: validProductionTrace() });
	assert.equal(imported.type, "failure.imported");
	assert.equal(imported.case.suite, "capability");
	assert.match(JSON.stringify(imported), /REDACTED_EMAIL/);
	assert.doesNotMatch(JSON.stringify(imported), /customer@example\.com/);
	assert.equal(imported.case.traceLink.traceId, "trace-7");
	assert.equal(imported.case.initialState.files[0].content, " ROUTE_OK for [REDACTED_EMAIL]\n");
	assert.equal(imported.case.initialState.files[1].content, "");

	const cases = failureCasesFromLedger([imported]);
	assert.equal(cases.length, 1);
	assert.equal(cases[0].suite, "capability");
	const workspace = await mkdtemp(path.join(tmpdir(), "pi-flow-failure-case-"));
	cases[0].setupWorkspace(workspace);
	assert.equal(await readFile(path.join(workspace, "input.txt"), "utf8"), " ROUTE_OK for [REDACTED_EMAIL]\n");
	assert.equal(await readFile(path.join(workspace, "empty.txt"), "utf8"), "");
	assert.equal(cases[0].score({ content: [{ text: "found ROUTE_OK" }] }).pass, true);
	assert.equal(cases[0].score({ content: [{ text: "not found" }] }).pass, false);

	const unrelated = failureInput();
	unrelated.case.hiddenReasoning = "not required";
	assert.throws(() => buildFailureImport(unrelated, { traceValidation: validProductionTrace() }), /unsupported fields: hiddenReasoning/);

	const traversal = failureInput();
	traversal.case.initialState.files[0].path = "../outside.txt";
	assert.throws(() => buildFailureImport(traversal, { traceValidation: validProductionTrace() }), /normalized file path inside the case workspace/);
	assert.throws(() => buildFailureImport(failureInput()), /production trace validation is required/);
	for (const invalidPath of [".", "a//b", "a/./b", "dir/", "nul\0name"]) {
		const aliased = failureInput();
		aliased.case.initialState.files[0].path = invalidPath;
		assert.throws(() => buildFailureImport(aliased, { traceValidation: validProductionTrace() }), /normalized file path/);
	}
});

test("release trace validation rejects a root-only remnant of a larger trace", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-release-trace-"));
	const traceFile = path.join(directory, "runtime.jsonl");
	const trialId = "release-case::trial-001";
	await writeFile(traceFile, `${JSON.stringify({
		trace_id: "trace-1",
		span_id: "root-1",
		parent_span_id: null,
		start_time_unix_ms: 1,
		end_time_unix_ms: 2,
		attributes: {
			"flow.span_role": "root",
			"flow.trace.expected_spans": 2,
			"flow.run_id": "release-run",
			"flow.case_id": "release-case",
			"flow.trial_id": trialId,
		},
	})}\n`, "utf8");
	const reliability = {
		runId: "release-run",
		runtimeTraceFile: traceFile,
		cases: [{ caseId: "release-case", trials: [{
			trialId,
			runtimeTrace: {
				health: "recorded",
				traceFile,
				traceId: "trace-1",
				rootSpanId: "root-1",
				context: { runId: "release-run", caseId: "release-case", trialId },
			},
		}] }],
	};
	const validation = validateReleaseRuntimeTrace(traceFile, reliability);
	assert.equal(validation.valid, false);
	assert.match(validation.issues.join("\n"), /structural gate failed/);
});

test("production failure import rejects a structurally incomplete linked trace", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-production-trace-"));
	const traceFile = path.join(directory, "runtime.jsonl");
	await writeFile(traceFile, `${JSON.stringify({
		trace_id: "trace-7",
		span_id: "root-7",
		parent_span_id: null,
		start_time_unix_ms: 1,
		end_time_unix_ms: 2,
		attributes: {
			"flow.span_role": "root",
			"flow.trace.expected_spans": 2,
			"flow.run_id": "run-7",
			"flow.case_id": "case-7",
			"flow.trial_id": "trial-7",
		},
	})}\n`, "utf8");
	const validation = validateProductionTrace({
		traceFile,
		sha256: sha256File(traceFile),
		traceId: "trace-7",
		rootSpanId: "root-7",
		runId: "run-7",
		caseId: "case-7",
		trialId: "trial-7",
	});
	assert.equal(validation.valid, false);
	assert.match(validation.issues.join("\n"), /structural gate failed/);
});

test("promotion calibration validation enforces the release calibration policy", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-promotion-calibration-"));
	const inputs = releaseInputs();
	const calibrationFile = path.join(directory, "calibration.json");
	await writeFile(calibrationFile, `${JSON.stringify(inputs.calibration)}\n`, "utf8");
	inputs.reliability.evaluation.calibration.sha256 = sha256File(calibrationFile);
	assert.equal(validateCalibrationArtifact(calibrationFile, inputs.reliability).valid, true);

	const stale = structuredClone(inputs.calibration);
	stale.drift.status = "unknown";
	await writeFile(calibrationFile, `${JSON.stringify(stale)}\n`, "utf8");
	inputs.reliability.evaluation.calibration.sha256 = sha256File(calibrationFile);
	const validation = validateCalibrationArtifact(calibrationFile, inputs.reliability);
	assert.equal(validation.valid, false);
	assert.match(validation.issues.join("\n"), /stale or has no matching prior evidence/);
});

test("promotion is append-only and requires stable held-out success on one system", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-failure-ledger-"));
	const ledgerPath = path.join(directory, "ledger.jsonl");
	const imported = buildFailureImport(failureInput(), { importedAt: "2026-07-28T11:00:00.000Z", traceValidation: validProductionTrace() });
	const importedRecord = await appendFailureEvent(ledgerPath, imported);

	const reliability = releaseInputs().reliability;
	reliability.runId = "held-out-run";
	const initialLedger = await readFailureLedger(ledgerPath);
	const identity = failureLedgerIdentity(initialLedger.events, sha256File(ledgerPath));
	const importBinding = {
		...identity.importedCases["production-routing-failure"],
		ledgerSha256: identity.sha256,
		ledgerHeadHash: identity.headHash,
	};
	assert.equal(importBinding.eventHash, importedRecord.eventHash);
	reliability.evidencePurpose = heldOutPurpose(importBinding);
	reliability.evaluation.suite.caseIds = ["production-routing-failure"];
	reliability.cases[0].caseId = "production-routing-failure";
	reliability.cases[0].trials = reliability.cases[0].trials.slice(0, 3).map((trial, index) => ({
		...trial,
		trialId: `production-routing-failure::trial-00${index + 1}`,
		traceCaseId: `production-routing-failure::trial-00${index + 1}`,
	}));
	reliability.subjectTrials = 3;
	reliability.evaluation.budgets.subjectTrials = 3;
	authenticateHeldOut(reliability);
	const trials = buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability,
		systemDigest: evaluatedSystemDigest(reliability),
		runtimeTraceValidation: heldOutTrace(reliability),
		judgedRunValidation: heldOutJudgedRun(),
		calibrationValidation: heldOutCalibration(),
		attestationKey: TEST_ATTESTATION_KEY,
		importBinding,
		recordedAt: "2026-07-28T12:00:00.000Z",
	});
	for (const trial of trials.slice(0, 2)) await appendFailureEvent(ledgerPath, trial);
	await assert.rejects(appendFailureEvent(ledgerPath, trials[0]), /duplicates an existing held-out trial identity/);

	let ledger = await readFailureLedger(ledgerPath);
	const denied = buildPromotionDecision(ledger.events, "production-routing-failure", { cohortId: "held-out-run", decidedAt: "2026-07-28T12:30:00.000Z" });
	assert.equal(denied.decision, "denied");
	assert.match(denied.reasons.join("\n"), /requires 3 held-out trials/);
	await appendFailureEvent(ledgerPath, denied);

	await appendFailureEvent(ledgerPath, trials[2]);
	ledger = await readFailureLedger(ledgerPath);
	const approved = buildPromotionDecision(ledger.events, "production-routing-failure", { cohortId: "held-out-run", decidedAt: "2026-07-28T13:00:00.000Z" });
	assert.equal(approved.decision, "approved");
	assert.equal(approved.toSuite, "regression");
	assert.deepEqual(approved.trialIds, trials.map((trial) => trial.trialId));
	await appendFailureEvent(ledgerPath, approved);

	ledger = await readFailureLedger(ledgerPath);
	assert.equal(ledger.valid, true);
	assert.equal(ledger.events.at(-1)?.previousHash, ledger.events.at(-2)?.eventHash);
	assert.equal(failureCasesFromLedger(ledger.events)[0].suite, "regression");
	assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
});

test("held-out evidence rejects failures, trace loss, policy failure, and mixed revisions", () => {
	const imported = buildFailureImport(failureInput(), { traceValidation: validProductionTrace() });
	const clean = releaseInputs().reliability;
	clean.cases[0].caseId = "production-routing-failure";
	clean.cases[0].trials = clean.cases[0].trials.slice(0, 3).map((trial, index) => ({
		...trial,
		trialId: `production-routing-failure::trial-00${index + 1}`,
		traceCaseId: `production-routing-failure::trial-00${index + 1}`,
	}));
	clean.subjectTrials = 3;
	clean.evaluation.budgets.subjectTrials = 3;
	const importBinding = testImportBinding();
	clean.evidencePurpose = heldOutPurpose(importBinding);
	clean.evaluation.suite.caseIds = ["production-routing-failure"];
	authenticateHeldOut(clean);
	const trialEvents = buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability: clean,
		systemDigest: evaluatedSystemDigest(clean),
		runtimeTraceValidation: heldOutTrace(clean),
		judgedRunValidation: heldOutJudgedRun(),
		calibrationValidation: heldOutCalibration(),
		attestationKey: TEST_ATTESTATION_KEY,
		importBinding,
	});

	for (const mutate of [
		(event) => { event.passed = false; },
		(event) => { event.traceHealth = "missing"; },
		(event) => { event.policyPassed = false; },
	]) {
		const events = [imported, ...structuredClone(trialEvents)];
		mutate(events[1]);
		const decision = buildPromotionDecision(events, "production-routing-failure", { cohortId: clean.runId });
		assert.equal(decision.decision, "denied");
	}

	const mixed = [imported, ...structuredClone(trialEvents)];
	mixed[1].systemDigest = "commit-b";
	assert.match(buildPromotionDecision(mixed, "production-routing-failure", { cohortId: clean.runId }).reasons.join("\n"), /same evaluated system/);
	const mixedTrace = [imported, ...structuredClone(trialEvents)];
	mixedTrace[1].runtimeTraceSha256 = "9".repeat(64);
	assert.match(buildPromotionDecision(mixedTrace, "production-routing-failure", { cohortId: clean.runId }).reasons.join("\n"), /one runtime trace artifact/);

	const oldFailed = structuredClone(trialEvents[0]);
	oldFailed.runId = "old-failed-run";
	oldFailed.passed = false;
	const cleanDecision = buildPromotionDecision([imported, oldFailed, ...trialEvents], "production-routing-failure", { cohortId: clean.runId });
	assert.equal(cleanDecision.decision, "approved", "an older failed cohort must not poison a later stable cohort");
	const differentModel = structuredClone(clean);
	differentModel.evaluation.models.subjects = ["provider/different-subject"];
	assert.notEqual(evaluatedSystemDigest(differentModel), evaluatedSystemDigest(clean), "promotion identity includes model/topology/budget provenance");

	const reusedJudgement = structuredClone(clean);
	reusedJudgement.cases[0].trials[1].traceCaseId = reusedJudgement.cases[0].trials[0].traceCaseId;
	reusedJudgement.harnessAttestation = reliabilityAttestation(reusedJudgement, { key: TEST_ATTESTATION_KEY });
	assert.throws(() => buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability: reusedJudgement,
		systemDigest: evaluatedSystemDigest(reusedJudgement),
		runtimeTraceValidation: heldOutTrace(reusedJudgement),
		judgedRunValidation: heldOutJudgedRun(),
		calibrationValidation: heldOutCalibration(),
		attestationKey: TEST_ATTESTATION_KEY,
		importBinding,
	}), /canonical objective, model, or judged-run evidence/);

	const ordinaryReliability = structuredClone(clean);
	delete ordinaryReliability.evidencePurpose;
	assert.throws(() => buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability: ordinaryReliability,
		systemDigest: evaluatedSystemDigest(ordinaryReliability),
		runtimeTraceValidation: heldOutTrace(ordinaryReliability),
		judgedRunValidation: heldOutJudgedRun(),
		calibrationValidation: heldOutCalibration(),
		attestationKey: TEST_ATTESTATION_KEY,
		importBinding,
	}), /dedicated held-out promotion run/);
	assert.throws(() => buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability: clean,
		systemDigest: evaluatedSystemDigest(clean),
		runtimeTraceValidation: { valid: false, issues: ["missing root"], matchedTrials: 2 },
		judgedRunValidation: heldOutJudgedRun(),
		calibrationValidation: heldOutCalibration(),
		attestationKey: TEST_ATTESTATION_KEY,
		importBinding,
	}), /runtime trace validation failed/);
});

test("failure ledger detects edits to prior append-only records", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-tampered-ledger-"));
	const ledgerPath = path.join(directory, "ledger.jsonl");
	await appendFailureEvent(ledgerPath, buildFailureImport(failureInput(), { traceValidation: validProductionTrace() }));
	const original = await readFile(ledgerPath, "utf8");
	await import("node:fs/promises").then(({ writeFile }) => writeFile(
		ledgerPath,
		original.replace("Routing failure for", "Rewritten routing failure for"),
		"utf8",
	));
	const ledger = await readFailureLedger(ledgerPath);
	assert.equal(ledger.valid, false);
	assert.match(ledger.issues.join("\n"), /broken eventHash/);
});

test("failure ledger rejects duplicate imports and held-out evidence before import", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-failure-ordering-"));
	const duplicateLedger = path.join(directory, "duplicates.jsonl");
	const imported = buildFailureImport(failureInput(), { traceValidation: validProductionTrace() });
	await appendFailureEvent(duplicateLedger, imported);
	await assert.rejects(appendFailureEvent(duplicateLedger, imported), /duplicates an existing imported case id/);

	const reliability = releaseInputs().reliability;
	reliability.cases[0].caseId = "production-routing-failure";
	reliability.cases[0].trials = reliability.cases[0].trials.slice(0, 3).map((trial, index) => ({
		...trial,
		trialId: `production-routing-failure::trial-00${index + 1}`,
		traceCaseId: `production-routing-failure::trial-00${index + 1}`,
	}));
	reliability.subjectTrials = 3;
	reliability.evaluation.budgets.subjectTrials = 3;
	reliability.evaluation.suite.caseIds = ["production-routing-failure"];
	const importBinding = testImportBinding();
	reliability.evidencePurpose = heldOutPurpose(importBinding);
	authenticateHeldOut(reliability);
	const [trial] = buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability,
		systemDigest: evaluatedSystemDigest(reliability),
		runtimeTraceValidation: heldOutTrace(reliability),
		judgedRunValidation: heldOutJudgedRun(),
		calibrationValidation: heldOutCalibration(),
		attestationKey: TEST_ATTESTATION_KEY,
		importBinding,
	});
	await assert.rejects(
		appendFailureEvent(path.join(directory, "pre-import.jsonl"), trial),
		/must follow exactly one matching imported case/,
	);
});

test("failure ledger refuses persisted imports that bypass canonical sanitation", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-invalid-failure-ledger-"));
	const ledgerPath = path.join(directory, "ledger.jsonl");
	const imported = buildFailureImport(failureInput(), { traceValidation: validProductionTrace() });
	imported.case.initialState.files[0].path = "../outside.txt";
	await assert.rejects(
		appendFailureEvent(ledgerPath, imported),
		/refusing to append invalid failure evidence.*normalized file path inside the case workspace/,
	);
});
