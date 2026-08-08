// Workflow phase-shape validation, owned here and shared by both sides of the
// gate: handleWorkflow (modes/workflow.ts) enforces these predicates before
// any state write or spawn, and the selection eval's admissibility seam
// (evals/select-admissibility.mjs) scores the very same functions, so the
// scored gate cannot drift from the enforced one (#88). validate.ts re-exports
// them beside the other call-level predicates.
import { MAX_WORKFLOW_PHASES, flowError, type FlowError } from "./types.ts";

/**
 * handleWorkflow walks its phases in order, and an approval phase reached in
 * a headless run is refused WORKFLOW_APPROVAL_REQUIRED before any child
 * spawns (state is persisted first, so this is pre-spawn, not pre-work). A
 * workflow whose FIRST phase gates on approval therefore never starts a
 * child in the headless selection subject; the eval scores that refusal. The
 * `.message` check mirrors the handler's own approval-phase marker. A resume
 * stays silent, like every workflow rule read off the phase list statically:
 * the handler loads persisted state before walking phases, so a fresh subject
 * is refused WORKFLOW_STATE_INVALID — outside the vocabulary — first, and a
 * completed opener would be skipped, not re-asked (#91).
 */
export function workflowHeadlessApprovalRefusal(params: Record<string, any>): FlowError | null {
	if (params?.workflow === undefined || params.workflow?.resume) return null;
	const phases = params.workflow?.phases;
	if (!Array.isArray(phases)) return null;
	if (!phases[0]?.approval?.message) return null;
	return flowError(
		"WORKFLOW_APPROVAL_REQUIRED",
		"Workflow approval phase requires a human decision.",
		"The workflow opens with an approval phase, and a headless run has no UI to collect the decision, so no child can spawn.",
		"Run in an interactive UI, or open with a work phase.",
	);
}

/**
 * The handler's work-phase test — a phase spawns a child only when it names
 * both an agent and a task. Exported so the selection eval counts exactly
 * the phases the tool would run (#88).
 */
export function isWorkflowWorkPhase(phase: any): boolean {
	return Boolean(phase?.agent && phase?.task);
}

/**
 * handleWorkflow's phase-shape validation, called by the handler itself and
 * scored by the selection eval so the two cannot drift: 1..MAX phases,
 * unique ids, each phase exactly one kind — approval (approval.message) or
 * work (agent AND task). An invalid phase refuses the call WHOLE before any
 * state write, so valid siblings cannot satisfy a case's topology (#88).
 */
export function workflowPhasesRefusal(params: Record<string, any>): FlowError | null {
	if (params?.workflow === undefined) return null;
	const phases = Array.isArray(params.workflow?.phases) ? params.workflow.phases : [];
	if (phases.length < 1 || phases.length > MAX_WORKFLOW_PHASES) {
		return flowError("WORKFLOW_INVALID", `Workflow mode needs 1..${MAX_WORKFLOW_PHASES} phases.`, "workflow.phases was empty or exceeded the bounded state-machine limit.", `Provide 1..${MAX_WORKFLOW_PHASES} ordered work or approval phases.`);
	}
	const ids = new Set<string>();
	for (const phase of phases) {
		const approval = Boolean(phase?.approval?.message);
		const work = isWorkflowWorkPhase(phase);
		if (!phase?.id || ids.has(phase.id) || approval === work) {
			return flowError("WORKFLOW_INVALID", "Workflow phases need unique ids and exactly one phase kind.", "Each phase must be either agent+task work or an approval node, but not both; ids must be unique.", "Fix the phase ids and provide either agent+task or approval.message for every phase.");
		}
		ids.add(phase.id);
	}
	return null;
}
