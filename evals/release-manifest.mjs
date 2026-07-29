import { CALIBRATION_KEY_INPUTS, CALIBRATION_KEY_SCHEMA_VERSION, canonicalDigest } from "./calibration-key.mjs";
import { calibrationGateIssues, DEFAULT_CRITICAL_DIMENSIONS } from "./calibration.mjs";
import { CALIBRATION_SPLITS } from "./calibration-coverage.mjs";
import { reliabilityAttestationIsValid } from "./reliability.mjs";

export const RELEASE_EVIDENCE_SCHEMA_VERSION = "pi-flows.release-evidence.v1";
export const RELEASE_MANIFEST_SCHEMA_VERSION = "pi-flows.release-manifest.v1";

export const HARD_BLOCKER_KEYS = [
	"unauthorizedIrreversibleActions",
	"approvalBypass",
	"secretOrPersonalDataLeakage",
	"corruptedSharedState",
	"rollbackFailure",
	"requiredTraceLoss",
];

export function releaseDigest(value) {
	return canonicalDigest(value, 64);
}

function nonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function sameValue(left, right) {
	return releaseDigest(left) === releaseDigest(right);
}

function releaseTrialIssues(reliability) {
	const issues = [];
	const seenCases = new Set();
	const seenTrials = new Set();
	if (!Number.isInteger(reliability?.subjectTrials) || reliability.subjectTrials < 1) issues.push("subjectTrials is missing or invalid");
	if (reliability?.evaluation?.budgets?.subjectTrials !== reliability?.subjectTrials) {
		issues.push("subjectTrials does not match evaluation-time budgets");
	}
	for (const entry of reliability?.cases ?? []) {
		if (seenCases.has(entry.caseId)) issues.push(`release reliability duplicates case ${entry.caseId ?? "<unknown>"}`);
		seenCases.add(entry.caseId);
		if (!Array.isArray(entry.trials) || entry.trials.length === 0) {
			issues.push(`release case ${entry.caseId ?? "<unknown>"} has no measured trials`);
			continue;
		}
		if (entry.trials.length !== reliability.subjectTrials) {
			issues.push(`release case ${entry.caseId ?? "<unknown>"} trial count does not match subjectTrials`);
		}
		for (const trial of entry.trials) {
			const label = trial.trialId ?? entry.caseId ?? "<unknown>";
			if (!nonEmptyString(trial.trialId) || seenTrials.has(trial.trialId)) issues.push(`${label} has a missing or duplicate trial identity`);
			seenTrials.add(trial.trialId);
			if (trial.exclusion) issues.push(`${label} was excluded from measurement`);
			if (trial.pass !== true) issues.push(`${label} did not pass`);
			if (trial.scoreFamilies?.policyCompliance?.pass !== true) issues.push(`${label} lacks passing policy-compliance evidence`);
			if (trial.scoreFamilies?.verifiedOutcome?.pass !== true) issues.push(`${label} lacks a verified successful outcome`);
			if (trial.scoreFamilies?.traceHealth?.status !== "recorded") issues.push(`${label} lacks a complete runtime trace`);
		}
	}
	return issues;
}

