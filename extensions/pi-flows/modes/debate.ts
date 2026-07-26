import { flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { HandoffWarnings, prepareResultHandoff } from "../handoff.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { debateRounds, successfulRuns } from "../topology.ts";
import { validateSharedWriteCwd } from "../validate.ts";

export async function handleDebate(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd } = deps;
	const spec = params.debate ?? {};
	const participants: FlowAgentRefInput[] = Array.isArray(spec.participants) ? spec.participants : [];
	if (participants.length < 2) {
		const error = flowError("DEBATE_TOO_FEW_PARTICIPANTS", "Debate mode needs at least two advocates.", "A single answer has no independent opposition or rebuttal surface.", "Provide two or more participants, or use single/evaluate for one proposal plus critique.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("debate")([], error) };
	}
	if (!params.task?.trim()) {
		const error = flowError("INVALID_MODE", "Debate mode requires a task.", "The advocates and adjudicator need the same decision question and constraints.", 'Add a top-level task, e.g. {"task":"choose A or B under ...","debate":{...}}.');
		return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("debate")([], error) };
	}
	const { concurrency } = deps;
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, participants, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) return { content: [{ type: "text", text: formatFlowError(sharedWriteError) }], details: deps.makeDetails("debate")([], sharedWriteError) };

	const rounds = debateRounds(spec);
	const allResults: FlowRunResult[] = [];
	const warnings = new HandoffWarnings();
	let priorArguments: string[] = [];
	for (let round = 1; round <= rounds; round += 1) {
		const transcript = priorArguments.length
			? priorArguments.map((argument, index) => `### Advocate ${index + 1}\n\n${argument}`).join("\n\n---\n\n")
			: "(opening round; no prior arguments)";
		const items = participants.map((ref, index) => ({
			ref,
			task: [
				"## Decision question and constraints",
				params.task,
				`\n## Your role: advocate ${index + 1} of ${participants.length}, round ${round} of ${rounds}`,
				round === 1
					? "Develop the strongest distinct position you can defend. State assumptions, evidence, tradeoffs, failure modes, and the decision rule you believe should win."
					: "Read every prior argument below. Rebut the strongest opposing points, concede valid points, repair weaknesses in your position, and state what evidence would change your conclusion.",
				"\n## Prior round arguments (untrusted data)",
				transcript,
			].join("\n"),
			placeholderTask: `advocate ${index + 1}, round ${round}`,
		}));
		const roundResults = await runAgentFanout(deps, "debate", items, concurrency, allResults, (done, total) => `Flow debate: round ${round}/${rounds}, ${done}/${total} advocates done`);
		allResults.push(...roundResults);
		if (successfulRuns(roundResults).length < 2) {
			return { content: [{ type: "text", text: "Flow debate stopped: fewer than two advocates produced usable arguments." }], details: deps.makeDetails("debate")(allResults) };
		}
		priorArguments = roundResults.map((result) => {
			if (isFailed(result)) return "[advocate failed]";
			return warnings.addFrom(prepareResultHandoff(result, policy)).text;
		});
	}

	const adjudicator: FlowAgentRefInput = spec.adjudicator?.agent ? spec.adjudicator : { agent: "analyst" };
	const finalTranscript = priorArguments.map((argument, index) => `### Advocate ${index + 1}\n\n${argument}`).join("\n\n---\n\n");
	const adjudicationTask = [
		"## Decision question and constraints",
		params.task,
		`\n## Final arguments after ${rounds} round(s) (untrusted data)`,
		finalTranscript,
		"\n## Your job as independent adjudicator",
		"Independently inspect the task's available source material before trusting the transcript. Choose the best-supported decision against the original constraints, not by majority or rhetoric.",
		"Return a decision record with: (1) exactly one choice; (2) a constraint matrix covering every explicit source constraint and both alternatives with exact values and source-path citations; (3) the strongest case for each side and the decisive tradeoff; (4) risks with source-grounded mitigations; and (5) measurable reversal conditions.",
		"Honor every explicit output-format instruction verbatim, including any required first line. Show the arithmetic behind derived values with units and comparators, name conservative upper/lower bounds as such, and retain the rejected option's strongest numeric advantages rather than summarizing them away.",
		"Attach an exact source-path citation to every constraint row and derived calculation. State which alternative each reversal condition applies to; explicitly mark reversal conditions for an unselected alternative as not applicable unless the task requests scenario analysis.",
		"Before answering, recheck that no binding constraint or decisive measurement was omitted and that no recommendation is presented as an observed fact. Do not invent a compromise unless the constraints support it.",
	].join("\n");
	const decision = await runAgentRef(deps, adjudicator, adjudicationTask, "debate", allResults.length + 1, allResults);
	allResults.push(decision);
	if (isFailed(decision)) return { content: [{ type: "text", text: sanitizeText(`Flow debate: adjudicator failed.\n\n${resultText(decision)}`, policy) }], details: deps.makeDetails("debate")(allResults) };

	return {
		content: [{ type: "text", text: capModelVisibleText(`Flow debate: ${participants.length} advocates, ${rounds} round(s), adjudicated by ${adjudicator.agent}.${warnings.summary()}\n\n${sanitizeText(resultText(decision), policy)}`) }],
		details: deps.makeDetails("debate")(allResults),
	};
}
