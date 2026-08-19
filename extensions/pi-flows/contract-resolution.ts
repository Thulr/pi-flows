// Contract identity and admission: the shared canonical-digest primitives, the
// admissibility predicate, and the resolved form it gates. delegation.ts
// re-exports the public names, so downstream imports are unchanged.
import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import { redactValue } from "./sanitize.ts";
import { Budget, flowError, type CapturePolicy, type DelegationContract, type FlowAgentRefInput, type FlowError } from "./types.ts";
import { appendReturnRequirements } from "./validate.ts";

export const ENVELOPE_VERSION = "pi-flows.return-envelope.v1";
const SIDE_EFFECT_CLASSES = new Set(["none", "read-only", "reversible", "irreversible"]);

type RecordValue = Record<string, any>;

export function isRecord(value: unknown): value is RecordValue {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function stringArray(value: unknown): value is string[] {
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

/** The envelope's field list as prose, stated once so every instruction that teaches the shape teaches the same shape. */
const ENVELOPE_REQUIRED_FIELDS = "schemaVersion, contractId, status, summary, evidence, artifactReferences, digests, changedState, unresolvedQuestions, retry, and data";

/**
 * The contract-specific half of a budget wrap-up notice. The generic ask
 * ("emit the envelope now") has failed in a real code-review run (#112): a
 * near-ceiling child needs the exact identity and format its final message
 * must carry, or it wraps up in prose and forfeits the flow's result at
 * validation. Lives beside `renderTask` because both teach the same return
 * protocol, and drifting apart is exactly what a child cannot recover from.
 */
export function contractWrapUpRequirement(contract: DelegationContract): string {
	return [
		`This task is contracted: your final message must be exactly one JSON object in a fenced json block using schemaVersion "${ENVELOPE_VERSION}", with contractId set to exactly "${delegationContractId(contract)}".`,
		`Use status "partial" unless the work is truly complete, keep \`data\` conforming to the contract's returnSchema, and include the required fields (${ENVELOPE_REQUIRED_FIELDS}).`,
		"Prose, another format, or further tool calls will invalidate this run.",
	].join(" ");
}

export function storedError(error: FlowError, policy: CapturePolicy): FlowError {
	return { ...error, cause: redactValue(error.cause, policy) as string };
}

export function deepFreeze<T>(value: T): T {
	// The isFrozen guard also terminates on cycles, which JSON-sourced params
	// cannot express but a hostile in-process caller could.
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value)) deepFreeze(nested);
	}
	return value;
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

/**
 * The contract admissibility predicate, exported for the selection eval's
 * admissibility seam. The transition path reaches it only through
 * `ResolvedDelegationContract.resolve`.
 */
export function validateDelegationContract(
	value: unknown,
	policy: CapturePolicy = { recordContent: true, redactSecrets: true },
): FlowError | null {
	const error = rawDelegationContractError(value);
	return error ? storedError(error, policy) : null;
}

// TS `private constructor` is erased at runtime; this key never leaves the
// module, so construction is runtime-private, not merely type-private.
const CONSTRUCTION_KEY = Symbol("pi-flows.construction");

/**
 * A delegation contract admitted to the transition path: shape-validated,
 * returnSchema compiled, identity digested — all at construction. Rendering,
 * contract budgets, and return validation exist only as methods here, so none
 * can run against a raw contract or derive a divergent identity.
 */
export class ResolvedDelegationContract {
	readonly #checkReturnData: (data: unknown) => boolean;

	private constructor(
		readonly contract: DelegationContract,
		/** The canonical contract identity every return envelope must name. */
		readonly id: string,
		checkReturnData: (data: unknown) => boolean,
		key: symbol,
	) {
		if (key !== CONSTRUCTION_KEY) {
			throw new TypeError("ResolvedDelegationContract is constructed only by resolve(); direct construction would bypass contract admissibility.");
		}
		this.#checkReturnData = checkReturnData;
		// Frozen so an own always-true `checkReturnData` cannot be attached; #state is unaffected.
		Object.freeze(this);
	}

	/** The only way in: a value that fails the admissibility predicate never becomes an object the transitions accept. */
	static resolve(
		value: unknown,
		policy: CapturePolicy = { recordContent: true, redactSecrets: true },
	): { resolved?: ResolvedDelegationContract; error?: FlowError } {
		const error = validateDelegationContract(value, policy);
		if (error) return { error };
		// Snapshot, then freeze: every piece of resolved state must keep
		// describing the contract that was admitted, not what a retained,
		// mutated input drifted into.
		const contract = deepFreeze(structuredClone(value)) as DelegationContract;
		// Proven compilable by the predicate above; compiled exactly once here.
		const validator = Compile(contract.returnSchema);
		return { resolved: new ResolvedDelegationContract(contract, canonicalSha256(contract), (data) => validator.Check(data), CONSTRUCTION_KEY) };
	}

	/** Render the child task with the contract terms and the return protocol bound to this contract's identity. */
	renderTask(task: string | undefined, returnRequirements?: string, requireEvidence?: boolean): string {
		const goal = task?.trim() || this.contract.objective;
		return [
			appendReturnRequirements(goal, returnRequirements, requireEvidence),
				"\n## Delegation contract",
			JSON.stringify(this.contract, null, 2),
			"\n## Required return protocol",
			`Return one JSON object in a fenced \`json\` block using schemaVersion "${ENVELOPE_VERSION}".`,
			`Set contractId to exactly "${this.id}" so downstream consumers can reject missing or stale returns.`,
			`Required fields: ${ENVELOPE_REQUIRED_FIELDS}.`,
			"`data` must satisfy contract.returnSchema. Evidence items use {claim, source}. Artifact references use {path}. Digests use {artifact, algorithm:\"sha256\", value}.",
			"Use empty arrays when no evidence, artifacts, digests, changed state, or unresolved questions exist. Do not report success as prose outside the envelope.",
		].join("\n");
	}

	/** Render admitted terms as context for another Role without instructing it to use this contract's Return protocol. */
	reviewContext(task: string | undefined): string {
		return [
			task?.trim() || this.contract.objective,
			"\n## Delegation contract under review (context only)",
			JSON.stringify(this.contract, null, 2),
		].join("\n");
	}

	/** The contract budget for this contract. `contract.budget.timeoutMs` is a wall-clock bound, not spend, and is applied at dispatch via `timeoutMs` instead. */
	budget(): Budget | undefined {
		return Budget.forContract(this.contract.budget);
	}

	/** The dispatch wall-clock bound from the contract budget. */
	get timeoutMs(): number | undefined {
		return this.contract.budget.timeoutMs;
	}

	/** Does envelope `data` satisfy this contract's compiled returnSchema? */
	checkReturnData(data: unknown): boolean {
		return this.#checkReturnData(data);
	}
}

// With instances frozen at construction, freezing the prototype and
// constructor closes the remaining dispatch-tampering paths.
Object.freeze(ResolvedDelegationContract.prototype);
Object.freeze(ResolvedDelegationContract);

/** Resolve the contract dispatch will enforce for one child reference. */
export function resolveDelegationContract(
	ref: Pick<FlowAgentRefInput, "contract"> | undefined,
	fallback?: DelegationContract,
): DelegationContract | undefined {
	return ref?.contract ?? fallback;
}
