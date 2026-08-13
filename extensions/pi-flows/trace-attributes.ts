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
import type { BudgetSnapshot, CapturePolicy, DelegationContract, DelegationHandoffEnvelope, FlowError, FlowTraceContext, HandoffPolicy, PreparedHandoff } from "./types.ts";

const LABEL_CAP = 512;
const LIST_CAP = 1024;

/** Bound on any one span attribute. Equal to LIST_CAP today but deliberately its own name: it bounds a different role and may diverge. */
const ATTRIBUTE_CAP = 1024;

/**
 * Structural keys get their own, larger bound. They are machine identifiers the
 * report parses to check the attribution chain, and a truncated one would read as
 * a broken chain — a valid run failing the gate because its ids were long.
 *
 * All five share the bound deliberately. A key capped on one side and intact on
 * the other cannot be matched to itself, so capping them differently would break
 * exactly the comparison they exist for. The unresolved list is part of that
 * comparison: its entries are declared keys, matched against the declared list.
 */
const STRUCTURAL_CAP = 8 * 1024;
const STRUCTURAL_ATTRIBUTES = new Set(["flow.unit_key", "flow.stage_key", "flow.depends_on", "flow.depends_on_span_ids", "flow.depends_on_unresolved"]);

/** The eval-linkage identity as the sink stores it: redacted, bounded identifiers. */
export function storedTraceContext(context: FlowTraceContext, policy: CapturePolicy): FlowTraceContext {
	const identifier = (value: string) => sanitizeText(value, { ...policy, recordContent: true }, 256);
	return {
		runId: identifier(context.runId),
		caseId: identifier(context.caseId),
		trialId: identifier(context.trialId),
		...(context.trialIndex === undefined ? {} : { trialIndex: context.trialIndex }),
		...(context.arm === undefined ? {} : { arm: identifier(context.arm) }),
		...(context.attempt === undefined ? {} : { attempt: context.attempt }),
	};
}

/** The same identity as span attributes, copied onto every row so any span alone names its run. */
export function traceContextAttributes(context?: FlowTraceContext): Record<string, unknown> {
	if (!context) return {};
	return {
		"flow.run_id": context.runId,
		"flow.case_id": context.caseId,
		"flow.trial_id": context.trialId,
		"flow.trial_index": context.trialIndex,
		"flow.arm": context.arm,
		"flow.attempt": context.attempt,
	};
}

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

/**
 * How a value looks once written: redacted, then capped.
 *
 * Attribute values reach the sink from mode handlers, and several are operator-
 * or repo-supplied: an approval actor from PI_FLOWS_APPROVAL_ACTOR, a workflow
 * phase id, a graph node id, a branch name. They are identity rather than
 * content, so `recordContent:false` does not withhold them — but there is no
 * reason a configured actor of `token=…`, or a home path, should reach the
 * file verbatim when the same string is redacted everywhere else.
 */
export function storedLabel(value: string, policy: CapturePolicy): string {
	return label(value, policy, ATTRIBUTE_CAP);
}

/** How a structural key list looks once written: redacted, then capped at the structural bound. */
export function storedStructural(value: string, policy: CapturePolicy): string {
	return label(value, policy, STRUCTURAL_CAP);
}

/** A whole attribute map under the same rules, each key at the bound its role earns. */
export function storedAttributes(attributes: Record<string, unknown> | undefined, policy: CapturePolicy): Record<string, unknown> {
	if (!attributes) return {};
	const stored: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(attributes)) {
		stored[key] = typeof value === "string" ? label(value, policy, STRUCTURAL_ATTRIBUTES.has(key) ? STRUCTURAL_CAP : ATTRIBUTE_CAP) : value;
	}
	return stored;
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
	handoffPolicy?: HandoffPolicy;
	policyAction?: PreparedHandoff["action"];
	compositional?: boolean;
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
	if (accounting.handoffPolicy) attributes["flow.handoff.policy"] = accounting.handoffPolicy;
	if (accounting.policyAction) attributes["flow.handoff.policy_action"] = accounting.policyAction;
	const attackDetected = Boolean(accounting.warnings?.length);
	const blocked = accounting.policyAction === "quarantine" || accounting.policyAction === "fail";
	const propagated = attackDetected && accounting.policyAction === "warn";
	attributes["flow.handoff.scan_flagged"] = attackDetected;
	attributes["flow.handoff.payload_propagated"] = propagated;
	attributes["flow.handoff.payload_withheld"] = attackDetected && blocked;
	attributes["flow.handoff.sensitive_request_propagated"] = propagated && Boolean(accounting.warnings?.some((warning) => warning.includes("secret-exfiltration")));
	attributes["flow.handoff.compositional"] = accounting.compositional ?? false;
	if (accounting.contract) attributes["flow.handoff.preserved_constraint_ids"] = list(constraintIdentifiers(accounting.contract), policy);
	if (accounting.rawBytes !== undefined) attributes["flow.handoff.raw_bytes"] = accounting.rawBytes;
	if (accounting.carriedBytes !== undefined) {
		attributes["flow.handoff.carried_bytes"] = accounting.carriedBytes;
		if (accounting.rawBytes !== undefined) attributes["flow.handoff.filtered"] = accounting.carriedBytes < accounting.rawBytes;
	}
	return attributes;
}

/** Whatever declared the artifact: an accepted handoff, or the rejected envelope whose claims are the evidence of what went wrong. */
export interface ArtifactSource {
	agent: string;
	contractId: string | null;
	digests: Array<{ artifact: string; algorithm: string; value: string }>;
}

/**
 * One artifact a child pointed at, with the digest it asserted.
 *
 * `verified` is the load-bearing field: an artifact recorded from a rejected
 * envelope carries the child's own claim about a file that did not match it, and
 * a reader must not mistake that for a checked digest.
 */
export function artifactAttributes(source: ArtifactSource, artifactPath: string, policy: CapturePolicy, verified = true): Record<string, unknown> {
	const digest = source.digests.find((entry) => entry.artifact === artifactPath);
	return {
		...(policy.recordContent ? { "flow.artifact.path": label(artifactPath, policy, LIST_CAP) } : {}),
		"flow.artifact.from_agent": label(source.agent, policy),
		"flow.artifact.contract_id": source.contractId ?? "(legacy)",
		"flow.artifact.digest_declared": Boolean(digest),
		"flow.artifact.verified": verified,
		...(digest ? { "flow.artifact.digest": `${digest.algorithm}:${digest.value}` } : {}),
	};
}

/**
 * Budget state after a child charged it, recorded on the span that caused the
 * change.
 *
 * The prefix follows the snapshot's own authority. A contracted child is bounded
 * by two independent budgets — the flow's and the contract's — and the
 * contract's is usually the tighter one, so recording both under one prefix
 * would name a ceiling that did not stop the child and omit the one that did.
 */
export function budgetAttributes(budget: BudgetSnapshot | undefined): Record<string, unknown> {
	if (!budget) return {};
	const prefix = budget.authority === "contract" ? "flow.contract_budget" : "flow.budget";
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