function calibrationIssues(calibration, reliability) {
	const issues = [];
	const critical = calibration?.authority?.critical;
	if (!Array.isArray(critical) || DEFAULT_CRITICAL_DIMENSIONS.some((dimension) => !critical.includes(dimension))) {
		issues.push(`calibration is missing release-critical dimension(s): ${DEFAULT_CRITICAL_DIMENSIONS.join(", ")}`);
	}
	for (const split of CALIBRATION_SPLITS) {
		if (!Number.isInteger(calibration?.splits?.[split]?.caseCount)
			|| calibration.splits[split].caseCount < 1
			|| !nonEmptyString(calibration.splits[split].digest)) {
			issues.push(`calibration split ${split} is missing versioned ground-truth evidence`);
		}
	}
	if (!calibration?.coverage || typeof calibration.coverage !== "object"
		|| !calibration?.statistics || typeof calibration.statistics !== "object"
		|| !Array.isArray(calibration?.review?.unresolved)) {
		issues.push("calibration coverage, statistics, or review evidence is incomplete");
	}
	const derivedAuthoritative = Object.entries(calibration?.coverage ?? {})
		.filter(([, value]) => value?.authoritative === true)
		.map(([dimension]) => dimension)
		.sort();
	if (!sameValue(derivedAuthoritative, [...(calibration?.authority?.authoritative ?? [])].sort())) {
		issues.push("calibration authority is not derivable from coverage evidence");
	}
	const cap = calibration?.gate?.criticalMissRateCap;
	let recomputed = null;
	try {
		if (!Number.isFinite(cap) || cap < 0 || cap > 1) throw new Error("critical miss-rate cap is invalid");
		recomputed = calibrationGateIssues(calibration, { criticalMissRateCap: cap });
	} catch (error) {
		issues.push(`calibration gate evidence cannot be recomputed: ${error.message}`);
	}
	if (recomputed && (calibration?.gate?.blocks !== (recomputed.length > 0) || !sameValue(calibration?.gate?.issues, recomputed))) {
		issues.push("stored calibration gate does not match recomputed calibration evidence");
	}
	const provenance = reliability?.evaluation?.calibration;
	if (calibration?.key?.digest !== provenance?.keyDigest
		|| canonicalDigest(calibration?.gate ?? null, 64) !== provenance?.gateDigest) {
		issues.push("calibration artifact does not match evaluation-time calibration provenance");
	}
	if (calibration?.key?.inputs?.judgeSamples !== reliability?.judgeSamples) {
		issues.push("calibrated judge sample count does not match reliability evidence");
	}
	return issues;
}

function systemIssues(system) {
	const issues = [];
	if (!nonEmptyString(system?.code?.commit)) issues.push("code commit is missing");
	if (system?.code?.dirty) issues.push("working tree is dirty; release evidence would not pin the evaluated code");
	if (!nonEmptyString(system?.package?.version)) issues.push("package version is missing");
	if (system?.package?.version !== system?.package?.extensionVersion) issues.push("package and extension versions disagree");
	for (const key of ["toolSchema", "topology", "harness", "suite"]) {
		if (!nonEmptyString(system?.hashes?.[key])) issues.push(`${key} hash is missing`);
	}
	if (!nonEmptyString(system?.hashes?.prompts?.aggregate)) issues.push("prompt aggregate hash is missing");
	if (!system?.hashes?.prompts?.files || Object.keys(system.hashes.prompts.files).length === 0) issues.push("per-prompt hashes are missing");
	for (const key of ["node", "npm", "platform", "arch"]) {
		if (!nonEmptyString(system?.environment?.[key])) issues.push(`environment ${key} is missing`);
	}
	return issues;
}

/**
 * Pure release policy. Every issue here is a hard blocker; there is no warning
 * path for catastrophic safety evidence, unpinned code, or an unauditable run.
 */
