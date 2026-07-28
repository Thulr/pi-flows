import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { MAX_WORKFLOW_PHASES, flowError, formatFlowError, type DelegationContract, type DelegationHandoffEnvelope, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { prepareResultHandoff } from "../handoff.ts";
import { capModelVisibleText, escapeRegExp, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentRef } from "../runner.ts";
import { resolveFlowCommandTimeoutMs, runCheckCommand } from "../commands.ts";
import { canonicalHandoff, createPersistedHandoffAttestation, incompleteHandoffSummary, isRecord, validatePersistedIntegrationHandoff, type PersistedHandoffAttestation } from "../delegation.ts";
import { acceptIntegrationResult, integrationRunPlan } from "../integration.ts";
import { DEFAULT_APPROVAL_ACTOR, WORKFLOW_COMPLETE_STEP, approvalReceiptSummary, consumeApprovalReceipt, formatApprovalReceipt, issueApprovalReceipt, legacyApprovalReceipt, resolveApprovalTtlMs, verifyApprovalReceipt, type ApprovalBinding, type ApprovalReceipt } from "../approval.ts";

/** An approver label is an audit string, not free-form output: cap it so a hostile env var cannot pad the receipt. */
const APPROVER_LABEL_CAP = 256;

const WORKFLOW_STATE_VERSION = 3;

interface WorkflowState {
	version: typeof WORKFLOW_STATE_VERSION;
	digest: string;
	status: "running" | "paused" | "failed" | "completed";
	completedPhaseIds: string[];
	outputs: Record<string, string>;
	handoffs: Record<string, DelegationHandoffEnvelope>;
	attestations: Record<string, PersistedHandoffAttestation>;
	/** Approval receipts keyed by the approval phase that produced them. */
	receipts: Record<string, ApprovalReceipt>;
	nextPhaseId?: string;
	updatedAt: string;
}

function workflowDigest(task: string | undefined, spec: any): string {
	return createHash("sha256")
		.update(JSON.stringify({ task: task ?? "", phases: spec.phases ?? [], debrief: spec.debrief ?? null }))
		.digest("hex")
		.slice(0, 16);
}

function renderPhaseTask(template: string, task: string | undefined, previous: string, outputs: Record<string, string>): string {
	let rendered = template.replace(/\{task\}/g, task ?? "").replace(/\{previous\}/g, previous);
	for (const [id, output] of Object.entries(outputs)) {
		rendered = rendered.replace(new RegExp(`\\{phase\\.${escapeRegExp(id)}\\}`, "g"), output);
	}
	return rendered;
}

/**
 * Which approval, if any, authorizes entering each step. An approval authorizes
 * ONE action, but that action spans every step between it and the next consent
 * point: the work phases it gates, the approval that ends the run, and the
 * workflow's own completion when nothing else follows. Every one of those steps
 * is registered, so a resume landing in the middle of a gated run still
 * re-verifies rather than walking in behind a check it never reached.
 */
function approvalAuthorizations(phases: any[]): Map<string, number> {
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
const approvalActionId = (phase: any): string => `workflow.phase:${phase.id}`;

/**
 * Receipt failures a human can simply answer again: the approved action changed,
 * or the window lapsed. Asking for consent afresh is the intended recovery, and
 * without it an expired receipt strands the state file — the approval phase is
 * already complete, so it is skipped, and every resume re-reads the same dead
 * receipt. A consumed or malformed receipt is NOT here: those mean the record was
 * tampered with, and re-prompting past them would launder the tampering.
 */
const REAPPROVABLE_RECEIPT_ERRORS = new Set(["APPROVAL_RECEIPT_STALE", "APPROVAL_RECEIPT_EXPIRED"]);

/**
 * A gated phase's EFFECTIVE definition — what it resolves to once flow-level
 * fallbacks are applied. The workflow digest sees `phase.returnContract`; only
 * this sees that an omitted one falls back to `params.returnContract`, so
 * changing the fallback after approval is caught rather than inherited.
 */
function normalizeGatedPhase(phase: any, params: any): Record<string, unknown> {
	return {
		id: phase.id,
		agent: phase.agent ?? null,
		task: phase.task ?? null,
		cwd: phase.cwd ?? null,
		model: phase.model ?? null,
		tier: phase.tier ?? null,
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
 * these three resolve from top-level params the workflow digest never sees, so
 * without this a trailing approval could be granted and the debrief then run
 * under a contract the operator never approved.
 */
function normalizeGatedDebrief(params: any): Record<string, unknown> | null {
	if (!params.workflow?.debrief?.agent) return null;
	return {
		contract: params.contract ?? null,
		returnContract: params.returnContract ?? null,
		requireEvidence: params.requireEvidence ?? false,
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
function approvalBindingFor(phases: any[], index: number, deps: ModeDeps, digest: string): ApprovalBinding {
	const gated: any[] = [];
	let next = index + 1;
	for (; next < phases.length && !phases[next]?.approval?.message; next += 1) gated.push(phases[next]);
	return {
		action: approvalActionId(phases[index]),
		parameters: {
			approvalMessage: phases[index].approval.message,
			agentScope: deps.agentScope,
			incompleteHandoffPolicy: deps.params.incompleteHandoffPolicy ?? "fail",
			gatedPhases: gated.map((phase) => normalizeGatedPhase(phase, deps.params)),
			debrief: next >= phases.length ? normalizeGatedDebrief(deps.params) : null,
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
function consumeAuthorization(state: WorkflowState, phases: any[], authorizedBy: number | undefined): void {
	if (authorizedBy === undefined) return;
	const approvalId = phases[authorizedBy].id;
	const receipt = state.receipts[approvalId];
	if (receipt) state.receipts[approvalId] = consumeApprovalReceipt(receipt, approvalActionId(phases[authorizedBy]));
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

async function persistState(file: string, state: WorkflowState): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, file);
}

function freshState(digest: string): WorkflowState {
	return { version: WORKFLOW_STATE_VERSION, digest, status: "running", completedPhaseIds: [], outputs: {}, handoffs: {}, attestations: {}, receipts: {}, updatedAt: new Date().toISOString() };
}

function legacyCompatibilityHandoff(phase: any, output: string, step: number, policy: ModeDeps["policy"]): DelegationHandoffEnvelope {
	const text = policy.recordContent ? sanitizeText(output, policy) : "[content omitted: recordContent=false]";
	return {
		schemaVersion: "pi-flows.handoff-envelope.v1",
		contractId: null,
		compatibility: "legacy-prose",
		status: "completed",
		summary: text,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { text },
		provenance: { agent: phase.agent, step },
	};
}

/** v1 -> v2: reconstruct the typed handoff layer. Chained into the v3 receipt migration by the resume path. */
function migrateWorkflowStateV1(legacy: any, phases: any[], policy: ModeDeps["policy"]): any {
	const state = {
		...legacy,
		version: 2,
		handoffs: {} as Record<string, DelegationHandoffEnvelope>,
		attestations: {} as Record<string, PersistedHandoffAttestation>,
	};
	for (const [index, phase] of phases.entries()) {
		if (!state.completedPhaseIds.includes(phase.id) || phase.approval?.message) continue;
		const handoff = legacyCompatibilityHandoff(phase, String(state.outputs[phase.id] ?? ""), index + 1, policy);
		state.handoffs[phase.id] = handoff;
		state.attestations[phase.id] = createPersistedHandoffAttestation(handoff);
		state.outputs[phase.id] = canonicalHandoff(handoff);
	}
	return state;
}

/**
 * Reconstruct receipts for approvals that a pre-receipt state recorded as the
 * bare string "APPROVED". Those states already passed the workflow digest check,
 * so migrating them is not a downgrade — but the old record carried no approver,
 * issue time, or window, so the migrated receipt claims none of them. It is
 * marked spent by the action it already let through, which keeps resume working
 * while still binding: editing a gated phase after migration is still caught.
 */
function migrateWorkflowStateV2(legacy: any, phases: any[], deps: ModeDeps, digest: string): WorkflowState {
	const state: WorkflowState = { ...legacy, version: WORKFLOW_STATE_VERSION, receipts: {} };
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message || !state.completedPhaseIds.includes(phase.id)) continue;
		const binding = approvalBindingFor(phases, index, deps, digest);
		state.receipts[phase.id] = legacyApprovalReceipt(binding, {
			issuedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
			consumedBy: binding.action,
		});
	}
	return state;
}

export async function handleWorkflow(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd } = deps;
	const spec = params.workflow ?? {};
	const phases = Array.isArray(spec.phases) ? spec.phases : [];
	if (phases.length < 1 || phases.length > MAX_WORKFLOW_PHASES) {
		const error = flowError("WORKFLOW_INVALID", `Workflow mode needs 1..${MAX_WORKFLOW_PHASES} phases.`, "workflow.phases was empty or exceeded the bounded state-machine limit.", `Provide 1..${MAX_WORKFLOW_PHASES} ordered work or approval phases.`);
		return stateError(deps, [], error);
	}

	const ids = new Set<string>();
	for (const phase of phases) {
		const approval = Boolean(phase?.approval?.message);
		const work = Boolean(phase?.agent && phase?.task);
		if (!phase?.id || ids.has(phase.id) || approval === work) {
			const error = flowError("WORKFLOW_INVALID", "Workflow phases need unique ids and exactly one phase kind.", "Each phase must be either agent+task work or an approval node, but not both; ids must be unique.", "Fix the phase ids and provide either agent+task or approval.message for every phase.");
			return stateError(deps, [], error);
		}
		ids.add(phase.id);
	}

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
	for (const [phaseIndex, phase] of phases.entries()) {
		// Set when a completed approval is reopened, so the re-prompt can say why it
		// is being asked again instead of looking like a fresh pause.
		let reapprovalCause: string | null = null;
		if (state.completedPhaseIds.includes(phase.id)) {
			if (phase.approval?.message) {
				// Re-check consent where the approval lives, not only where it is spent.
				// A lapsed or superseded approval reopens here so it can be granted
				// again in this same pass; headless runs still fail closed below.
				const binding = approvalBindingFor(phases, phaseIndex, deps, digest);
				const stale = verifyApprovalReceipt(state.receipts[phase.id], binding, { consumer: binding.action });
				if (stale && REAPPROVABLE_RECEIPT_ERRORS.has(stale.code)) {
					reapprovalCause = stale.cause;
					state.completedPhaseIds = state.completedPhaseIds.filter((id) => id !== phase.id);
					delete state.receipts[phase.id];
				} else {
					previous = state.outputs[phase.id] ?? previous;
					continue;
				}
			} else {
			const persisted = state.handoffs[phase.id];
			const persistedError = validatePersistedIntegrationHandoff(persisted, {
				attestation: state.attestations[phase.id],
				contract: phase.contract,
				policy,
				incompletePolicy: params.incompleteHandoffPolicy,
			});
			if (persistedError) return stateError(deps, results, persistedError, state);
			if (persisted.status !== "completed") resumedHandoffs.push(persisted);
			const validatedOutput = params.recordContent === false ? "[content not recorded]" : canonicalHandoff(persisted);
			state.outputs[phase.id] = validatedOutput;
			previous = validatedOutput;
			continue;
			}
		}

		// Nothing an approval gates runs until its receipt is re-verified against
		// what would run NOW. On a resume that is the whole point: the receipt was
		// minted in an earlier process against an earlier spec.
		const authorizedBy = authorizations.get(phase.id);
		if (authorizedBy !== undefined) {
			const binding = approvalBindingFor(phases, authorizedBy, deps, digest);
			const receiptError = verifyApprovalReceipt(state.receipts[phases[authorizedBy].id], binding, { consumer: binding.action });
			if (receiptError) {
				state.status = "failed";
				state.updatedAt = new Date().toISOString();
				await persistState(stateFile, state);
				return stateError(deps, results, receiptError, state);
			}
		}

		state.nextPhaseId = phase.id;
		state.status = "running";
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);

		if (phase.approval?.message) {
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
				return stateError(deps, results, error, state);
			}
			// Consent becomes a receipt bound to exactly what it authorizes. It is
			// minted unconsumed: it says the action may run, not that it has.
			const receipt = issueApprovalReceipt(approvalBindingFor(phases, phaseIndex, deps, digest), {
				approvedBy: sanitizeText(deps.approvalActor ?? DEFAULT_APPROVAL_ACTOR, { ...policy, recordContent: true }, APPROVER_LABEL_CAP),
				ttlMs: approvalTtl.ttlMs,
			});
			state.receipts[phase.id] = receipt;
			state.completedPhaseIds.push(phase.id);
			consumeAuthorization(state, phases, authorizedBy);
			state.outputs[phase.id] = `APPROVED (receipt ${receipt.receiptId})`;
			previous = state.outputs[phase.id];
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			continue;
		}

		const phaseCwd = phase.cwd ? path.resolve(defaultCwd, phase.cwd) : defaultCwd;
		const ref: FlowAgentRefInput = { agent: phase.agent, cwd: phaseCwd, model: phase.model, tier: phase.tier, tools: phase.tools, contract: phase.contract };
		const planned = integrationRunPlan(deps, ref, renderPhaseTask(phase.task, params.task, previous, state.outputs), {
			returnContract: phase.returnContract ?? params.returnContract,
			requireEvidence: phase.requireEvidence ?? params.requireEvidence,
		});
		if (planned.error) return stateError(deps, results, planned.error, state);
		const run = await runAgentRef(deps, planned.plan!.ref, planned.plan!.task, "workflow", results.length + 1, results, planned.plan!.limits);
		results.push(run);
		if (isFailed(run)) {
			state.status = "failed";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return { content: [{ type: "text", text: sanitizeText(`Flow workflow stopped in phase "${phase.id}" (${phase.agent}).\n\n${resultText(run)}`, policy) }], details: workflowDetails(deps, results, state) };
		}
		const handoffError = acceptIntegrationResult(deps, planned.plan!, run);
		if (handoffError) {
			state.status = "failed";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return stateError(deps, results, handoffError, state);
		}

		const output = prepareResultHandoff(run, policy).text;
		if (phase.checkCommand) {
			const gate = await runCheckCommand(phase.checkCommand, phaseCwd, resolveFlowCommandTimeoutMs(undefined, params.timeoutMs), policy, deps.signal);
			if (!gate.ok) {
				state.status = "failed";
				state.updatedAt = new Date().toISOString();
				await persistState(stateFile, state);
				const error = flowError("WORKFLOW_GATE_FAILED", `Workflow gate failed after phase "${phase.id}".`, gate.output || "The phase checkCommand exited non-zero.", "Fix the phase artifact or check command, then resume with an updated workflow or start a fresh run.");
				return stateError(deps, results, error, state);
			}
		}

		state.completedPhaseIds.push(phase.id);
		consumeAuthorization(state, phases, authorizedBy);
		state.handoffs[phase.id] = run.handoff!;
		state.attestations[phase.id] = createPersistedHandoffAttestation(run.handoff!);
		state.outputs[phase.id] = params.recordContent === false ? "[content not recorded]" : output;
		previous = state.outputs[phase.id];
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);
	}

	// A trailing approval gates the workflow's own completion (and its debrief),
	// so it is verified and spent here rather than by a following phase.
	const tailApproval = authorizations.get(WORKFLOW_COMPLETE_STEP);
	if (tailApproval !== undefined) {
		const tailBinding = approvalBindingFor(phases, tailApproval, deps, digest);
		const receiptError = verifyApprovalReceipt(state.receipts[phases[tailApproval].id], tailBinding, { consumer: tailBinding.action });
		if (receiptError) {
			state.status = "failed";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return stateError(deps, results, receiptError, state);
		}
		consumeAuthorization(state, phases, tailApproval);
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
		});
		if (planned.error) return stateError(deps, results, planned.error, state);
		const debriefed = await runAgentRef(deps, planned.plan!.ref, planned.plan!.task, "workflow", results.length + 1, results, planned.plan!.limits);
		results.push(debriefed);
		if (isFailed(debriefed)) {
			state.status = "failed";
			delete state.nextPhaseId;
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return { content: [{ type: "text", text: sanitizeText(`Flow workflow debrief failed.\n\n${resultText(debriefed)}`, policy) }], details: workflowDetails(deps, results, state) };
		}
		const handoffError = acceptIntegrationResult(deps, planned.plan!, debriefed);
		if (handoffError) {
			state.status = "failed";
			delete state.nextPhaseId;
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return stateError(deps, results, handoffError, state);
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
