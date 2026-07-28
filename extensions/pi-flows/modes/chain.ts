import { formatFlowError, type DelegationContract, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { prepareResultHandoff, prepareTextHandoff, withInjectionNotice } from "../handoff.ts";
import { appendReturnContract, resolvedCwd } from "../validate.ts";
import { renderTaskTemplate } from "../parse.ts";
import { canonicalEnvelope, createDelegationBudget, renderDelegationTask, validateDelegationContract, validateReturnEnvelope } from "../delegation.ts";
import { runAgentRef } from "../runner.ts";
import { recordStepHandoff } from "../integration.ts";

/** One place a chain step's unit key is derived, so its link and its handoff name the same unit. */
const stepKey = (index: number) => `step-${index + 1}`;

export async function handleChain(deps: ModeDeps): Promise<ModeOutput> {
	const { params, policy, makeDetails, defaultCwd } = deps;
	const results: FlowRunResult[] = [];
	let previous = "";
	for (const step of params.chain) {
		const contract = (step.contract ?? params.contract) as DelegationContract | undefined;
		const error = contract ? validateDelegationContract(contract, policy) : null;
		if (error) return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("chain")([], error) };
	}

	for (let index = 0; index < params.chain.length; index += 1) {
		const step = params.chain[index];
		const contract = (step.contract ?? params.contract) as DelegationContract | undefined;
		const rendered = renderTaskTemplate(step.task, params.task ?? params.contract?.objective, previous);
		const task = contract
			? renderDelegationTask(rendered, contract, step.returnContract ?? params.returnContract, step.requireEvidence ?? params.requireEvidence)
			: appendReturnContract(rendered, step.returnContract ?? params.returnContract, step.requireEvidence ?? params.requireEvidence);
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
				scope: { key: stepKey(index), ...(index > 0 ? { dependsOn: [`${stepKey(index - 1)}.handoff`] } : {}) },
			},
		);
		results.push(result);

		if (isFailed(result)) {
			return {
				content: [{ type: "text", text: sanitizeText(`Flow chain stopped at step ${index + 1} (${step.agent}):\n\n${resultText(result)}`, policy) }],
				details: makeDetails("chain")(results),
			};
		}
		if (contract) {
			const validated = validateReturnEnvelope(result, contract, resolvedCwd(defaultCwd, step.cwd), policy);
			if (validated.error) {
				return { content: [{ type: "text", text: formatFlowError(validated.error) }], details: makeDetails("chain")(results, validated.error) };
			}
			const handoff = prepareTextHandoff(canonicalEnvelope(validated.envelope!), policy);
			previous = withInjectionNotice(handoff, `chain step ${index + 1} envelope`);
			// The step validated its own envelope, so it records its own boundary:
			// this is where one agent's output becomes the next agent's prompt.
			recordStepHandoff(deps, { result, contract, envelope: validated.envelope, carried: previous, scope: { key: stepKey(index) } });
			continue;
		}
		// {previous} is this step's output reused as the next step's prompt — a trust
		// boundary. Strip invisible chars and flag injection markers before handoff.
		const handoff = prepareResultHandoff(result, policy);
		previous = withInjectionNotice(handoff, `chain step ${index + 1} output`);
		recordStepHandoff(deps, { result, carried: previous, scope: { key: stepKey(index) } });
	}

	return {
		content: [{ type: "text", text: sanitizeText(resultText(results[results.length - 1]), policy) }],
		details: makeDetails("chain")(results),
	};
}
