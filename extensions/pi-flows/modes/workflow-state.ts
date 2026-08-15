/**
 * The persisted shape of a workflow run, and how older versions become current.
 *
 * Split from the phase loop because it answers a different question — "what is
 * on disk, and what does an older file mean now?" — and because a migration
 * reconstructs consent, which deserves to be read on its own rather than found
 * inside a loop.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { flowError, type DelegationHandoffEnvelope, type FlowError, type ModeDeps } from "../types.ts";
import { sanitizeText } from "../sanitize.ts";
import { canonicalHandoff, createPersistedHandoffAttestation, type PersistedHandoffAttestation } from "../delegation.ts";
import { legacyApprovalReceipt, migrateSpentApprovalReceipt, type ApprovalReceipt } from "../approval.ts";
import { approvalBindingFor, approvalProfileRefusal, gatedPhaseIds, historicalApprovalSearchForV3, workflowProfileEnvironment, WORKFLOW_STATE_VERSION, type HistoricalApprovalSearch } from "./workflow-approval.ts";

export interface WorkflowState {
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

export function workflowDigest(task: string | undefined, spec: any): string {
	return createHash("sha256")
		.update(JSON.stringify({ task: task ?? "", phases: spec.phases ?? [], debrief: spec.debrief ?? null }))
		.digest("hex")
		.slice(0, 16);
}

export async function persistState(file: string, state: WorkflowState): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, file);
}

export function freshState(digest: string): WorkflowState {
	return { version: WORKFLOW_STATE_VERSION, digest, status: "running", completedPhaseIds: [], outputs: {}, handoffs: {}, attestations: {}, receipts: {}, updatedAt: new Date().toISOString() };
}

/** Whether work, a consecutive next consent point, or terminal completion has not happened yet. */
function approvalActionOutstanding(state: { completedPhaseIds: string[]; status: string }, phases: any[], index: number): boolean {
	const gated = gatedPhaseIds(phases, index);
	const next = index + gated.length + 1;
	return gated.some((id) => !state.completedPhaseIds.includes(id))
		|| (gated.length === 0 && next < phases.length && !state.completedPhaseIds.includes(phases[next].id))
		|| (next >= phases.length && state.status !== "completed");
}

function historicalThinkingSearchError(phaseId: string, search: HistoricalApprovalSearch, policy: ModeDeps["policy"]): FlowError {
	const safePhase = sanitizeText(phaseId, policy, 256);
	if (search.invalidWitnesses.length > 0) {
		const safeWitnesses = sanitizeText(search.invalidWitnesses.join(", "), policy, 512);
		return flowError(
			"WORKFLOW_STATE_INVALID",
			`The historical Thinking witness for approval phase "${safePhase}" is inconsistent.`,
			`The supplied entries (${safeWitnesses}) cannot come from one capability profile for their shared model.`,
			"Correct or remove the conflicting workflow.historicalThinking values, then resume again.",
		);
	}
	const safeUnwitnessed = sanitizeText(search.unwitnessed.join(", "), policy, 512);
	return flowError(
		"WORKFLOW_STATE_INVALID",
		`Approval phase "${safePhase}" needs historical Thinking evidence to finish migration.`,
		`Its v3 receipt has ${search.candidateCount.toLocaleString("en-US")} coherent model-clamp candidates; the bounded verifier checked ${search.candidateLimit.toLocaleString("en-US")} without declaring the receipt stale.`,
		`Set effective v3 levels under workflow.historicalThinking.phases for one or more of: ${safeUnwitnessed}; use workflow.historicalThinking.debrief for the debrief. The supplied values are accepted only if the stored receipt digest verifies.`,
	);
}

