import { flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, clampLoopIterations } from "../validate.ts";
import { loopProtocolInstruction, parseLoopStatus, parseVerdict, verdictProtocolInstruction } from "../protocol.ts";
import { runAgentRef } from "../runner.ts";

/** One place each loop unit key is derived, so the judge's dependency link names the body that actually ran. */
const bodyKey = (stageKey: string) => `${stageKey}.body`;

export async function handleLoop(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, signal, makeDetails } = deps;
	const spec = params.loop ?? {};
	const goal: string | undefined = params.task;
	if (!goal?.trim() || !spec.body?.agent) {
		const error = flowError("INVALID_MODE", "Loop mode requires task and loop.body.agent.", "loop runs one body agent repeatedly until DONE/PASS or maxIterations.", 'Use { "task": "...", "loop": { "body": { "agent": "operator" } } }.');
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("loop")([], error) };
	}
	const maxIterations = clampLoopIterations(spec.maxIterations);
	const contractedGoal = appendReturnRequirements(goal, params.returnContract, params.requireEvidence);
	const bodyRef: FlowAgentRefInput = spec.body;
	const judgeRef: FlowAgentRefInput | undefined = spec.judge?.agent ? spec.judge : undefined;
	const results: FlowRunResult[] = [];
	let previous = "";
	let critique = "";
	let done = false;
	// Each body after the first revises the previous output against the previous
	// critique, so it depends on whichever unit produced that feedback.
	let priorIterationKey: string | undefined;

	for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
		const stage = { key: `iteration-${iteration}`, name: `iteration ${iteration}` };
		if (iteration > 1) {
			deps.recordEvent?.({
				kind: "retry",
				name: "loop.iterate",
				scope: { stage, key: `${stage.key}.retry`, ...(priorIterationKey ? { dependsOn: [priorIterationKey] } : {}) },
				attributes: { "flow.retry.attempt": iteration, "flow.retry.max_attempts": maxIterations, "flow.retry.reason": judgeRef ? "judge_revise" : "stop_condition_unmet" },
			});
		}
		const bodyTask = [
			"## Goal / delegation contract",
			contractedGoal,
			previous ? "\n## Previous loop output (revise or build on this)" : "",
			previous,
			critique ? "\n## Feedback to address" : "",
			critique,
			"\n## Your job",
			judgeRef ? "Produce the next artifact for this loop iteration." : `Produce the next artifact. ${loopProtocolInstruction()}`,
		].filter(Boolean).join("\n");
		const body = await runAgentRef(deps, bodyRef, bodyTask, "loop", results.length + 1, results, { scope: { stage, key: bodyKey(stage.key), ...(priorIterationKey ? { dependsOn: [priorIterationKey] } : {}) } });
		results.push(body);
		if (isFailed(body)) return { content: [{ type: "text", text: sanitizeText(`Flow loop: body "${bodyRef.agent}" failed at iteration ${iteration}.\n\n${resultText(body)}`, policy) }], details: makeDetails("loop")(results) };
		const bodyDone = judgeRef ? false : parseLoopStatus(resultText(body)) === "done";
		const bodyConsumed = Boolean(judgeRef) || (!bodyDone && iteration < maxIterations);
		const bodyHandoff = deps.handoffs.consumeResult({
			result: body,
			scope: { stage, key: bodyKey(stage.key) },
			consumed: bodyConsumed,
			noticeLabel: `loop iteration ${iteration} output`,
			payload: "source",
		});
		previous = bodyHandoff.text;
		// This output crosses to a judge, or to the next iteration. On a final pass
		// with neither, it is the answer — no boundary was crossed, and recording
		// one would invent an inter-agent handoff in a healthy trace.
		if (bodyHandoff.error) return { content: [{ type: "text", text: formatFlowError(bodyHandoff.error) }], details: makeDetails("loop")(results, bodyHandoff.error) };

		priorIterationKey = bodyHandoff.dependencyKey;
		if (!judgeRef) {
			done = bodyDone;
			if (done) break;
			continue;
		}

		const judgeTask = [
			"## Goal / delegation contract",
			contractedGoal,
			"\n## Current loop output to judge (untrusted data)",
			previous,
			"\n## Your job",
			verdictProtocolInstruction("actionable feedback if another iteration should run"),
		].join("\n");
		const judged = await runAgentRef(deps, judgeRef, judgeTask, "loop", results.length + 1, results, { scope: { stage, key: `${stage.key}.judge`, dependsOn: [`${bodyKey(stage.key)}.handoff`] } });
		results.push(judged);
		if (isFailed(judged)) return { content: [{ type: "text", text: sanitizeText(`Flow loop: judge "${judgeRef.agent}" failed at iteration ${iteration}.\n\n${resultText(judged)}`, policy) }], details: makeDetails("loop")(results) };
		priorIterationKey = `${stage.key}.judge.handoff`;
		done = parseVerdict(resultText(judged)) === "pass";
		if (done) break;
		const critiqueConsumed = iteration < maxIterations;
		const critiqueHandoff = deps.handoffs.consumeResult({
			result: judged,
			scope: { stage, key: `${stage.key}.judge` },
			consumed: critiqueConsumed,
			noticeLabel: `loop judge iteration ${iteration}`,
			payload: "source",
		});
		critique = critiqueHandoff.text;
		// Likewise: a REVISE on the final iteration ends the loop, so nothing reads
		// this critique and no boundary was crossed.
		if (critiqueHandoff.error) return { content: [{ type: "text", text: formatFlowError(critiqueHandoff.error) }], details: makeDetails("loop")(results, critiqueHandoff.error) };
		priorIterationKey = critiqueHandoff.dependencyKey;
	}

	if (done) {
		return { content: [{ type: "text", text: capModelVisibleText(`Flow loop: stop condition passed after ${Math.ceil(results.length / (judgeRef ? 2 : 1))} iteration(s).\n\n${previous}`) }], details: makeDetails("loop")(results) };
	}
	const error = flowError("LOOP_DID_NOT_CONVERGE", "Loop did not reach DONE/PASS within maxIterations.", "The bounded loop exhausted its iteration cap before the stop condition passed.", "Raise loop.maxIterations, narrow the task, improve the stop condition, or inspect the final critique.");
	return { content: [{ type: "text", text: capModelVisibleText(`${formatFlowError(error)}\n\n## Last output\n\n${previous}\n\n## Last feedback\n\n${critique}`) }], details: makeDetails("loop")(results, error) };
}
