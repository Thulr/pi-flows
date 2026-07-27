import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import Schema from "typebox/schema";
import { extractLastJsonBlock } from "./protocol.ts";
import { resultText } from "./sanitize.ts";
import { flowError, type DelegationContract, type DelegationReturnEnvelope, type FlowError, type FlowRunResult } from "./types.ts";
import { appendReturnContract } from "./validate.ts";

const ENVELOPE_VERSION = "pi-flows.return-envelope.v1";
const SIDE_EFFECT_CLASSES = new Set(["none", "read-only", "reversible", "irreversible"]);
const ENVELOPE_STATUSES = new Set(["completed", "partial", "blocked", "failed"]);

type RecordValue = Record<string, any>;

function isRecord(value: unknown): value is RecordValue {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(nonEmptyString);
}

function contractError(reason: string): FlowError {
	return flowError(
		"INVALID_DELEGATION_CONTRACT",
		"Typed delegation contract is invalid.",
		reason,
		"Provide every required contract field with the documented type before dispatching a child.",
	);
}

export function validateDelegationContract(value: unknown): FlowError | null {
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
		Schema.Compile(value.returnSchema);
	} catch (error) {
		return contractError(`\`contract.returnSchema\` could not be compiled: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!nonEmptyString(value.owner)) return contractError("`contract.owner` must be a non-empty string.");
	return null;
}

export function renderDelegationTask(
	task: string | undefined,
	contract: DelegationContract,
	returnContract?: string,
	requireEvidence?: boolean,
): string {
	const goal = task?.trim() || contract.objective;
	return [
		appendReturnContract(goal, returnContract, requireEvidence),
		"\n## Typed delegation contract",
		JSON.stringify(contract, null, 2),
		"\n## Required return protocol",
		`Return one JSON object in a fenced \`json\` block using schemaVersion "${ENVELOPE_VERSION}".`,
		"Required fields: schemaVersion, status, summary, evidence, artifactReferences, digests, changedState, unresolvedQuestions, retry, and data.",
		"`data` must satisfy contract.returnSchema. Evidence items use {claim, source}. Artifact references use {path}. Digests use {artifact, algorithm:\"sha256\", value}.",
		"Use empty arrays when no evidence, artifacts, digests, changed state, or unresolved questions exist. Do not report success as prose outside the envelope.",
	].join("\n");
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
	const realCwd = realpathSync(cwd);
	const realFile = realpathSync(resolved);
	const realRelative = path.relative(realCwd, realFile);
	if (path.isAbsolute(realRelative) || realRelative.startsWith("..")) {
		return { error: envelopeError(`Artifact reference resolves outside the child cwd: ${artifact}.`) };
	}
	return { file: realFile };
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
		const actual = createHash("sha256").update(readFileSync(artifact.file!)).digest("hex");
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

export function validateReturnEnvelope(
	result: FlowRunResult,
	contract: DelegationContract,
	cwd: string,
): { envelope?: DelegationReturnEnvelope; error?: FlowError } {
	const parsed = extractLastJsonBlock(resultText(result));
	if (!validateEnvelopeShape(parsed)) return { error: envelopeError("The child did not return a structurally valid pi-flows.return-envelope.v1 object.") };
	let validator;
	try {
		validator = Schema.Compile(contract.returnSchema);
	} catch (error) {
		return { error: contractError(`\`contract.returnSchema\` could not be compiled: ${error instanceof Error ? error.message : String(error)}`) };
	}
	if (!validator.Check(parsed.data)) return { error: envelopeError("Envelope `data` does not satisfy contract.returnSchema.") };
	const digestError = validateDigests(parsed, cwd);
	if (digestError) return { error: digestError };
	const envelope = { ...parsed, usage: result.usage };
	result.envelope = envelope;
	return { envelope };
}

export function canonicalEnvelope(envelope: DelegationReturnEnvelope): string {
	return JSON.stringify(envelope);
}
