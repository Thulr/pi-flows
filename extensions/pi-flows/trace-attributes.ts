/**
 * What a coordination span says about itself.
 *
 * Two rules shape everything here. First, a span must identify *what authority
 * ran under what contract* — agent and prompt version, allowed tools, the
 * authority grant, the delegation reason, the contract hash, and the expected
 * return schema — because "the child failed" is not attributable without them.
 * Second, a span must not become a second copy of the payload: handoff spans
 * carry shapes, sizes, identifiers, and digests, never the summary text, the
 * evidence prose, or the `data` body those identifiers point at.
 */
import { canonicalSha256, delegationContractId } from "./delegation.ts";
import { sanitizeText } from "./sanitize.ts";
import type { CapturePolicy, DelegationContract, DelegationHandoffEnvelope, FlowError } from "./types.ts";

const LABEL_CAP = 512;
const LIST_CAP = 1024;

function shortDigest(value: string): string {
	return canonicalSha256(value).slice("sha256:".length, "sha256:".length + 12);
}

/** Identity of an agent's system prompt. Two runs of the same agent text share it; an edited prompt does not. */
export function promptVersion(systemPrompt: string): string {
	return systemPrompt.trim() ? `sha256:${shortDigest(systemPrompt)}` : "(empty)";
}

/**
 * Stable identifiers for a contract's constraints and acceptance checks. The id
 * is derived from the constraint text, so the same constraint keeps the same id
 * at every hop — which is what makes "was this constraint preserved across the
 * handoff?" answerable from the trace — while the text itself stays out of it.
 */
export function constraintIdentifiers(contract: DelegationContract): string[] {
	return [
		...contract.constraints.map((value, index) => `constraint.${index + 1}:${shortDigest(value)}`),
		...contract.acceptanceChecks.map((value, index) => `acceptance.${index + 1}:${shortDigest(value)}`),
	];
}

function label(value: string, policy: CapturePolicy, cap = LABEL_CAP): string {
	return sanitizeText(value, { ...policy, recordContent: true }, cap);
}

function list(values: string[], policy: CapturePolicy): string {
	return label(values.join(","), policy, LIST_CAP);
}

export interface DelegationIdentity {
	systemPrompt: string;
	/** Resolved tool allowlist: `undefined` means the child inherits pi's builtin tools. */
	allowedTools?: string[];
	contract?: DelegationContract;
	delegationReason?: string;
	policy: CapturePolicy;
}

/**
 * Who was allowed to do what, under which contract. Recorded on every child
 * span so an audit can answer "was this child permitted to do that?" without
 * re-deriving the dispatch decision from the parameters.
 *
 * Structure — counts, digests, class names, tool names — is always recorded:
 * it is what makes the span attributable and it carries no payload. The
 * free-text halves (the delegation reason, the contract owner, the authority
 * prose) are content, so `recordContent:false` withholds them exactly as it
 * withholds child input/output. Their digests still identify the contract, so a
 * content-free trace can still tell two contracts apart.
 */
export function delegationIdentityAttributes(identity: DelegationIdentity): Record<string, unknown> {
	const { contract, policy } = identity;
	const attributes: Record<string, unknown> = {
		"flow.agent_prompt_version": promptVersion(identity.systemPrompt),
		"flow.allowed_tools": identity.allowedTools === undefined ? "(pi builtin tools)" : identity.allowedTools.length === 0 ? "(none)" : list(identity.allowedTools, policy),
	};
	if (identity.delegationReason?.trim() && policy.recordContent) attributes["flow.delegation_reason"] = label(identity.delegationReason, policy);
	if (!contract) return attributes;
	attributes["flow.contract_id"] = delegationContractId(contract);
	attributes["flow.side_effect_class"] = contract.sideEffectClass;
	attributes["flow.return_schema_digest"] = canonicalSha256(contract.returnSchema);
	attributes["flow.constraint_ids"] = list(constraintIdentifiers(contract), policy);
	attributes["flow.authority_may_count"] = contract.authority.may.length;
	attributes["flow.authority_must_not_count"] = contract.authority.mustNot.length;
	attributes["flow.authority_requires_approval_count"] = contract.authority.requiresApproval.length;
	if (policy.recordContent) {
		attributes["flow.contract_owner"] = label(contract.owner, policy);
		attributes["flow.authority_may"] = list(contract.authority.may, policy);
		attributes["flow.authority_must_not"] = list(contract.authority.mustNot, policy);
		attributes["flow.authority_requires_approval"] = list(contract.authority.requiresApproval, policy);
	}
	return attributes;
}

export interface HandoffAccounting {
	/** Whether the integrator accepted this handoff for synthesis or merge. */
	accepted: boolean;
	rejection?: FlowError;
	/** Bytes of model-visible child output before handoff filtering, when known. */
	rawBytes?: number;
	/** Bytes actually carried forward to the next prompt, when known. */
	carriedBytes?: number;
	/** Injection-scan labels raised while preparing the content for reuse. */
	warnings?: string[];
	contract?: DelegationContract;
	policy: CapturePolicy;
}

