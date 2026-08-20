import type { FlowAgentRefInput } from "../types.ts";

/**
 * What one orchestrate call resolves to before anything spawns: which agent
 * fills each role, and where the goal comes from.
 *
 * Both questions have three readers — the mode table's plan declaration, the
 * pre-spawn refusal, and the handler — and each used to answer them for itself
 * (CONTEXT.md: Mirror). A declaration that defaults a role differently from the
 * handler describes a topology the flow does not run, which is what the
 * shared-write guard and the requested-agent scan then answer about; a refusal
 * that reads the goal differently refuses a call the handler could have run.
 * Both now resolve here.
 */

/**
 * Orchestrate's roles, resolved once (CONTEXT.md: Mirror). The declaration
 * below and the handler both read their refs here, so which agent fills a role
 * — and the default when the caller names none — is stated once rather than in
 * two places kept in agreement by hand.
 *
 * Review and verify have no default: they are optional roles, and the caller
 * naming one is what turns the stage on. Both readers therefore treat an
 * agent-less ref as absent rather than substituting anything.
 */
export const ORCHESTRATE_ROLE_DEFAULTS = {
	commander: { agent: "commander" },
	recon: { agent: "recon" },
	debrief: { agent: "debrief" },
} as const satisfies Record<string, FlowAgentRefInput>;

/** Orchestrate's roles for one call: the caller's ref where given, else the shared default; the two optional roles only where the caller named an agent. */
export function orchestrateRoles(params: any): {
	commander: FlowAgentRefInput;
	recon: FlowAgentRefInput;
	debrief: FlowAgentRefInput;
	review?: FlowAgentRefInput;
	verify?: FlowAgentRefInput;
} {
	const spec = params?.orchestrate ?? {};
	return {
		commander: spec.commander ?? ORCHESTRATE_ROLE_DEFAULTS.commander,
		recon: spec.recon ?? ORCHESTRATE_ROLE_DEFAULTS.recon,
		debrief: spec.debrief ?? ORCHESTRATE_ROLE_DEFAULTS.debrief,
		...(spec.review && typeof spec.review.agent === "string" ? { review: spec.review } : {}),
		...(spec.verify && typeof spec.verify.agent === "string" ? { verify: spec.verify } : {}),
	};
}

/**
 * Where orchestrate's goal and return requirements come from, resolved once
 * (CONTEXT.md: Mirror). The goal may arrive under three keys — the top-level
 * `task`, or `orchestrate.task`, or `orchestrate.returnRequirements` read as
 * the goal when nothing else names one — and the pre-spawn refusal and the
 * handler must read them identically: a refusal that disagrees with the
 * handler about whether a goal exists would refuse a call the handler could
 * have run, or admit one it cannot. Total over raw model args.
 */
export function orchestrateGoal(params: any): { goal?: string; returnRequirements?: string } {
	const spec = params?.orchestrate ?? {};
	const nestedTask = typeof spec.task === "string" ? spec.task : undefined;
	const nestedReturnRequirements = typeof spec.returnRequirements === "string" ? spec.returnRequirements : undefined;
	const goal = params?.task ?? nestedTask ?? nestedReturnRequirements;
	return {
		...(typeof goal === "string" ? { goal } : {}),
		returnRequirements: params?.returnRequirements ?? (params?.task || nestedTask ? nestedReturnRequirements : undefined),
	};
}

