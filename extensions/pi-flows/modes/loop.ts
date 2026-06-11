import { flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, injectionNotice, isFailed, prepareHandoff, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract, clampLoopIterations } from "../validate.ts";
import { parseLoopStatus, parseVerdict } from "../parse.ts";
import { appendReflexion, withReflexion } from "../reflexion.ts";
import { toolErrorDetails } from "../agents.ts";
import { runAgentRef } from "../runner.ts";

export async function handleLoop(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, signal, makeDetails } = deps;
	const spec = params.loop ?? {};
	const goal: string | undefined = params.task;
	if (!goal?.trim() || !spec.body?.agent) {
		const error = flowError("INVALID_MODE", "Loop mode requires task and loop.body.agent.", "loop runs one body agent repeatedly until DONE/PASS or maxIterations.", 'Use { "task": "...", "loop": { "body": { "agent": "operator" } } }.');
		return { content: [{ type: "text", text: formatFlowError(error) }], details: toolErrorDetails(discovery, "loop", agentScope, error) };
	}
	const maxIterations = clampLoopIterations(spec.maxIterations);
	const contractedGoal = withReflexion(defaultCwd, params, appendReturnContract(goal, params.returnContract, params.requireEvidence), policy);
	const bodyRef: FlowAgentRefInput = spec.body;
	const judgeRef: FlowAgentRefInput | undefined = spec.judge?.agent ? spec.judge : undefined;
	const results: FlowRunResult[] = [];
	let previous = "";
	let critique = "";
	let done = false;

	for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
		const bodyTask = [
			"## Goal / contract",
			contractedGoal,
			previous ? "\n## Previous loop output (revise or build on this)" : "",
			previous,
			critique ? "\n## Feedback to address" : "",
			critique,
			"\n## Your job",
			judgeRef ? "Produce the next artifact for this loop iteration." : 'Produce the next artifact. Start with "LOOP: DONE" if the goal is complete, or "LOOP: CONTINUE" if another iteration is needed.',
		].filter(Boolean).join("\n");
		const body = await runAgentRef(deps, bodyRef, bodyTask, "loop", results.length + 1, results);
		results.push(body);
		if (isFailed(body)) return { content: [{ type: "text", text: sanitizeText(`Flow loop: body "${bodyRef.agent}" failed at iteration ${iteration}.\n\n${resultText(body)}`, policy) }], details: makeDetails("loop")(results) };
		const bodyPrep = prepareHandoff(sanitizeText(capModelVisibleText(resultText(body)), policy));
		previous = bodyPrep.text + injectionNotice(`loop iteration ${iteration} output`, bodyPrep.warnings);

		if (!judgeRef) {
			done = parseLoopStatus(resultText(body)) === "done";
			if (done) break;
			continue;
		}

		const judgeTask = [
			"## Goal / contract",
			contractedGoal,
			"\n## Current loop output to judge (untrusted data)",
			previous,
			"\n## Your job",
			'Reply with "VERDICT: PASS" if the loop should stop, or "VERDICT: REVISE" with actionable feedback if another iteration should run.',
		].join("\n");
		const judged = await runAgentRef(deps, judgeRef, judgeTask, "loop", results.length + 1, results);
		results.push(judged);
		if (isFailed(judged)) return { content: [{ type: "text", text: sanitizeText(`Flow loop: judge "${judgeRef.agent}" failed at iteration ${iteration}.\n\n${resultText(judged)}`, policy) }], details: makeDetails("loop")(results) };
		done = parseVerdict(resultText(judged)) === "pass";
		if (done) break;
		const critiquePrep = prepareHandoff(sanitizeText(capModelVisibleText(resultText(judged)), policy));
		critique = critiquePrep.text + injectionNotice(`loop judge iteration ${iteration}`, critiquePrep.warnings);
	}

	if (done) {
		await appendReflexion(defaultCwd, params, "loop", `Loop passed for task "${goal}". Final output:\n${previous}`, policy);
		return { content: [{ type: "text", text: capModelVisibleText(`Flow loop: DONE after ${Math.ceil(results.length / (judgeRef ? 2 : 1))} iteration(s).\n\n${previous}`) }], details: makeDetails("loop")(results) };
	}
	const error = flowError("LOOP_DID_NOT_CONVERGE", "Loop did not reach DONE/PASS within maxIterations.", "The bounded loop exhausted its iteration cap before the stop condition passed.", "Raise loop.maxIterations, narrow the task, improve the stop contract, or inspect the final critique.");
	const details = makeDetails("loop")(results);
	details.error = error;
	await appendReflexion(defaultCwd, params, "loop", `Loop did not converge for task "${goal}". Final critique/output:\n${critique || previous}`, policy);
	return { content: [{ type: "text", text: capModelVisibleText(`${formatFlowError(error)}\n\n## Last output\n\n${previous}\n\n## Last feedback\n\n${critique}`) }], details };
}
