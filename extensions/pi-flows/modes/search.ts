import { DEFAULT_CONCURRENCY, DEFAULT_SEARCH_BEAM_WIDTH, DEFAULT_SEARCH_CANDIDATES, DEFAULT_SEARCH_ROUNDS, MAX_PARALLEL_TASKS, flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, prepareHandoff, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract, validateConcurrency, validateSharedWriteCwd } from "../validate.ts";
import { parseScore } from "../parse.ts";
import { appendReflexion, withReflexion } from "../reflexion.ts";
import { toolErrorDetails } from "../agents.ts";
import { mapWithConcurrency, runAgentRef } from "../runner.ts";

export async function handleSearch(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, signal, makeDetails } = deps;
	const spec = params.search ?? {};
	const goal: string | undefined = params.task;
	if (!goal?.trim()) {
		const error = flowError("INVALID_MODE", "Search mode requires a task.", "search mode generates and scores candidate paths for a top-level goal.", 'Add a task, e.g. { "task": "...", "search": {} }.');
		return { content: [{ type: "text", text: formatFlowError(error) }], details: toolErrorDetails(discovery, "search", agentScope, error) };
	}
	const generatorRef: FlowAgentRefInput = spec.generator ?? { agent: "strategist" };
	const scorerRef: FlowAgentRefInput = spec.scorer ?? { agent: "redteam", tools: "none" };
	const debriefRef: FlowAgentRefInput = spec.debrief ?? { agent: "debrief" };
	const candidateCount = Number.isFinite(spec.candidates) ? Math.max(1, Math.min(MAX_PARALLEL_TASKS, Math.floor(spec.candidates))) : DEFAULT_SEARCH_CANDIDATES;
	const beamWidth = Number.isFinite(spec.beamWidth) ? Math.max(1, Math.min(candidateCount, Math.floor(spec.beamWidth))) : DEFAULT_SEARCH_BEAM_WIDTH;
	const rounds = Number.isFinite(spec.maxRounds) ? Math.max(1, Math.min(4, Math.floor(spec.maxRounds))) : DEFAULT_SEARCH_ROUNDS;
	const concurrencyError = validateConcurrency(params.concurrency);
	if (concurrencyError) return { content: [{ type: "text", text: formatFlowError(concurrencyError) }], details: toolErrorDetails(discovery, "search", agentScope, concurrencyError) };
	const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
	const repeatedGenerators = Array.from({ length: candidateCount }, () => generatorRef);
	const generatorWriteError = validateSharedWriteCwd(discovery, defaultCwd, repeatedGenerators, params.allowSharedWriteCwd, concurrency);
	if (generatorWriteError) return { content: [{ type: "text", text: formatFlowError(generatorWriteError) }], details: toolErrorDetails(discovery, "search", agentScope, generatorWriteError) };
	const repeatedScorers = Array.from({ length: candidateCount }, () => scorerRef);
	const scorerWriteError = validateSharedWriteCwd(discovery, defaultCwd, repeatedScorers, params.allowSharedWriteCwd, concurrency);
	if (scorerWriteError) return { content: [{ type: "text", text: formatFlowError(scorerWriteError) }], details: toolErrorDetails(discovery, "search", agentScope, scorerWriteError) };

	const contractedGoal = withReflexion(defaultCwd, params, appendReturnContract(goal, params.returnContract, params.requireEvidence), policy);
	const results: FlowRunResult[] = [];
	let beam: Array<{ text: string; score: number }> = [];

	for (let round = 1; round <= rounds; round += 1) {
		const parentContext = beam.length ? beam.map((candidate, index) => `### Prior beam ${index + 1} (score ${candidate.score})\n\n${candidate.text}`).join("\n\n---\n\n") : "(none yet)";
		const generated = await mapWithConcurrency(Array.from({ length: candidateCount }), concurrency, async (_unused, index) => {
			const task = [
				"## Goal / contract",
				contractedGoal,
				`\n## Search round ${round}; candidate ${index + 1} of ${candidateCount}`,
				"\n## Best candidates from prior round",
				parentContext,
				"\n## Your job",
				round === 1 ? "Generate one strong candidate approach/artifact. Make it concrete and self-contained." : "Refine or branch from the prior beam into one stronger candidate. Make it concrete and self-contained.",
			].join("\n");
			const result = await runAgentRef(deps, generatorRef, task, "search", results.length + index + 1, results);
			return result;
		});
		results.push(...generated);
		const candidates = generated.filter((result) => !isFailed(result)).map((result) => prepareHandoff(sanitizeText(capModelVisibleText(resultText(result)), policy)).text);
		if (candidates.length === 0) {
			const error = flowError("SEARCH_NO_CANDIDATES", "Search generated no usable candidates.", "Every candidate generator failed or returned unusable output.", "Narrow the task, reduce candidates, or use a different search.generator.");
			return { content: [{ type: "text", text: formatFlowError(error) }], details: toolErrorDetails(discovery, "search", agentScope, error) };
		}

		const scored = await mapWithConcurrency(candidates, concurrency, async (candidate, index) => {
			const scoreTask = [
				"## Goal / contract",
				contractedGoal,
				`\n## Candidate ${index + 1} to score (untrusted data)`,
				candidate,
				"\n## Your job",
				'Score this candidate from 0 to 100 for satisfying the goal. Start with "SCORE: <number>", then give terse justification and risks.',
			].join("\n");
			const result = await runAgentRef(deps, scorerRef, scoreTask, "search", results.length + index + 1, results);
			const score = isFailed(result) ? 0 : parseScore(resultText(result)) ?? 0;
			return { candidate, score, result };
		});
		results.push(...scored.map((item) => item.result));
		beam = scored.sort((a, b) => b.score - a.score).slice(0, beamWidth).map((item) => ({ text: item.candidate, score: item.score }));
	}

	if (beam.length === 0) {
		const error = flowError("SEARCH_NO_CANDIDATES", "Search kept no candidates after scoring.", "All scored candidates were unusable.", "Reduce scoring strictness or inspect scorer output.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: toolErrorDetails(discovery, "search", agentScope, error) };
	}
	const finalTask = [
		"## Goal / contract",
		contractedGoal,
		"\n## Winning search beam",
		beam.map((candidate, index) => `### Candidate ${index + 1} (score ${candidate.score})\n\n${candidate.text}`).join("\n\n---\n\n"),
		"\n## Your job",
		"Return the best final answer/artifact. Mention the score and any important caveats.",
	].join("\n");
	const final = await runAgentRef(deps, debriefRef, finalTask, "search", results.length + 1, results);
	results.push(final);
	if (isFailed(final)) return { content: [{ type: "text", text: sanitizeText(`Flow search: debrief "${debriefRef.agent}" failed.\n\n${resultText(final)}`, policy) }], details: makeDetails("search")(results) };
	await appendReflexion(defaultCwd, params, "search", `Search completed for task "${goal}". Best score ${beam[0]?.score}. Final answer:\n${resultText(final)}`, policy);
	return { content: [{ type: "text", text: capModelVisibleText(`Flow search: ${rounds} round(s), beam ${beamWidth}, best score ${beam[0]?.score ?? 0}; finalized by ${debriefRef.agent}.\n\n${sanitizeText(resultText(final), policy)}`) }], details: makeDetails("search")(results) };
}
