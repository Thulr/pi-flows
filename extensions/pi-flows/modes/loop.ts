import { flowError, modeSettle, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, clampLoopIterations } from "../validate.ts";
import { loopProtocolInstruction, parseLoopStatus, parsedVerdict, verdictProtocolInstruction } from "../protocol.ts";
import { integrationControl } from "../delegation.ts";
import { consumeIntegrationResult, dispatchIntegrationPlan, integrationRunPlan } from "../integration.ts";
import { plannedRefs, sumRunDurations, type ModePlan } from "./plan.ts";

/** Sequential body and optional judge roles, each with its own contract. */
export function planLoop(params: any): ModePlan {
	if (!params.loop) return { waves: [], opening: [] };
	const body = plannedRefs([params.loop?.body]);
	const judge = plannedRefs([params.loop?.judge]);
	return {
		waves: [
			{ refs: body, guarded: false, contracts: "own" },
			...(judge.length > 0 ? [{ refs: judge, guarded: false, contracts: "own" as const }] : []),
		],
		opening: body,
	};
}

export function criticalPathLoop(_params: any, results: FlowRunResult[]): number | undefined {
	return sumRunDurations(results);
}

const bodyKey = (stageKey: string) => `${stageKey}.body`;

/** Refuse a missing goal or body before the first iteration. */
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
	// Later bodies depend on the prior output or judge feedback they revise.
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
			judgeRef ? "Produce the next artifact for this loop iteration." : `Produce the next artifact. ${loopProtocolInstruction(Boolean(bodyRef.contract))}`,
		].filter(Boolean).join("\n");
		const bodyPlan = integrationRunPlan(deps, bodyRef, bodyTask, {
			scope: { stage, key: bodyKey(stage.key), ...(priorIterationKey ? { dependsOn: [priorIterationKey] } : {}) },
		});
		if (bodyPlan.error) return settle.refuse(bodyPlan.error);
		const bodyDispatch = await dispatchIntegrationPlan(deps, bodyPlan.plan!, settle, { completion: "terminal", enforceCompletion: true, payload: "source" });
		if (bodyDispatch.status === "failed") return settle.complete(sanitizeText(`Flow loop: body "${bodyRef.agent}" failed at iteration ${iteration}.\n\n${resultText(bodyDispatch.result)}`, policy));
		if (bodyDispatch.status === "refused") return bodyDispatch.output;
		const body = bodyDispatch.result;
		const bodyDone = judgeRef ? false : parseLoopStatus(integrationControl(body)) === "done";
		const bodyConsumed = Boolean(judgeRef) || (!bodyDone && iteration < maxIterations);
		const bodyHandoff = bodyConsumed
			? consumeIntegrationResult(deps, bodyPlan.plan!, body, {
					scope: { stage, key: bodyKey(stage.key) },
					completion: "integrate",
					enforceCompletion: true,
					noticeLabel: `loop iteration ${iteration} output`,
					payload: "source",
				})
			: bodyDispatch.handoff;
		previous = bodyHandoff.text;
		// Only output read by a judge or later iteration is a handoff.
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
			verdictProtocolInstruction("actionable feedback if another iteration should run", Boolean(judgeRef.contract)),
		].join("\n");
		const judgePlan = integrationRunPlan(deps, judgeRef, judgeTask, { scope: { stage, key: `${stage.key}.judge`, dependsOn: [bodyHandoff.dependencyKey!] } });
		if (judgePlan.error) return settle.refuse(judgePlan.error);
		const judgeDispatch = await dispatchIntegrationPlan(deps, judgePlan.plan!, settle, { completion: "terminal", enforceCompletion: true, payload: "source" });
		if (judgeDispatch.status === "failed") return settle.complete(sanitizeText(`Flow loop: judge "${judgeRef.agent}" failed at iteration ${iteration}.\n\n${resultText(judgeDispatch.result)}`, policy));
		if (judgeDispatch.status === "refused") return judgeDispatch.output;
		const judged = judgeDispatch.result;
		const verdict = parsedVerdict(integrationControl(judged));
		done = verdict === "pass";
		// Record the stop decision against the judge that produced it.
		deps.recordEvent?.({
			kind: "validation",
			name: "loop.judge_verdict",
			ok: done,
			scope: { stage, key: `${stage.key}.verdict`, dependsOn: [`${stage.key}.judge`] },
			attributes: {
				"flow.verdict.value": verdict ?? "revise",
				"flow.verdict.iteration": iteration,
				"flow.verdict.fallback_used": verdict === null,
			},
		});
		if (done) break;
		const critiqueConsumed = iteration < maxIterations;
		const critiqueHandoff = critiqueConsumed
			? consumeIntegrationResult(deps, judgePlan.plan!, judged, {
					scope: { stage, key: `${stage.key}.judge` },
					completion: "integrate",
					enforceCompletion: true,
					noticeLabel: `loop judge iteration ${iteration}`,
					payload: "source",
				})
			: judgeDispatch.handoff;
		critique = critiqueHandoff.text;
		// A final REVISE reaches no Child and is not a handoff.
		if (critiqueHandoff.error) return settle.refuse(critiqueHandoff.error);
		priorIterationKey = critiqueHandoff.dependencyKey;
	}

	if (done) {
		return settle.complete(capModelVisibleText(`Flow loop: stop condition passed after ${Math.ceil(settle.results.length / (judgeRef ? 2 : 1))} iteration(s).\n\n${previous}`));
	}
	const error = flowError("LOOP_DID_NOT_CONVERGE", "Loop did not reach DONE/PASS within maxIterations.", "The bounded loop exhausted its iteration cap before the stop condition passed.", "Raise loop.maxIterations, narrow the task, improve the stop condition, or inspect the final critique.");
	return settle.refuse(error, { footer: `\n\n## Last output\n\n${previous}\n\n## Last feedback\n\n${critique}` });
}
