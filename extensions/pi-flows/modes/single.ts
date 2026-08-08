import type { ModeDeps, ModeOutput } from "../types.ts";
import { formatFlowError } from "../types.ts";
import { isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, resolvedCwd } from "../validate.ts";
import { ResolvedDelegationContract } from "../delegation.ts";
import { runAgentRef } from "../runner.ts";

export async function handleSingle(deps: ModeDeps): Promise<ModeOutput> {
	const { params, policy, makeDetails, defaultCwd } = deps;
	const resolution = params.contract ? ResolvedDelegationContract.resolve(params.contract, policy) : {};
	if (resolution.error) {
		return { content: [{ type: "text", text: formatFlowError(resolution.error) }], details: makeDetails("single")([], resolution.error) };
	}
	const contract = resolution.resolved;
	const task = contract
		? contract.renderTask(params.task, params.returnContract, params.requireEvidence)
		: appendReturnRequirements(params.task, params.returnContract, params.requireEvidence);
	const result = await runAgentRef(
		deps,
		{ agent: params.agent, cwd: params.cwd, tools: params.tools },
		task,
		"single",
		undefined,
		[],
		{
			limits: contract
				? { captureRawOutput: true, timeoutMs: contract.timeoutMs, contractBudget: contract.budget(), contract: contract.contract }
				: {},
			scope: { key: "single" },
		},
	);
	if (!isFailed(result)) {
		const handoff = deps.handoffs.consumeResult({
			result,
			contract,
			cwd: resolvedCwd(defaultCwd, params.cwd),
			consumed: false,
			completion: "terminal",
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
