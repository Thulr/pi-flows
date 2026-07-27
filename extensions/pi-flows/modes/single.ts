import type { ModeDeps, ModeOutput } from "../types.ts";
import { formatFlowError } from "../types.ts";
import { isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract, resolvedCwd } from "../validate.ts";
import { createDelegationBudget, renderDelegationTask, validateDelegationContract, validateReturnEnvelope } from "../delegation.ts";
import { runAgentRef } from "../runner.ts";

export async function handleSingle(deps: ModeDeps): Promise<ModeOutput> {
	const { params, policy, makeDetails, defaultCwd } = deps;
	const contractError = params.contract ? validateDelegationContract(params.contract, policy) : null;
	if (contractError) {
		return { content: [{ type: "text", text: formatFlowError(contractError) }], details: makeDetails("single")([], contractError) };
	}
	const task = params.contract
		? renderDelegationTask(params.task, params.contract, params.returnContract, params.requireEvidence)
		: appendReturnContract(params.task, params.returnContract, params.requireEvidence);
	const result = await runAgentRef(
		deps,
		{ agent: params.agent, cwd: params.cwd, tools: params.tools },
		task,
		"single",
		undefined,
		[],
		params.contract
			? { captureRawOutput: true, timeoutMs: params.contract.budget.timeoutMs, contractBudget: createDelegationBudget(params.contract) }
			: {},
	);
	if (params.contract && !isFailed(result)) {
		const validated = validateReturnEnvelope(result, params.contract, resolvedCwd(defaultCwd, params.cwd), policy);
		if (validated.error) {
			return { content: [{ type: "text", text: formatFlowError(validated.error) }], details: makeDetails("single")([result], validated.error) };
		}
	}
	return {
		content: [{ type: "text", text: sanitizeText(resultText(result), policy) }],
		details: makeDetails("single")([result]),
	};
}
