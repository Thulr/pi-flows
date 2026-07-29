import { readFileSync } from "node:fs";
import { canonicalDigest } from "./calibration-key.mjs";
import { calibrationGateIssues, DEFAULT_CRITICAL_DIMENSIONS } from "./calibration.mjs";
import { CALIBRATION_SPLITS } from "./calibration-coverage.mjs";
import { sha256File } from "./release-system.mjs";

function readJson(file, label, issues) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		issues.push(`${label} could not be read as JSON: ${error.message}`);
		return null;
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

export function validateJudgedRun(file, reliability) {
	const issues = [];
	const judgedRun = readJson(file, "judged run", issues);
	let sha256 = null;
	try {
		sha256 = sha256File(file);
	} catch (error) {
		issues.push(`judged run could not be hashed: ${error.message}`);
	}
	if (sha256 !== reliability?.evaluation?.judgedRun?.sha256) {
		issues.push("judged run SHA-256 does not match reliability provenance");
	}
	const cases = new Map();
	for (const entry of judgedRun?.cases ?? []) {
		if (typeof entry?.case_id !== "string" || cases.has(entry.case_id)) {
			issues.push("judged run contains a missing or duplicate case identity");
			continue;
		}
		cases.set(entry.case_id, entry);
	}
	for (const reliabilityCase of reliability?.cases ?? []) {
		for (const trial of reliabilityCase.trials ?? []) {
			const identity = trial.traceCaseId ?? trial.trialId;
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
	const calibration = readJson(file, "calibration artifact", issues);
	let sha256 = null;
	try {
		sha256 = sha256File(file);
	} catch (error) {
		issues.push(`calibration artifact could not be hashed: ${error.message}`);
	}
	const provenance = reliability?.evaluation?.calibration;
	if (sha256 !== provenance?.sha256) issues.push("calibration artifact SHA-256 does not match reliability provenance");
	if (calibration?.key?.digest !== provenance?.keyDigest) issues.push("calibration key does not match reliability provenance");
	if (canonicalDigest(calibration?.gate ?? null, 64) !== provenance?.gateDigest) {
		issues.push("calibration gate does not match reliability provenance");
	}
	if (DEFAULT_CRITICAL_DIMENSIONS.some((dimension) => !calibration?.authority?.critical?.includes(dimension))) {
		issues.push("calibration is missing the release-critical criterion dimension");
	}
	for (const split of CALIBRATION_SPLITS) {
		if (!Number.isInteger(calibration?.splits?.[split]?.caseCount)
			|| calibration.splits[split].caseCount < 1
			|| typeof calibration.splits[split].digest !== "string"
			|| calibration.splits[split].digest.length === 0) {
			issues.push(`calibration split ${split} is incomplete`);
		}
	}
	if (!Number.isFinite(calibration?.gate?.criticalMissRateCap)) issues.push("calibration critical miss-rate cap is missing");
	try {
		const recomputed = calibrationGateIssues(calibration, { criticalMissRateCap: calibration?.gate?.criticalMissRateCap });
		if (calibration?.gate?.blocks !== (recomputed.length > 0)
			|| canonicalDigest(calibration?.gate?.issues ?? null, 64) !== canonicalDigest(recomputed, 64)) {
			issues.push("calibration gate differs from recomputed evidence");
		}
	} catch (error) {
		issues.push(`calibration evidence cannot be recomputed: ${error.message}`);
	}
	return { valid: issues.length === 0, issues, sha256, calibration };
}
