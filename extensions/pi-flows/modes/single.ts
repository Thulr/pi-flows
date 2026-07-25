import type { ModeDeps, ModeOutput } from "../types.ts";
import { resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract } from "../validate.ts";
import { runAgentRef } from "../runner.ts";

export async function handleSingle(deps: ModeDeps): Promise<ModeOutput> {
	const { params, policy, makeDetails } = deps;
	const result = await runAgentRef(
		deps,
		{ agent: params.agent, cwd: params.cwd, tools: params.tools },
		appendReturnContract(params.task, params.returnContract, params.requireEvidence),
		"single",
		undefined,
		[],
	);
	return {
		content: [{ type: "text", text: sanitizeText(resultText(result), policy) }],
		details: makeDetails("single")([result]),
	};
}
