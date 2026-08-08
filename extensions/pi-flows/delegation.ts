import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { ENVELOPE_VERSION, ResolvedDelegationContract, canonicalSha256, isRecord, nonEmptyString, storedError, stringArray } from "./contract-resolution.ts";
import { extractLastJsonBlock } from "./protocol.ts";
import { Run } from "./run.ts";
import { capModelVisibleText, isFailed, redactValue, resultText } from "./sanitize.ts";
import { flowError, type CapturePolicy, type DelegationHandoffEnvelope, type DelegationReturnEnvelope, type FlowError, type FlowRunResult, type IncompleteHandoffPolicy } from "./types.ts";

// Contract identity/admission live in contract-resolution.ts; re-exported here.
export { ResolvedDelegationContract, canonicalJsonValue, canonicalSha256, delegationContractId, isRecord, validateDelegationContract } from "./contract-resolution.ts";

const ENVELOPE_STATUSES = new Set(["completed", "partial", "blocked", "failed"]);

export interface PersistedHandoffAttestation {
	schemaVersion: "pi-flows.handoff-attestation.v1";
	contractId: string | null;
	compatibility: DelegationHandoffEnvelope["compatibility"];
	status: DelegationHandoffEnvelope["status"];
	handoffDigest: string;
	validation: "typed" | "legacy-compatibility";
}

function envelopeError(reason: string): FlowError {
	return flowError(
		"RETURN_ENVELOPE_INVALID",
		"Child return envelope is invalid.",
		reason,
		"Return the documented pi-flows.return-envelope.v1 JSON object and ensure `data` satisfies contract.returnSchema.",
	);
}

function validateEnvelopeShape(value: unknown): value is DelegationReturnEnvelope {
	if (!isRecord(value) || value.schemaVersion !== ENVELOPE_VERSION || !ENVELOPE_STATUSES.has(value.status) || !nonEmptyString(value.summary)) return false;
	if (value.contractId !== undefined && !/^sha256:[a-f0-9]{64}$/i.test(value.contractId)) return false;
	if (!Array.isArray(value.evidence) || !value.evidence.every((item: unknown) => isRecord(item) && nonEmptyString(item.claim) && nonEmptyString(item.source))) return false;
	if (!Array.isArray(value.artifactReferences) || !value.artifactReferences.every((item: unknown) => isRecord(item) && nonEmptyString(item.path))) return false;
	if (!Array.isArray(value.digests) || !value.digests.every((item: unknown) => isRecord(item) && nonEmptyString(item.artifact) && item.algorithm === "sha256" && /^[a-f0-9]{64}$/i.test(item.value))) return false;
	if (!stringArray(value.changedState) || !stringArray(value.unresolvedQuestions)) return false;
	if (!isRecord(value.retry) || typeof value.retry.retryable !== "boolean") return false;
	if (value.retry.reason !== undefined && !nonEmptyString(value.retry.reason)) return false;
	if (value.retry.afterMs !== undefined && (typeof value.retry.afterMs !== "number" || !Number.isFinite(value.retry.afterMs) || value.retry.afterMs < 0)) return false;
	return Object.hasOwn(value, "data");
}

function artifactFile(cwd: string, artifact: string): { file?: string; error?: FlowError } {
	const resolved = path.resolve(cwd, artifact);
	const relative = path.relative(path.resolve(cwd), resolved);
	if (path.isAbsolute(relative) || relative.startsWith("..")) {
		return { error: envelopeError(`Artifact reference escapes the child cwd: ${artifact}.`) };
	}
	if (!existsSync(resolved)) return { error: envelopeError(`Artifact reference does not exist: ${artifact}.`) };
	try {
		const realCwd = realpathSync(cwd);
		const realFile = realpathSync(resolved);
		const realRelative = path.relative(realCwd, realFile);
		if (path.isAbsolute(realRelative) || realRelative.startsWith("..")) {
			return { error: envelopeError(`Artifact reference resolves outside the child cwd: ${artifact}.`) };
		}
		if (!statSync(realFile).isFile()) return { error: envelopeError(`Artifact reference is not a regular file: ${artifact}.`) };
		return { file: realFile };
	} catch (error) {
		return { error: envelopeError(`Artifact reference could not be inspected: ${artifact} (${error instanceof Error ? error.message : String(error)}).`) };
	}
}

