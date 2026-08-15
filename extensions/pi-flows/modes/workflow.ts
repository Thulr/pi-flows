import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { encodeAuthorKey, flowError, modeSettle, type DelegationContract, type DelegationHandoffEnvelope, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, escapeRegExp, resultText, sanitizeText } from "../sanitize.ts";
import { resolveFlowCommandTimeoutMs, runCheckCommand } from "../commands.ts";
import { ResolvedDelegationContract, canonicalHandoff, createPersistedHandoffAttestation, incompleteHandoffSummary, isRecord, validatePersistedIntegrationHandoff, type PersistedHandoffAttestation } from "../delegation.ts";
import { dispatchIntegrationPlan, integrationRunPlan } from "../integration.ts";
import { ApprovalAuthorization, DEFAULT_APPROVAL_ACTOR, WORKFLOW_COMPLETE_STEP, approvalReceiptSummary, formatApprovalReceipt, issueApprovalReceipt, legacyApprovalReceipt, resolveApprovalTtlMs, type ApprovalReceipt } from "../approval.ts";
import { approvalAuthorizations, approvalBindingFor, approvalProfileRefusal, approverLabel, consumeAuthorization, gatedPhaseIds, resolveApprovalBinding, REAPPROVABLE_RECEIPT_ERRORS, workflowApprovalProfileRefusal, workflowProfileEnvironment, WORKFLOW_STATE_VERSION } from "./workflow-approval.ts";
import { durablePhaseHandoff, freshState, migrateWorkflowStateV1, migrateWorkflowStateV2, migrateWorkflowStateV3, persistFailedState, persistState, workflowDigest, type WorkflowState } from "./workflow-state.ts";
import { isWorkflowWorkPhase, resolvedCwd, workflowHeadlessApprovalRefusal, workflowPhasesRefusal, type CwdTargetBinding } from "../validate.ts";
import { plannedRefs, sumRunDurations, type ModePlan, type PreSpawnContext } from "./plan.ts";

/**
 * Workflow's plan: one wave per phase in phase order (approval phases plan no
 * refs — they spawn nothing — though a phase-declared agent stays on the
 * requested-agents surface), then the optional debrief. Nothing is guarded:
 * phases run one at a time. The opening is the first WORK phase, and only
 * when it is statically certain — a resume reads persisted state this plan
 * cannot, and an invalid phase list is refused WORKFLOW_INVALID before any
 * roster check. Phases carry only their own contracts; the debrief resolves
 * against the call's fallback.
 */
export function planWorkflow(params: any): ModePlan {
	if (!params.workflow) return { waves: [], opening: [] };
	const spec = params.workflow ?? {};
	const phases = Array.isArray(spec.phases) ? spec.phases : [];
	const debrief = plannedRefs([spec.debrief]);
	return {
		waves: [
			...phases.map((phase: unknown) => ({ refs: plannedRefs([phase]), guarded: false, contracts: "own" as const })),
			...(debrief.length > 0 ? [{ refs: debrief, guarded: false, contracts: "resolved" as const }] : []),
		],
		opening: spec.resume || workflowPhasesRefusal(params) ? [] : plannedRefs(phases.filter(isWorkflowWorkPhase).slice(0, 1)),
	};
}

/** Phases run one at a time: sequential. */
export function criticalPathWorkflow(_params: any, results: FlowRunResult[]): number | undefined {
	return sumRunDurations(results);
}

/**
 * Workflow's pre-spawn refusal (modes/contract.ts). Both rules already
 * live in Core (validate-workflow.ts) because the handler and the eval always
 * shared them; this composes them into the one question the table asks, and
 * supplies the context the second rule needs.
 *
 * Phase shape is refused unconditionally. The approval rule is
 * context-dependent: an opening approval phase can be collected interactively,
 * so only a headless run is refused before spawning — which is why the handler
 * enforces that one inline, against the UI it actually has, rather than
 * through this declaration.
 */
export function preSpawnRefusalWorkflow(params: any, context: PreSpawnContext): FlowError | null {
	return workflowPhasesRefusal(params ?? {})
		?? (context.agentProfiles ? workflowApprovalProfileRefusal(params ?? {}, context.agentProfiles) : null)
		?? (context.headless ? workflowHeadlessApprovalRefusal(params ?? {}) : null);
}

