// The approval machinery of workflow mode: what an approval authorizes, how that
// is turned into a binding, and when it may be reopened.
//
// Split out of workflow.ts because it is a self-contained question — "what did
// this consent cover?" — that the phase loop only consults. Nothing here touches
// the persisted state type; the helpers take the two fields they need, so the
// state shape stays workflow.ts's business.
import { sanitizeText } from "../sanitize.ts";
import { consumeApprovalReceipt, WORKFLOW_COMPLETE_STEP, type ApprovalBinding, type ApprovalReceipt } from "../approval.ts";
import type { CapturePolicy, ModeDeps } from "../types.ts";
import { resolveChildModel } from "../runner.ts";

/** An approver label is an audit string, not free-form output: cap it so a hostile env var cannot pad the receipt. */
const APPROVER_LABEL_CAP = 256;

/** The state schema version an approval is granted against. */
export const WORKFLOW_STATE_VERSION = 3;

/**
 * Receipt failures a human can simply answer again: the approved action changed,
 * or the window lapsed. Asking for consent afresh is the intended recovery, and
 * without it an expired receipt strands the state file — the approval phase is
 * already complete, so it is skipped, and every resume re-reads the same dead
 * receipt. A consumed or malformed receipt is NOT here: those mean the record was
 * tampered with, and re-prompting past them would launder the tampering.
 */
export const REAPPROVABLE_RECEIPT_ERRORS = new Set(["APPROVAL_RECEIPT_STALE", "APPROVAL_RECEIPT_EXPIRED"]);

/** The audit label to credit for an approval, capped and redacted. */
export const approverLabel = (deps: ModeDeps, policy: CapturePolicy, fallback: string): string =>
	sanitizeText(deps.approvalActor ?? fallback, { ...policy, recordContent: true }, APPROVER_LABEL_CAP);

/**
 * Which approval, if any, authorizes entering each step. An approval authorizes
 * ONE action, but that action spans every step between it and the next consent
 * point: the work phases it gates, the approval that ends the run, and the
 * workflow's own completion when nothing else follows. Every one of those steps
 * is registered, so a resume landing in the middle of a gated run still
 * re-verifies rather than walking in behind a check it never reached.
 */
export function approvalAuthorizations(phases: any[]): Map<string, number> {
	const authorizations = new Map<string, number>();
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message) continue;
		let step = index + 1;
		for (; step < phases.length; step += 1) {
			authorizations.set(phases[step].id, index);
			if (phases[step]?.approval?.message) break;
		}
		if (step >= phases.length) authorizations.set(WORKFLOW_COMPLETE_STEP, index);
	}
	return authorizations;
}

/** The action id an approval phase authorizes. The single source for both the binding and the consumption record. */
export const approvalActionId = (phase: any): string => `workflow.phase:${phase.id}`;

/** The work phases an approval gates: everything up to the next consent point. */
export function gatedPhaseIds(phases: any[], index: number): string[] {
	const gated: string[] = [];
	for (let next = index + 1; next < phases.length && !phases[next]?.approval?.message; next += 1) gated.push(phases[next].id);
	return gated;
}

/** Has any of the run this approval gates already executed? */
export const gatedRunStarted = (phases: any[], index: number, completedPhaseIds: string[]): boolean =>
	gatedPhaseIds(phases, index).some((id) => completedPhaseIds.includes(id));

/**
 * What one gated ref will actually run as: the concrete model and thinking
 * level, resolved exactly the way dispatch resolves them.
 *
 * The tier NAME is not enough to bind. `tier:"deep"` is a question, not an
 * answer — it resolves through the per-install roster, so a config override, a
 * provider losing auth, or a registry refresh between approval and resume can
 * leave the same word selecting a different model, vendor, and effort. A receipt
 * that recorded only the word would still verify while the child ran materially
 * different work, which is the one thing a binding digest exists to prevent.
 *
 * Resolved through `resolveChildModel` rather than re-derived here so the
 * receipt and the dispatch can never disagree about what a tier means.
 */