function validateDigests(envelope: DelegationReturnEnvelope, cwd: string): FlowError | null {
	const referenced = new Set(envelope.artifactReferences.map((artifact) => artifact.path));
	for (const artifact of referenced) {
		const checked = artifactFile(cwd, artifact);
		if (checked.error) return checked.error;
	}
	for (const digest of envelope.digests) {
		if (!referenced.has(digest.artifact)) return envelopeError(`Digest target is not declared in artifactReferences: ${digest.artifact}.`);
		const artifact = artifactFile(cwd, digest.artifact);
		if (artifact.error) return artifact.error;
		let actual;
		try {
			actual = createHash("sha256").update(readFileSync(artifact.file!)).digest("hex");
		} catch (error) {
			return envelopeError(`Artifact could not be read for digest verification: ${digest.artifact} (${error instanceof Error ? error.message : String(error)}).`);
		}
		if (actual !== digest.value.toLowerCase()) {
			return flowError(
				"RETURN_DIGEST_MISMATCH",
				"Child artifact digest did not match.",
				`Artifact ${digest.artifact} reported ${digest.value.toLowerCase()} but its SHA-256 digest is ${actual}.`,
				"Treat the handoff as untrusted. Regenerate the artifact and envelope together, then retry.",
			);
		}
	}
	return null;
}

function validateEnvelopeAgainstContract(
	envelope: DelegationReturnEnvelope,
	contract: ResolvedDelegationContract,
	cwd: string,
): FlowError | null {
	if (envelope.contractId !== contract.id) {
		const actual = envelope.contractId ?? "(missing)";
		return flowError(
			"RETURN_CONTRACT_MISMATCH",
			"Child return envelope did not match the dispatched contract.",
			`Expected contractId ${contract.id}, received ${actual}.`,
			"Discard the stale or unbound handoff and rerun the child with the current delegation contract.",
		);
	}
	if (!contract.checkReturnData(envelope.data)) return envelopeError("Envelope `data` does not satisfy contract.returnSchema.");
	return validateDigests(envelope, cwd);
}

function storedEnvelope(envelope: DelegationReturnEnvelope, policy: CapturePolicy): DelegationReturnEnvelope {
	const stored = (value: string) => redactValue(value, policy) as string;
	return {
		...envelope,
		summary: stored(envelope.summary),
		evidence: envelope.evidence.map(({ claim, source }) => ({ claim: stored(claim), source: stored(source) })),
		artifactReferences: envelope.artifactReferences.map(({ path: artifact }) => ({ path: stored(artifact) })),
		digests: envelope.digests.map((digest) => ({ ...digest, artifact: stored(digest.artifact) })),
		changedState: envelope.changedState.map(stored),
		unresolvedQuestions: envelope.unresolvedQuestions.map(stored),
		retry: { ...envelope.retry, ...(envelope.retry.reason ? { reason: stored(envelope.retry.reason) } : {}) },
		data: redactValue(envelope.data, policy),
	};
}

/**
 * Identity is always checked. An envelope naming a different contract, or none,
 * was not produced under the terms this child was dispatched with, and no caller
 * has ever wanted to accept one — making it optional only created call sites
 * that could forget.
 *
 * Module-private: `prepareIntegrationHandoff` is the one transition through
 * which a child result becomes integrable.
 *
 * @returns on success, the stored envelope. On rejection, the error — plus
 *   `rejected`, the child's own claims in stored form, when the envelope was at
 *   least structurally an envelope. A digest mismatch is exactly when those
 *   claims matter most: the artifact it named and the digest it asserted are the
 *   evidence of what went wrong, and discarding them loses the corruption along
 *   with the trust.
 */
