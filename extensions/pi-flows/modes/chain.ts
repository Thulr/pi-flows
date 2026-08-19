import { modeSettle, type DelegationContract, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { resultText, sanitizeText } from "../sanitize.ts";
import { renderTaskTemplate } from "../parse.ts";
import { ResolvedDelegationContract } from "../delegation.ts";
import { dispatchIntegrationPlan, integrationRunPlan } from "../integration.ts";
import { plannedRefs, sumRunDurations, type ModePlan } from "./plan.ts";

/**
 * Chain's plan: one single-ref wave per step, in step order, none guarded —
 * steps never run concurrently, so the shared-write guard has nothing to see.
 * The opening is the first step (empty when it names no agent).
 */
export function planChain(params: any): ModePlan {
	if (!Array.isArray(params.chain) || params.chain.length === 0) return { waves: [], opening: [] };
	const waves = params.chain.map((step: unknown) => ({ refs: plannedRefs([step]), guarded: false, contracts: "resolved" as const }));
	return { waves, opening: waves[0]!.refs };
}

/** Strictly sequential: every step is on the path. */
export function criticalPathChain(_params: any, results: FlowRunResult[]): number | undefined {
	return sumRunDurations(results);
}

/** One place a chain step's unit key is derived, so its link and its handoff name the same unit. */
const stepKey = (index: number) => `step-${index + 1}`;

export async function handleChain(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	let previous = "";
	let priorHandoffKey: string | undefined;
	const stepContracts: Array<ResolvedDelegationContract | undefined> = [];
	for (const step of params.chain) {
		const raw = (step.contract ?? params.contract) as DelegationContract | undefined;
		const resolution = raw ? ResolvedDelegationContract.resolve(raw, policy) : {};
		if (resolution.error) return settle.refuse(resolution.error);
		stepContracts.push(resolution.resolved);
	}

	for (let index = 0; index < params.chain.length; index += 1) {
		const step = params.chain[index];
		// The last step's output is the answer, not a handoff: nothing downstream
		// receives it, so recording a boundary there would invent one.
		const handsOff = index < params.chain.length - 1;
		const contract = stepContracts[index];
		const rendered = renderTaskTemplate(step.task, params.task ?? params.contract?.objective, previous);
		const planned = integrationRunPlan(
			deps,
			{ agent: step.agent, cwd: step.cwd, model: step.model, tier: step.tier, thinking: step.thinking, tools: step.tools, contract: step.contract },
			rendered,
			{
				// Each chain step is a distinct delegation, even when it inherits the same contract value.
				shareContractBudget: false,
				fallbackContract: params.contract,
				returnRequirements: step.returnRequirements ?? params.returnRequirements,
				requireEvidence: step.requireEvidence ?? params.requireEvidence,
				// A chain step consumed the previous step's output; the link records
				// that without pretending the earlier step spawned this one.
				// Through the handoff, not around it: what the previous step *produced*
				// is not what this step received — validation, filtering, and the
				// injection scan sit in between, and that boundary is where the
				// carried text was actually decided.
				scope: { key: stepKey(index), ...(priorHandoffKey ? { dependsOn: [priorHandoffKey] } : {}) },
			},
		);
		if (planned.error) return settle.refuse(planned.error);
		const dispatched = await dispatchIntegrationPlan(deps, planned.plan!, settle, {
			completion: handsOff ? "integrate" : "terminal",
			noticeLabel: `chain step ${index + 1} ${contract ? "envelope" : "output"}`,
			payload: "source",
			// Consume under the bare step key: the dependency link belongs to the
			// step's own dispatch scope above, not to the handoff it consumed.
			scope: { key: stepKey(index) },
		});
		if (dispatched.status === "failed") {
			return settle.complete(sanitizeText(`Flow chain stopped at step ${index + 1} (${step.agent}):\n\n${resultText(dispatched.result)}`, policy));
		}
		if (dispatched.status === "refused") return dispatched.output;
		if (handsOff) {
			previous = dispatched.handoff.text;
			priorHandoffKey = dispatched.handoff.dependencyKey;
		}
	}

	return settle.complete(sanitizeText(resultText(settle.results[settle.results.length - 1]), policy));
}
