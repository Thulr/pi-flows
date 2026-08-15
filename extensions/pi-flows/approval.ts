// Durable, single-use approval receipts.
//
// A workflow approval used to be the string "APPROVED" in the resume state:
// free-floating consent that authorized nothing in particular and never went
// stale. A receipt instead binds one exact action to the exact parameters it was
// approved for, so consent cannot silently widen between the approval and the
// action.
//
// The workflow digest already covers the workflow's SHAPE (top-level task,
// phases, debrief) and rejects a resume whose state describes a different
// workflow. The receipt covers what that digest cannot see: the EFFECTIVE
// parameters the gated phases resolve to — each effective Agent profile,
// agentScope, returnContract, requireEvidence, incompleteHandoffPolicy, the
// enforced injection-handoff policy, and the resolved delegation contract.
// Source shadowing, a prompt/tool edit, or a changed cwd path/identity therefore
// needs fresh approval instead of riding the old one.
//
// Threat model: this is replay and drift protection for a local 0o600 state
// file, not authentication. Anyone who can write that file can write any receipt
// into it, and there is no key to sign with that would not also live beside it.
// What receipts do stop is the realistic failure: consent carried across an edit
// it never covered, consent that outlived its window, consent spent twice, a
// crash-resume that silently re-uses spent consent, and a state file whose
// recorded approval facts were changed after the fact by a partial write, a
// half-applied merge, or a tool that rewrites one field.
import { createHash, randomUUID } from "node:crypto";
import { deepFreeze } from "./contract-resolution.ts";
import { canonicalSha256, isRecord } from "./delegation.ts";
import { flowError, mintEvent, type ApprovalReceiptSummary, type EventAttribution, type FlowError } from "./types.ts";

export const APPROVAL_RECEIPT_SCHEMA_VERSION = "pi-flows.approval-receipt.v1";

/**
 * Consent goes stale. An approval granted for yesterday's run should not
 * authorize today's resume unless it is granted again, so every minted receipt
 * carries an expiry and the default is one working day.
 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_APPROVAL_TTL_MS = 60 * 1000;
export const MAX_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The step id standing for "the workflow finishes", used when an approval gates the tail of a workflow rather than a following phase. */
export const WORKFLOW_COMPLETE_STEP = "workflow.complete";

/** Fallback approver label when the host supplies no actor. An audit attribution, not an authenticated identity. */
export const DEFAULT_APPROVAL_ACTOR = "interactive-ui";

/**
 * Everything one approval authorizes. The digest over this record is the
 * receipt's binding: change any field and the receipt no longer verifies.
 */
export interface ApprovalBinding {
	/** The exact action approved, e.g. `workflow.phase:deploy`. */
	action: string;
	/** Normalized action parameters. Hashed into the binding digest, never persisted raw. */
	parameters: unknown;
	/** The actor that asked for approval. */
	requestedBy: string;
	/** Identity of the workflow the approval was granted inside. */
	workflowDigest: string;
	/** Schema version of the persisted state the approval was granted against. */
	stateVersion: number;
}

export interface ApprovalReceipt {
	schemaVersion: typeof APPROVAL_RECEIPT_SCHEMA_VERSION;
	receiptId: string;
	action: string;
	bindingDigest: string;
	requestedBy: string;
	approvedBy: string;
	workflowDigest: string;
	stateVersion: number;
	issuedAt: string;
	/** Always set for receipts this version mints; null only on receipts migrated from pre-receipt state. */
	expiresAt: string | null;
	consumedAt: string | null;
	consumedBy: string | null;
	validation: "typed" | "legacy-compatibility";
	/** Digest over every other field. Integrity against accidental edits, not authenticity — see the module header. */
	receiptDigest: string;
}

export type { ApprovalReceiptSummary };

/** A receipt mid-construction: every recorded field, with the integrity digest not yet stamped. */
type UnsealedReceipt = Omit<ApprovalReceipt, "receiptDigest"> & { receiptDigest?: string };

/**
 * The binding digest: what the approval AUTHORIZES. Canonical (recursively
 * key-sorted) JSON so that reordering object keys in a workflow spec does not
 * read as a changed action, and so the digest matches the canonicalization the
 * delegation contract ids already use.
 */
