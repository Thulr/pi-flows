import type { ModeDeps, ModeOutput } from "../types.ts";
import { resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract } from "../validate.ts";
import { runFlowAgent } from "../runner.ts";

export async function handleSingle(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, defaultCwd, signal, onUpdate, makeDetails } = deps;
	const result = await runFlowAgent({
		defaultCwd,
		agents: discovery.agents,
		agentName: params.agent,
		task: appendReturnContract(params.task, params.returnContract, params.requireEvidence),
		cwd: params.cwd,
		model: params.model,
		tools: params.tools,
		timeoutMs: params.timeoutMs,
		recordContent: params.recordContent,
		redactSecrets: params.redactSecrets,
		signal,
		budget: deps.budget,
		recordSpan: deps.recordSpan,
		onUpdate,
		makeDetails: makeDetails("single"),
	});
	return {
		content: [{ type: "text", text: sanitizeText(resultText(result), policy) }],
		details: makeDetails("single")([result]),
	};
}
