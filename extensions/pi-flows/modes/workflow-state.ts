/**
 * The persisted shape of a workflow run, and how older versions become current.
 *
 * Split from the phase loop because it answers a different question — "what is
 * on disk, and what does an older file mean now?" — and because a migration
 * reconstructs consent, which deserves to be read on its own rather than found
 * inside a loop.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { flowError, type DelegationHandoffEnvelope, type FlowError, type FlowRunResult, type ModeDeps } from "../types.ts";
import { sanitizeText } from "../sanitize.ts";
import { ResolvedDelegationContract, canonicalHandoff, canonicalSha256, compatibilityHandoff, createPersistedHandoffAttestation, isRecord, typedHandoff, type PersistedHandoffAttestation } from "../delegation.ts";
import { legacyApprovalReceipt, migrateSpentApprovalReceipt, rebindApprovalReceipt, type ApprovalBinding, type ApprovalReceipt } from "../approval.ts";
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

/** The fields that define what a workflow IS: the top-level task, the phases in order, and the debrief. One literal, so both identity algorithms always look at the same content. */
function workflowIdentityContent(task: string | undefined, spec: any): Record<string, unknown> {
	return { task: task ?? "", phases: spec.phases ?? [], debrief: spec.debrief ?? null };
}

/**
 * The workflow's content identity: the extension's canonical (recursively
 * key-sorted) digest over the identity content, in the 16-hex short form state
 * files are named by. Reordering object keys at any nesting level does not
 * change it; array order and every meaning-bearing value do. Version 5 state
 * files carry this digest — the state version is what records which algorithm
 * produced a persisted digest.
 */
export function workflowDigest(task: string | undefined, spec: any): string {
	return canonicalSha256(workflowIdentityContent(task, spec)).replace(/^sha256:/, "").slice(0, 16);
}

/**
 * The order-sensitive digest versions 1–4 were named and checked by, kept
 * byte-exact so their state files and receipt bindings stay reachable. Used
 * only to find and verify legacy state, never to name new state.
 */
export function legacyWorkflowDigest(task: string | undefined, spec: any): string {
	return createHash("sha256")
		.update(JSON.stringify(workflowIdentityContent(task, spec)))
		.digest("hex")
		.slice(0, 16);
}

/** Where a resume's state was actually read from: the requested file, or the legacy-digest fallback. */
export interface WorkflowStateSource {
	file: string;
	raw: string;
}

/**
 * Read resume state with the legacy-identity fallback. The canonical-digest
 * file always wins; the legacy-digest file is read only when the canonical one
 * does not exist, so the lookup never has to choose between two candidates.
 * When neither exists, the canonical path's error is reported — that is the
 * name the current default documents.
 */
export async function readWorkflowState(stateFile: string, legacyStateFile: string | null): Promise<WorkflowStateSource> {
	try {
		return { file: stateFile, raw: await readFile(stateFile, "utf8") };
	} catch (cause) {
		if (!legacyStateFile || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
		try {
			return { file: legacyStateFile, raw: await readFile(legacyStateFile, "utf8") };
		} catch (legacyCause) {
			throw (legacyCause as NodeJS.ErrnoException).code === "ENOENT" ? cause : legacyCause;
		}
	}
}

export async function persistState(file: string, state: WorkflowState): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, file);
}

