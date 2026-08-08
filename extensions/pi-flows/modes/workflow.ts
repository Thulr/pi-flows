import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { encodeAuthorKey, flowError, formatFlowError, type DelegationContract, type DelegationHandoffEnvelope, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, escapeRegExp, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentRef } from "../runner.ts";
import { resolveFlowCommandTimeoutMs, runCheckCommand } from "../commands.ts";
import { ResolvedDelegationContract, canonicalHandoff, createPersistedHandoffAttestation, incompleteHandoffSummary, isRecord, validatePersistedIntegrationHandoff, type PersistedHandoffAttestation } from "../delegation.ts";
import { integrationRunPlan, runIntegrationPlan } from "../integration.ts";
import { ApprovalAuthorization, DEFAULT_APPROVAL_ACTOR, WORKFLOW_COMPLETE_STEP, approvalReceiptSummary, formatApprovalReceipt, issueApprovalReceipt, legacyApprovalReceipt, resolveApprovalTtlMs, type ApprovalReceipt } from "../approval.ts";
import { approvalAuthorizations, approvalBindingFor, approverLabel, consumeAuthorization, gatedPhaseIds, gatedRunStarted, REAPPROVABLE_RECEIPT_ERRORS, unbindableGatedRefs, WORKFLOW_STATE_VERSION } from "./workflow-approval.ts";
import { freshState, migrateWorkflowStateV1, migrateWorkflowStateV2, persistState, workflowDigest, type WorkflowState } from "./workflow-state.ts";
import { workflowPhasesRefusal } from "../validate.ts";

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

function stateError(deps: ModeDeps, results: FlowRunResult[], error: FlowError, state?: WorkflowState): ModeOutput {
	return { content: [{ type: "text", text: formatFlowError(error) }], details: workflowDetails(deps, results, state, error) };
}

