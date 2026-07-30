import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { Compile } from "typebox/compile";
import { extractLastJsonBlock } from "./protocol.ts";
import { capModelVisibleText, isFailed, redactValue, resultText, takeRawFinalAssistantText } from "./sanitize.ts";
import { flowError, type CapturePolicy, type ContractBudget, type DelegationContract, type DelegationHandoffEnvelope, type DelegationReturnEnvelope, type FlowError, type FlowRunResult, type IncompleteHandoffPolicy } from "./types.ts";
import { appendReturnRequirements } from "./validate.ts";

const ENVELOPE_VERSION = "pi-flows.return-envelope.v1";
const SIDE_EFFECT_CLASSES = new Set(["none", "read-only", "reversible", "irreversible"]);
const ENVELOPE_STATUSES = new Set(["completed", "partial", "blocked", "failed"]);

type RecordValue = Record<string, any>;

export interface PersistedHandoffAttestation {
	schemaVersion: "pi-flows.handoff-attestation.v1";
	contractId: string | null;
	compatibility: DelegationHandoffEnvelope["compatibility"];
	status: DelegationHandoffEnvelope["status"];
	handoffDigest: string;
	validation: "typed" | "legacy-compatibility";
}

export function isRecord(value: unknown): value is RecordValue {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(nonEmptyString);
}

/** Recursively key-sorted JSON, so a digest identifies content rather than authoring order. Shared with approval receipts so every binding digest in the extension canonicalizes the same way. */
export function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
}

/** One canonical digest for every content identity in the extension, so two digests over the same content always agree. */
export function canonicalSha256(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(canonicalJsonValue(value))).digest("hex")}`;
}

export function delegationContractId(contract: DelegationContract): string {
	return canonicalSha256(contract);
}

function contractError(reason: string): FlowError {
	return flowError(
		"INVALID_DELEGATION_CONTRACT",
		"Delegation contract is invalid.",
		reason,
		"Provide every required contract field with the documented type before dispatching a child.",
	);
}

function rawDelegationContractError(value: unknown): FlowError | null {
	if (!isRecord(value)) return contractError("`contract` must be an object.");
	if (!nonEmptyString(value.objective)) return contractError("`contract.objective` must be a non-empty string.");
	for (const field of ["constraints", "nonGoals", "dependencies", "acceptanceChecks"]) {
		if (!stringArray(value[field])) return contractError(`\`contract.${field}\` must be an array of non-empty strings.`);
	}
	if (!isRecord(value.authority)) return contractError("`contract.authority` must be an object.");
	for (const field of ["may", "mustNot", "requiresApproval"]) {
		if (!stringArray(value.authority[field])) return contractError(`\`contract.authority.${field}\` must be an array of non-empty strings.`);
	}
	if (!SIDE_EFFECT_CLASSES.has(value.sideEffectClass)) {
		return contractError("`contract.sideEffectClass` must be none, read-only, reversible, or irreversible.");
	}
	if (!isRecord(value.budget)) return contractError("`contract.budget` must be an object.");
	for (const [key, limit] of Object.entries(value.budget)) {
		if (!["timeoutMs", "maxCostUsd", "maxTokens", "maxGeneratedTokens"].includes(key) || typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
			return contractError(`\`contract.budget.${key}\` must be a non-negative finite number.`);
		}
	}
	if (!isRecord(value.returnSchema)) return contractError("`contract.returnSchema` must be a JSON Schema object.");
	try {
		Compile(value.returnSchema);
	} catch (error) {
		return contractError(`\`contract.returnSchema\` could not be compiled: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!nonEmptyString(value.owner)) return contractError("`contract.owner` must be a non-empty string.");
	return null;
}

export function validateDelegationContract(
	value: unknown,
	policy: CapturePolicy = { recordContent: true, redactSecrets: true },
): FlowError | null {
	const error = rawDelegationContractError(value);
	return error ? storedError(error, policy) : null;
}

export function renderDelegationTask(
	task: string | undefined,
	contract: DelegationContract,
	returnContract?: string,
	requireEvidence?: boolean,
): string {
	const goal = task?.trim() || contract.objective;
	const contractId = delegationContractId(contract);
	return [
		appendReturnRequirements(goal, returnContract, requireEvidence),
			"\n## Delegation contract",
		JSON.stringify(contract, null, 2),
		"\n## Required return protocol",
		`Return one JSON object in a fenced \`json\` block using schemaVersion "${ENVELOPE_VERSION}".`,
		`Set contractId to exactly "${contractId}" so downstream consumers can reject missing or stale returns.`,
		"Required fields: schemaVersion, contractId, status, summary, evidence, artifactReferences, digests, changedState, unresolvedQuestions, retry, and data.",
		"`data` must satisfy contract.returnSchema. Evidence items use {claim, source}. Artifact references use {path}. Digests use {artifact, algorithm:\"sha256\", value}.",
		"Use empty arrays when no evidence, artifacts, digests, changed state, or unresolved questions exist. Do not report success as prose outside the envelope.",
	].join("\n");
}

