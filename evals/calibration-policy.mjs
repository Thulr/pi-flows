import { CALIBRATION_KEY_INPUTS, CALIBRATION_KEY_SCHEMA_VERSION, canonicalDigest } from "./calibration-key.mjs";
import { calibrationGateIssues, DEFAULT_CRITICAL_DIMENSIONS } from "./calibration.mjs";
import { CALIBRATION_SPLITS } from "./calibration-coverage.mjs";

const text = (value) => typeof value === "string" && value.length > 0;
const same = (left, right) => canonicalDigest(left, 64) === canonicalDigest(right, 64);

export function calibrationPolicyIssues(calibration, reliability) {
	const issues = [];
	const inputs = calibration?.key?.inputs;
	if (calibration?.schemaVersion !== "pi-flows.calibration.v1"
		|| calibration?.key?.schemaVersion !== CALIBRATION_KEY_SCHEMA_VERSION
		|| !inputs
		|| CALIBRATION_KEY_INPUTS.some((key) => !(key in inputs))
		|| Object.keys(inputs ?? {}).some((key) => !CALIBRATION_KEY_INPUTS.includes(key))
		|| calibration.key.digest !== canonicalDigest(inputs)) {
		issues.push("calibration key is missing, incomplete, or does not match its inputs");
	}
	if (!["valid", "unknown", "stale"].includes(calibration?.drift?.status)) issues.push("calibration drift provenance is missing");
	if (inputs?.judgeModel !== reliability?.evaluation?.models?.judge || inputs?.judgeSamples !== reliability?.judgeSamples) {
		issues.push("calibrated judge identity or sample count does not match reliability provenance");
	}
	const critical = calibration?.authority?.critical;
	if (!Array.isArray(critical) || DEFAULT_CRITICAL_DIMENSIONS.some((dimension) => !critical.includes(dimension))) {
		issues.push(`calibration is missing release-critical dimension(s): ${DEFAULT_CRITICAL_DIMENSIONS.join(", ")}`);
	}
	for (const split of CALIBRATION_SPLITS) {
		if (!Number.isInteger(calibration?.splits?.[split]?.caseCount)
			|| calibration.splits[split].caseCount < 1
			|| !text(calibration.splits[split].digest)) {
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
	if (!same(derivedAuthoritative, [...(calibration?.authority?.authoritative ?? [])].sort())) {
		issues.push("calibration authority is not derivable from coverage evidence");
	}
	for (const dimension of critical ?? []) {
		const missed = calibration?.statistics?.[dimension]?.detection?.falseNegativeRate;
		if (!Number.isFinite(missed?.value)
			|| !Number.isInteger(missed?.samples) || missed.samples < 1
			|| !Number.isFinite(missed?.confidence95?.upper)) {
			issues.push(`critical calibration dimension ${dimension} lacks complete missed-defect statistics`);
		}
	}
	const cap = calibration?.gate?.criticalMissRateCap;
	let recomputed = null;
	try {
		if (!Number.isFinite(cap) || cap < 0 || cap > 1) throw new Error("critical miss-rate cap is invalid");
		recomputed = calibrationGateIssues(calibration, { criticalMissRateCap: cap });
	} catch (error) {
		issues.push(`calibration gate evidence cannot be recomputed: ${error.message}`);
	}
	if (recomputed && (calibration?.gate?.blocks !== (recomputed.length > 0) || !same(calibration?.gate?.issues, recomputed))) {
		issues.push("stored calibration gate does not match recomputed calibration evidence");
	}
	if (recomputed) issues.push(...recomputed);
	const provenance = reliability?.evaluation?.calibration;
	if (calibration?.key?.digest !== provenance?.keyDigest
		|| canonicalDigest(calibration?.gate ?? null, 64) !== provenance?.gateDigest) {
		issues.push("calibration artifact does not match evaluation-time calibration provenance");
	}
	return issues;
}
