import type { FlowRunResult, ModeDeps, ModeOutput } from "../types.ts";
import { capModelVisibleText, injectionNotice, isFailed, prepareHandoff, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract } from "../validate.ts";
import { renderTaskTemplate } from "../parse.ts";
import { runFlowAgent } from "../runner.ts";

export async function handleChain(deps: ModeDeps): Promise<ModeOutput> {
	const { params, policy, defaultCwd, signal, onUpdate, makeDetails } = deps;
	const results: FlowRunResult[] = [];
	let previous = "";

	for (let index = 0; index < params.chain.length; index += 1) {
		const step = params.chain[index];
		const task = appendReturnContract(renderTaskTemplate(step.task, params.task, previous), step.returnContract ?? params.returnContract, step.requireEvidence ?? params.requireEvidence);
		const result = await runFlowAgent({
			defaultCwd,
			agents: deps.discovery.agents,
			agentName: step.agent,
			task,
			cwd: step.cwd,
			model: step.model,
			tools: step.tools,
			timeoutMs: params.timeoutMs,
			recordContent: params.recordContent,
			redactSecrets: params.redactSecrets,
			step: index + 1,
			signal,
			budget: deps.budget,
			recordSpan: deps.recordSpan,
			onUpdate: (partial) => {
				const current = partial.details.results[0];
				onUpdate?.({
					content: partial.content,
					details: makeDetails("chain")([...results, ...(current ? [current] : [])]),
				});
			},
			makeDetails: makeDetails("chain"),
		});
		results.push(result);

		if (isFailed(result)) {
			return {
				content: [{ type: "text", text: sanitizeText(`Flow chain stopped at step ${index + 1} (${step.agent}):\n\n${resultText(result)}`, policy) }],
				details: makeDetails("chain")(results),
			};
		}
		// {previous} is this step's output reused as the next step's prompt — a trust
		// boundary. Strip invisible chars and flag injection markers before handoff.
		const handoff = prepareHandoff(sanitizeText(capModelVisibleText(resultText(result)), policy));
		previous = handoff.text + injectionNotice(`chain step ${index + 1} output`, handoff.warnings);
	}

	return {
		content: [{ type: "text", text: sanitizeText(resultText(results[results.length - 1]), policy) }],
		details: makeDetails("chain")(results),
	};
}