export function createDelegationBudget(contract: DelegationContract): ContractBudget | undefined {
	const { maxCostUsd, maxTokens, maxGeneratedTokens } = contract.budget;
	if (maxCostUsd === undefined && maxTokens === undefined && maxGeneratedTokens === undefined) return undefined;
	return { maxCostUsd, maxTokens, maxGeneratedTokens, spentCost: 0, spentTokens: 0, spentGeneratedTokens: 0 };
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
	contract: DelegationContract,
	cwd: string,
): FlowError | null {
	const expected = delegationContractId(contract);
	if (envelope.contractId !== expected) {
		const actual = envelope.contractId ?? "(missing)";
		return flowError(
			"RETURN_CONTRACT_MISMATCH",
			"Child return envelope did not match the dispatched contract.",
			`Expected contractId ${expected}, received ${actual}.`,
			"Discard the stale or unbound handoff and rerun the child with the current delegation contract.",
		);
	}
	let validator;
	try {
		validator = Compile(contract.returnSchema);
	} catch (error) {
		return contractError(`\`contract.returnSchema\` could not be compiled: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!validator.Check(envelope.data)) return envelopeError("Envelope `data` does not satisfy contract.returnSchema.");
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

function storedError(error: FlowError, policy: CapturePolicy): FlowError {
	return { ...error, cause: redactValue(error.cause, policy) as string };
}

/**
 * Identity is always checked. An envelope naming a different contract, or none,
 * was not produced under the terms this child was dispatched with, and no caller
 * has ever wanted to accept one — making it optional only created call sites
 * that could forget.
 *
 * @returns on success, the stored envelope. On rejection, the error — plus
 *   `rejected`, the child's own claims in stored form, when the envelope was at
 *   least structurally an envelope. A digest mismatch is exactly when those
 *   claims matter most: the artifact it named and the digest it asserted are the
 *   evidence of what went wrong, and discarding them loses the corruption along
 *   with the trust.
 */
export function validateReturnEnvelope(
	result: FlowRunResult,
	contract: DelegationContract,
	cwd: string,
	policy: CapturePolicy,
): { envelope?: DelegationReturnEnvelope; error?: FlowError; rejected?: DelegationReturnEnvelope } {
	const parsed = extractLastJsonBlock(takeRawFinalAssistantText(result) ?? resultText(result));
	if (!validateEnvelopeShape(parsed)) return { error: storedError(envelopeError("The child did not return a structurally valid pi-flows.return-envelope.v1 object."), policy) };
	const validationError = validateEnvelopeAgainstContract(parsed, contract, cwd);
	if (validationError) return { error: storedError(validationError, policy), rejected: storedEnvelope(parsed, policy) };
	const envelope = storedEnvelope({ ...parsed, usage: result.usage }, policy);
	result.envelope = envelope;
	return { envelope };
}

export function canonicalEnvelope(envelope: DelegationReturnEnvelope): string {
	return JSON.stringify(envelope);
}

export function typedHandoff(result: FlowRunResult, envelope: DelegationReturnEnvelope, contract: DelegationContract): DelegationHandoffEnvelope {
	return {
		schemaVersion: "pi-flows.handoff-envelope.v1",
		contractId: delegationContractId(contract),
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
		contract?: DelegationContract;
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
		const expected = delegationContractId(options.contract);
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

export function prepareIntegrationHandoff(
	result: FlowRunResult,
	options: {
		contract?: DelegationContract;
		cwd: string;
		policy: CapturePolicy;
		incompletePolicy?: IncompleteHandoffPolicy;
		attach?: boolean;
		enforceCompletion?: boolean;
		validated?: {
			contractId: string;
			envelope: DelegationReturnEnvelope;
			handoff: DelegationHandoffEnvelope;
		};
	},
): { handoff?: DelegationHandoffEnvelope; error?: FlowError; rejected?: DelegationReturnEnvelope } {
	let handoff: DelegationHandoffEnvelope;
	let returned: DelegationReturnEnvelope | undefined;
	if (options.contract) {
		const expectedContractId = delegationContractId(options.contract);
		const reusable = options.validated?.contractId === expectedContractId
			&& options.validated.envelope.contractId === expectedContractId
			&& options.validated.handoff.contractId === expectedContractId
			&& options.validated.handoff.compatibility === "typed"
			? options.validated
			: undefined;
		if (reusable) {
			returned = reusable.envelope;
			handoff = reusable.handoff;
		} else {
			const validated = validateReturnEnvelope(result, options.contract, options.cwd, options.policy);
			if (validated.error) return { error: validated.error, ...(validated.rejected ? { rejected: validated.rejected } : {}) };
			returned = validated.envelope!;
			handoff = typedHandoff(result, returned, options.contract);
		}
	} else {
		handoff = compatibilityHandoff(result, options.policy);
	}
	if (options.enforceCompletion !== false && handoff.status !== "completed" && !canIncludeIncompleteHandoff(handoff, options.incompletePolicy)) {
		// A partial or blocked envelope is refused, but its artifact and digest
		// claims are the evidence of what the child touched before it stopped.
		// Returning them as rejected evidence keeps those artifacts in the trace,
		// exactly as a digest mismatch does.
		return { error: storedError(incompleteEnvelopeError(handoff), options.policy), ...(returned ? { rejected: returned } : {}) };
	}
	if (options.attach !== false) result.handoff = handoff;
	return { handoff };
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