/** One place both sides of a phase dependency link derive the key, so they cannot drift. */
const phaseStageKey = (phaseId: string) => `phase-${encodeAuthorKey(phaseId)}`;
const phaseStateKey = (phaseId: string) => `${phaseStageKey(phaseId)}.state`;
const phaseApprovalKey = (phaseId: string) => `${phaseStageKey(phaseId)}.approval`;
function phaseWorkKey(phaseId: string): string {
	return `${phaseStageKey(phaseId)}.work`;
}

function renderPhaseTask(template: string, task: string | undefined, previous: string, outputs: Record<string, string>): string {
	let rendered = template.replace(/\{task\}/g, task ?? "").replace(/\{previous\}/g, previous);
	for (const [id, output] of Object.entries(outputs)) {
		rendered = rendered.replace(new RegExp(`\\{phase\\.${escapeRegExp(id)}\\}`, "g"), output);
	}
	return rendered;
}

/** Recheck a completed work phase without trusting or rewriting its persisted output. */
function resumedPhaseHandoff(phase: any, state: WorkflowState, params: any, policy: ModeDeps["policy"]): { handoff?: DelegationHandoffEnvelope; error?: FlowError } {
	let phaseContract: ResolvedDelegationContract | undefined;
	if (phase.contract) {
		const resolution = ResolvedDelegationContract.resolve(phase.contract, policy);
		if (resolution.error) return { error: resolution.error };
		phaseContract = resolution.resolved;
	}
	const handoff = state.handoffs[phase.id];
	const error = validatePersistedIntegrationHandoff(handoff, {
		attestation: state.attestations[phase.id],
		contract: phaseContract,
		policy,
		incompletePolicy: params.incompleteHandoffPolicy,
	});
	return error ? { error } : { handoff };
}

/**
 * Every durable state change is attributable. A workflow's failure mode is
 * usually "which phase left the state where", and that question is unanswerable
 * from child spans alone because approvals, gates, and resumes move state
 * without spawning anything.
 */
function recordPhaseState(deps: ModeDeps, phaseId: string, transition: string, state: WorkflowState, extra: Record<string, unknown> = {}): void {
	deps.recordEvent?.({
		kind: "state",
		name: `workflow.${transition}`,
		ok: state.status !== "failed",
		scope: { key: phaseStateKey(phaseId), stage: { key: phaseStageKey(phaseId), name: `phase ${phaseId}` } },
		attributes: {
			"flow.workflow.phase_id": phaseId,
			"flow.workflow.status": state.status,
			"flow.workflow.completed_phases": state.completedPhaseIds.length,
			"flow.workflow.digest": state.digest,
			"flow.workflow.state_version": state.version,
			...extra,
		},
	});
}