/**
 * What crossed the handoff boundary — filtering, size, warnings, preserved
 * constraint identifiers, acceptance status, artifact references — and nothing
 * that would make the trace a second copy of the payload.
 */
export function handoffAttributes(handoff: DelegationHandoffEnvelope, accounting: HandoffAccounting): Record<string, unknown> {
	const { policy } = accounting;
	const artifacts = handoff.artifactReferences.map((reference) => reference.path);
	const attributes: Record<string, unknown> = {
		"flow.handoff.compatibility": handoff.compatibility,
		"flow.handoff.status": handoff.status,
		"flow.handoff.contract_id": handoff.contractId ?? "(legacy)",
		"flow.handoff.from_agent": label(handoff.provenance.agent, policy),
		"flow.handoff.acceptance": accounting.accepted ? "accepted" : `rejected:${accounting.rejection?.code ?? "unknown"}`,
		"flow.handoff.evidence_count": handoff.evidence.length,
		"flow.handoff.artifact_count": artifacts.length,
		"flow.handoff.digest_count": handoff.digests.length,
		"flow.handoff.changed_state_count": handoff.changedState.length,
		"flow.handoff.unresolved_count": handoff.unresolvedQuestions.length,
		"flow.handoff.retryable": handoff.retry.retryable,
		"flow.handoff.content_recorded": policy.recordContent,
		"flow.handoff.redaction_enabled": policy.redactSecrets,
	};
	if (handoff.provenance.step !== undefined) attributes["flow.handoff.from_step"] = handoff.provenance.step;
	// Artifact paths are workspace content, so they follow the content policy; the
	// count and the digests below stay either way, because they are what make a
	// corrupted artifact attributable.
	if (artifacts.length && policy.recordContent) attributes["flow.handoff.artifact_refs"] = list(artifacts, policy);
	if (accounting.warnings?.length) attributes["flow.handoff.injection_warnings"] = list(accounting.warnings, policy);
	if (accounting.contract) attributes["flow.handoff.preserved_constraint_ids"] = list(constraintIdentifiers(accounting.contract), policy);
	if (accounting.rawBytes !== undefined) attributes["flow.handoff.raw_bytes"] = accounting.rawBytes;
	if (accounting.carriedBytes !== undefined) {
		attributes["flow.handoff.carried_bytes"] = accounting.carriedBytes;
		if (accounting.rawBytes !== undefined) attributes["flow.handoff.filtered"] = accounting.carriedBytes < accounting.rawBytes;
	}
	return attributes;
}

/** One artifact the handoff pointed at, with the digest that was checked against it. */
export function artifactAttributes(handoff: DelegationHandoffEnvelope, artifactPath: string, policy: CapturePolicy): Record<string, unknown> {
	const digest = handoff.digests.find((entry) => entry.artifact === artifactPath);
	return {
		...(policy.recordContent ? { "flow.artifact.path": label(artifactPath, policy, LIST_CAP) } : {}),
		"flow.artifact.from_agent": label(handoff.provenance.agent, policy),
		"flow.artifact.contract_id": handoff.contractId ?? "(legacy)",
		"flow.artifact.digest_declared": Boolean(digest),
		...(digest ? { "flow.artifact.digest": `${digest.algorithm}:${digest.value}` } : {}),
	};
}

interface BudgetState {
	maxCostUsd?: number;
	maxTokens?: number;
	maxGeneratedTokens?: number;
	spentCost: number;
	spentTokens: number;
	spentGeneratedTokens: number;
}

/**
 * Budget state after a child charged it, recorded on the span that caused the
 * change.
 *
 * @param prefix which ceiling this is. A contracted child is bounded by two
 *   independent budgets — the flow tree's and the contract's — and the contract's
 *   is usually the tighter one, so recording only the flow budget would name a
 *   limit that did not stop the child and omit the one that did.
 */
export function budgetAttributes(budget: BudgetState | undefined, prefix = "flow.budget"): Record<string, unknown> {
	if (!budget) return {};
	const attributes: Record<string, unknown> = {
		[`${prefix}.spent_cost_usd`]: budget.spentCost,
		[`${prefix}.spent_tokens`]: budget.spentTokens,
		[`${prefix}.spent_generated_tokens`]: budget.spentGeneratedTokens,
	};
	if (budget.maxCostUsd !== undefined) attributes[`${prefix}.limit_cost_usd`] = budget.maxCostUsd;
	if (budget.maxTokens !== undefined) attributes[`${prefix}.limit_tokens`] = budget.maxTokens;
	if (budget.maxGeneratedTokens !== undefined) attributes[`${prefix}.limit_generated_tokens`] = budget.maxGeneratedTokens;
	return attributes;
}