function validateReturnEnvelope(
	result: FlowRunResult,
	contract: ResolvedDelegationContract,
	cwd: string,
	policy: CapturePolicy,
): { envelope?: DelegationReturnEnvelope; error?: FlowError; rejected?: DelegationReturnEnvelope } {
	const run = Run.of(result);
	const parsed = extractLastJsonBlock(run.takeEnvelopeCandidate() ?? resultText(result));
	if (!validateEnvelopeShape(parsed)) return { error: storedError(envelopeError("The child did not return a structurally valid pi-flows.return-envelope.v1 object."), policy) };
	const validationError = validateEnvelopeAgainstContract(parsed, contract, cwd);
	if (validationError) return { error: storedError(validationError, policy), rejected: storedEnvelope(parsed, policy) };
	const validated = { ...parsed, usage: result.usage };
	const envelope = storedEnvelope(validated, policy);
	run.acceptReturnEnvelope(validated, envelope);
	return { envelope };
}

export function canonicalEnvelope(envelope: DelegationReturnEnvelope): string {
	return JSON.stringify(envelope);
}

export function typedHandoff(result: FlowRunResult, envelope: DelegationReturnEnvelope, contract: ResolvedDelegationContract): DelegationHandoffEnvelope {
	return {
		schemaVersion: "pi-flows.handoff-envelope.v1",
		contractId: contract.id,
		compatibility: "typed",
		status: envelope.status,
		summary: envelope.summary,
		evidence: envelope.evidence,
		artifactReferences: envelope.artifactReferences,
		digests: envelope.digests,
		changedState: envelope.changedState,
		unresolvedQuestions: envelope.unresolvedQuestions,
		retry: envelope.retry,
		data: envelope.data,
		provenance: { agent: result.agent, ...(result.step === undefined ? {} : { step: result.step }) },
		usage: envelope.usage,
	};
}

export function compatibilityHandoff(result: FlowRunResult, policy: CapturePolicy): DelegationHandoffEnvelope {
	const text = redactValue(capModelVisibleText(resultText(result)), policy) as string;
	return {
		schemaVersion: "pi-flows.handoff-envelope.v1",
		contractId: null,
		compatibility: "legacy-prose",
		status: isFailed(result) ? "failed" : "completed",
		summary: text,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { text },
		provenance: { agent: result.agent, ...(result.step === undefined ? {} : { step: result.step }) },
		usage: result.usage,
	};
}

function incompleteEnvelopeError(handoff: DelegationHandoffEnvelope): FlowError {
	const resolution = handoff.status === "failed"
		? "Retry the failed child and require a completed, partial, or blocked handoff before integration. Failed handoffs remain terminal."
		: 'Resolve or retry the child, or explicitly set incompleteHandoffPolicy:"include" to synthesize while preserving the incomplete status and provenance.';
	return flowError(
		"RETURN_ENVELOPE_INCOMPLETE",
		`Child returned a ${handoff.status} handoff that cannot be integrated.`,
		`Contract ${handoff.contractId ?? "(legacy)"} from ${handoff.provenance.agent} reported status "${handoff.status}" with ${handoff.unresolvedQuestions.length} unresolved question(s).`,
		resolution,
		handoff.retry.retryable,
	);
}

function canIncludeIncompleteHandoff(handoff: DelegationHandoffEnvelope, policy: IncompleteHandoffPolicy | undefined): boolean {
	return policy === "include" && (handoff.status === "partial" || handoff.status === "blocked");
}

