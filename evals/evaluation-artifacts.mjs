import { readFileSync } from "node:fs";
import { canonicalDigest } from "./calibration-key.mjs";
import { calibrationPolicyIssues } from "./calibration-policy.mjs";
import { sha256Bytes, sha256File } from "./release-system.mjs";

export function readJsonSnapshot(file, label, issues = []) {
	try {
		const bytes = readFileSync(file);
		return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256Bytes(bytes) };
	} catch (error) {
		issues.push(`${label} could not be read as JSON: ${error.message}`);
		return { value: null, sha256: null };
	}
}

export function evaluationArtifactProvenance(calibrationFile, calibration, judgedRunFile) {
	return {
		calibration: {
			sha256: sha256File(calibrationFile),
			keyDigest: calibration?.key?.digest ?? null,
			gateDigest: canonicalDigest(calibration?.gate, 64),
		},
		judgedRun: { sha256: sha256File(judgedRunFile) },
	};
}

export function promotionProvenanceIssues(reliability, caseId) {
	const issues = [];
	const system = reliability?.evaluatedSystem;
	const evaluation = reliability?.evaluation;
	if (!system?.code?.commit || system.code.dirty !== false
		|| !system?.package?.name || !system.package.version || system.package.version !== system.package.extensionVersion
		|| !system?.hashes?.prompts?.aggregate || Object.keys(system?.hashes?.prompts?.files ?? {}).length === 0
		|| ["toolSchema", "topology", "harness", "suite"].some((key) => !system?.hashes?.[key])
		|| ["node", "npm", "platform", "arch"].some((key) => !system?.environment?.[key])) {
		issues.push("complete evaluated-system package, hash, and environment provenance is required");
	}
	if (evaluation?.agentDiscovery !== "package-only"
		|| !evaluation?.failureLedger?.sha256
		|| !Array.isArray(evaluation?.models?.subjects) || evaluation.models.subjects.length === 0
		|| !evaluation?.models?.judge
		|| !evaluation?.grader?.name || !evaluation.grader.version
		|| !evaluation?.topology?.cases?.[caseId]?.mode || !evaluation.topology.cases[caseId].paramsDigest
		|| !evaluation?.budgets?.cases?.[caseId]
		|| !evaluation?.calibration?.sha256 || !evaluation.calibration.keyDigest || !evaluation.calibration.gateDigest
		|| !evaluation?.judgedRun?.sha256) {
		issues.push("complete evaluation-time ledger, model, grader, topology, budget, judge, and calibration provenance is required");
	}
	return issues;
}

export function validateJudgedRun(file, reliability) {
	const issues = [];
	const { value: judgedRun, sha256 } = readJsonSnapshot(file, "judged run", issues);
	if (sha256 !== reliability?.evaluation?.judgedRun?.sha256) {
		issues.push("judged run SHA-256 does not match reliability provenance");
	}
	if (judgedRun?.repro?.judge_model !== reliability?.evaluation?.models?.judge
		|| judgedRun?.repro?.thulr_version !== reliability?.evaluation?.grader?.version) {
		issues.push("judged run judge model or grader version does not match reliability provenance");
	}
	const cases = new Map();
	for (const entry of judgedRun?.cases ?? []) {
		if (typeof entry?.case_id !== "string" || cases.has(entry.case_id)) {
			issues.push("judged run contains a missing or duplicate case identity");
			continue;
		}
		cases.set(entry.case_id, entry);
	}
	const usedCases = new Set();
	for (const reliabilityCase of reliability?.cases ?? []) {
		for (const trial of reliabilityCase.trials ?? []) {
			const identity = trial.traceCaseId ?? trial.trialId;
			if (reliability.subjectTrials > 1 && trial.traceCaseId !== trial.trialId) {
				issues.push(`${trial.trialId ?? "<unknown>"} must carry its own judged traceCaseId`);
			}
			if (usedCases.has(identity)) issues.push(`${identity ?? "<unknown>"} reuses a judged-run case`);
			usedCases.add(identity);
			const judged = cases.get(identity);
			if (!judged) {
				issues.push(`${identity ?? "<unknown>"} is absent from the judged run`);
				continue;
			}
			if (canonicalDigest(judged.dims ?? null, 64) !== canonicalDigest(trial.judge ?? null, 64)) {
				issues.push(`${identity} judge verdict differs from the judged run`);
			}
		}
	}
	return { valid: issues.length === 0, issues, sha256 };
}

export function validateCalibrationArtifact(file, reliability) {
	const issues = [];
	const { value: calibration, sha256 } = readJsonSnapshot(file, "calibration artifact", issues);
	const provenance = reliability?.evaluation?.calibration;
	if (sha256 !== provenance?.sha256) issues.push("calibration artifact SHA-256 does not match reliability provenance");
	if (calibration?.key?.digest !== provenance?.keyDigest) issues.push("calibration key does not match reliability provenance");
	if (canonicalDigest(calibration?.gate ?? null, 64) !== provenance?.gateDigest) {
		issues.push("calibration gate does not match reliability provenance");
	}
	issues.push(...calibrationPolicyIssues(calibration, reliability));
	return { valid: issues.length === 0, issues, sha256, calibration };
}
