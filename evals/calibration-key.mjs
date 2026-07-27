// The calibration validity key: what a calibration was measured against.
//
// Calibration answers "how well does this judge track ground truth". That answer
// is only about the exact judge, rubric, thresholds, and trace projection it was
// measured with. Swap the judge model, reword a rubric, widen the noise band, or
// change what the trace tells the judge, and the old precision/recall numbers
// describe a system that no longer exists — but nothing stops them from being
// quoted at a release review.
//
// So calibration carries a key over every input that could move its numbers, and
// a stored calibration whose key does not match the current run is reported as
// stale with the changed inputs named. Invalidation is derived, not remembered:
// there is no "remember to bump the version" step to forget.
//
// Two of the inputs are computed rather than declared, so a change cannot slip
// past by not editing a constant: `rubric` hashes the criteria text every case
// puts in front of the judge, and `traceSerialization` hashes the attribute keys
// the trace projection actually emits.
import { createHash } from "node:crypto";

export const CALIBRATION_KEY_SCHEMA_VERSION = "pi-flows.calibration-key.v1";

/**
 * Bumped by hand when the case -> span projection changes MEANING without
 * changing its attribute keys — a renamed value vocabulary, a different fallback.
 * Shape changes are caught automatically by `traceAttributeDigest`.
 */
export const EVAL_TRACE_SCHEMA_VERSION = "pi-flows.eval-trace.v1";

/** Every input a calibration's numbers depend on. A key is exactly these fields, in this order. */
export const CALIBRATION_KEY_INPUTS = [
	"judgeModel",
	"judgeSamples",
	"judgeBin",
	"evalSet",
	"promptVersion",
	"configVersion",
	"rubric",
	"thresholds",
	"traceSchemaVersion",
	"traceSerialization",
];

function canonicalJsonValue(value) {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
}

/** One canonical digest for every calibration artifact, so two digests over the same content always agree. */
export const canonicalDigest = (value, length = 16) => createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex").slice(0, length);

/**
 * A digest over every rubric the judge reads: the primary criterion, the named
 * per-dimension criteria, and the expected behaviour each case declares.
 * Rewording any of them is a different grading instruction, so it invalidates.
 */
export function rubricDigest(cases) {
	const rubrics = {};
	for (const testCase of cases ?? []) {
		const id = testCase.id ?? testCase.name;
		if (!id) continue;
		rubrics[id] = {
			criterion: testCase.criterion ?? null,
			criteria: testCase.criteria ?? null,
			expectedBehavior: testCase.expectedBehavior ?? null,
			judgeOnlyDimensions: [...(testCase.judgeOnlyDimensions ?? [])].sort(),
		};
	}
	return canonicalDigest(rubrics);
}

/**
 * A digest over the SHAPE of the emitted trace — the union of attribute keys
 * across its spans, sorted. Adding, removing, or renaming what the judge is told
 * about a case changes this without anyone remembering to bump a version.
 */
export function traceAttributeDigest(spans) {
	const keys = new Set();
	for (const span of spans ?? []) {
		for (const key of Object.keys(span?.attributes ?? {})) keys.add(key);
	}
	return canonicalDigest([...keys].sort());
}

/** The threshold configuration a gate would apply. Loosening any of it changes what calibration means for the gate. */
export function thresholdFingerprint({ noiseBand, scoreGuardrails = [], efficiencyGuardrails = [], abstentionBand, criticalDimensions = [], coverage } = {}) {
	return {
		noiseBand: noiseBand ?? null,
		scoreGuardrails: [...scoreGuardrails].sort(),
		efficiencyGuardrails: [...efficiencyGuardrails].sort(),
		abstentionBand: abstentionBand ?? null,
		criticalDimensions: [...criticalDimensions].sort(),
		coverage: coverage ?? null,
	};
}

/**
 * The key for the current run. `inputs` is kept alongside the digest so a drift
 * report can say WHICH input moved rather than only that something did.
 *
 * @returns {{ schemaVersion: string, digest: string, inputs: Record<string, unknown> }}
 */
export function calibrationKey(rawInputs) {
	const inputs = Object.fromEntries(CALIBRATION_KEY_INPUTS.map((name) => [name, rawInputs?.[name] ?? null]));
	return { schemaVersion: CALIBRATION_KEY_SCHEMA_VERSION, digest: canonicalDigest(inputs), inputs };
}

/**
 * Compare a stored calibration's key against this run's. A run with no stored
 * calibration is `unknown` rather than valid — absence of a prior measurement is
 * not evidence the current one holds.
 *
 * @returns {{ status: "valid"|"stale"|"unknown", changed: string[] }}
 */
export function calibrationKeyDrift(stored, current) {
	if (!stored || typeof stored !== "object") return { status: "unknown", changed: [] };
	if (stored.schemaVersion !== current.schemaVersion) return { status: "stale", changed: ["schemaVersion"] };
	if (stored.digest === current.digest) return { status: "valid", changed: [] };
	const changed = CALIBRATION_KEY_INPUTS.filter(
		(name) => JSON.stringify(canonicalJsonValue(stored.inputs?.[name] ?? null)) !== JSON.stringify(canonicalJsonValue(current.inputs[name])),
	);
	// A digest mismatch with no named input means the stored key predates an input
	// being added to the list — still stale, and worth saying so plainly.
	return { status: "stale", changed: changed.length ? changed : ["(unrecorded input)"] };
}

export function formatCalibrationKeyDrift(drift, { digest }) {
	if (drift.status === "unknown") return `calibration key ${digest}: no prior calibration to compare against`;
	if (drift.status === "valid") return `calibration key ${digest}: unchanged since the stored calibration`;
	return `calibration key ${digest}: STALE — prior calibration was measured with a different ${drift.changed.join(", ")}`;
}
