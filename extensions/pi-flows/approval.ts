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
// parameters the gated phases resolve to — agentScope, returnContract,
// requireEvidence, incompleteHandoffPolicy, the resolved delegation contract.
// Flipping agentScope from "user" to "project" between approval and execution
// swaps which repo-controlled prompt actually runs; that now needs a fresh
// approval instead of riding the old one.
//
// Threat model: this is replay and drift protection for a local 0o600 state
// file, not authentication. Anyone who can write that file can write any receipt
// into it, and there is no key to sign with that would not also live beside it.
// What receipts do stop is the realistic failure: consent carried across an edit
// it never covered, consent that outlived its window, consent spent twice, and a
// crash-resume that silently re-uses spent consent.
import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonValue } from "./delegation.ts";
import { flowError, type ApprovalReceiptSummary, type FlowError } from "./types.ts";

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
}

export type { ApprovalReceiptSummary };

function isRecord(value: unknown): value is Record<string, any> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The binding digest. Canonical (recursively key-sorted) JSON so that reordering
 * object keys in a workflow spec does not read as a changed action, and so the
 * digest matches the canonicalization the delegation contract ids already use.
 */
export function approvalBindingDigest(binding: ApprovalBinding): string {
	const canonical = canonicalJsonValue({
		action: binding.action,
		parameters: binding.parameters ?? null,
		requestedBy: binding.requestedBy,
		workflowDigest: binding.workflowDigest,
		stateVersion: binding.stateVersion,
	});
	return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** Mint a receipt for a granted approval. The receipt starts unconsumed: it authorizes the action, it does not record that the action happened. */
export function issueApprovalReceipt(
	binding: ApprovalBinding,
	{ approvedBy, ttlMs = DEFAULT_APPROVAL_TTL_MS, now = Date.now() }: { approvedBy: string; ttlMs?: number; now?: number },
): ApprovalReceipt {
	const issuedAt = new Date(now).toISOString();
	const bindingDigest = approvalBindingDigest(binding);
	return {
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
	};
}

/**
 * A receipt reconstructed for an approval that a pre-receipt state recorded as
 * the bare string "APPROVED". Mirrors how a v1 handoff is migrated as
 * `legacy-prose`: the old state carried no approver, no issue time, and no
 * window, so the migrated receipt claims none of them and is exempt from
 * expiry — it still binds, so a later edit to the gated action is still caught.
 */
export function legacyApprovalReceipt(binding: ApprovalBinding, { issuedAt, consumedBy }: { issuedAt: string; consumedBy: string }): ApprovalReceipt {
	const bindingDigest = approvalBindingDigest(binding);
	return {
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
	};
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
	return null;
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
export function verifyApprovalReceipt(
	receipt: unknown,
	binding: ApprovalBinding,
	{ consumer, now = Date.now() }: { consumer: string; now?: number },
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
	const expected = approvalBindingDigest(binding);
	if (stored.bindingDigest !== expected || stored.action !== binding.action) {
		return flowError(
			"APPROVAL_RECEIPT_STALE",
			`The approval for "${binding.action}" no longer matches the action it would authorize.`,
			"The approved action or its effective parameters (agent scope, return contract, evidence requirement, incomplete-handoff policy, or delegation contract) changed after approval was granted.",
			"Re-run in an interactive Pi UI to approve the current action, or restore the parameters that were approved and resume again.",
		);
	}
	if (stored.expiresAt !== null) {
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
	if (stored.consumedAt !== null && stored.consumedBy !== consumer) {
		return flowError(
			"APPROVAL_RECEIPT_CONSUMED",
			`The approval for "${binding.action}" was already spent.`,
			`Receipt ${stored.receiptId} was consumed by "${stored.consumedBy}" and cannot also authorize "${consumer}".`,
			"Approvals are single use. Re-run in an interactive Pi UI to approve this action on its own.",
		);
	}
	return null;
}

/** Burn a receipt once its authorized action has begun. Re-consuming by the same action is a resume, not a second use. */
export function consumeApprovalReceipt(receipt: ApprovalReceipt, consumer: string, now = Date.now()): ApprovalReceipt {
	if (receipt.consumedAt !== null && receipt.consumedBy === consumer) return receipt;
	return { ...receipt, consumedAt: new Date(now).toISOString(), consumedBy: consumer };
}

/** Identifiers and status only — the bound parameters never leave the binding digest. */
export function approvalReceiptSummary(receipt: ApprovalReceipt): ApprovalReceiptSummary {
	return {
		receiptId: receipt.receiptId,
		action: receipt.action,
		approvedBy: receipt.approvedBy,
		issuedAt: receipt.issuedAt,
		expiresAt: receipt.expiresAt,
		status: receipt.consumedAt === null ? "issued" : "consumed",
		consumedBy: receipt.consumedBy,
		validation: receipt.validation,
	};
}

export function formatApprovalReceipt(summary: ApprovalReceiptSummary): string {
	const window = summary.expiresAt ? ` expires ${summary.expiresAt}` : " no expiry (migrated)";
	return `${summary.action} · receipt ${summary.receiptId} · ${summary.status}${summary.consumedBy ? ` by ${summary.consumedBy}` : ""} · approved by ${summary.approvedBy} ·${window}`;
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