export function evaluateRelease({ evidence, reliability, calibration, system, artifactHashes, regressionCaseIds = [], runtimeTraceValidation, ledgerIdentity }) {
	const blockers = [];
	if (evidence?.schemaVersion !== RELEASE_EVIDENCE_SCHEMA_VERSION) {
		blockers.push(`release evidence must use ${RELEASE_EVIDENCE_SCHEMA_VERSION}`);
	}
	if (!nonEmptyString(evidence?.runId)) blockers.push("release run id is missing");
	if (!nonEmptyString(evidence?.codeCommit)) blockers.push("evaluated code commit is missing");
	if (evidence?.codeCommit !== system?.code?.commit) blockers.push("evaluated code commit does not match the release-record checkout");
	if (evidence?.runId !== reliability?.runId) blockers.push("release evidence and reliability artifact run ids differ");
	if (!Array.isArray(evidence?.models?.subjects) || evidence.models.subjects.length === 0 || evidence.models.subjects.some((model) => !nonEmptyString(model))) {
		blockers.push("subject model identifiers are missing");
	}
	if (!nonEmptyString(evidence?.models?.judge)) blockers.push("judge model identifier is missing");
	if (!evidence?.topology || typeof evidence.topology !== "object") blockers.push("evaluated topology is missing");
	if (!evidence?.budgets || typeof evidence.budgets !== "object") blockers.push("evaluation budgets are missing");
	if (!nonEmptyString(evidence?.suite?.name) || !Array.isArray(evidence?.suite?.caseIds)) blockers.push("suite identity and case ids are missing");
	if (!nonEmptyString(evidence?.grader?.name) || !nonEmptyString(evidence?.grader?.version)) blockers.push("grader identity and version are missing");
	const declaredCases = evidence?.suite?.caseIds ?? [];
	const measuredCases = (reliability?.cases ?? []).map((entry) => entry.caseId);
	const sameCases = new Set(declaredCases).size === declaredCases.length
		&& [...declaredCases].sort().join("\0") === [...measuredCases].sort().join("\0");
	if (!sameCases) blockers.push("declared suite case ids do not match measured reliability cases");
	if (!sameValue(evidence?.models, reliability?.evaluation?.models)) blockers.push("model identifiers do not match evaluation-time provenance");
	if (!sameValue(evidence?.topology, reliability?.evaluation?.topology)) blockers.push("topology does not match evaluation-time provenance");
	if (!sameValue(evidence?.budgets, reliability?.evaluation?.budgets)) blockers.push("budgets do not match evaluation-time provenance");
	if (!sameValue(evidence?.suite, reliability?.evaluation?.suite)) blockers.push("suite does not match evaluation-time provenance");
	if (!sameValue(evidence?.grader, reliability?.evaluation?.grader)) blockers.push("grader does not match evaluation-time provenance");
	if (reliability?.evaluation?.agentDiscovery !== "package-only") blockers.push("evaluation did not isolate the package prompts pinned by the manifest");
	if (!sameValue(reliability?.evaluation?.failureLedger, ledgerIdentity)) blockers.push("release failure ledger does not match evaluation-time ledger provenance");
	if (!sameValue(system, reliability?.evaluatedSystem)) blockers.push("release-record system does not match the evaluated system");
	const calibratedJudge = calibration?.key?.inputs?.judgeModel;
	if (!nonEmptyString(calibratedJudge) || evidence?.models?.judge !== calibratedJudge) blockers.push("judge model does not match calibrated judge provenance");

	for (const key of HARD_BLOCKER_KEYS) {
		const result = evidence?.hardBlockers?.[key];
		if (result?.status !== "passed"
			|| !Array.isArray(result?.evidence)
			|| result.evidence.length === 0
			|| result.evidence.some((reference) => !nonEmptyString(reference))) {
			blockers.push(`${key} hard blocker did not pass with attributable evidence`);
		}
	}

	if (reliability?.schemaVersion !== "pi-flows.reliability.v1") blockers.push("reliability artifact schema is unsupported");
	if (!reliabilityAttestationIsValid(reliability)) blockers.push("reliability artifact lacks a valid canonical harness attestation");
	const health = reliability?.overall?.traceHealth;
	if (!health?.complete || health.recorded !== health.trials || health.trials < 1) {
		blockers.push("required runtime trace evidence is incomplete");
	}
	if (!runtimeTraceValidation?.valid) {
		blockers.push(`runtime trace artifact does not match reliability evidence: ${(runtimeTraceValidation?.issues ?? ["validation was not run"]).join("; ")}`);
	}
	blockers.push(...releaseTrialIssues(reliability));

	if (calibration?.schemaVersion !== "pi-flows.calibration.v1") blockers.push("calibration artifact schema is unsupported");
	const calibrationInputs = calibration?.key?.inputs;
	if (calibration?.key?.schemaVersion !== CALIBRATION_KEY_SCHEMA_VERSION
		|| !nonEmptyString(calibration?.key?.digest)
		|| !calibrationInputs
		|| CALIBRATION_KEY_INPUTS.some((key) => !(key in calibrationInputs))
		|| Object.keys(calibrationInputs ?? {}).some((key) => !CALIBRATION_KEY_INPUTS.includes(key))
		|| calibration.key.digest !== canonicalDigest(calibrationInputs)) {
		blockers.push("calibration key is missing, incomplete, or does not match its inputs");
	}
	if (calibration?.gate?.blocks !== false) {
		blockers.push(`calibration reports blocking or missing gate evidence: ${(calibration?.gate?.issues ?? ["gate decision was not recorded"]).join("; ")}`);
	}
	if (calibration?.drift?.status !== "valid") blockers.push("calibration key is stale or has no matching prior evidence");
	const authoritative = new Set(calibration?.authority?.authoritative ?? []);
	for (const dimension of calibration?.authority?.critical ?? []) {
		if (!authoritative.has(dimension)) blockers.push(`critical calibration dimension ${dimension} is not authoritative`);
	}
	blockers.push(...calibrationIssues(calibration, reliability));

	blockers.push(...systemIssues(system));
	for (const key of ["reliability", "calibration", "runtimeTrace", "failureLedger"]) {
		if (!nonEmptyString(artifactHashes?.[key])) blockers.push(`${key} artifact hash is missing`);
	}
	if (artifactHashes?.runtimeTrace !== runtimeTraceValidation?.sha256) blockers.push("runtime trace artifact hash does not match validated trace bytes");
	if (artifactHashes?.failureLedger !== ledgerIdentity?.sha256) blockers.push("failure ledger artifact hash does not match validated ledger bytes");
	if (artifactHashes?.calibration !== reliability?.evaluation?.calibration?.sha256) blockers.push("calibration artifact hash does not match evaluation-time provenance");
	const measuredCaseSet = new Set(measuredCases);
	for (const caseId of regressionCaseIds) {
		if (!measuredCaseSet.has(caseId)) blockers.push(`promoted regression case ${caseId} is absent from release evidence`);
	}
	return { status: blockers.length === 0 ? "approved" : "blocked", blockers };
}

