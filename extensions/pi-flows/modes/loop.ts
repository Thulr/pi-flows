import { flowError, modeSettle, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, clampLoopIterations } from "../validate.ts";
import { loopProtocolInstruction, parseLoopStatus, parseVerdict, verdictProtocolInstruction } from "../protocol.ts";
import { runAgentRef } from "../runner.ts";
import { plannedRefs, sumRunDurations, type ModePlan } from "./plan.ts";

/**
 * Loop's plan: the body role (the opening — empty when no body agent is
 * named, and the handler refuses INVALID_MODE), then the optional judge.
 * Iterations repeat these roles sequentially, so nothing is guarded and no
 * wave carries contract budgets.
 */
export function planLoop(params: any): ModePlan {
	if (!params.loop) return { waves: [], opening: [] };
	const body = plannedRefs([params.loop?.body]);
	const judge = plannedRefs([params.loop?.judge]);
	return {
		waves: [
			{ refs: body, guarded: false },
			...(judge.length > 0 ? [{ refs: judge, guarded: false }] : []),
		],
		opening: body,
	};
}

/** Body and judge alternate one at a time: sequential. */
export function criticalPathLoop(_params: any, results: FlowRunResult[]): number | undefined {
	return sumRunDurations(results);
}

/** One place each loop unit key is derived, so the judge's dependency link names the body that actually ran. */
const bodyKey = (stageKey: string) => `${stageKey}.body`;

/**
 * Loop's pre-spawn refusal (modes/contract.ts): a loop with no goal or no body
 * agent has nothing to iterate and is refused INVALID_MODE before it spawns.
 * Total over raw model args.
 */
export function preSpawnRefusalLoop(params: any): FlowError | null {
	if (params?.loop === undefined) return null;
	const spec = params.loop ?? {};
	if (typeof params.task === "string" && params.task.trim() && spec.body?.agent) return null;
	return flowError("INVALID_MODE", "Loop mode requires task and loop.body.agent.", "loop runs one body agent repeatedly until DONE/PASS or maxIterations.", 'Use { "task": "...", "loop": { "body": { "agent": "operator" } } }.');
}

export async function handleLoop(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	const spec = params.loop ?? {};
	const entryRefusal = preSpawnRefusalLoop(params);
	if (entryRefusal) return settle.refuse(entryRefusal);
	const goal = params.task as string;
	const maxIterations = clampLoopIterations(spec.maxIterations);
	const contractedGoal = appendReturnRequirements(goal, params.returnContract, params.requireEvidence);
	const bodyRef: FlowAgentRefInput = spec.body;
	const judgeRef: FlowAgentRefInput | undefined = spec.judge?.agent ? spec.judge : undefined;
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
		const body = await runAgentRef(deps, bodyRef, bodyTask, settle.mode, settle.nextStep, [...settle.results], { scope: { stage, key: bodyKey(stage.key), ...(priorIterationKey ? { dependsOn: [priorIterationKey] } : {}) } });
		settle.track(body);
		if (isFailed(body)) return settle.complete(sanitizeText(`Flow loop: body "${bodyRef.agent}" failed at iteration ${iteration}.\n\n${resultText(body)}`, policy));
		const bodyDone = judgeRef ? false : parseLoopStatus(resultText(body)) === "done";
		const bodyConsumed = Boolean(judgeRef) || (!bodyDone && iteration < maxIterations);
		const bodyHandoff = deps.handoffs.consumeResult({
			result: body,
			scope: { stage, key: bodyKey(stage.key) },
			completion: bodyConsumed ? "integrate" : "terminal",
			noticeLabel: `loop iteration ${iteration} output`,
			payload: "source",
		});
		previous = bodyHandoff.text;
		// This output crosses to a judge, or to the next iteration. On a final pass
		// with neither, it is the answer — no boundary was crossed, and recording
		// one would invent an inter-agent handoff in a healthy trace.
		if (bodyHandoff.error) return settle.refuse(bodyHandoff.error);

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
		const judged = await runAgentRef(deps, judgeRef, judgeTask, settle.mode, settle.nextStep, [...settle.results], { scope: { stage, key: `${stage.key}.judge`, dependsOn: [bodyHandoff.dependencyKey!] } });
		settle.track(judged);
		if (isFailed(judged)) return settle.complete(sanitizeText(`Flow loop: judge "${judgeRef.agent}" failed at iteration ${iteration}.\n\n${resultText(judged)}`, policy));
		done = parseVerdict(resultText(judged)) === "pass";
		if (done) break;
		const critiqueConsumed = iteration < maxIterations;
		const critiqueHandoff = deps.handoffs.consumeResult({
			result: judged,
			scope: { stage, key: `${stage.key}.judge` },
			completion: critiqueConsumed ? "integrate" : "terminal",
			noticeLabel: `loop judge iteration ${iteration}`,
			payload: "source",
		});
		critique = critiqueHandoff.text;
		// Likewise: a REVISE on the final iteration ends the loop, so nothing reads
		// this critique and no boundary was crossed.
		if (critiqueHandoff.error) return settle.refuse(critiqueHandoff.error);
		priorIterationKey = critiqueHandoff.dependencyKey;
	}

	if (done) {
		return settle.complete(capModelVisibleText(`Flow loop: stop condition passed after ${Math.ceil(settle.results.length / (judgeRef ? 2 : 1))} iteration(s).\n\n${previous}`));
	}
	const error = flowError("LOOP_DID_NOT_CONVERGE", "Loop did not reach DONE/PASS within maxIterations.", "The bounded loop exhausted its iteration cap before the stop condition passed.", "Raise loop.maxIterations, narrow the task, improve the stop condition, or inspect the final critique.");
	return settle.refuse(error, { footer: `\n\n## Last output\n\n${previous}\n\n## Last feedback\n\n${critique}` });
}