function resolvedDispatch(ref: any, params: any, deps: ModeDeps): { model: string | null; thinking: string | null } {
	const agent = deps.discovery.agents.find((candidate) => candidate.name === ref.agent);
	const choice = resolveChildModel(
		{ model: agent?.model, tier: agent?.tier, thinking: agent?.thinking },
		{ model: ref.model ?? params.model, tier: ref.tier ?? params.tier, thinking: ref.thinking ?? params.thinking },
		deps.roster,
	);
	// A rung that resolves to "the pi default" still runs a CONCRETE model, and
	// which one can change between approval and resume. Collapsing every default
	// to the same null marker would make those changes invisible to the digest —
	// the same drift the tier name had, one layer down.
	return { model: choice.model ?? deps.roster?.defaultModel ?? null, thinking: choice.thinking ?? null };
}

/**
 * A gated phase's EFFECTIVE definition — what it resolves to once flow-level
 * fallbacks and the model roster are applied. The workflow digest sees
 * `phase.returnContract`; only this sees that an omitted one falls back to
 * `params.returnContract`, so changing the fallback after approval is caught
 * rather than inherited.
 */
export function normalizeGatedPhase(phase: any, params: any, deps: ModeDeps): Record<string, unknown> {
	const dispatch = resolvedDispatch(phase, params, deps);
	return {
		id: phase.id,
		agent: phase.agent ?? null,
		task: phase.task ?? null,
		cwd: phase.cwd ?? null,
		// The tier is kept for legibility — it is what the operator read — but what
		// binds is what it resolves to, so roster drift invalidates the receipt.
		tier: phase.tier ?? params.tier ?? null,
		model: dispatch.model,
		thinking: dispatch.thinking,
		tools: phase.tools ?? null,
		checkCommand: phase.checkCommand ?? null,
		contract: phase.contract ?? null,
		returnContract: phase.returnContract ?? params.returnContract ?? null,
		requireEvidence: phase.requireEvidence ?? params.requireEvidence ?? false,
	};
}

/**
 * The debrief's EFFECTIVE parameters. Bound only when the approval gates the
 * workflow's completion, because only then does the debrief run under it — and
 * these resolve from top-level params the workflow digest never sees, so without
 * this a trailing approval could be granted and the debrief then run under a
 * contract, or on a model, the operator never approved.
 */
function normalizeGatedDebrief(params: any, deps: ModeDeps): Record<string, unknown> | null {
	const debrief = params.workflow?.debrief;
	if (!debrief?.agent) return null;
	const dispatch = resolvedDispatch(debrief, params, deps);
	return {
		contract: params.contract ?? null,
		returnContract: params.returnContract ?? null,
		requireEvidence: params.requireEvidence ?? false,
		tier: debrief.tier ?? params.tier ?? null,
		model: dispatch.model,
		thinking: dispatch.thinking,
	};
}

/**
 * What an approval phase actually authorizes: the contiguous run of work phases
 * between it and the next approval — plus the debrief, when that run reaches the
 * end of the workflow — under the agent scope and handoff policy in force when
 * consent was given. Recomputed from the live spec on every use, so the receipt
 * is checked against what would run now, not against whatever the state file
 * claims was approved.
 */
export function approvalBindingFor(phases: any[], index: number, deps: ModeDeps, digest: string): ApprovalBinding {
	const gatedIds = new Set(gatedPhaseIds(phases, index));
	const gated = phases.filter((phase: any) => gatedIds.has(phase.id));
	return {
		action: approvalActionId(phases[index]),
		parameters: {
			approvalMessage: phases[index].approval.message,
			agentScope: deps.agentScope,
			incompleteHandoffPolicy: deps.params.incompleteHandoffPolicy ?? "fail",
			handoffPolicy: deps.handoffs.resolution,
			gatedPhases: gated.map((phase) => normalizeGatedPhase(phase, deps.params, deps)),
			debrief: index + gatedIds.size + 1 >= phases.length ? normalizeGatedDebrief(deps.params, deps) : null,
		},
		requestedBy: "flow:workflow",
		workflowDigest: digest,
		stateVersion: WORKFLOW_STATE_VERSION,
	};
}

/**
 * Burn the receipt that authorized an action, once that action has begun. The
 * consumer is the ACTION, not the individual step, so a gated run of several
 * phases spends one approval once rather than needing one per phase.
 */
export function consumeAuthorization(receipts: Record<string, ApprovalReceipt>, phases: any[], authorizedBy: number | undefined): void {
	if (authorizedBy === undefined) return;
	const approvalId = phases[authorizedBy].id;
	const receipt = receipts[approvalId];
	if (receipt) receipts[approvalId] = consumeApprovalReceipt(receipt, approvalActionId(phases[authorizedBy]));
}