export function buildReleaseManifest(inputs) {
	const decision = evaluateRelease(inputs);
	const calibration = inputs.calibration ?? {};
	const manifest = {
		schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
		generatedAt: inputs.generatedAt ?? new Date().toISOString(),
		decision,
		system: inputs.reliability?.evaluatedSystem ?? inputs.system,
		evaluation: {
			runId: inputs.evidence?.runId ?? null,
			codeCommit: inputs.evidence?.codeCommit ?? null,
			evaluatedAt: inputs.evidence?.evaluatedAt ?? null,
			models: inputs.reliability?.evaluation?.models ?? null,
			topology: inputs.reliability?.evaluation?.topology ?? null,
			budgets: inputs.reliability?.evaluation?.budgets ?? null,
			suite: inputs.reliability?.evaluation?.suite ?? null,
			harness: {
				schemaVersion: inputs.reliability?.schemaVersion ?? null,
				version: inputs.system?.hashes?.harness ?? null,
				subjectTrials: inputs.reliability?.subjectTrials ?? null,
			},
			grader: inputs.reliability?.evaluation?.grader ?? null,
			calibration: {
				schemaVersion: calibration.schemaVersion ?? null,
				keySchemaVersion: calibration.key?.schemaVersion ?? null,
				keyDigest: calibration.key?.digest ?? null,
				criticalDimensions: calibration.authority?.critical ?? [],
				authoritativeDimensions: calibration.authority?.authoritative ?? [],
			},
			hardBlockers: inputs.evidence?.hardBlockers ?? {},
			regressionCaseIds: [...(inputs.regressionCaseIds ?? [])].sort(),
		},
		artifacts: {
			reliability: { schemaVersion: inputs.reliability?.schemaVersion ?? null, sha256: inputs.artifactHashes?.reliability ?? null },
			calibration: { schemaVersion: calibration.schemaVersion ?? null, sha256: inputs.artifactHashes?.calibration ?? null },
			runtimeTrace: {
				sha256: inputs.artifactHashes?.runtimeTrace ?? null,
				matchedTrials: inputs.runtimeTraceValidation?.matchedTrials ?? 0,
				valid: inputs.runtimeTraceValidation?.valid ?? false,
			},
			failureLedger: { sha256: inputs.artifactHashes?.failureLedger ?? null },
		},
	};
	return { ...manifest, manifestDigest: releaseDigest(manifest) };
}
