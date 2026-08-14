import { DEFAULT_SEARCH_BEAM_WIDTH, flowError, modeSettle, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, validateSharedWriteCwd } from "../validate.ts";
import { parseScore, scoreProtocolInstruction } from "../protocol.ts";
import { integrationControl } from "../delegation.ts";
import { dispatchIntegrationPlan, dispatchIntegrationWave, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { searchTopology, successfulRuns } from "../topology.ts";
import { maxRunDuration, plannedRefs, runDuration, type ModePlan } from "./plan.ts";

/** Generator wave, scorer wave, then debrief; every role enforces its own contract. */
export function planSearch(params: any): ModePlan {
	if (!params.search) return { waves: [], opening: [] };
	const spec = params.search ?? {};
	const generator = plannedRefs([spec.generator])[0] ?? { agent: "strategist" };
	const scorer = plannedRefs([spec.scorer])[0] ?? { agent: "redteam", tools: "none" };
	const debrief = plannedRefs([spec.debrief])[0] ?? { agent: "debrief" };
	const { candidateCount } = searchTopology(spec);
	const generators = Array.from({ length: candidateCount }, () => generator);
	return {
		waves: [
			{ refs: generators, guarded: true, contracts: "own" },
			{ refs: Array.from({ length: candidateCount }, () => scorer), guarded: true, contracts: "own" },
			{ refs: [debrief], guarded: false, contracts: "own" },
		],
		opening: generators,
	};
}

/** Slowest generator + slowest scorer per round, then the debrief tail. */
export function criticalPathSearch(params: any, results: FlowRunResult[]): number | undefined {
	const { candidateCount: candidates, rounds } = searchTopology(params.search);
	let offset = 0;
	let path = 0;
	for (let round = 0; round < rounds; round += 1) {
		const generated = results.slice(offset, offset + candidates);
		if (generated.length !== candidates) return undefined;
		path += maxRunDuration(generated);
		offset += candidates;
		const scoredCount = successfulRuns(generated).length;
		const scored = results.slice(offset, offset + scoredCount);
		if (scoredCount === 0 || scored.length !== scoredCount) return undefined;
		path += maxRunDuration(scored);
		offset += scoredCount;
	}
	return results.length === offset + 1 ? path + runDuration(results[offset]) : undefined;
}

const generatorKey = (roundKeyValue: string, index: number) => `${roundKeyValue}.gen-${index + 1}`;

function roundKey(round: number): string {
	return `round-${round}`;
}

/** Refuse a missing search goal before any generator spawns. */
export function preSpawnRefusalSearch(params: any): FlowError | null {
	if (params?.search === undefined) return null;
	if (typeof params.task === "string" && params.task.trim()) return null;
	return flowError("INVALID_MODE", "Search mode requires a task.", "search mode generates and scores candidate paths for a top-level goal.", 'Add a task, e.g. { "task": "...", "search": {} }.');
}

export async function handleSearch(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, discovery, policy, defaultCwd } = deps;
	const spec = params.search ?? {};
	const entryRefusal = preSpawnRefusalSearch(params);
	if (entryRefusal) return settle.refuse(entryRefusal);
	const goal = params.task as string;
	const generatorRef: FlowAgentRefInput = spec.generator ?? { agent: "strategist" };
	const scorerRef: FlowAgentRefInput = spec.scorer ?? { agent: "redteam", tools: "none" };
	const debriefRef: FlowAgentRefInput = spec.debrief ?? { agent: "debrief" };
	const { candidateCount, rounds } = searchTopology(spec);
	const beamWidth = Number.isFinite(spec.beamWidth) ? Math.max(1, Math.min(candidateCount, Math.floor(spec.beamWidth))) : DEFAULT_SEARCH_BEAM_WIDTH;
	const { concurrency } = deps;
	// Refuse an unsafe scorer wave before generators spend; wave dispatch remains the backstop.
	const repeatedScorers = Array.from({ length: candidateCount }, () => scorerRef);
	const scorerWriteError = validateSharedWriteCwd(discovery, defaultCwd, repeatedScorers, params.allowSharedWriteCwd, concurrency);
	if (scorerWriteError) return settle.refuse(scorerWriteError);

	const contractedGoal = appendReturnRequirements(goal, params.returnContract, params.requireEvidence);
	// Carry the score unit that selected each candidate into the next round.
	let beam: Array<{ text: string; score: number; scoreKey: string }> = [];

	for (let round = 1; round <= rounds; round += 1) {
		const roundStage = { key: roundKey(round), name: `round ${round}` };
		// Nested stages preserve which scorer judged each candidate in each round.
		const generateStage = { key: `${roundStage.key}.generate`, name: `round ${round} generate`, parent: roundStage };
		const scoreStage = { key: `${roundStage.key}.score`, name: `round ${round} score`, parent: roundStage };
		const parentContext = beam.length ? beam.map((candidate, index) => `### Prior beam ${index + 1} (score ${candidate.score})\n\n${candidate.text}`).join("\n\n---\n\n") : "(none yet)";
		const generatorPlans: IntegrationRunPlan[] = [];
		for (let index = 0; index < candidateCount; index += 1) {
			const task = [
				"## Goal / delegation contract",
				contractedGoal,
				`\n## Search round ${round}; candidate ${index + 1} of ${candidateCount}`,
				"\n## Best candidates from prior round",
				parentContext,
				"\n## Your job",
				round === 1 ? "Generate one strong candidate approach/artifact. Make it concrete and self-contained." : "Refine or branch from the prior beam into one stronger candidate. Make it concrete and self-contained.",
			].join("\n");
			const planned = integrationRunPlan(deps, generatorRef, task, {
				placeholderTask: goal,
				scope: { key: generatorKey(roundStage.key, index), ...(beam.length ? { dependsOn: beam.map((candidate) => candidate.scoreKey) } : {}) },
			});
			if (planned.error) return settle.refuse(planned.error);
			generatorPlans.push(planned.plan!);
		}
		const generatedWave = await dispatchIntegrationWave(deps, settle, generatorPlans, {
			statusText: (settled, total) => `Flow search: round ${round} generated ${settled}/${total}`,
			stage: generateStage,
			consume: { completion: "integrate", payload: "source" },
		});
		if (generatedWave.status === "refused") return generatedWave.output;
		const generated = generatedWave.results;
		// Keep each surviving candidate tied to the generator that produced it.
		const candidateEntries: Array<{ text: string; dependency?: string }> = [];
		for (const [index, result] of generated.entries()) {
			if (isFailed(result)) continue;
			const handoff = generatedWave.consumptions[index]!;
			candidateEntries.push({ text: handoff.text, dependency: handoff.dependencyKey });
		}
		const candidates = candidateEntries.map((entry) => entry.text);
		if (candidates.length === 0) {
			const error = flowError("SEARCH_NO_CANDIDATES", "Search generated no usable candidates.", "Every candidate generator failed or returned unusable output.", "Narrow the task, reduce candidates, or use a different search.generator.");
			return settle.refuse(error);
		}

		const scorePlans: IntegrationRunPlan[] = [];
		for (const [index, { text: candidate, dependency }] of candidateEntries.entries()) {
			const task = [
				"## Goal / delegation contract",
				contractedGoal,
				`\n## Candidate ${index + 1} to score (untrusted data)`,
				candidate,
				"\n## Your job",
				`Score this candidate for satisfying the goal. ${scoreProtocolInstruction(Boolean(scorerRef.contract))}`,
			].join("\n");
			const planned = integrationRunPlan(deps, scorerRef, task, {
				placeholderTask: candidate,
				scope: { key: `${scoreStage.key}-${index + 1}`, ...(dependency ? { dependsOn: [dependency] } : {}) },
			});
			if (planned.error) return settle.refuse(planned.error);
			scorePlans.push(planned.plan!);
		}
		const scoreWave = await dispatchIntegrationWave(deps, settle, scorePlans, {
			statusText: (settled, total) => `Flow search: round ${round} scored ${settled}/${total}`,
			stage: scoreStage,
			consume: { completion: "terminal", enforceCompletion: true, payload: "source" },
		});
		if (scoreWave.status === "refused") return scoreWave.output;
		const scoreResults = scoreWave.results;
		const scored = candidates.map((candidate, index) => {
			const result = scoreResults[index];
			const parsed = isFailed(result) ? null : parseScore(integrationControl(result));
			return { candidate, score: parsed ?? 0, parsed: parsed !== null, result, scoreKey: `${scoreStage.key}-${index + 1}` };
		});
		// Record scores before sorting so values stay aligned with scorer keys.
		deps.recordEvent?.({
			kind: "validation",
			name: "search.scores",
			ok: scored.some((item) => item.parsed),
			scope: { stage: scoreStage, key: `${roundStage.key}.scores`, dependsOn: scored.map((item) => item.scoreKey) },
			attributes: {
				"flow.verdict.round": round,
				"flow.verdict.scores": scored.map((item) => item.score).join(","),
				"flow.verdict.beam_width": beamWidth,
				"flow.verdict.fallback_count": scored.filter((item) => !item.parsed).length,
			},
		});
		beam = scored.sort((a, b) => b.score - a.score).slice(0, beamWidth).map((item) => ({ text: item.candidate, score: item.score, scoreKey: item.scoreKey }));
	}

	if (beam.length === 0) {
		const error = flowError("SEARCH_NO_CANDIDATES", "Search kept no candidates after scoring.", "All scored candidates were unusable.", "Reduce scoring strictness or inspect scorer output.");
		return settle.refuse(error);
	}
	const finalTask = [
		"## Goal / delegation contract",
		contractedGoal,
		"\n## Winning search beam",
		beam.map((candidate, index) => `### Candidate ${index + 1} (score ${candidate.score})\n\n${candidate.text}`).join("\n\n---\n\n"),
		"\n## Your job",
		"Return the best final answer/artifact. Mention the score and any important caveats.",
	].join("\n");
	const finalPlan = integrationRunPlan(deps, debriefRef, finalTask, { scope: { key: "debrief", dependsOn: beam.map((candidate) => candidate.scoreKey) } });
	if (finalPlan.error) return settle.refuse(finalPlan.error);
	const finalDispatch = await dispatchIntegrationPlan(deps, finalPlan.plan!, settle, { completion: "terminal", enforceCompletion: true, payload: "source" });
	if (finalDispatch.status === "failed") return settle.complete(sanitizeText(`Flow search: debrief "${debriefRef.agent}" failed.\n\n${resultText(finalDispatch.result)}`, policy));
	if (finalDispatch.status === "refused") return finalDispatch.output;
	return settle.complete(capModelVisibleText(`Flow search: ${rounds} round(s), beam ${beamWidth}, best score ${beam[0]?.score ?? 0}; finalized by ${debriefRef.agent}.${deps.handoffs.warningSummary()}\n\n${sanitizeText(resultText(finalDispatch.result), policy)}`));
}
