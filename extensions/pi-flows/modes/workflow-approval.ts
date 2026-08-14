// The approval machinery of workflow mode: what an approval authorizes, how that
// is turned into a binding, and when it may be reopened.
//
// Split out of workflow.ts because it is a self-contained question — "what did
// this consent cover?" — that the phase loop only consults. Nothing here touches
// the persisted state type; the helpers take the two fields they need, so the
// state shape stays workflow.ts's business.
import { sanitizeText } from "../sanitize.ts";
import { WORKFLOW_COMPLETE_STEP, type ApprovalAuthorization, type ApprovalBinding, type ApprovalReceipt } from "../approval.ts";
import { resolveAgentProfile, type AgentProfileEnvironment, type EffectiveAgentProfile } from "../agent-profile.ts";
import { flowError, type CapturePolicy, type FlowError, type ModeDeps } from "../types.ts";

/** An approver label is an audit string, not free-form output: cap it so a hostile env var cannot pad the receipt. */
const APPROVER_LABEL_CAP = 256;
const PROFILE_REFUSAL_POLICY: CapturePolicy = { recordContent: true, redactSecrets: true };

/** The state schema version an approval is granted against. */
export const WORKFLOW_STATE_VERSION = 4;

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

/**
 * What one gated ref will actually run as, resolved through the same effective
 * Agent-profile seam the child-process adapter uses.
 *
 * The tier NAME is not enough to bind. `tier:"deep"` is a question, not an
 * answer — it resolves through the per-install roster, so a config override, a
 * provider losing auth, or a registry refresh between approval and resume can
 * leave the same word selecting a different model, vendor, and effort. A receipt
 * that recorded only the word would still verify while the child ran materially
 * different work, which is the one thing a binding digest exists to prevent.
 *
 * The receipt and dispatch share this resolver so source selection, inherited
 * tools, cwd, model, and Thinking cannot drift between them.
 */
function effectiveProfile(ref: any, params: any, environment: AgentProfileEnvironment): EffectiveAgentProfile {
	return resolveAgentProfile({
		agents: environment.agents,
		agentName: ref.agent,
		defaultCwd: environment.defaultCwd,
		cwd: ref.cwd,
		model: ref.model ?? params.model,
		tier: ref.tier ?? params.tier,
		thinking: ref.thinking,
		flowThinking: params.thinking,
		tools: ref.tools,
		roster: environment.roster,
	});
}

/** Project ModeDeps onto the invocation facts effective-profile resolution owns. */
export const workflowProfileEnvironment = (deps: ModeDeps): AgentProfileEnvironment => ({
	agents: deps.discovery.agents,
	defaultCwd: deps.defaultCwd,
	roster: deps.roster,
});

/**
 * Gated refs whose effective Agent profile cannot be bound, by phase id.
 *
 * A receipt claims to bind exact conditions. A missing Agent leaves source and
 * prompt unknown; Pi-default tools and implicit model/Thinking settings can
 * change outside the workflow before resume. Those profiles are refused before
 * consent rather than represented by a value the runner may later interpret
 * differently.
 */
function unboundGatedRefs(phases: any[], index: number, params: any, environment: AgentProfileEnvironment): string[] {
	const gatedIds = new Set(gatedPhaseIds(phases, index));
	const unbindable = phases
		.filter((phase: any) => gatedIds.has(phase.id) && phase.agent)
		.filter((phase: any) => effectiveProfile(phase, params, environment).unbound.length > 0)
		.map((phase: any) => phase.id);
	const debrief = params.workflow?.debrief;
	if (debrief?.agent && index + gatedIds.size + 1 >= phases.length && effectiveProfile(debrief, params, environment).unbound.length > 0) {
		unbindable.push("debrief");
	}
	return unbindable;
}

/** The one refusal produced when an approval would under-bind a gated profile. */
export function approvalProfileRefusal(phases: any[], index: number, params: any, environment: AgentProfileEnvironment): FlowError | null {
	const unbindable = unboundGatedRefs(phases, index, params, environment);
	if (unbindable.length === 0) return null;
	const phase = phases[index];
	const phaseId = sanitizeText(String(phase.id), PROFILE_REFUSAL_POLICY, 256);
	const gatedIds = sanitizeText(unbindable.join(", "), PROFILE_REFUSAL_POLICY, 1024);
	return flowError(
		"WORKFLOW_INVALID",
		`Approval phase "${phaseId}" gates work whose effective Agent profile cannot be recorded.`,
		`These gated steps do not resolve every condition a receipt must bind (selected Agent source and prompt identity, effective tools, resolved cwd, concrete model, and Thinking level): ${gatedIds}. Missing Agents, Pi-default tools, model selectors without an exact current registry match, or implicit Thinking settings can change before resume without an exact value to compare.${environment.roster?.source === "unavailable" ? " No model registry was readable, so no model or tier could be bound here." : ""}`,
		"Select a discovered Agent and give each listed step explicit tools, model (or a resolvable tier), and Thinking level wherever its Agent profile does not supply them.",
	);
}