export function approvalBindingDigest(binding: ApprovalBinding): string {
	return canonicalSha256({
		action: binding.action,
		parameters: binding.parameters ?? null,
		requestedBy: binding.requestedBy,
		workflowDigest: binding.workflowDigest,
		stateVersion: binding.stateVersion,
	});
}

/**
 * A digest over every recorded field of a receipt except itself — the actors, the
 * issue time, the expiry, the consumption record. The binding digest covers what
 * was authorized; this covers what was WRITTEN DOWN about the approval, so a
 * truncated write, a half-applied merge, or a tool that rewrites one field is
 * caught rather than honoured. It stops accidents, not an attacker: anyone
 * editing the state file deliberately can recompute it.
 */
export function approvalReceiptDigest(receipt: UnsealedReceipt): string {
	const { receiptDigest: _ignored, ...recorded } = receipt;
	return canonicalSha256(recorded);
}

/** Stamp the integrity digest onto a receipt, at issue and after each legitimate field change. */
function sealReceipt(receipt: UnsealedReceipt): ApprovalReceipt {
	return { ...(receipt as ApprovalReceipt), receiptDigest: approvalReceiptDigest(receipt) };
}

/**
 * Mint a receipt for a granted approval. The receipt starts unconsumed: it
 * authorizes the action, it does not record that the action happened.
 *
 * Issuance mints its own approval event (#128): consent becoming a durable
 * receipt is this module's fact, so the evidence is recorded here rather than
 * left to the caller's discipline. The event carries receipt identity and
 * status only — the approved parameters stay inside the binding digest, so the
 * trace can name the consent without leaking it. The caller owns the
 * attribution; the receipt-identity attributes are this seam's, assembled
 * through the `mintEvent` home so the merge order is spelled once.
 */
export function issueApprovalReceipt(
	binding: ApprovalBinding,
	{ approvedBy, ttlMs = DEFAULT_APPROVAL_TTL_MS, now = Date.now() }: { approvedBy: string; ttlMs?: number; now?: number },
	attribution: EventAttribution,
): ApprovalReceipt {
	const issuedAt = new Date(now).toISOString();
	const bindingDigest = approvalBindingDigest(binding);
	const receipt = sealReceipt({
		schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
		receiptId: createHash("sha256").update(`${bindingDigest}:${issuedAt}:${randomUUID()}`).digest("hex").slice(0, 16),
		action: binding.action,
		bindingDigest,
		requestedBy: binding.requestedBy,
		approvedBy,
		workflowDigest: binding.workflowDigest,
		stateVersion: binding.stateVersion,
		issuedAt,
		expiresAt: new Date(now + ttlMs).toISOString(),
		consumedAt: null,
		consumedBy: null,
		validation: "typed",
	});
	mintEvent(attribution, {
		kind: "approval",
		attributes: {
			"flow.approval.receipt_id": receipt.receiptId,
			"flow.approval.action": receipt.action,
			"flow.approval.approved_by": receipt.approvedBy,
			"flow.approval.expires_at": receipt.expiresAt ?? "(none)",
			"flow.approval.validation": receipt.validation,
		},
	});
	return receipt;
}

/**
 * A receipt reconstructed for an approval that a pre-receipt state recorded as
 * the bare string "APPROVED". Mirrors how a v1 handoff is migrated as
 * `legacy-prose`: the old state carried no approver, no issue time, and no
 * window, so the migrated receipt claims none of them and is exempt from
 * expiry — it still binds, so a later edit to the gated action is still caught.
 * Reconstruction, not consent: unlike issueApprovalReceipt it mints no
 * approval event, because no human decision happened here to evidence.
 */
export function legacyApprovalReceipt(binding: ApprovalBinding, { issuedAt, consumedBy }: { issuedAt: string; consumedBy: string }): ApprovalReceipt {
	const bindingDigest = approvalBindingDigest(binding);
	return sealReceipt({
		schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
		receiptId: createHash("sha256").update(`${bindingDigest}:legacy`).digest("hex").slice(0, 16),
		action: binding.action,
		bindingDigest,
		requestedBy: binding.requestedBy,
		approvedBy: "unknown (approved before receipts were recorded)",
		workflowDigest: binding.workflowDigest,
		stateVersion: binding.stateVersion,
		issuedAt,
		expiresAt: null,
		consumedAt: issuedAt,
		consumedBy,
		validation: "legacy-compatibility",
	});
}

