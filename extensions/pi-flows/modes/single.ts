import type { FlowRunResult, ModeDeps, ModeOutput } from "../types.ts";
import { modeSettle } from "../types.ts";
import { resultText, sanitizeText } from "../sanitize.ts";
import { dispatchIntegrationPlan, integrationRunPlan } from "../integration.ts";
import { sumRunDurations, type ModePlan } from "./plan.ts";

/**
 * Single's plan: the one named role, never guarded (one ref cannot collide).
 * The planned ref deliberately carries only the agent name — params.cwd and
 * params.tools are handler concerns the pre-spawn readers have never read.
 * The opening requires a task or contract, matching the mode's activation:
 * an agent with nothing to run spawns nothing.
 */
export function planSingle(params: any): ModePlan {
	if (!params.agent) return { waves: [], opening: [] };
	const refs = [{ agent: params.agent as string }];
	return {
		waves: [{ refs, guarded: false, contracts: "resolved" }],
		opening: params.task || params.contract ? refs : [],
	};
}

/** One child after another is a sum — for single, the one child's own duration. */
export function criticalPathSingle(_params: any, results: FlowRunResult[]): number | undefined {
	return sumRunDurations(results);
}

export async function handleSingle(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	const planned = integrationRunPlan(deps, { agent: params.agent, cwd: params.cwd, tools: params.tools }, params.task, {
		fallbackContract: params.contract,
		returnContract: params.returnContract,
		requireEvidence: params.requireEvidence,
		scope: { key: "single" },
	});
	if (planned.error) return settle.refuse(planned.error);
	const dispatched = await dispatchIntegrationPlan(deps, planned.plan!, settle, { completion: "terminal", payload: "source" });
	if (dispatched.status === "refused") return dispatched.output;
	// Failed and completed runs settle the same way: the child's text is the
	// answer either way, and the run itself stays in details — a failed single
	// run is prose the parent reads, not a flow refusal.
	return settle.complete(sanitizeText(resultText(dispatched.result), policy));
}