/** Fresh-workflow profile refusal declared before its first Child can spawn. */
export function workflowApprovalProfileRefusal(params: any, environment: AgentProfileEnvironment): FlowError | null {
	if (params.workflow?.resume) return null;
	const phases = Array.isArray(params.workflow?.phases) ? params.workflow.phases : [];
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message) continue;
		const refusal = approvalProfileRefusal(phases, index, params, environment);
		if (refusal) return refusal;
	}
	return null;
}

/** Authored and inherited phase terms shared by current and historical bindings. */
function gatedPhaseTerms(phase: any, params: any): Record<string, unknown> {
	return {
		id: phase.id,
		agent: phase.agent ?? null,
		task: phase.task ?? null,
		tier: phase.tier ?? params.tier ?? null,
		checkCommand: phase.checkCommand ?? null,
		contract: phase.contract ?? null,
		returnContract: phase.returnContract ?? params.returnContract ?? null,
		requireEvidence: phase.requireEvidence ?? params.requireEvidence ?? false,
	};
}

/**
 * A gated phase's EFFECTIVE definition — what it resolves to once flow-level
 * fallbacks and the model roster are applied. The workflow digest sees
 * `phase.returnContract`; only this sees that an omitted one falls back to
 * `params.returnContract`, so changing the fallback after approval is caught
 * rather than inherited.
 */
export function normalizeGatedPhase(phase: any, params: any, deps: ModeDeps): Record<string, unknown> {
	const profile = effectiveProfile(phase, params, workflowProfileEnvironment(deps)).identity;
	return {
		...gatedPhaseTerms(phase, params),
		source: profile.source,
		promptDigest: profile.promptDigest,
		cwd: profile.resolvedCwd,
		model: profile.model,
		thinking: profile.thinking,
		tools: profile.effectiveTools,
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
	const profile = effectiveProfile(debrief, params, workflowProfileEnvironment(deps)).identity;
	return {
		agent: debrief.agent,
		source: profile.source,
		promptDigest: profile.promptDigest,
		tools: profile.effectiveTools,
		cwd: profile.resolvedCwd,
		contract: debrief.contract ?? params.contract ?? null,
		returnContract: params.returnContract ?? null,
		requireEvidence: params.requireEvidence ?? false,
		tier: debrief.tier ?? params.tier ?? null,
		model: profile.model,
		thinking: profile.thinking,
	};
}

/**
 * The under-bound v3 projection, retained only to verify fully spent receipts
 * before migrating them to audit-only compatibility evidence. It must remain an
 * exact statement of the old schema; outstanding v3 consent is never rebuilt.
 */
export function historicalApprovalBindingForV3(phases: any[], index: number, deps: ModeDeps, digest: string): ApprovalBinding {
	const gatedIds = new Set(gatedPhaseIds(phases, index));
	const gated = phases.filter((phase: any) => gatedIds.has(phase.id));
	const environment = workflowProfileEnvironment(deps);
	const historicalPhase = (phase: any) => {
		const profile = effectiveProfile(phase, deps.params, environment);
		return {
			...gatedPhaseTerms(phase, deps.params),
			cwd: phase.cwd ?? null,
			model: profile.modelChoice.model ?? null,
			thinking: profile.modelChoice.thinking ?? null,
			tools: phase.tools ?? null,
		};
	};
	const debrief = deps.params.workflow?.debrief;
	const gatesDebrief = Boolean(debrief?.agent && index + gatedIds.size + 1 >= phases.length);
	const debriefProfile = gatesDebrief ? effectiveProfile(debrief, deps.params, environment) : null;
	const historicalDebrief = gatesDebrief
		? {
				contract: deps.params.contract ?? null,
				returnContract: deps.params.returnContract ?? null,
				requireEvidence: deps.params.requireEvidence ?? false,
				tier: debrief.tier ?? deps.params.tier ?? null,
				model: debriefProfile?.modelChoice.model ?? null,
				thinking: debriefProfile?.modelChoice.thinking ?? null,
			}
		: null;
	return {
		action: approvalActionId(phases[index]),
		parameters: {
			approvalMessage: phases[index].approval.message,
			agentScope: deps.agentScope,
			incompleteHandoffPolicy: deps.params.incompleteHandoffPolicy ?? "fail",
			handoffPolicy: deps.handoffs.resolution,
			gatedPhases: gated.map(historicalPhase),
			debrief: historicalDebrief,
		},
		requestedBy: "flow:workflow",
		workflowDigest: digest,
		stateVersion: 3,
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
 * consumer is the ACTION, not the step, so a gated run spends one approval
 * once. Only a verified authorization can be spent: the capability comes from
 * `ApprovalAuthorization.verify` in this same handler pass.
 */
export function consumeAuthorization(
	receipts: Record<string, ApprovalReceipt>,
	phases: any[],
	authorizedBy: number | undefined,
	authorization: ApprovalAuthorization | undefined,
): void {
	if (authorizedBy === undefined || !authorization) return;
	receipts[phases[authorizedBy].id] = authorization.consume();
}