/** FlowDetails plus the receipts this run issued or spent — identifiers and status, never the approved parameters. */
function workflowDetails(deps: ModeDeps, results: FlowRunResult[], state?: WorkflowState, error?: FlowError) {
	const details = deps.makeDetails("workflow")(results, error);
	const approvals = Object.values(state?.receipts ?? {}).map(approvalReceiptSummary);
	if (approvals.length) details.approvals = approvals;
	return details;
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
	const { params, discovery, policy, agentScope, defaultCwd } = deps;
	const spec = params.workflow ?? {};
	const phases = Array.isArray(spec.phases) ? spec.phases : [];
	// Shared with the selection eval's admissibility seam: an invalid phase
	// refuses the call whole before any state write or spawn (#88). The
	// normalized spec keeps validation unskippable even if activation changes.
	const phasesRefusal = workflowPhasesRefusal({ workflow: spec });
	if (phasesRefusal) return stateError(deps, [], phasesRefusal);

	const approvalTtl = resolveApprovalTtlMs(spec.approvalTtlMs);
	if ("error" in approvalTtl) return stateError(deps, [], approvalTtl.error);

	const digest = workflowDigest(params.task, spec);
	const stateFile = path.resolve(defaultCwd, spec.stateFile ?? `.pi/flow-workflows/${digest}.json`);
	const authorizations = approvalAuthorizations(phases);
	let state = freshState(digest);
	if (spec.resume) {
		try {
			const loaded = JSON.parse(await readFile(stateFile, "utf8")) as any;
			if (![1, 2, WORKFLOW_STATE_VERSION].includes(loaded.version) || loaded.digest !== digest || !Array.isArray(loaded.completedPhaseIds)
				|| !loaded.outputs || typeof loaded.outputs !== "object" || Array.isArray(loaded.outputs)) throw new Error("state does not match this workflow");
			let restored = loaded.version === 1 ? migrateWorkflowStateV1(loaded, phases, policy) : loaded;
			if (!isRecord(restored.handoffs) || !isRecord(restored.attestations)) throw new Error("state does not match this workflow");
			if (restored.version < WORKFLOW_STATE_VERSION) restored = migrateWorkflowStateV2(restored, phases, deps, digest);
			if (!isRecord(restored.receipts)) throw new Error("state does not match this workflow");
			state = restored as WorkflowState;
			if (loaded.version !== WORKFLOW_STATE_VERSION) await persistState(stateFile, state);
		} catch (cause) {
			const error = flowError("WORKFLOW_STATE_INVALID", "Workflow resume state is missing or incompatible.", `Could not resume ${sanitizeText(stateFile, policy)}: ${cause instanceof Error ? cause.message : String(cause)}.`, "Use the same task/phases/stateFile that created the state, or omit resume to start a fresh workflow.");
			return stateError(deps, [], error);
		}
	} else {
		await persistState(stateFile, state);
	}

	const results: FlowRunResult[] = [];
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
				// Reopening is only safe while none of the gated run has happened. Once
				// part of it has, a fresh receipt would claim to authorize work that
				// actually ran under the old parameters — one receipt describing two
				// different actions — and would erase the receipt that authorized the
				// completed half. That is a judgement call for a person, not a retry.
				if (stale && REAPPROVABLE_RECEIPT_ERRORS.has(stale.code) && !gatedRunStarted(phases, phaseIndex, state.completedPhaseIds)) {
					reapprovalCause = stale.cause;
					state.completedPhaseIds = state.completedPhaseIds.filter((id) => id !== phase.id);
					delete state.receipts[phase.id];
				} else if (stale && REAPPROVABLE_RECEIPT_ERRORS.has(stale.code)) {
					state.status = "failed";
					state.updatedAt = new Date().toISOString();
					await persistState(stateFile, state);
					return stateError(deps, results, flowError(
						stale.code,
						`The approval for "${binding.action}" no longer matches, and part of what it authorized has already run.`,
						`${stale.cause} Phases ${gatedPhaseIds(phases, phaseIndex).filter((id) => state.completedPhaseIds.includes(id)).join(", ")} already ran under the parameters that were approved, so re-approving now would authorize a mix of old and new.`,
						"Restore the parameters that were approved and resume, or start a fresh run so the whole gated sequence executes under one approval.",
					), state);
				} else {
					previous = state.outputs[phase.id] ?? previous;
					recordPhaseState(deps, phase.id, "approval.resumed", state, { "flow.approval.receipt_id": state.receipts[phase.id]?.receiptId ?? "(none)" });
					registerPhaseUnit(phaseStateKey(phase.id));
					continue;
				}
			} else {
			const persisted = state.handoffs[phase.id];
			// A resumed contracted phase re-resolves its contract the same way the
			// original run did, so the persisted handoff is checked against a
			// contract that provably passed admissibility, not raw spec data.
			let phaseContract: ResolvedDelegationContract | undefined;
			if (phase.contract) {
				const resolution = ResolvedDelegationContract.resolve(phase.contract, policy);
				if (resolution.error) return stateError(deps, results, resolution.error, state);
				phaseContract = resolution.resolved;
			}
			const persistedError = validatePersistedIntegrationHandoff(persisted, {
				attestation: state.attestations[phase.id],
				contract: phaseContract,
				policy,
				incompletePolicy: params.incompleteHandoffPolicy,
			});
			if (persistedError) return stateError(deps, results, persistedError, state);
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
		if (authorizedBy !== undefined) {
			const binding = approvalBindingFor(phases, authorizedBy, deps, digest);
			const verified = ApprovalAuthorization.verify(state.receipts[phases[authorizedBy].id], binding, { consumer: binding.action });
			if (verified.error) {
				state.status = "failed";
				state.updatedAt = new Date().toISOString();
				await persistState(stateFile, state);
				return stateError(deps, results, verified.error, state);
			}
			authorization = verified.authorization;
		}

		state.nextPhaseId = phase.id;
		state.status = "running";
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);
		recordPhaseState(deps, phase.id, "phase.started", state, { "flow.workflow.phase_kind": phase.approval?.message ? "approval" : "work" });

		if (phase.approval?.message) {
			// Refused before the human is asked, not after: consent given to an
			// action whose model cannot be recorded would be consent this receipt
			// cannot honour on resume, and asking for it first would waste it.
			const unbindable = unbindableGatedRefs(phases, phaseIndex, deps);
			if (unbindable.length > 0) {
				const error = flowError(
					"WORKFLOW_INVALID",
					`Approval phase "${phase.id}" gates work whose model cannot be recorded.`,
					`These gated steps resolve to no model, so each runs whatever model pi is configured to default to: ${unbindable.join(", ")}. That model can change before this workflow resumes, and the approval receipt would still verify — authorizing work on a model, and possibly a provider, the approver never saw.${deps.roster && deps.roster.source === "unavailable" ? " No model registry was readable, so no tier could resolve here; naming a model outright is the way through." : ""}`,
					"Give each of those steps a model (or a tier, when the model registry is readable), so the approval records what it authorizes.",
				);
				recordPhaseState(deps, phase.id, "approval.blocked", state, { "flow.error_code": error.code });
				return stateError(deps, results, error, state);
			}
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
				return stateError(deps, results, error, state);
			}
			// Consent becomes a receipt bound to exactly what it authorizes. It is
			// minted unconsumed: it says the action may run, not that it has.
			const receipt = issueApprovalReceipt(approvalBindingFor(phases, phaseIndex, deps, digest), {
				approvedBy: approverLabel(deps, policy, DEFAULT_APPROVAL_ACTOR),
				ttlMs: approvalTtl.ttlMs,
			});
			state.receipts[phase.id] = receipt;
			state.completedPhaseIds.push(phase.id);
			consumeAuthorization(state.receipts, phases, authorizedBy, authorization);
			state.outputs[phase.id] = `APPROVED (receipt ${receipt.receiptId})`;
			previous = state.outputs[phase.id];
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			// Receipt identity and status only — the approved parameters stay inside
			// the binding digest, so the trace can name the consent without leaking it.
			deps.recordEvent?.({
				kind: "approval",
				name: "workflow.approval.issued",
				scope: { key: phaseApprovalKey(phase.id), stage },
				attributes: {
					"flow.approval.receipt_id": receipt.receiptId,
					"flow.approval.action": receipt.action,
					"flow.approval.approved_by": receipt.approvedBy,
					"flow.approval.expires_at": receipt.expiresAt ?? "(none)",
					"flow.approval.validation": receipt.validation,
					"flow.approval.reopened": Boolean(reapprovalCause),
				},
			});
			recordPhaseState(deps, phase.id, "approval.granted", state, { "flow.approval.receipt_id": receipt.receiptId });
			registerPhaseUnit(phaseApprovalKey(phase.id));
			continue;
		}

		const phaseCwd = phase.cwd ? path.resolve(defaultCwd, phase.cwd) : defaultCwd;
		const ref: FlowAgentRefInput = { agent: phase.agent, cwd: phaseCwd, model: phase.model, tier: phase.tier, thinking: phase.thinking, tools: phase.tools, contract: phase.contract };
		const planned = integrationRunPlan(deps, ref, renderPhaseTask(phase.task, params.task, previous, state.outputs), {
			returnContract: phase.returnContract ?? params.returnContract,
			requireEvidence: phase.requireEvidence ?? params.requireEvidence,
			// The child's key must differ from its stage's: a workflow phase is both,
			// and one shared name would leave dependency links pointing at whichever
			// was registered last.
			scope: { key: phaseWorkKey(phase.id), stage, ...(priorPhaseKey ? { dependsOn: [priorPhaseKey] } : {}) },
		});
		if (planned.error) return stateError(deps, results, planned.error, state);
		const run = await runIntegrationPlan(deps, planned.plan!, "workflow", results.length + 1, results);
		results.push(run);
		if (isFailed(run)) {
			state.status = "failed";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			recordPhaseState(deps, phase.id, "phase.failed", state, { "flow.error_code": run.error?.code ?? "(none)" });
			return { content: [{ type: "text", text: sanitizeText(`Flow workflow stopped in phase "${phase.id}" (${phase.agent}).\n\n${resultText(run)}`, policy) }], details: workflowDetails(deps, results, state) };
		}
		const consumed = Boolean(spec.debrief?.agent)
			|| phases.slice(phaseIndex + 1).some((candidate: any) => candidate?.agent && candidate?.task);
		const handoff = deps.handoffs.consumeResult({ plan: planned.plan!, result: run, consumed });
		if (handoff.error) {
			state.status = "failed";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			recordPhaseState(deps, phase.id, "phase.failed", state, { "flow.error_code": handoff.error.code });
			return stateError(deps, results, handoff.error, state);
		}

		const output = handoff.text;
		if (phase.checkCommand) {
			const gate = await runCheckCommand(phase.checkCommand, phaseCwd, resolveFlowCommandTimeoutMs(undefined, params.timeoutMs), policy, deps.signal);
			deps.recordEvent?.({
				kind: "validation",
				name: "workflow.gate",
				ok: gate.ok,
				// The command ran against this phase's workspace, so a failed workflow
				// ends at the output that failed rather than at a disconnected gate.
				scope: { key: `${stage.key}.gate`, stage, dependsOn: [phaseWorkKey(phase.id)] },
				attributes: { "flow.workflow.phase_id": phase.id, "flow.check.passed": gate.ok },
			});
			if (!gate.ok) {
				state.status = "failed";
				state.updatedAt = new Date().toISOString();
				await persistState(stateFile, state);
				recordPhaseState(deps, phase.id, "phase.failed", state, { "flow.error_code": "WORKFLOW_GATE_FAILED" });
				const error = flowError("WORKFLOW_GATE_FAILED", `Workflow gate failed after phase "${phase.id}".`, gate.output || "The phase checkCommand exited non-zero.", "Fix the phase artifact or check command, then resume with an updated workflow or start a fresh run.");
				return stateError(deps, results, error, state);
			}
		}

		state.completedPhaseIds.push(phase.id);
		consumeAuthorization(state.receipts, phases, authorizedBy, authorization);
		state.handoffs[phase.id] = run.handoff!;
		state.attestations[phase.id] = createPersistedHandoffAttestation(run.handoff!);
		state.outputs[phase.id] = params.recordContent === false ? "[content not recorded]" : output;
		previous = state.outputs[phase.id];
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);
		recordPhaseState(deps, phase.id, "phase.completed", state, { "flow.handoff.status": run.handoff!.status, "flow.handoff.compatibility": run.handoff!.compatibility });
		// A later child reads the prepared output through its task, so it depends on
		// the handoff boundary. A terminal phase has no such boundary and remains a
		// child dependency instead of inventing a handoff to the caller.
		registerPhaseUnit(handoff.dependencyKey ?? phaseWorkKey(phase.id));
	}

	// A trailing approval gates the workflow's own completion (and its debrief),
	// so it is verified and spent here rather than by a following phase.
	const tailApproval = authorizations.get(WORKFLOW_COMPLETE_STEP);
	if (tailApproval !== undefined) {
		const tailBinding = approvalBindingFor(phases, tailApproval, deps, digest);
		const tailVerified = ApprovalAuthorization.verify(state.receipts[phases[tailApproval].id], tailBinding, { consumer: tailBinding.action });
		if (tailVerified.error) {
			state.status = "failed";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return stateError(deps, results, tailVerified.error, state);
		}
		consumeAuthorization(state.receipts, phases, tailApproval, tailVerified.authorization);
	}

	let finalText = previous;
	const debriefRef: FlowAgentRefInput | undefined = spec.debrief?.agent ? spec.debrief : undefined;
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
			scope: { key: "debrief", dependsOn: phaseUnitKeys },
		});
		if (planned.error) return stateError(deps, results, planned.error, state);
		const debriefed = await runIntegrationPlan(deps, planned.plan!, "workflow", results.length + 1, results);
		results.push(debriefed);
		if (isFailed(debriefed)) {
			state.status = "failed";
			delete state.nextPhaseId;
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return { content: [{ type: "text", text: sanitizeText(`Flow workflow debrief failed.\n\n${resultText(debriefed)}`, policy) }], details: workflowDetails(deps, results, state) };
		}
		const handoff = deps.handoffs.consumeResult({ plan: planned.plan!, result: debriefed, consumed: false });
		if (handoff.error) {
			state.status = "failed";
			delete state.nextPhaseId;
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return stateError(deps, results, handoff.error, state);
		}
		finalText = resultText(debriefed);
	}

	state.status = "completed";
	delete state.nextPhaseId;
	state.updatedAt = new Date().toISOString();
	await persistState(stateFile, state);
	const details = workflowDetails(deps, results, state);
	const approvals = details.approvals?.map((receipt) => `\n  ${formatApprovalReceipt(receipt)}`).join("") ?? "";
	return {
		content: [{ type: "text", text: capModelVisibleText(`Flow workflow: ${phases.length} phases completed.${incompleteHandoffSummary(results, resumedHandoffs)} State: ${sanitizeText(path.relative(defaultCwd, stateFile), policy)}${approvals ? `\nApprovals:${approvals}` : ""}\n\n${sanitizeText(finalText, policy)}`) }],
		details,
	};
}