export async function handleWorkflow(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy, defaultCwd } = deps;
	const spec = params.workflow ?? {};
	const phases = Array.isArray(spec.phases) ? spec.phases : [];
	// Shared with the selection eval's admissibility seam: an invalid phase
	// refuses the call whole before any state write or spawn (#88). The
	// normalized spec keeps validation unskippable even if activation changes.
	const profiles = workflowProfileEnvironment(deps);
	const phasesRefusal = preSpawnRefusalWorkflow(params, { headless: false, agentProfiles: profiles });
	if (phasesRefusal) return settle.refuse(phasesRefusal);

	const approvalTtl = resolveApprovalTtlMs(spec.approvalTtlMs);
	if ("error" in approvalTtl) return settle.refuse(approvalTtl.error);

	const digest = workflowDigest(params.task, spec);
	const stateFile = path.resolve(defaultCwd, spec.stateFile ?? `.pi/flow-workflows/${digest}.json`);
	const authorizations = approvalAuthorizations(phases);
	let state = freshState(digest);
	if (spec.resume) {
		try {
			const loaded = JSON.parse(await readFile(stateFile, "utf8")) as any;
			if (![1, 2, 3, WORKFLOW_STATE_VERSION].includes(loaded.version) || loaded.digest !== digest || !Array.isArray(loaded.completedPhaseIds)
				|| !loaded.outputs || typeof loaded.outputs !== "object" || Array.isArray(loaded.outputs)) throw new Error("state does not match this workflow");
			let restored = loaded.version === 1 ? migrateWorkflowStateV1(loaded, phases, policy) : loaded;
			if (!isRecord(restored.handoffs) || !isRecord(restored.attestations)) throw new Error("state does not match this workflow");
			if (restored.version === 2) {
				const migrated = migrateWorkflowStateV2(restored, phases, deps, digest);
				if (migrated.error) return settle.refuse(migrated.error);
				restored = migrated.state;
			}
			if (restored.version === 3) {
				if (!isRecord(restored.receipts)) throw new Error("state does not match this workflow");
				const migrated = migrateWorkflowStateV3(restored, phases, deps, digest);
				if (migrated.error) return settle.refuse(migrated.error);
				restored = migrated.state;
			}
			if (!isRecord(restored.receipts)) throw new Error("state does not match this workflow");
			state = restored as WorkflowState;
			if (state.status === "completed" && phases.some((phase: any) => !state.completedPhaseIds.includes(phase.id))) {
				throw new Error("completed state omits one or more workflow phases");
			}
			if (loaded.version !== WORKFLOW_STATE_VERSION) await persistState(stateFile, state);
		} catch (cause) {
			const error = flowError("WORKFLOW_STATE_INVALID", "Workflow resume state is missing or incompatible.", `Could not resume ${sanitizeText(stateFile, policy)}: ${cause instanceof Error ? cause.message : String(cause)}.`, "Use the same task/phases/stateFile that created the state, or omit resume to start a fresh workflow.");
			return settle.refuse(error);
		}
	} else {
		await persistState(stateFile, state);
	}
	const resumedCompleted = Boolean(spec.resume && state.status === "completed");

	// Every output from here on carries the receipts this run issued or spent —
	// identifiers and status, never the approved parameters. Registered once the
	// state exists, and reading it live through the closure, so an output built
	// after later phases reflects the receipts they minted or consumed.
	settle.decorateDetails((details) => {
		const approvals = Object.values(state.receipts).map(approvalReceiptSummary);
		if (approvals.length) details.approvals = approvals;
		return details;
	});
	if (resumedCompleted) {
		for (const [phaseIndex, phase] of phases.entries()) {
			if (phase.approval?.message) {
				const binding = approvalBindingFor(phases, phaseIndex, deps, digest);
				const auditError = ApprovalAuthorization.verify(state.receipts[phase.id], binding, { consumer: binding.action }).error;
				if (auditError && !REAPPROVABLE_RECEIPT_ERRORS.has(auditError.code)) return settle.refuse(auditError);
			} else if (state.completedPhaseIds.includes(phase.id)) {
				const resumed = resumedPhaseHandoff(phase, state, params, policy);
				if (resumed.error) return settle.refuse(resumed.error);
			}
		}
		const approvals = Object.values(state.receipts).map(approvalReceiptSummary).map((receipt) => `\n  ${formatApprovalReceipt(receipt)}`).join("");
		return settle.complete(capModelVisibleText(`Flow workflow: ${phases.length} phases were already completed; no Child reran. State: ${sanitizeText(path.relative(defaultCwd, stateFile), policy)}${approvals ? `\nApprovals:${approvals}` : ""}`));
	}
	const resumedHandoffs: DelegationHandoffEnvelope[] = [];
	let previous = "";
	// The unit a following phase depends on differs by how the prior phase ran: a
	// work phase leaves a child span, an approval leaves only its approval event,
	// and a resumed phase leaves only its state event. Assuming the work key for
	// all three left the approval-to-work edge pointing at a span that never
	// existed, so each branch records what it actually registered.
	let priorPhaseKey: string | undefined;
	// What each phase actually registered, in order. The debrief consumes every
	// phase's artifact, so its links have to name the units that exist — approval
	// and resumed phases never produce a work child to point at.
	const phaseUnitKeys: string[] = [];
	const registerPhaseUnit = (key: string) => {
		priorPhaseKey = key;
		phaseUnitKeys.push(key);
	};
	for (const [phaseIndex, phase] of phases.entries()) {
		const stage = { key: phaseStageKey(phase.id), name: `phase ${phase.id}` };
		// Set when a completed approval is reopened, so the re-prompt can say why it
		// is being asked again instead of looking like a fresh pause.
		let reapprovalCause: string | null = null;
		if (state.completedPhaseIds.includes(phase.id)) {
			if (phase.approval?.message) {
				// Re-check consent where the approval lives, not only where it is spent.
				// A lapsed or superseded approval reopens here so it can be granted
				// again in this same pass; headless runs still fail closed below.
				const binding = approvalBindingFor(phases, phaseIndex, deps, digest);
				const stale = ApprovalAuthorization.verify(state.receipts[phase.id], binding, { consumer: binding.action }).error;
				const completedGatedPhases = gatedPhaseIds(phases, phaseIndex).filter((id) => state.completedPhaseIds.includes(id));
				const authorizationStarted = completedGatedPhases.length > 0 || typeof state.receipts[phase.id]?.consumedAt === "string";
				// Reopening is only safe while none of the gated run has happened. Once
				// part of it has, a fresh receipt would claim to authorize work that
				// actually ran under the old parameters — one receipt describing two
				// different actions — and would erase the receipt that authorized the
				// completed half. That is a judgement call for a person, not a retry.
				if (stale && REAPPROVABLE_RECEIPT_ERRORS.has(stale.code) && !authorizationStarted) {
					reapprovalCause = stale.cause;
					state.completedPhaseIds = state.completedPhaseIds.filter((id) => id !== phase.id);
					delete state.receipts[phase.id];
				} else if (stale && REAPPROVABLE_RECEIPT_ERRORS.has(stale.code)) {
					await persistFailedState(stateFile, state);
					return settle.refuse(flowError(
						stale.code,
						`The approval for "${binding.action}" no longer matches, and part of what it authorized has already run.`,
						`${stale.cause} ${completedGatedPhases.length > 0 ? `Phases ${completedGatedPhases.join(", ")} already ran` : "The receipt was already consumed when its gated debrief began"} under the conditions that were approved, so re-approving now would authorize a mix of old and new.`,
						"Restore the parameters that were approved and resume, or start a fresh run so the whole gated sequence executes under one approval.",
					));
				} else if (stale) {
					await persistFailedState(stateFile, state);
					return settle.refuse(stale);
				} else {
					previous = state.outputs[phase.id] ?? previous;
					recordPhaseState(deps, phase.id, "approval.resumed", state, { "flow.approval.receipt_id": state.receipts[phase.id]?.receiptId ?? "(none)" });
					registerPhaseUnit(phaseStateKey(phase.id));
					continue;
				}
			} else {
				const resumed = resumedPhaseHandoff(phase, state, params, policy);
				if (resumed.error) return settle.refuse(resumed.error);
				const persisted = resumed.handoff!;
				if (persisted.status !== "completed") resumedHandoffs.push(persisted);
				const validatedOutput = params.recordContent === false ? "[content not recorded]" : canonicalHandoff(persisted);
				state.outputs[phase.id] = validatedOutput;
				previous = validatedOutput;
				recordPhaseState(deps, phase.id, "phase.resumed", state, { "flow.handoff.status": persisted.status, "flow.handoff.compatibility": persisted.compatibility });
				registerPhaseUnit(phaseStateKey(phase.id));
				continue;
			}
		}

		// Nothing an approval gates runs until its receipt is re-verified against
		// what would run NOW. On a resume that is the whole point: the receipt was
		// minted in an earlier process against an earlier spec.
		const authorizedBy = authorizations.get(phase.id);
		let authorization: ApprovalAuthorization | undefined;
		let approvedPhaseCwd: CwdTargetBinding | undefined;
		if (authorizedBy !== undefined) {
			const profileError = isWorkflowWorkPhase(phase) ? approvalProfileRefusal(phases, authorizedBy, params, profiles) : null;
			if (profileError) return settle.refuse(profileError);
			const resolvedApproval = resolveApprovalBinding(phases, authorizedBy, deps, digest);
			const verified = ApprovalAuthorization.verify(state.receipts[phases[authorizedBy].id], resolvedApproval.binding, { consumer: resolvedApproval.binding.action });
			if (verified.error) {
				await persistFailedState(stateFile, state);
				return settle.refuse(verified.error);
			}
			authorization = verified.authorization;
			approvedPhaseCwd = resolvedApproval.gatedCwds.get(phase.id);
		}

		state.nextPhaseId = phase.id;
		state.status = "running";
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);
		recordPhaseState(deps, phase.id, "phase.started", state, { "flow.workflow.phase_kind": phase.approval?.message ? "approval" : "work" });

		if (phase.approval?.message) {
			// Refused before the human is asked, not after: consent given to an
			// action whose effective profile cannot be recorded would be consent
			// this receipt cannot honour on resume, and asking first would waste it.
			const profileError = approvalProfileRefusal(phases, phaseIndex, params, profiles);
			if (profileError) {
				recordPhaseState(deps, phase.id, "approval.blocked", state, { "flow.error_code": profileError.code });
				return settle.refuse(profileError);
			}
			const resolvedApproval = resolveApprovalBinding(phases, phaseIndex, deps, digest);
			const prompt = reapprovalCause ? `${phase.approval.message}\n\nRe-approval needed: ${reapprovalCause}` : phase.approval.message;
			const decision = await deps.requestApproval?.("Approve workflow phase?", prompt) ?? "required";
			if (decision !== "approved") {
				state.status = decision === "required" ? "paused" : "failed";
				state.updatedAt = new Date().toISOString();
				await persistState(stateFile, state);
				const code = decision === "required" ? "WORKFLOW_APPROVAL_REQUIRED" : "WORKFLOW_APPROVAL_DENIED";
				const error = flowError(
					code,
					decision === "required" ? `Workflow paused before approval phase "${phase.id}".` : `Workflow approval phase "${phase.id}" was denied.`,
					decision === "required"
						? `Approval nodes fail closed in headless runs; completed phase artifacts were persisted.${reapprovalCause ? ` A previously granted approval no longer holds: ${reapprovalCause}` : ""}`
						: `The interactive approval prompt was denied.${reapprovalCause ? ` It was re-asked because ${reapprovalCause}` : ""}`,
					decision === "required" ? `Resume in an interactive Pi UI with workflow.resume:true and stateFile:"${spec.stateFile ?? path.relative(defaultCwd, stateFile)}".` : "Review the persisted artifacts, update the workflow if needed, then retry.",
				);
				recordPhaseState(deps, phase.id, "approval.blocked", state, { "flow.approval.decision": decision, "flow.error_code": code, "flow.approval.reopened": Boolean(reapprovalCause) });
				return settle.refuse(error);
			}
			// Consent becomes a receipt bound to exactly what it authorizes. It is
			// minted unconsumed: it says the action may run, not that it has. The
			// receipt attests its own issuance — the seam records the approval event.
			const receipt = issueApprovalReceipt(resolvedApproval.binding, {
				approvedBy: approverLabel(deps, policy, DEFAULT_APPROVAL_ACTOR),
				ttlMs: approvalTtl.ttlMs,
			}, {
				record: deps.recordEvent,
				name: "workflow.approval.issued",
				scope: { key: phaseApprovalKey(phase.id), stage },
				attributes: { "flow.approval.reopened": Boolean(reapprovalCause) },
			});
			state.receipts[phase.id] = receipt;
			state.completedPhaseIds.push(phase.id);
			consumeAuthorization(state.receipts, phases, authorizedBy, authorization);
			state.outputs[phase.id] = `APPROVED (receipt ${receipt.receiptId})`;
			previous = state.outputs[phase.id];
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			recordPhaseState(deps, phase.id, "approval.granted", state, { "flow.approval.receipt_id": receipt.receiptId });
			registerPhaseUnit(phaseApprovalKey(phase.id));
			continue;
		}

		if (authorizedBy !== undefined) {
			const profileError = approvalProfileRefusal(phases, authorizedBy, params, profiles);
			if (profileError) return settle.refuse(profileError);
			const finalApproval = resolveApprovalBinding(phases, authorizedBy, deps, digest);
			const finalVerification = ApprovalAuthorization.verify(state.receipts[phases[authorizedBy].id], finalApproval.binding, { consumer: finalApproval.binding.action });
			if (finalVerification.error) {
				await persistFailedState(stateFile, state);
				return settle.refuse(finalVerification.error);
			}
			authorization = finalVerification.authorization;
			approvedPhaseCwd = finalApproval.gatedCwds.get(phase.id);
		}
		const phaseCwd = approvedPhaseCwd?.path ?? resolvedCwd(defaultCwd, phase.cwd);
		const ref: FlowAgentRefInput = { agent: phase.agent, cwd: phaseCwd, model: phase.model, tier: phase.tier, thinking: phase.thinking, tools: phase.tools, contract: phase.contract };
		const planned = integrationRunPlan(deps, ref, renderPhaseTask(phase.task, params.task, previous, state.outputs), {
			returnContract: phase.returnContract ?? params.returnContract,
			requireEvidence: phase.requireEvidence ?? params.requireEvidence,
			cwdBinding: approvedPhaseCwd,
			// The child's key must differ from its stage's: a workflow phase is both,
			// and one shared name would leave dependency links pointing at whichever
			// was registered last.
			scope: { key: phaseWorkKey(phase.id), stage, ...(priorPhaseKey ? { dependsOn: [priorPhaseKey] } : {}) },
		});
		if (planned.error) return settle.refuse(planned.error);
		const consumed = Boolean(spec.debrief?.agent)
			|| phases.slice(phaseIndex + 1).some((candidate: any) => candidate?.agent && candidate?.task);
		const dispatched = await dispatchIntegrationPlan(deps, planned.plan!, settle, { completion: consumed ? "integrate" : "terminal", enforceCompletion: true });
		if (dispatched.status === "failed") {
			await persistFailedState(stateFile, state);
			recordPhaseState(deps, phase.id, "phase.failed", state, { "flow.error_code": dispatched.result.error?.code ?? "(none)" });
			return settle.complete(sanitizeText(`Flow workflow stopped in phase "${phase.id}" (${phase.agent}).\n\n${resultText(dispatched.result)}`, policy));
		}
		if (dispatched.status === "refused") {
			await persistFailedState(stateFile, state);
			recordPhaseState(deps, phase.id, "phase.failed", state, { "flow.error_code": dispatched.error.code });
			return dispatched.output;
		}
		const run = dispatched.result;
		const handoff = dispatched.handoff;

		const output = handoff.text;
		if (phase.checkCommand) {
			const gate = await runCheckCommand(phase.checkCommand, phaseCwd, resolveFlowCommandTimeoutMs(undefined, params.timeoutMs), policy, {
				record: deps.recordEvent,
				name: "workflow.gate",
				// The command ran against this phase's workspace, so a failed workflow
				// ends at the output that failed rather than at a disconnected gate.
				scope: { key: `${stage.key}.gate`, stage, dependsOn: [phaseWorkKey(phase.id)] },
				attributes: { "flow.workflow.phase_id": phase.id },
			}, deps.signal);
			if (!gate.ok) {
				await persistFailedState(stateFile, state);
				recordPhaseState(deps, phase.id, "phase.failed", state, { "flow.error_code": "WORKFLOW_GATE_FAILED" });
				const error = flowError("WORKFLOW_GATE_FAILED", `Workflow gate failed after phase "${phase.id}".`, gate.output || "The phase checkCommand exited non-zero.", "Fix the phase artifact or check command, then resume with an updated workflow or start a fresh run.");
				return settle.refuse(error);
			}
		}

		state.completedPhaseIds.push(phase.id);
		consumeAuthorization(state.receipts, phases, authorizedBy, authorization);
		const phaseContract = phase.contract ? ResolvedDelegationContract.resolve(phase.contract, policy).resolved : undefined;
		const persistedHandoff = durablePhaseHandoff(run, phaseContract, policy);
		state.handoffs[phase.id] = persistedHandoff;
		state.attestations[phase.id] = createPersistedHandoffAttestation(persistedHandoff);
		state.outputs[phase.id] = params.recordContent === false ? "[content not recorded]" : output;
		previous = state.outputs[phase.id];
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);
		recordPhaseState(deps, phase.id, "phase.completed", state, { "flow.handoff.status": persistedHandoff.status, "flow.handoff.compatibility": persistedHandoff.compatibility });
		// A later child reads the prepared output through its task, so it depends on
		// the handoff boundary. A terminal phase has no such boundary and remains a
		// child dependency instead of inventing a handoff to the caller.
		registerPhaseUnit(handoff.dependencyKey ?? phaseWorkKey(phase.id));
	}
	// A trailing approval gates the workflow's own completion (and its debrief),
	// so it is verified and spent here rather than by a following phase.
	const tailApproval = authorizations.get(WORKFLOW_COMPLETE_STEP);
	let approvedDebriefCwd: CwdTargetBinding | undefined;
	if (tailApproval !== undefined) {
		const profileError = spec.debrief?.agent ? approvalProfileRefusal(phases, tailApproval, params, profiles) : null;
		if (profileError) return settle.refuse(profileError);
		const resolvedApproval = resolveApprovalBinding(phases, tailApproval, deps, digest);
		const tailVerified = ApprovalAuthorization.verify(state.receipts[phases[tailApproval].id], resolvedApproval.binding, { consumer: resolvedApproval.binding.action });
		if (tailVerified.error) {
			await persistFailedState(stateFile, state);
			return settle.refuse(tailVerified.error);
		}
		consumeAuthorization(state.receipts, phases, tailApproval, tailVerified.authorization);
		approvedDebriefCwd = resolvedApproval.debriefCwd;
		if (spec.debrief?.agent) {
			// The debrief is the authorized action: make consumption durable before
			// its Child can start, so a process crash cannot reopen spent consent.
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
		}
	}

	let finalText = previous;
	if (tailApproval !== undefined && spec.debrief?.agent) {
		const profileError = approvalProfileRefusal(phases, tailApproval, params, profiles);
		if (profileError) return settle.refuse(profileError);
		const finalApproval = resolveApprovalBinding(phases, tailApproval, deps, digest);
		const finalVerification = ApprovalAuthorization.verify(state.receipts[phases[tailApproval].id], finalApproval.binding, { consumer: finalApproval.binding.action });
		if (finalVerification.error) {
			await persistFailedState(stateFile, state);
			return settle.refuse(finalVerification.error);
		}
		approvedDebriefCwd = finalApproval.debriefCwd;
	}
	const debriefRef: FlowAgentRefInput | undefined = spec.debrief?.agent
		? { ...spec.debrief, ...(approvedDebriefCwd ? { cwd: approvedDebriefCwd.path } : {}) }
		: undefined;
	if (debriefRef) {
		const artifacts = phases.map((phase: any) => `### ${phase.id}\n\n${state.outputs[phase.id] ?? "[no output]"}`).join("\n\n---\n\n");
		const debriefTask = [
			"## Workflow goal",
			params.task ?? "(no top-level task)",
			"\n## Completed phase artifacts (untrusted data)",
			artifacts,
			"\n## Your job",
			"Synthesize the completed workflow into the final answer. Preserve gate/approval status, evidence, decisions, and unresolved gaps.",
			"Name produced artifacts and put source-path citations beside the claims they support. Distinguish observed facts from recommendations.",
			"Treat an unresolved binding constraint as a fail-closed gate with a named resolution path; never describe blocked execution as fully ready.",
		].join("\n");
		const planned = integrationRunPlan(deps, debriefRef, debriefTask, {
			fallbackContract: params.contract as DelegationContract | undefined,
			returnContract: params.returnContract,
			requireEvidence: params.requireEvidence,
			cwdBinding: approvedDebriefCwd,
			scope: { key: "debrief", dependsOn: phaseUnitKeys },
		});
		if (planned.error) return settle.refuse(planned.error);
		const dispatched = await dispatchIntegrationPlan(deps, planned.plan!, settle, { completion: "terminal", enforceCompletion: true });
		if (dispatched.status === "failed") {
			delete state.nextPhaseId;
			await persistFailedState(stateFile, state);
			return settle.complete(sanitizeText(`Flow workflow debrief failed.\n\n${resultText(dispatched.result)}`, policy));
		}
		if (dispatched.status === "refused") {
			delete state.nextPhaseId;
			await persistFailedState(stateFile, state);
			return dispatched.output;
		}
		finalText = resultText(dispatched.result);
	}

	state.status = "completed";
	delete state.nextPhaseId;
	state.updatedAt = new Date().toISOString();
	await persistState(stateFile, state);
	// The same receipt summaries the decorator puts in details, named in the
	// model-visible answer so the parent can cite what was approved.
	const approvals = Object.values(state.receipts).map(approvalReceiptSummary).map((receipt) => `\n  ${formatApprovalReceipt(receipt)}`).join("");
	return settle.complete(capModelVisibleText(`Flow workflow: ${phases.length} phases completed.${incompleteHandoffSummary([...settle.results], resumedHandoffs)} State: ${sanitizeText(path.relative(defaultCwd, stateFile), policy)}${approvals ? `\nApprovals:${approvals}` : ""}\n\n${sanitizeText(finalText, policy)}`));
}