function canonicalIsoTimestamp(value: string): boolean {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function shapeIssue(value: unknown): string | null {
	if (!isRecord(value)) return "no receipt was recorded for the approval that authorizes this action";
	if (value.schemaVersion !== APPROVAL_RECEIPT_SCHEMA_VERSION) return `receipt schemaVersion must be "${APPROVAL_RECEIPT_SCHEMA_VERSION}"`;
	for (const field of ["receiptId", "action", "bindingDigest", "requestedBy", "approvedBy", "workflowDigest", "issuedAt"]) {
		if (typeof value[field] !== "string" || value[field].trim().length === 0) return `receipt.${field} must be a non-empty string`;
	}
	if (!Number.isInteger(value.stateVersion)) return "receipt.stateVersion must be an integer";
	if (value.expiresAt !== null && typeof value.expiresAt !== "string") return "receipt.expiresAt must be an ISO timestamp or null";
	if (value.consumedAt !== null && typeof value.consumedAt !== "string") return "receipt.consumedAt must be an ISO timestamp or null";
	if (value.consumedBy !== null && typeof value.consumedBy !== "string") return "receipt.consumedBy must be an action id or null";
	if (value.validation !== "typed" && value.validation !== "legacy-compatibility") return "receipt.validation must be typed or legacy-compatibility";
	if (typeof value.receiptDigest !== "string") return "receipt.receiptDigest must be a string";
	if (value.receiptDigest !== approvalReceiptDigest(value as ApprovalReceipt)) {
		return "receipt.receiptDigest does not match the receipt's contents; a recorded field (actor, issue time, expiry, or consumption) was changed after it was written";
	}
	if ((value.consumedAt === null) !== (value.consumedBy === null)) return "receipt.consumedAt and receipt.consumedBy must either both be null or both be set";
	for (const field of ["issuedAt", "expiresAt", "consumedAt"] as const) {
		if (value[field] !== null && !canonicalIsoTimestamp(value[field] as string)) return `receipt.${field} must be a canonical ISO timestamp`;
	}
	return null;
}

/** Never leaves this module: makes ApprovalAuthorization construction runtime-private, not merely type-private. */
const AUTHORIZATION_KEY = Symbol("pi-flows.authorization");

/** `ApprovalAuthorization.verify`'s outcome: a refusal, or the sole capability to spend the receipt. */
export type ApprovalVerification =
	| { error: FlowError; authorization?: undefined }
	| { error?: undefined; authorization: ApprovalAuthorization };

/**
 * Proof that a stored receipt was verified against the action about to run —
 * and the only path to spending it: `consume` exists only on this object, and
 * this object exists only as `verify`'s success result, already bound to the
 * verified consumer.
 */
export class ApprovalAuthorization {
	readonly #receipt: ApprovalReceipt;
	readonly #consumer: string;
	#consumed: ApprovalReceipt | undefined;

	private constructor(receipt: ApprovalReceipt, consumer: string, key: symbol) {
		// TS `private` is erased at runtime; the key keeps construction
		// runtime-private, so no authorization exists without verify passing.
		if (key !== AUTHORIZATION_KEY) {
			throw new TypeError("ApprovalAuthorization is constructed only by verify(); direct construction would bypass expiry, binding, and replay checks.");
		}
		this.#receipt = receipt;
		this.#consumer = consumer;
		// Freezing blocks own-property shadowing of `consume`; the #consumed latch is unaffected.
		Object.freeze(this);
	}

	/**
	 * Independently re-verify a receipt against the action about to run. The binding
	 * is recomputed from the live workflow spec and params rather than trusted from
	 * the stored receipt, so a receipt only authorizes what it was actually granted
	 * for.
	 *
	 * @param consumer the action about to use this receipt. Every step the approval
	 *   gates presents the SAME action, so re-verifying anywhere inside that run is a
	 *   resume; a different action is a replay and is refused.
	 */
	static verify(
		receipt: unknown,
		binding: ApprovalBinding,
		{ consumer, now = Date.now() }: { consumer: string; now?: number },
	): ApprovalVerification {
		const error = receiptIssue(receipt, binding, { consumer, now });
		if (error) return { error };
		// A frozen clone: consumption seals what verification covered, not what a retained receipt drifted into.
		return { authorization: new ApprovalAuthorization(deepFreeze(structuredClone(receipt)) as ApprovalReceipt, consumer, AUTHORIZATION_KEY) };
	}

	/**
	 * Burn the receipt once its authorized action has begun. Re-consuming is a
	 * resume, not a second use: the first consumption is latched, so a duplicate
	 * call returns the identical receipt rather than re-sealing.
	 */
	consume(now = Date.now()): ApprovalReceipt {
		this.#consumed ??= this.#receipt.consumedAt !== null && this.#receipt.consumedBy === this.#consumer
			? this.#receipt
			: sealReceipt({ ...this.#receipt, consumedAt: new Date(now).toISOString(), consumedBy: this.#consumer });
		return this.#consumed;
	}
}

Object.freeze(ApprovalAuthorization.prototype);
Object.freeze(ApprovalAuthorization);

function receiptIssue(
	receipt: unknown,
	binding: ApprovalBinding,
	{ consumer, now }: { consumer: string; now: number },
): FlowError | null {
	const shape = shapeIssue(receipt);
	if (shape) {
		return flowError(
			"APPROVAL_RECEIPT_INVALID",
			`No usable approval receipt authorizes "${binding.action}".`,
			`${shape}.`,
			"Re-run the workflow in an interactive Pi UI to approve the phase again; a hand-edited or truncated state file cannot be repaired in place.",
		);
	}
	const stored = receipt as ApprovalReceipt;
	if (stored.consumedAt !== null && stored.consumedBy !== consumer) {
		return flowError(
			"APPROVAL_RECEIPT_CONSUMED",
			`The approval for "${binding.action}" was already spent.`,
			`Receipt ${stored.receiptId} was consumed by "${stored.consumedBy}" and cannot also authorize "${consumer}".`,
			"Approvals are single use. Re-run in an interactive Pi UI to approve this action on its own.",
		);
	}
	const expected = approvalBindingDigest(binding);
	if (stored.bindingDigest !== expected || stored.action !== binding.action) {
		return flowError(
			"APPROVAL_RECEIPT_STALE",
			`The approval for "${binding.action}" no longer matches the action it would authorize.`,
			"The approved action or its effective conditions (selected Agent source, prompt identity, effective tools, canonical cwd path or filesystem identity, model, Thinking level, agent scope, return/evidence requirements, handoff policy, or delegation contract) changed after approval was granted.",
			"Re-run in an interactive Pi UI to approve the current action, or restore the parameters that were approved and resume again.",
		);
	}
	// The window bounds how long consent authorizes STARTING the action. Once the
	// receipt has been spent on it, re-checking the clock would abort a gated run
	// halfway through and leave the workflow worse off than finishing it — the
	// binding still has to match, so nothing about the action can have changed.
	if (stored.expiresAt !== null && stored.consumedAt === null) {
		const expiry = Date.parse(stored.expiresAt);
		if (!Number.isFinite(expiry)) {
			return flowError(
				"APPROVAL_RECEIPT_INVALID",
				`No usable approval receipt authorizes "${binding.action}".`,
				`receipt.expiresAt is not a parseable ISO timestamp: ${JSON.stringify(stored.expiresAt)}.`,
				"Re-run the workflow in an interactive Pi UI to approve the phase again.",
			);
		}
		if (now > expiry) {
			return flowError(
				"APPROVAL_RECEIPT_EXPIRED",
				`The approval for "${binding.action}" expired at ${stored.expiresAt}.`,
				"Approvals authorize a bounded window so consent cannot be banked indefinitely; this resume arrived after that window closed.",
				`Re-run in an interactive Pi UI to approve again, or widen the window with workflow.approvalTtlMs (${MIN_APPROVAL_TTL_MS}..${MAX_APPROVAL_TTL_MS} ms) before approving.`,
			);
		}
	}
	return null;
}

type SpentApprovalMigration =
	| { receipt: ApprovalReceipt; error?: undefined }
	| { receipt?: undefined; error: FlowError };

/**
 * Verify and rebind a v3 receipt already spent on its action. Completed actions
 * retain audit evidence; in-progress actions retain their same-action retry.
 * Checking consumption here prevents callers from re-sealing merely issued consent.
 */
export function migrateSpentApprovalReceipt(receipt: unknown, historical: ApprovalBinding, current: ApprovalBinding): SpentApprovalMigration {
	const verified = ApprovalAuthorization.verify(receipt, historical, { consumer: historical.action });
	if (verified.error) return { error: verified.error };
	const stored = receipt as ApprovalReceipt;
	if (stored.consumedAt === null || stored.consumedBy !== historical.action) {
		return {
			error: flowError(
				"APPROVAL_RECEIPT_INVALID",
				"A historical approval receipt is inconsistent with workflow state.",
				`Receipt ${stored.receiptId} was never spent on the action the state records as started.`,
				"Restore the original state file or start a fresh workflow; unspent historical consent cannot become spent compatibility evidence.",
			),
		};
	}
	return {
		receipt: sealReceipt({
			...stored,
			action: current.action,
			bindingDigest: approvalBindingDigest(current),
			requestedBy: current.requestedBy,
			workflowDigest: current.workflowDigest,
			stateVersion: current.stateVersion,
			validation: "legacy-compatibility",
		}),
	};
}

/**
 * Identifiers and status only — the bound parameters never leave the binding
 * digest. Receipts reach this summary even when no step re-verified them this
 * run (an approval whose gated phases all completed earlier), so the integrity
 * digest is re-checked here too: an audit line must not repeat a receipt's
 * claims about who approved what as fact when the record does not hold together.
 */
export function approvalReceiptSummary(receipt: unknown): ApprovalReceiptSummary {
	// A summary is built from whatever the state file held, including on the paths
	// that are refusing that state. A malformed entry must degrade to an unverified
	// line, never throw past the actionable error it accompanies.
	if (!isRecord(receipt)) {
		return { receiptId: "(none)", action: "(unreadable)", approvedBy: "(unreadable)", issuedAt: "(unreadable)", expiresAt: null, status: "issued", consumedBy: null, validation: "unverified" };
	}
	const stored = receipt as ApprovalReceipt;
	const intact = shapeIssue(stored) === null;
	return {
		receiptId: String(stored.receiptId ?? "(none)"),
		action: String(stored.action ?? "(unreadable)"),
		approvedBy: String(stored.approvedBy ?? "(unreadable)"),
		issuedAt: String(stored.issuedAt ?? "(unreadable)"),
		expiresAt: typeof stored.expiresAt === "string" ? stored.expiresAt : null,
		status: stored.consumedAt ? "consumed" : "issued",
		consumedBy: typeof stored.consumedBy === "string" ? stored.consumedBy : null,
		validation: intact ? stored.validation : "unverified",
	};
}

export function formatApprovalReceipt(summary: ApprovalReceiptSummary): string {
	const window = summary.expiresAt ? ` expires ${summary.expiresAt}` : " no expiry (migrated)";
	// The caveat goes first. A reader who stops after the first clause must not
	// come away believing a record that does not hold together.
	const caveat = summary.validation === "unverified" ? "UNVERIFIED (receipt invalid) · " : "";
	return `${caveat}${summary.action} · receipt ${summary.receiptId} · ${summary.status}${summary.consumedBy ? ` by ${summary.consumedBy}` : ""} · approved by ${summary.approvedBy} ·${window}`;
}

/** Validate an operator-supplied approval window before it is used to mint a receipt. */
export function resolveApprovalTtlMs(value: unknown): { ttlMs: number } | { error: FlowError } {
	if (value === undefined || value === null) return { ttlMs: DEFAULT_APPROVAL_TTL_MS };
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < MIN_APPROVAL_TTL_MS || value > MAX_APPROVAL_TTL_MS) {
		return {
			error: flowError(
				"WORKFLOW_INVALID",
				"Workflow approval window is invalid.",
				`workflow.approvalTtlMs must be an integer from ${MIN_APPROVAL_TTL_MS} to ${MAX_APPROVAL_TTL_MS} milliseconds, got ${JSON.stringify(value)}.`,
				`Pass workflow.approvalTtlMs as an integer in ${MIN_APPROVAL_TTL_MS}..${MAX_APPROVAL_TTL_MS}, or omit it for the ${DEFAULT_APPROVAL_TTL_MS} ms default.`,
			),
		};
	}
	return { ttlMs: value };
}