/** Mark a workflow failed and durably record the transition before returning its refusal. */
export async function persistFailedState(file: string, state: WorkflowState): Promise<void> {
	state.status = "failed";
	state.updatedAt = new Date().toISOString();
	await persistState(file, state);
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

/**
 * The handoff envelope a completed phase persists durably. An integrating phase's
 * Handoff is already attached to its run; a terminal phase has no downstream role,
 * so its run carries only the validated Return envelope (or nothing, for legacy
 * prose) and the envelope form is rebuilt here for durable resume — without ever
 * attaching it to the run (issue #142).
 */
export function durablePhaseHandoff(run: FlowRunResult, contract: ResolvedDelegationContract | undefined, policy: ModeDeps["policy"]): DelegationHandoffEnvelope {
	if (run.handoff) return run.handoff;
	if (run.envelope && contract) return typedHandoff(run, run.envelope, contract);
	return compatibilityHandoff(run, policy);
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
	const state: WorkflowState = { ...legacy, version: WORKFLOW_STATE_VERSION, digest, receipts: {} };
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
 * v3 -> current: unspent outstanding consent reopens. Spent same-action receipts
 * become compatibility evidence: audit-only if complete, or retaining their
 * retry while the action remains in progress. `historicalDigest` is the digest
 * the v3 state recorded — the one its receipts were bound under — while
 * `digest` is the canonical identity the migrated state and receipts carry.
 */
export function migrateWorkflowStateV3(legacy: any, phases: any[], deps: ModeDeps, digest: string, historicalDigest: string): { state: WorkflowState; error?: FlowError } {
	const state: WorkflowState = { ...legacy, version: WORKFLOW_STATE_VERSION, digest, receipts: { ...legacy.receipts } };
	const historicalWitness = deps.params.workflow?.historicalThinking;
	const unusedWitnesses = new Set(Object.keys(historicalWitness?.phases ?? {}).map((phaseId) => `phase ${phaseId}`));
	if (historicalWitness && Object.hasOwn(historicalWitness, "debrief")) unusedWitnesses.add("debrief");
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message || !state.completedPhaseIds.includes(phase.id)) continue;
		const outstanding = approvalActionOutstanding(state, phases, index);
		const stored = state.receipts[phase.id];
		if (outstanding && typeof stored?.consumedAt !== "string") continue;

		const current = approvalBindingFor(phases, index, deps, digest);
		const search = historicalApprovalSearchForV3(phases, index, deps, historicalDigest);
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

/**
 * Load, verify, and migrate a resumed workflow's persisted state to the current
 * version, persisting the migrated record under the canonical name. Returns the
 * current-version state, or the refusal explaining why the record cannot resume
 * this workflow. Never treats an unmatched record as fresh work.
 */
export async function restoreWorkflowState(
	deps: ModeDeps,
	phases: any[],
	spec: any,
	digest: string,
	stateFile: string,
	legacyStateFile: string | null,
): Promise<{ state: WorkflowState; error?: undefined } | { state?: undefined; error: FlowError }> {
	let sourceFile = stateFile;
	try {
		const source = await readWorkflowState(stateFile, legacyStateFile);
		sourceFile = source.file;
		const loaded = JSON.parse(source.raw) as any;
		// A v5 state carries the canonical digest; older versions carried the
		// order-sensitive one, so either identity of the same content matches.
		// Migrations rebind receipts against loaded.digest — the identity the
		// state actually recorded them under.
		const digests = loaded.version === WORKFLOW_STATE_VERSION ? [digest] : [digest, legacyWorkflowDigest(deps.params.task, spec)];
		if (![1, 2, 3, 4, WORKFLOW_STATE_VERSION].includes(loaded.version) || !digests.includes(loaded.digest) || !Array.isArray(loaded.completedPhaseIds)
			|| !loaded.outputs || typeof loaded.outputs !== "object" || Array.isArray(loaded.outputs)) throw new Error("state does not match this workflow");
		let restored = loaded.version === 1 ? migrateWorkflowStateV1(loaded, phases, deps.policy) : loaded;
		if (!isRecord(restored.handoffs) || !isRecord(restored.attestations)) throw new Error("state does not match this workflow");
		if (restored.version === 2) {
			const migrated = migrateWorkflowStateV2(restored, phases, deps, digest);
			if (migrated.error) return { error: migrated.error };
			restored = migrated.state;
		}
		if (restored.version === 3) {
			if (!isRecord(restored.receipts)) throw new Error("state does not match this workflow");
			const migrated = migrateWorkflowStateV3(restored, phases, deps, digest, loaded.digest);
			if (migrated.error) return { error: migrated.error };
			restored = migrated.state;
		}
		if (restored.version === 4) {
			if (!isRecord(restored.receipts)) throw new Error("state does not match this workflow");
			const migrated = migrateWorkflowStateV4(restored, phases, deps, digest, loaded.digest);
			if (migrated.error) return { error: migrated.error };
			restored = migrated.state;
		}
		if (!isRecord(restored.receipts)) throw new Error("state does not match this workflow");
		const state = restored as WorkflowState;
		if (state.status === "completed" && phases.some((phase: any) => !state.completedPhaseIds.includes(phase.id))) {
			throw new Error("completed state omits one or more workflow phases");
		}
		if (loaded.version !== WORKFLOW_STATE_VERSION || source.file !== stateFile) {
			await persistState(stateFile, state);
			// Retire the legacy-named file only after its migrated content is
			// durable under the canonical name, so no later lookup sees two
			// candidates and no crash window loses the state.
			if (source.file !== stateFile) await rm(source.file, { force: true });
		}
		return { state };
	} catch (cause) {
		return {
			error: flowError(
				"WORKFLOW_STATE_INVALID",
				"Workflow resume state is missing or incompatible.",
				`Could not resume ${sanitizeText(sourceFile, deps.policy)}: ${cause instanceof Error ? cause.message : String(cause)}.`,
				"Use the same task/phases/stateFile that created the state, or omit resume to start a fresh workflow.",
			),
		};
	}
}

/**
 * v4 -> v5: only the identity ALGORITHM changed (#144) — canonical key-sorted
 * digests replace the order-sensitive ones — so the state digest is restamped
 * and every completed approval's receipt is revalidated against the v4
 * encoding of the live workflow, then rebound to the v5 encoding. A receipt
 * that fails to revalidate means the approved conditions themselves drifted:
 * a spent one fails the migration, keeping the legacy record so restoring the
 * conditions can retry it; an unspent one is left for the phase loop, which
 * reopens or refuses it against the current binding.
 */
export function migrateWorkflowStateV4(legacy: any, phases: any[], deps: ModeDeps, digest: string, historicalDigest: string): { state: WorkflowState; error?: FlowError } {
	const state: WorkflowState = { ...legacy, version: WORKFLOW_STATE_VERSION, digest, receipts: { ...legacy.receipts } };
	for (const [index, phase] of phases.entries()) {
		if (!phase?.approval?.message || !state.completedPhaseIds.includes(phase.id)) continue;
		const stored = state.receipts[phase.id];
		const historical: ApprovalBinding = { ...approvalBindingFor(phases, index, deps, historicalDigest), stateVersion: 4 };
		const rebound = rebindApprovalReceipt(stored, historical, approvalBindingFor(phases, index, deps, digest));
		if (rebound.receipt) state.receipts[phase.id] = rebound.receipt;
		else if (isRecord(stored) && typeof stored.consumedAt === "string") return { state, error: rebound.error };
	}
	return { state };
}
