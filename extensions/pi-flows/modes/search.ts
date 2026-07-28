import { DEFAULT_SEARCH_BEAM_WIDTH, flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { HandoffWarnings, prepareResultHandoff } from "../handoff.ts";
import { appendReturnContract, validateSharedWriteCwd } from "../validate.ts";
import { parseScore, scoreProtocolInstruction } from "../protocol.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { searchTopology } from "../topology.ts";

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

	const contractedGoal = appendReturnContract(goal, params.returnContract, params.requireEvidence);
	const results: FlowRunResult[] = [];
	const handoffWarnings = new HandoffWarnings();
	let beam: Array<{ text: string; score: number }> = [];

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
				scope: { key: `${roundStage.key}.gen-${index + 1}` },
				task: [
					"## Goal / contract",
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
			(done, total) => `Flow search: round ${round} generated ${done}/${total}`,
			generateStage,
		);
		results.push(...generated);
		// Keep each surviving candidate tied to the generator span that produced it,
		// so its score links back to the right candidate rather than to the round.
		const candidateEntries = generated
			.map((result, index) => ({ result, generatorKey: `${roundStage.key}.gen-${index + 1}` }))
			.filter(({ result }) => !isFailed(result))
			.map(({ result, generatorKey }) => ({ text: handoffWarnings.addFrom(prepareResultHandoff(result, policy)).text, generatorKey }));
		const candidates = candidateEntries.map((entry) => entry.text);
		if (candidates.length === 0) {
			const error = flowError("SEARCH_NO_CANDIDATES", "Search generated no usable candidates.", "Every candidate generator failed or returned unusable output.", "Narrow the task, reduce candidates, or use a different search.generator.");
			return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("search")(results, error) };
		}

		const scoreResults = await runAgentFanout(
			deps,
			"search",
			candidateEntries.map(({ text: candidate, generatorKey }, index) => ({
				ref: scorerRef,
				scope: { key: `${roundStage.key}.score-${index + 1}`, dependsOn: [generatorKey] },
				task: [
					"## Goal / contract",
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
			(done, total) => `Flow search: round ${round} scored ${done}/${total}`,
			scoreStage,
		);
		const scored = candidates.map((candidate, index) => {
			const result = scoreResults[index];
			const score = isFailed(result) ? 0 : parseScore(resultText(result)) ?? 0;
			return { candidate, score, result };
		});
		results.push(...scored.map((item) => item.result));
		beam = scored.sort((a, b) => b.score - a.score).slice(0, beamWidth).map((item) => ({ text: item.candidate, score: item.score }));
	}

	if (beam.length === 0) {
		const error = flowError("SEARCH_NO_CANDIDATES", "Search kept no candidates after scoring.", "All scored candidates were unusable.", "Reduce scoring strictness or inspect scorer output.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("search")(results, error) };
	}
	const finalTask = [
		"## Goal / contract",
		contractedGoal,
		"\n## Winning search beam",
		beam.map((candidate, index) => `### Candidate ${index + 1} (score ${candidate.score})\n\n${candidate.text}`).join("\n\n---\n\n"),
		"\n## Your job",
		"Return the best final answer/artifact. Mention the score and any important caveats.",
	].join("\n");
	const final = await runAgentRef(deps, debriefRef, finalTask, "search", results.length + 1, results, {}, { key: "debrief", dependsOn: [roundKey(rounds)] });
	results.push(final);
	if (isFailed(final)) return { content: [{ type: "text", text: sanitizeText(`Flow search: debrief "${debriefRef.agent}" failed.\n\n${resultText(final)}`, policy) }], details: makeDetails("search")(results) };
	return { content: [{ type: "text", text: capModelVisibleText(`Flow search: ${rounds} round(s), beam ${beamWidth}, best score ${beam[0]?.score ?? 0}; finalized by ${debriefRef.agent}.${handoffWarnings.summary()}\n\n${sanitizeText(resultText(final), policy)}`) }], details: makeDetails("search")(results) };
}
