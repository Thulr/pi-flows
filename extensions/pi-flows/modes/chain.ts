import { formatFlowError, type DelegationContract, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, resolvedCwd } from "../validate.ts";
import { renderTaskTemplate } from "../parse.ts";
import { createDelegationBudget, renderDelegationTask, validateDelegationContract } from "../delegation.ts";
import { runAgentRef } from "../runner.ts";

/** One place a chain step's unit key is derived, so its link and its handoff name the same unit. */
const stepKey = (index: number) => `step-${index + 1}`;

export async function handleChain(deps: ModeDeps): Promise<ModeOutput> {
	const { params, policy, makeDetails, defaultCwd } = deps;
	const results: FlowRunResult[] = [];
	let previous = "";
	let priorHandoffKey: string | undefined;
	for (const step of params.chain) {
		const contract = (step.contract ?? params.contract) as DelegationContract | undefined;
		const error = contract ? validateDelegationContract(contract, policy) : null;
		if (error) return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("chain")([], error) };
	}

	for (let index = 0; index < params.chain.length; index += 1) {
		const step = params.chain[index];
		// The last step's output is the answer, not a handoff: nothing downstream
		// receives it, so recording a boundary there would invent one.
		const handsOff = index < params.chain.length - 1;
		const contract = (step.contract ?? params.contract) as DelegationContract | undefined;
		const rendered = renderTaskTemplate(step.task, params.task ?? params.contract?.objective, previous);
		const task = contract
			? renderDelegationTask(rendered, contract, step.returnContract ?? params.returnContract, step.requireEvidence ?? params.requireEvidence)
			: appendReturnRequirements(rendered, step.returnContract ?? params.returnContract, step.requireEvidence ?? params.requireEvidence);
		const result = await runAgentRef(
			deps,
			{ agent: step.agent, cwd: step.cwd, model: step.model, tier: step.tier, tools: step.tools },
			task,
			"chain",
			index + 1,
			results,
			{
				limits: contract
					? { captureRawOutput: true, timeoutMs: contract.budget.timeoutMs, contractBudget: createDelegationBudget(contract), contract }
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
			consumed: handsOff,
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
