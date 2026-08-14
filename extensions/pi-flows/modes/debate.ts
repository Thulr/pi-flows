import { flowError, modeSettle, type DelegationContract, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runWave } from "../runner.ts";
import { debateRounds, successfulRuns } from "../topology.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { dispatchIntegrationPlan, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { maxRunDuration, plannedRefs, runDuration, withinFanoutCap, type ModePlan } from "./plan.ts";

/**
 * Debate's plan: the advocate wave (repeated per round at runtime; the roles
 * are declared once), then the adjudicator with the handler's analyst
 * default. The advocate wave is guarded unless the panel is over the cap,
 * where the schema refuses before the guard — the wave stays declared while
 * the admissibility mirror stays silent and no opening is certain.
 */
export function planDebate(params: any): ModePlan {
	if (!params.debate) return { waves: [], opening: [] };
	const spec = params.debate ?? {};
	const participants = plannedRefs(spec.participants);
	const guarded = withinFanoutCap(spec.participants);
	const adjudicator = plannedRefs([spec.adjudicator?.agent ? spec.adjudicator : { agent: "analyst" }]);
	return {
		waves: [
			{ refs: participants, guarded, contracts: "resolved" },
			...(adjudicator.length > 0 ? [{ refs: adjudicator, guarded: false, contracts: "resolved" as const }] : []),
		],
		opening: guarded ? participants : [],
	};
}

/** Per round, the slowest advocate; then the adjudicator tail. Underivable when the results do not fill the declared rounds. */
export function criticalPathDebate(params: any, results: FlowRunResult[]): number | undefined {
	const participantCount = Array.isArray(params.debate?.participants) ? params.debate.participants.length : 0;
	const rounds = debateRounds(params.debate);
	if (participantCount < 2 || results.length !== participantCount * rounds + 1) return undefined;
	let path = runDuration(results.at(-1));
	for (let round = 0; round < rounds; round += 1) {
		path += maxRunDuration(results.slice(round * participantCount, (round + 1) * participantCount));
	}
	return path;
}

/** One place every advocate key is derived, so a round's dependency links cannot drift from the spans they name. */
function advocateKey(round: number, index: number): string {
	return `round-${round}.advocate-${index + 1}`;
}

/**
 * Debate's pre-spawn refusal (modes/contract.ts): fewer than two advocates, or
 * no decision question, is refused before any advocate spawns — in the
 * handler's order, so the participant count is judged first. Total over raw
 * model args.
 */
export function preSpawnRefusalDebate(params: any): FlowError | null {
	if (params?.debate === undefined) return null;
	const spec = params.debate ?? {};
	const participants = Array.isArray(spec.participants) ? spec.participants : [];
	if (participants.length < 2) {
		return flowError("DEBATE_TOO_FEW_PARTICIPANTS", "Debate mode needs at least two advocates.", "A single answer has no independent opposition or rebuttal surface.", "Provide two or more participants, or use single/evaluate for one proposal plus critique.");
	}
	if (typeof params.task === "string" && params.task.trim()) return null;
	return flowError("INVALID_MODE", "Debate mode requires a task.", "The advocates and adjudicator need the same decision question and constraints.", 'Add a top-level task, e.g. {"task":"choose A or B under ...","debate":{...}}.');
}

export async function handleDebate(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	const spec = params.debate ?? {};
	const entryRefusal = preSpawnRefusalDebate(params);
	if (entryRefusal) return settle.refuse(entryRefusal);
	const participants: FlowAgentRefInput[] = spec.participants;

	const rounds = debateRounds(spec);
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
			if (planned.error) return settle.refuse(planned.error);
			items.push(planned.plan!);
		}
		const roundWave = await runWave(deps, settle, items, {
			statusText: (settled, total) => `Flow debate: round ${round}/${rounds}, ${settled}/${total} advocates settled`,
			stage: { key: `round-${round}`, name: `round ${round}` },
		});
		if (roundWave.status === "refused") return roundWave.output;
		const roundResults = roundWave.results;
		const roundEntries = roundResults.flatMap((result, index) =>
			isFailed(result) ? [] : [{ result, plan: items[index] }],
		);
		const handoffs = deps.handoffs.consumeResults(roundEntries);
		if (handoffs.error) return settle.refuse(handoffs.error);
		if (successfulRuns(roundResults).length < 2) {
			return settle.complete("Flow debate stopped: fewer than two advocates produced usable arguments.");
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
	if (planned.error) return settle.refuse(planned.error);
	const dispatched = await dispatchIntegrationPlan(deps, planned.plan!, settle, { completion: "terminal", enforceCompletion: true });
	if (dispatched.status === "failed") return settle.complete(sanitizeText(`Flow debate: adjudicator failed.\n\n${resultText(dispatched.result)}`, policy));
	if (dispatched.status === "refused") return dispatched.output;

	// The adjudicator's decision record is debate's verdict — accepted here,
	// where its dispatch settled, not parsed for a PASS/REVISE marker: the
	// decision is the record itself. A failed adjudicator returns above and
	// leaves no verdict to record.
	deps.recordEvent?.({
		kind: "validation",
		name: "debate.judge_verdict",
		ok: true,
		scope: { key: "adjudicator.verdict", dependsOn: ["adjudicator"] },
		attributes: {
			"flow.verdict.adjudicator": adjudicator.agent,
			"flow.verdict.rounds": rounds,
			"flow.verdict.advocate_count": participants.length,
		},
	});

	return settle.complete(capModelVisibleText(`Flow debate: ${participants.length} advocates, ${rounds} round(s), adjudicated by ${adjudicator.agent}.${incompleteHandoffSummary([...settle.results])}${deps.handoffs.warningSummary()}\n\n${sanitizeText(resultText(dispatched.result), policy)}`));
}
