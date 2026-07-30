import type { ModeDeps, ModeOutput } from "../types.ts";
import { formatFlowError } from "../types.ts";
import { isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, resolvedCwd } from "../validate.ts";
import { createDelegationBudget, renderDelegationTask, validateDelegationContract } from "../delegation.ts";
import { runAgentRef } from "../runner.ts";

export async function handleSingle(deps: ModeDeps): Promise<ModeOutput> {
	const { params, policy, makeDetails, defaultCwd } = deps;
	const contractError = params.contract ? validateDelegationContract(params.contract, policy) : null;
	if (contractError) {
		return { content: [{ type: "text", text: formatFlowError(contractError) }], details: makeDetails("single")([], contractError) };
	}
	const task = params.contract
		? renderDelegationTask(params.task, params.contract, params.returnContract, params.requireEvidence)
		: appendReturnRequirements(params.task, params.returnContract, params.requireEvidence);
	const result = await runAgentRef(
		deps,
		{ agent: params.agent, cwd: params.cwd, tools: params.tools },
		task,
		"single",
		undefined,
		[],
		{
			limits: params.contract
				? { captureRawOutput: true, timeoutMs: params.contract.budget.timeoutMs, contractBudget: createDelegationBudget(params.contract), contract: params.contract }
				: {},
			scope: { key: "single" },
		},
	);
	if (!isFailed(result)) {
		const handoff = deps.handoffs.consumeResult({
			result,
			contract: params.contract,
			cwd: resolvedCwd(defaultCwd, params.cwd),
			consumed: false,
			payload: "source",
		});
		if (handoff.error) {
			return { content: [{ type: "text", text: formatFlowError(handoff.error) }], details: makeDetails("single")([result], handoff.error) };
		}
	}
	return {
		content: [{ type: "text", text: sanitizeText(resultText(result), policy) }],
		details: makeDetails("single")([result]),
	};
}
