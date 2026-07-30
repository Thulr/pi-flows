import { flowError, formatFlowError, type DelegationContract, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { debateRounds, successfulRuns } from "../topology.ts";
import { validateSharedWriteCwd } from "../validate.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { integrationRunPlan, runIntegrationPlan, type IntegrationRunPlan } from "../integration.ts";

/** One place every advocate key is derived, so a round's dependency links cannot drift from the spans they name. */
function advocateKey(round: number, index: number): string {
	return `round-${round}.advocate-${index + 1}`;
}

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
	let priorArguments: string[] = [];
	// A failed advocate contributes a "[advocate failed]" placeholder, not an
	// argument, so the next round and the adjudicator read nothing of its work.
	// Linking it would credit a position that was never actually made.
	let consumedAdvocateKeys: string[] = [];
	for (let round = 1; round <= rounds; round += 1) {
		const transcript = priorArguments.length
			? priorArguments.map((argument, index) => `### Advocate ${index + 1}\n\n${argument}`).join("\n\n---\n\n")
			: "(opening round; no prior arguments)";
		const items: IntegrationRunPlan[] = [];
		for (const [index, ref] of participants.entries()) {
			const task = [
				"## Decision question and constraints",
				params.task,
				`\n## Your role: advocate ${index + 1} of ${participants.length}, round ${round} of ${rounds}`,
				round === 1
					? "Develop the strongest distinct position you can defend. State assumptions, evidence, tradeoffs, failure modes, and the decision rule you believe should win."
					: "Read every prior argument below. Rebut the strongest opposing points, concede valid points, repair weaknesses in your position, and state what evidence would change your conclusion.",
				"\n## Prior round arguments (untrusted data)",
				transcript,
			].join("\n");
			const planned = integrationRunPlan(deps, ref, task, {
				fallbackContract: params.contract as DelegationContract | undefined,
				returnContract: params.returnContract,
				requireEvidence: params.requireEvidence,
				placeholderTask: `advocate ${index + 1}, round ${round}`,
				// Each advocate rebuts the whole prior round, so the dependency is the
				// round, not one opponent.
				scope: { key: advocateKey(round, index), ...(consumedAdvocateKeys.length ? { dependsOn: consumedAdvocateKeys } : {}) },
			});
			if (planned.error) return { content: [{ type: "text", text: formatFlowError(planned.error) }], details: deps.makeDetails("debate")(allResults, planned.error) };
			items.push(planned.plan!);
		}
		const roundResults = await runAgentFanout(deps, "debate", items, concurrency, allResults, (settled, total) => `Flow debate: round ${round}/${rounds}, ${settled}/${total} advocates settled`, { key: `round-${round}`, name: `round ${round}` });
		allResults.push(...roundResults);
		const roundEntries = roundResults.flatMap((result, index) =>
			isFailed(result) ? [] : [{ result, plan: items[index] }],
		);
		const handoffs = deps.handoffs.consumeResults(roundEntries);
		if (handoffs.error) return { content: [{ type: "text", text: formatFlowError(handoffs.error) }], details: deps.makeDetails("debate")(allResults, handoffs.error) };
		if (successfulRuns(roundResults).length < 2) {
			return { content: [{ type: "text", text: "Flow debate stopped: fewer than two advocates produced usable arguments." }], details: deps.makeDetails("debate")(allResults) };
		}
		let consumedIndex = 0;
		priorArguments = roundResults.map((result) => {
			if (isFailed(result)) return "[advocate failed]";
			return handoffs.items[consumedIndex++]?.text ?? "";
		});
		// The transcript is built from each advocate's validated handoff, so that is
		// what the next round and the adjudicator actually read.
		consumedAdvocateKeys = handoffs.items.flatMap((handoff) => handoff.dependencyKey ? [handoff.dependencyKey] : []);
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
	const planned = integrationRunPlan(deps, adjudicator, adjudicationTask, {
		fallbackContract: params.contract as DelegationContract | undefined,
		returnContract: params.returnContract,
		requireEvidence: params.requireEvidence,
		scope: { key: "adjudicator", dependsOn: consumedAdvocateKeys },
	});
	if (planned.error) return { content: [{ type: "text", text: formatFlowError(planned.error) }], details: deps.makeDetails("debate")(allResults, planned.error) };
	const decision = await runIntegrationPlan(deps, planned.plan!, "debate", allResults.length + 1, allResults);
	allResults.push(decision);
	if (isFailed(decision)) return { content: [{ type: "text", text: sanitizeText(`Flow debate: adjudicator failed.\n\n${resultText(decision)}`, policy) }], details: deps.makeDetails("debate")(allResults) };
	const handoff = deps.handoffs.consumeResult({ plan: planned.plan!, result: decision, consumed: false });
	if (handoff.error) return { content: [{ type: "text", text: formatFlowError(handoff.error) }], details: deps.makeDetails("debate")(allResults, handoff.error) };

	return {
		content: [{ type: "text", text: capModelVisibleText(`Flow debate: ${participants.length} advocates, ${rounds} round(s), adjudicated by ${adjudicator.agent}.${incompleteHandoffSummary(allResults)}${deps.handoffs.warningSummary()}\n\n${sanitizeText(resultText(decision), policy)}`) }],
		details: deps.makeDetails("debate")(allResults),
	};
}