function unusedHistoricalThinkingError(unused: readonly string[], policy: ModeDeps["policy"]): FlowError {
	const safeUnused = sanitizeText(unused.join(", "), policy, 512);
	return flowError(
		"WORKFLOW_STATE_INVALID",
		"The historical Thinking witness does not identify spent v3 approval work.",
		`These entries were not consumed by any historical binding search: ${safeUnused}.`,
		"Remove entries for ungated, unspent, implicit-Thinking, or model-less Roles and resume again.",
	);
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

/** v1 -> v2: reconstruct the typed handoff layer. Chained through later migrations by the resume path. */
export function migrateWorkflowStateV1(legacy: any, phases: any[], policy: ModeDeps["policy"]): any {
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
 *
 * An approval whose gated work has NOT all run is different. If none ran, it
 * reopens through the normal approval path. If some ran, no receipt can prove
 * one set of conditions for both halves, so migration fails closed rather than
 * retroactively blessing current roster resolution as the old consent.
 */
export function migrateWorkflowStateV2(legacy: any, phases: any[], deps: ModeDeps, digest: string): { state: WorkflowState; error?: FlowError } {
	const state: WorkflowState = { ...legacy, version: WORKFLOW_STATE_VERSION, receipts: {} };
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message || !state.completedPhaseIds.includes(phase.id)) continue;
		// Only consent that is fully spent can be reconstructed, because only then
		// does the binding describe work that already happened rather than work
		// this resume is about to authorize.
		//
		// A TRAILING approval gates no phases at all — `gatedPhaseIds` is empty for
		// it — but it still authorizes the workflow's completion and its debrief.
		// Judging it by phases alone would call it spent while the debrief had yet
		// to run, and that debrief would then execute on whatever the roster now
		// resolves, never re-approved.
		const gated = gatedPhaseIds(phases, index);
		const outstanding = approvalActionOutstanding(state, phases, index);
		if (outstanding) {
			const completed = gated.filter((id) => state.completedPhaseIds.includes(id));
			if (completed.length > 0) {
				const safePhase = sanitizeText(String(phase.id), deps.policy, 256);
				const safeCompleted = sanitizeText(completed.join(", "), deps.policy, 512);
				return {
					state,
					error: flowError(
						"WORKFLOW_STATE_INVALID",
						`The legacy approval phase "${safePhase}" cannot be safely reopened.`,
						`Its v2 state completed part of the gated action (${safeCompleted}) but left later work outstanding, and recorded no receipt that can prove one set of approved conditions for both halves.`,
						"Restore and finish the workflow with the older pi-flows version, or start a fresh workflow so one current receipt covers the whole gated action.",
					),
				};
			}
			state.completedPhaseIds = state.completedPhaseIds.filter((id: string) => id !== phase.id);
			continue;
		}
		const binding = approvalBindingFor(phases, index, deps, digest);
		state.receipts[phase.id] = legacyApprovalReceipt(binding, {
			issuedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
			consumedBy: binding.action,
		});
	}
	return { state };
}

/**
 * v3 -> v4: unspent outstanding consent reopens. Spent same-action receipts
 * become compatibility evidence: audit-only if complete, or retaining their
 * retry while the action remains in progress.
 */
export function migrateWorkflowStateV3(legacy: any, phases: any[], deps: ModeDeps, digest: string): { state: WorkflowState; error?: FlowError } {
	const state: WorkflowState = { ...legacy, version: WORKFLOW_STATE_VERSION, receipts: { ...legacy.receipts } };
	const historicalWitness = deps.params.workflow?.historicalThinking;
	const unusedWitnesses = new Set(Object.keys(historicalWitness?.phases ?? {}).map((phaseId) => `phase ${phaseId}`));
	if (historicalWitness && Object.hasOwn(historicalWitness, "debrief")) unusedWitnesses.add("debrief");
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message || !state.completedPhaseIds.includes(phase.id)) continue;
		const outstanding = approvalActionOutstanding(state, phases, index);
		const stored = state.receipts[phase.id];
		if (outstanding && typeof stored?.consumedAt !== "string") continue;

		const current = approvalBindingFor(phases, index, deps, digest);
		const search = historicalApprovalSearchForV3(phases, index, deps, digest);
		for (const witnessed of search.witnessed) unusedWitnesses.delete(witnessed);
		if (search.invalidWitnesses.length > 0) return { state, error: historicalThinkingSearchError(phase.id, search, deps.policy) };
		const first = migrateSpentApprovalReceipt(stored, search.firstCandidate, current);
		let receipt = first.receipt;
		let stale = first.error;
		if (first.error && first.error.code !== "APPROVAL_RECEIPT_STALE") return { state, error: first.error };
		if (!receipt) {
			const historical = search.find(typeof stored?.bindingDigest === "string" ? stored.bindingDigest : "");
			if (historical) {
				const migrated = migrateSpentApprovalReceipt(stored, historical, current);
				if (migrated.error && migrated.error.code !== "APPROVAL_RECEIPT_STALE") return { state, error: migrated.error };
				receipt = migrated.receipt;
				stale = migrated.error;
			}
		}
		if (!receipt && !search.exhaustive) return { state, error: historicalThinkingSearchError(phase.id, search, deps.policy) };
		if (!receipt) return { state, error: stale! };
		if (outstanding) {
			const profileError = approvalProfileRefusal(phases, index, deps.params, workflowProfileEnvironment(deps));
			if (profileError) return { state, error: profileError };
		}
		state.receipts[phase.id] = receipt;
	}
	if (unusedWitnesses.size > 0) return { state, error: unusedHistoricalThinkingError([...unusedWitnesses], deps.policy) };
	return { state };
}
