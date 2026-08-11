// Derive the release evidence object from an evaluation that just ran.
//
// The operator-written evidence file exists so a human transcribes the run's
// provenance and asserts the six hard blockers. Every provenance field the gate
// checks — models, topology, budgets, suite, grader — is checked against the
// reliability artifact's own record, so transcribing them by hand can only ever
// introduce a mismatch. Deriving them drops that step without weakening a check.
//
// The hard blockers are the part no artifact can supply. They stay an explicit
// operator assertion: absent one, this records `not-attested`, which the gate
// rejects for missing attributable evidence.
import { HARD_BLOCKER_KEYS, RELEASE_EVIDENCE_SCHEMA_VERSION } from "./release-manifest.mjs";

/**
 * Build the `pi-flows.release-evidence.v1` object for a reliability artifact.
 *
 * @param {object} reliability Parsed reliability artifact from the run being decided.
 * @param {boolean} attested Whether the operator attested all six hard blockers.
 * @returns {object} Evidence in the shape `evaluateRelease` consumes.
 */
export function deriveEvidence(reliability, attested) {
	const evaluation = reliability?.evaluation ?? {};
	const blocker = attested
		? { status: "passed", evidence: [`operator-attested:${reliability?.runId ?? "unknown"}`] }
		: { status: "not-attested", evidence: [] };
	return {
		schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
		runId: reliability?.runId ?? null,
		codeCommit: reliability?.evaluatedSystem?.code?.commit ?? null,
		evaluatedAt: reliability?.generatedAt ?? null,
		models: evaluation.models,
		topology: evaluation.topology,
		budgets: evaluation.budgets,
		suite: evaluation.suite,
		grader: evaluation.grader,
		hardBlockers: Object.fromEntries(HARD_BLOCKER_KEYS.map((key) => [key, blocker])),
	};
}