export function validatePersistedIntegrationHandoff(
	value: unknown,
	options: {
		attestation: unknown;
		contract?: ResolvedDelegationContract;
		policy: CapturePolicy;
		incompletePolicy?: IncompleteHandoffPolicy;
	},
): FlowError | null {
	if (!isRecord(value)) return storedError(envelopeError("Persisted workflow handoff is missing or not an object."), options.policy);
	if (value.schemaVersion !== "pi-flows.handoff-envelope.v1"
		|| !isRecord(value.provenance)
		|| !nonEmptyString(value.provenance.agent)
		|| (value.provenance.step !== undefined && (!Number.isInteger(value.provenance.step) || value.provenance.step < 0))) {
		return storedError(envelopeError("Persisted workflow handoff metadata or provenance is structurally invalid."), options.policy);
	}
	const envelope = {
		schemaVersion: ENVELOPE_VERSION,
		...(typeof value.contractId === "string" ? { contractId: value.contractId } : {}),
		status: value.status,
		summary: value.summary,
		evidence: value.evidence,
		artifactReferences: value.artifactReferences,
		digests: value.digests,
		changedState: value.changedState,
		unresolvedQuestions: value.unresolvedQuestions,
		retry: value.retry,
		data: value.data,
	};
	if (!validateEnvelopeShape(envelope)) {
		return storedError(envelopeError("Persisted workflow handoff is structurally invalid."), options.policy);
	}
	if (options.contract) {
		if (value.compatibility !== "typed") {
			return storedError(envelopeError("Persisted contracted workflow phase is not a contract-bound handoff envelope."), options.policy);
		}
		const expected = options.contract.id;
		if (envelope.contractId !== expected) {
			return storedError(flowError(
				"RETURN_CONTRACT_MISMATCH",
				"Persisted workflow handoff did not match the current phase contract.",
				`Expected contractId ${expected}, received ${envelope.contractId ?? "(missing)"}.`,
				"Discard the stale workflow state and rerun the phase with the current delegation contract.",
			), options.policy);
		}
	} else if (value.compatibility !== "legacy-prose" || value.contractId !== null) {
		return storedError(envelopeError("Persisted legacy workflow phase is not a valid compatibility envelope."), options.policy);
	}
	const attestation = options.attestation;
	const expectedValidation = options.contract ? "typed" : "legacy-compatibility";
	if (!isRecord(attestation)
		|| attestation.schemaVersion !== "pi-flows.handoff-attestation.v1"
		|| attestation.contractId !== value.contractId
		|| attestation.compatibility !== value.compatibility
		|| attestation.status !== value.status
		|| attestation.validation !== expectedValidation
		|| attestation.handoffDigest !== handoffStorageDigest(value)) {
		return storedError(envelopeError("Persisted workflow handoff validation attestation is missing or does not match the stored handoff."), options.policy);
	}
	const handoff = value as unknown as DelegationHandoffEnvelope;
	if (handoff.status !== "completed" && !canIncludeIncompleteHandoff(handoff, options.incompletePolicy)) {
		return storedError(incompleteEnvelopeError(handoff), options.policy);
	}
	return null;
}

function handoffStorageDigest(handoff: unknown): string {
	return canonicalSha256(handoff);
}

export function createPersistedHandoffAttestation(handoff: DelegationHandoffEnvelope): PersistedHandoffAttestation {
	return {
		schemaVersion: "pi-flows.handoff-attestation.v1",
		contractId: handoff.contractId,
		compatibility: handoff.compatibility,
		status: handoff.status,
		handoffDigest: handoffStorageDigest(handoff),
		validation: handoff.compatibility === "typed" ? "typed" : "legacy-compatibility",
	};
}

/**
 * Proof that one child result validated under one contract identity, cwd, and
 * capture policy — an opaque token presented back for deferred consumption. It
 * carries its cloned envelope and handoff privately, so a second pass reuses
 * exactly what was validated instead of re-running filesystem digest checks.
 */
class IntegrationValidation {
	// ECMAScript-private: TS `private` fields stay writable at runtime, and a
	// mutated snapshot presented back would integrate without revalidation.
	readonly #result: FlowRunResult;
	readonly #contractId: string;
	readonly #cwd: string;
	readonly #policy: CapturePolicy;
	readonly #envelope: DelegationReturnEnvelope;
	readonly #handoff: DelegationHandoffEnvelope;

	constructor(result: FlowRunResult, contractId: string, cwd: string, policy: CapturePolicy, envelope: DelegationReturnEnvelope, handoff: DelegationHandoffEnvelope) {
		this.#result = result;
		this.#contractId = contractId;
		this.#cwd = cwd;
		this.#policy = policy;
		this.#envelope = envelope;
		this.#handoff = handoff;
		// Frozen against own-method decoration; reuse never dispatches through it anyway.
		Object.freeze(this);
	}

