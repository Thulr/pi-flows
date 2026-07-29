import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	HARD_BLOCKER_KEYS,
	RELEASE_EVIDENCE_SCHEMA_VERSION,
	buildReleaseManifest,
	evaluateRelease,
} from "../evals/release-manifest.mjs";
import {
	FAILURE_INPUT_SCHEMA_VERSION,
	appendFailureEvent,
	buildFailureImport,
	buildHeldOutTrialEvents,
	buildPromotionDecision,
	failureCasesFromLedger,
	readFailureLedger,
} from "../evals/failure-ledger.mjs";

const blockerEvidence = () => Object.fromEntries(HARD_BLOCKER_KEYS.map((key) => [
	key,
	{ status: "passed", evidence: [`check:${key}`] },
]));

function releaseInputs() {
	return {
		evidence: {
			schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
			runId: "release-run-123",
			codeCommit: "0123456789abcdef",
			evaluatedAt: "2026-07-28T12:00:00.000Z",
			models: { subjects: ["provider/subject-v1"], judge: "provider/judge-v2" },
			topology: { arm: "flows", modes: ["workflow", "evaluate"] },
			budgets: { maxCostUsd: 1, maxTokens: 20_000, timeoutMs: 120_000 },
			suite: { name: "release", caseIds: ["release-case"] },
			grader: { name: "thulr", version: "0.3.0" },
			hardBlockers: blockerEvidence(),
		},
		reliability: {
			schemaVersion: "pi-flows.reliability.v1",
			runId: "release-run-123",
			subjectTrials: 5,
			cases: [{
				caseId: "release-case",
				trials: Array.from({ length: 5 }, (_, index) => ({
					trialId: `release-case::trial-00${index + 1}`,
					pass: true,
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
		calibration: {
			schemaVersion: "pi-flows.calibration.v1",
			key: { schemaVersion: "pi-flows.calibration-key.v1", digest: "calibration-key" },
			drift: { status: "valid", changed: [] },
			authority: { critical: ["criterion"], authoritative: ["criterion"], provisional: [] },
			blocks: false,
		},
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
			calibration: "calibration-hash",
			runtimeTrace: "runtime-trace-hash",
		},
		generatedAt: "2026-07-28T12:30:00.000Z",
	};
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
	assert.equal(manifest.evaluation.calibration.keyDigest, "calibration-key");
	assert.equal(manifest.artifacts.runtimeTrace.sha256, "runtime-trace-hash");
	assert.match(manifest.manifestDigest, /^[a-f0-9]{64}$/);
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

	const staleCalibration = releaseInputs();
	staleCalibration.calibration.drift.status = "stale";
	assert.match(evaluateRelease(staleCalibration).blockers.join("\n"), /calibration key is stale/);

	const dirty = releaseInputs();
	dirty.system.code.dirty = true;
	assert.match(evaluateRelease(dirty).blockers.join("\n"), /working tree is dirty/);

	const wrongCommit = releaseInputs();
	wrongCommit.evidence.codeCommit = "different-commit";
	assert.match(evaluateRelease(wrongCommit).blockers.join("\n"), /evaluated code commit does not match/);

	const missingRegression = releaseInputs();
	missingRegression.regressionCaseIds = ["promoted-production-failure"];
	assert.match(evaluateRelease(missingRegression).blockers.join("\n"), /promoted regression case promoted-production-failure is absent/);
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
				sha256: "trace-digest",
			},
			failure: { summary: "The route omitted ROUTE_OK for customer@example.com.", labels: ["routing.wrong-agent"] },
			promotionPolicy: { minimumHeldOutTrials: 3, requiredPassRate: 1 },
		},
	};
}

test("validated production failures become sanitized executable capability cases", async () => {
	const imported = buildFailureImport(failureInput(), { importedAt: "2026-07-28T11:00:00.000Z" });
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
	assert.throws(() => buildFailureImport(unrelated), /unsupported fields: hiddenReasoning/);

	const traversal = failureInput();
	traversal.case.initialState.files[0].path = "../outside.txt";
	assert.throws(() => buildFailureImport(traversal), /must stay inside the case workspace/);
});

test("promotion is append-only and requires stable held-out success on one system", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-failure-ledger-"));
	const ledgerPath = path.join(directory, "ledger.jsonl");
	const imported = buildFailureImport(failureInput(), { importedAt: "2026-07-28T11:00:00.000Z" });
	await appendFailureEvent(ledgerPath, imported);

	const reliability = releaseInputs().reliability;
	reliability.runId = "held-out-run";
	reliability.cases[0].caseId = "production-routing-failure";
	reliability.cases[0].trials = reliability.cases[0].trials.slice(0, 3).map((trial, index) => ({
		...trial,
		trialId: `production-routing-failure::trial-00${index + 1}`,
	}));
	const trials = buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability,
		systemDigest: "commit-abc",
		recordedAt: "2026-07-28T12:00:00.000Z",
	});
	for (const trial of trials.slice(0, 2)) await appendFailureEvent(ledgerPath, trial);

	let ledger = await readFailureLedger(ledgerPath);
	const denied = buildPromotionDecision(ledger.events, "production-routing-failure", { decidedAt: "2026-07-28T12:30:00.000Z" });
	assert.equal(denied.decision, "denied");
	assert.match(denied.reasons.join("\n"), /requires 3 held-out trials/);
	await appendFailureEvent(ledgerPath, denied);

	await appendFailureEvent(ledgerPath, trials[2]);
	ledger = await readFailureLedger(ledgerPath);
	const approved = buildPromotionDecision(ledger.events, "production-routing-failure", { decidedAt: "2026-07-28T13:00:00.000Z" });
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
	const imported = buildFailureImport(failureInput());
	const clean = releaseInputs().reliability;
	clean.cases[0].caseId = "production-routing-failure";
	clean.cases[0].trials = clean.cases[0].trials.slice(0, 3);
	const trialEvents = buildHeldOutTrialEvents({
		caseId: "production-routing-failure",
		reliability: clean,
		systemDigest: "commit-a",
	});

	for (const mutate of [
		(event) => { event.passed = false; },
		(event) => { event.traceHealth = "missing"; },
		(event) => { event.policyPassed = false; },
	]) {
		const events = [imported, ...structuredClone(trialEvents)];
		mutate(events[1]);
		const decision = buildPromotionDecision(events, "production-routing-failure");
		assert.equal(decision.decision, "denied");
	}

	const mixed = [imported, ...structuredClone(trialEvents)];
	mixed[1].systemDigest = "commit-b";
	assert.match(buildPromotionDecision(mixed, "production-routing-failure").reasons.join("\n"), /same evaluated system/);
});

test("failure ledger detects edits to prior append-only records", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-flow-tampered-ledger-"));
	const ledgerPath = path.join(directory, "ledger.jsonl");
	await appendFailureEvent(ledgerPath, buildFailureImport(failureInput()));
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
