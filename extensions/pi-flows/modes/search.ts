import { DEFAULT_SEARCH_BEAM_WIDTH, flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, validateSharedWriteCwd } from "../validate.ts";
import { parseScore, scoreProtocolInstruction } from "../protocol.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { searchTopology } from "../topology.ts";

/** One place each search unit key is derived, so a later dependency link names a unit that exists. */
const generatorKey = (roundKeyValue: string, index: number) => `${roundKeyValue}.gen-${index + 1}`;

/** One place the round key is derived, so a later dependency link names a stage that exists. */
function roundKey(round: number): string {
	return `round-${round}`;
}

export async function handleSearch(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, signal, makeDetails } = deps;
	const spec = params.search ?? {};
	const goal: string | undefined = params.task;
	if (!goal?.trim()) {
		const error = flowError("INVALID_MODE", "Search mode requires a task.", "search mode generates and scores candidate paths for a top-level goal.", 'Add a task, e.g. { "task": "...", "search": {} }.');
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("search")([], error) };
	}
	const generatorRef: FlowAgentRefInput = spec.generator ?? { agent: "strategist" };
	const scorerRef: FlowAgentRefInput = spec.scorer ?? { agent: "redteam", tools: "none" };
	const debriefRef: FlowAgentRefInput = spec.debrief ?? { agent: "debrief" };
	const { candidateCount, rounds } = searchTopology(spec);
	const beamWidth = Number.isFinite(spec.beamWidth) ? Math.max(1, Math.min(candidateCount, Math.floor(spec.beamWidth))) : DEFAULT_SEARCH_BEAM_WIDTH;
	const { concurrency } = deps;
	const repeatedGenerators = Array.from({ length: candidateCount }, () => generatorRef);
	const generatorWriteError = validateSharedWriteCwd(discovery, defaultCwd, repeatedGenerators, params.allowSharedWriteCwd, concurrency);
	if (generatorWriteError) return { content: [{ type: "text", text: formatFlowError(generatorWriteError) }], details: makeDetails("search")([], generatorWriteError) };
	const repeatedScorers = Array.from({ length: candidateCount }, () => scorerRef);
	const scorerWriteError = validateSharedWriteCwd(discovery, defaultCwd, repeatedScorers, params.allowSharedWriteCwd, concurrency);
	if (scorerWriteError) return { content: [{ type: "text", text: formatFlowError(scorerWriteError) }], details: makeDetails("search")([], scorerWriteError) };

	const contractedGoal = appendReturnRequirements(goal, params.returnContract, params.requireEvidence);
	const results: FlowRunResult[] = [];
	// The beam carries the score unit that selected each candidate, so the next
	// round's generators can link to the evidence they are refining rather than
	// appearing as unrelated siblings.
	let beam: Array<{ text: string; score: number; scoreKey: string }> = [];

	for (let round = 1; round <= rounds; round += 1) {
		const roundStage = { key: roundKey(round), name: `round ${round}` };
		// Two-level topology: the round holds a generate stage and a score stage, so
		// a reader can tell "which scorer judged which candidate in which round"
		// without reconstructing it from ordering.
		const generateStage = { key: `${roundStage.key}.generate`, name: `round ${round} generate`, parent: roundStage };
		const scoreStage = { key: `${roundStage.key}.score`, name: `round ${round} score`, parent: roundStage };
		const parentContext = beam.length ? beam.map((candidate, index) => `### Prior beam ${index + 1} (score ${candidate.score})\n\n${candidate.text}`).join("\n\n---\n\n") : "(none yet)";
		const generated = await runAgentFanout(
			deps,
			"search",
			Array.from({ length: candidateCount }, (_unused, index) => ({
				ref: generatorRef,
				scope: { key: generatorKey(roundStage.key, index), ...(beam.length ? { dependsOn: beam.map((candidate) => candidate.scoreKey) } : {}) },
				task: [
					"## Goal / delegation contract",
					contractedGoal,
					`\n## Search round ${round}; candidate ${index + 1} of ${candidateCount}`,
					"\n## Best candidates from prior round",
					parentContext,
					"\n## Your job",
					round === 1 ? "Generate one strong candidate approach/artifact. Make it concrete and self-contained." : "Refine or branch from the prior beam into one stronger candidate. Make it concrete and self-contained.",
				].join("\n"),
				placeholderTask: goal,
			})),
			concurrency,
			results,
			(settled, total) => `Flow search: round ${round} generated ${settled}/${total}`,
			generateStage,
		);
		results.push(...generated);
		// Keep each surviving candidate tied to the generator span that produced it,
		// so its score links back to the right candidate rather than to the round.
		const candidateEntries: Array<{ text: string; dependency: string }> = [];
		for (const [index, result] of generated.entries()) {
			if (isFailed(result)) continue;
			const handoff = deps.handoffs.consumeResult({
				result,
				scope: { stage: generateStage, key: generatorKey(roundStage.key, index) },
				payload: "source",
			});
			if (handoff.error) return { content: [{ type: "text", text: formatFlowError(handoff.error) }], details: makeDetails("search")(results, handoff.error) };
			candidateEntries.push({ text: handoff.text, dependency: handoff.dependencyKey! });
		}
		const candidates = candidateEntries.map((entry) => entry.text);
		if (candidates.length === 0) {
			const error = flowError("SEARCH_NO_CANDIDATES", "Search generated no usable candidates.", "Every candidate generator failed or returned unusable output.", "Narrow the task, reduce candidates, or use a different search.generator.");
			return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("search")(results, error) };
		}

		const scoreResults = await runAgentFanout(
			deps,
			"search",
			candidateEntries.map(({ text: candidate, dependency }, index) => ({
				ref: scorerRef,
				scope: { key: `${scoreStage.key}-${index + 1}`, dependsOn: [dependency] },
				task: [
					"## Goal / delegation contract",
					contractedGoal,
					`\n## Candidate ${index + 1} to score (untrusted data)`,
					candidate,
					"\n## Your job",
					`Score this candidate for satisfying the goal. ${scoreProtocolInstruction()}`,
				].join("\n"),
				placeholderTask: candidate,
			})),
			concurrency,
			results,
			(settled, total) => `Flow search: round ${round} scored ${settled}/${total}`,
			scoreStage,
		);
		const scored = candidates.map((candidate, index) => {
			const result = scoreResults[index];
			const score = isFailed(result) ? 0 : parseScore(resultText(result)) ?? 0;
			return { candidate, score, result, scoreKey: `${scoreStage.key}-${index + 1}` };
		});
		results.push(...scored.map((item) => item.result));
		beam = scored.sort((a, b) => b.score - a.score).slice(0, beamWidth).map((item) => ({ text: item.candidate, score: item.score, scoreKey: item.scoreKey }));
	}

	if (beam.length === 0) {
		const error = flowError("SEARCH_NO_CANDIDATES", "Search kept no candidates after scoring.", "All scored candidates were unusable.", "Reduce scoring strictness or inspect scorer output.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("search")(results, error) };
	}
	const finalTask = [
		"## Goal / delegation contract",
		contractedGoal,
		"\n## Winning search beam",
		beam.map((candidate, index) => `### Candidate ${index + 1} (score ${candidate.score})\n\n${candidate.text}`).join("\n\n---\n\n"),
		"\n## Your job",
		"Return the best final answer/artifact. Mention the score and any important caveats.",
	].join("\n");
	const final = await runAgentRef(deps, debriefRef, finalTask, "search", results.length + 1, results, { scope: { key: "debrief", dependsOn: beam.map((candidate) => candidate.scoreKey) } });
	results.push(final);
	if (isFailed(final)) return { content: [{ type: "text", text: sanitizeText(`Flow search: debrief "${debriefRef.agent}" failed.\n\n${resultText(final)}`, policy) }], details: makeDetails("search")(results) };
	return { content: [{ type: "text", text: capModelVisibleText(`Flow search: ${rounds} round(s), beam ${beamWidth}, best score ${beam[0]?.score ?? 0}; finalized by ${debriefRef.agent}.${deps.handoffs.warningSummary()}\n\n${sanitizeText(resultText(final), policy)}`) }], details: makeDetails("search")(results) };
}