	/**
	 * Brand-checked, module-dispatched reuse: nothing is looked up THROUGH the
	 * token, so a patched token substitutes neither checks nor snapshots; the
	 * `#field in` brand subsumes `instanceof` and cannot be forged.
	 */
	static reuse(
		token: object | undefined,
		result: FlowRunResult,
		contractId: string,
		cwd: string,
		policy: CapturePolicy,
	): { envelope: DelegationReturnEnvelope; handoff: DelegationHandoffEnvelope } | undefined {
		// typeof guard: a primitive token is "no reuse", not a TypeError from `in`.
		if (!token || typeof token !== "object" || !(#envelope in token)) return undefined;
		const received = token as IntegrationValidation;
		const reusable = received.#result === result
			&& received.#contractId === contractId
			&& received.#cwd === cwd
			&& received.#policy.recordContent === policy.recordContent
			&& received.#policy.redactSecrets === policy.redactSecrets;
		if (!reusable) return undefined;
		return { envelope: structuredClone(received.#envelope), handoff: structuredClone(received.#handoff) };
	}
}

Object.freeze(IntegrationValidation.prototype);
Object.freeze(IntegrationValidation);

export function prepareIntegrationHandoff(
	result: FlowRunResult,
	options: {
		contract?: ResolvedDelegationContract;
		cwd: string;
		policy: CapturePolicy;
		incompletePolicy?: IncompleteHandoffPolicy;
		attach?: boolean;
		enforceCompletion?: boolean;
		/** Opaque receipt returned by a prior successful call for deferred consumption. */
		validation?: object;
	},
): { handoff?: DelegationHandoffEnvelope; validation?: object; error?: FlowError; rejected?: DelegationReturnEnvelope } {
	let handoff: DelegationHandoffEnvelope;
	let returned: DelegationReturnEnvelope | undefined;
	let validation = options.validation;
	if (options.contract) {
		const reused = IntegrationValidation.reuse(validation, result, options.contract.id, options.cwd, options.policy);
		if (reused) {
			returned = reused.envelope;
			handoff = reused.handoff;
		} else {
			const validated = validateReturnEnvelope(result, options.contract, options.cwd, options.policy);
			if (validated.error) return { error: validated.error, ...(validated.rejected ? { rejected: validated.rejected } : {}) };
			returned = validated.envelope!;
			handoff = typedHandoff(result, returned, options.contract);
			validation = new IntegrationValidation(result, options.contract.id, options.cwd, { ...options.policy }, structuredClone(returned), structuredClone(handoff));
		}
	} else {
		handoff = compatibilityHandoff(result, options.policy);
		validation = undefined;
	}
	if (options.enforceCompletion !== false && handoff.status !== "completed" && !canIncludeIncompleteHandoff(handoff, options.incompletePolicy)) {
		// A partial or blocked envelope is refused, but its artifact and digest
		// claims are the evidence of what the child touched before it stopped.
		// Returning them as rejected evidence keeps those artifacts in the trace,
		// exactly as a digest mismatch does.
		return { error: storedError(incompleteEnvelopeError(handoff), options.policy), ...(returned ? { rejected: returned } : {}) };
	}
	if (options.attach !== false) Run.of(result).acceptHandoff(handoff);
	return { handoff, ...(validation ? { validation } : {}) };
}

export function canonicalHandoff(handoff: DelegationHandoffEnvelope): string {
	return JSON.stringify(handoff);
}

export function integrationControlText(result: FlowRunResult): string {
	return result.handoff?.compatibility === "typed" ? JSON.stringify(result.handoff.data) : resultText(result);
}

export function incompleteHandoffSummary(results: FlowRunResult[], persistedHandoffs: DelegationHandoffEnvelope[] = []): string {
	const handoffs = [
		...results.flatMap((result) => result.handoff ? [result.handoff] : []),
		...persistedHandoffs,
	];
	const incomplete = handoffs.flatMap((handoff) =>
		handoff.status !== "completed"
			? [`${handoff.provenance.agent}:${handoff.status}`]
			: [],
	);
	return incomplete.length ? ` Included incomplete handoffs by explicit policy: ${incomplete.join(", ")}.` : "";
}
