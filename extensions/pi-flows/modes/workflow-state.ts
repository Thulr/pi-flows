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
import type { DelegationHandoffEnvelope, ModeDeps } from "../types.ts";
import { sanitizeText } from "../sanitize.ts";
import { canonicalHandoff, createPersistedHandoffAttestation, type PersistedHandoffAttestation } from "../delegation.ts";
import { legacyApprovalReceipt, type ApprovalReceipt } from "../approval.ts";
import { approvalBindingFor, gatedPhaseIds, WORKFLOW_STATE_VERSION } from "./workflow-approval.ts";

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
 * An approval whose gated work has NOT all run is a different case, and the
 * difference matters. Its binding would be computed from the roster that happens
 * to exist at resume time, so a tier now resolving to another provider — or a
 * phase that cannot be bound at all — would be retroactively blessed as the
 * thing the operator consented to. Nobody approved that. Those approvals are
 * left unmigrated, which drops them back through the normal approval path and
 * asks a human again.
 */
export function migrateWorkflowStateV2(legacy: any, phases: any[], deps: ModeDeps, digest: string): WorkflowState {
	const state: WorkflowState = { ...legacy, version: WORKFLOW_STATE_VERSION, receipts: {} };
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message || !state.completedPhaseIds.includes(phase.id)) continue;
		// Only consent that is fully spent can be reconstructed, because only then
		// does the binding describe work that already happened rather than work
		// this resume is about to authorize.
		const outstanding = gatedPhaseIds(phases, index).some((id) => !state.completedPhaseIds.includes(id));
		if (outstanding) {
			state.completedPhaseIds = state.completedPhaseIds.filter((id: string) => id !== phase.id);
			continue;
		}
		const binding = approvalBindingFor(phases, index, deps, digest);
		state.receipts[phase.id] = legacyApprovalReceipt(binding, {
			issuedAt: typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString(),
			consumedBy: binding.action,
		});
	}
	return state;
}
