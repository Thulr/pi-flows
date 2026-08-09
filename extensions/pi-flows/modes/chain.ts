import { formatFlowError, type DelegationContract, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, resolvedCwd } from "../validate.ts";
import { renderTaskTemplate } from "../parse.ts";
import { ResolvedDelegationContract } from "../delegation.ts";
import { runAgentRef } from "../runner.ts";
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
	const { params, policy, makeDetails, defaultCwd } = deps;
	const results: FlowRunResult[] = [];
	let previous = "";
	let priorHandoffKey: string | undefined;
	const stepContracts: Array<ResolvedDelegationContract | undefined> = [];
	for (const step of params.chain) {
		const raw = (step.contract ?? params.contract) as DelegationContract | undefined;
		const resolution = raw ? ResolvedDelegationContract.resolve(raw, policy) : {};
		if (resolution.error) return { content: [{ type: "text", text: formatFlowError(resolution.error) }], details: makeDetails("chain")([], resolution.error) };
		stepContracts.push(resolution.resolved);
	}

	for (let index = 0; index < params.chain.length; index += 1) {
		const step = params.chain[index];
		// The last step's output is the answer, not a handoff: nothing downstream
		// receives it, so recording a boundary there would invent one.
		const handsOff = index < params.chain.length - 1;
		const contract = stepContracts[index];
		const rendered = renderTaskTemplate(step.task, params.task ?? params.contract?.objective, previous);
		const task = contract
			? contract.renderTask(rendered, step.returnContract ?? params.returnContract, step.requireEvidence ?? params.requireEvidence)
			: appendReturnRequirements(rendered, step.returnContract ?? params.returnContract, step.requireEvidence ?? params.requireEvidence);
		const result = await runAgentRef(
			deps,
			{ agent: step.agent, cwd: step.cwd, model: step.model, tier: step.tier, thinking: step.thinking, tools: step.tools },
			task,
			"chain",
			index + 1,
			results,
			{
				limits: contract
					? { captureRawOutput: true, timeoutMs: contract.timeoutMs, contractBudget: contract.budget(), contract: contract.contract }
					: {},
				// A chain step consumed the previous step's output; the link records
				// that without pretending the earlier step spawned this one.
				// Through the handoff, not around it: what the previous step *produced*
				// is not what this step received — validation, filtering, and the
				// injection scan sit in between, and that boundary is where the
				// carried text was actually decided.
				scope: { key: stepKey(index), ...(priorHandoffKey ? { dependsOn: [priorHandoffKey] } : {}) },
			},
		);
		results.push(result);

		if (isFailed(result)) {
			return {
				content: [{ type: "text", text: sanitizeText(`Flow chain stopped at step ${index + 1} (${step.agent}):\n\n${resultText(result)}`, policy) }],
				details: makeDetails("chain")(results),
			};
		}
		const handoff = deps.handoffs.consumeResult({
			result,
			contract,
			cwd: resolvedCwd(defaultCwd, step.cwd),
			scope: { key: stepKey(index) },
			completion: handsOff ? "integrate" : "terminal",
			noticeLabel: `chain step ${index + 1} ${contract ? "envelope" : "output"}`,
			payload: "source",
		});
		if (handoff.error) return { content: [{ type: "text", text: formatFlowError(handoff.error) }], details: makeDetails("chain")(results, handoff.error) };
		if (handsOff) {
			previous = handoff.text;
			priorHandoffKey = handoff.dependencyKey;
		}
	}

	return {
		content: [{ type: "text", text: sanitizeText(resultText(results[results.length - 1]), policy) }],
		details: makeDetails("chain")(results),
	};
}
