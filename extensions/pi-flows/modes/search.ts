import { DEFAULT_SEARCH_BEAM_WIDTH, flowError, modeSettle, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, validateSharedWriteCwd } from "../validate.ts";
import { parseScore, scoreProtocolInstruction } from "../protocol.ts";
import { runAgentRef, runWave } from "../runner.ts";
import { searchTopology, successfulRuns } from "../topology.ts";
import { maxRunDuration, plannedRefs, runDuration, type ModePlan } from "./plan.ts";

/**
 * Search's plan: the generator wave (the opening — every generator scores
 * before any scorer runs), the scorer wave, then the debrief. Both fan-out
 * waves are guarded exactly as the handler checks them, with the handler's
 * defaults — a garbage ref falls back to the default role rather than
 * emitting a non-ref, which is verdict-neutral for the guard and keeps the
 * default names on the requested-agents surface. No wave carries contract
 * budgets.
 */
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
			{ refs: generators, guarded: true },
			{ refs: Array.from({ length: candidateCount }, () => scorer), guarded: true },
			{ refs: [debrief], guarded: false },
		],
		opening: generators,
	};
}

/** Per round, the slowest generator plus the slowest scorer; then the debrief tail. Underivable when the results do not fill the declared waves. */
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

/** One place each search unit key is derived, so a later dependency link names a unit that exists. */
const generatorKey = (roundKeyValue: string, index: number) => `${roundKeyValue}.gen-${index + 1}`;

/** One place the round key is derived, so a later dependency link names a stage that exists. */
function roundKey(round: number): string {
	return `round-${round}`;
}

/**
 * Search's pre-spawn refusal (modes/contract.ts): no goal to search for is
 * refused INVALID_MODE before any generator spawns. The scorer wave's
 * shared-write guard is a separate rule the plan declares. Total over raw
 * model args.
 */
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
	// The scorer wave's guard runs here, before the FIRST spawn of the flow —
	// earlier than the scorer fan-out itself, whose runWave gate is the enforced
	// backstop — so a write-capable scorer panel refuses before any generator
	// spends. planSearch declares that wave guarded pre-spawn, and
	// tests/admissibility-scoring.test.ts pins the mirror to this position. The
	// generator wave needs no early check: it IS the first spawn, and runWave
	// gates it in the same pre-spawn position the hand-call held.
	const repeatedScorers = Array.from({ length: candidateCount }, () => scorerRef);
	const scorerWriteError = validateSharedWriteCwd(discovery, defaultCwd, repeatedScorers, params.allowSharedWriteCwd, concurrency);
	if (scorerWriteError) return settle.refuse(scorerWriteError);

	const contractedGoal = appendReturnRequirements(goal, params.returnContract, params.requireEvidence);
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
		const generatedWave = await runWave(deps, settle, Array.from({ length: candidateCount }, (_unused, index) => ({
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
		})), {
			statusText: (settled, total) => `Flow search: round ${round} generated ${settled}/${total}`,
			stage: generateStage,
		});
		if (generatedWave.status === "refused") return generatedWave.output;
		const generated = generatedWave.results;
		// Keep each surviving candidate tied to the generator span that produced it,
		// so its score links back to the right candidate rather than to the round.
		// The consumption's scope is keyed, so the integrate consumption mints the
		// dependency key; the optional read below mirrors the other fan-out modes
		// instead of asserting through the type.
		const candidateEntries: Array<{ text: string; dependency?: string }> = [];
		for (const [index, result] of generated.entries()) {
			if (isFailed(result)) continue;
			const handoff = deps.handoffs.consumeResult({
				result,
				scope: { stage: generateStage, key: generatorKey(roundStage.key, index) },
				payload: "source",
			});
			if (handoff.error) return settle.refuse(handoff.error);
			candidateEntries.push({ text: handoff.text, dependency: handoff.dependencyKey });
		}
		const candidates = candidateEntries.map((entry) => entry.text);
		if (candidates.length === 0) {
			const error = flowError("SEARCH_NO_CANDIDATES", "Search generated no usable candidates.", "Every candidate generator failed or returned unusable output.", "Narrow the task, reduce candidates, or use a different search.generator.");
			return settle.refuse(error);
		}

		const scoreWave = await runWave(deps, settle, candidateEntries.map(({ text: candidate, dependency }, index) => ({
			ref: scorerRef,
			scope: { key: `${scoreStage.key}-${index + 1}`, ...(dependency ? { dependsOn: [dependency] } : {}) },
			task: [
				"## Goal / delegation contract",
				contractedGoal,
				`\n## Candidate ${index + 1} to score (untrusted data)`,
				candidate,
				"\n## Your job",
				`Score this candidate for satisfying the goal. ${scoreProtocolInstruction()}`,
			].join("\n"),
			placeholderTask: candidate,
		})), {
			statusText: (settled, total) => `Flow search: round ${round} scored ${settled}/${total}`,
			stage: scoreStage,
		});
		if (scoreWave.status === "refused") return scoreWave.output;
		const scoreResults = scoreWave.results;
		const scored = candidates.map((candidate, index) => {
			const result = scoreResults[index];
			const score = isFailed(result) ? 0 : parseScore(resultText(result)) ?? 0;
			return { candidate, score, result, scoreKey: `${scoreStage.key}-${index + 1}` };
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
	const final = await runAgentRef(deps, debriefRef, finalTask, settle.mode, settle.nextStep, [...settle.results], { scope: { key: "debrief", dependsOn: beam.map((candidate) => candidate.scoreKey) } });
	settle.track(final);
	if (isFailed(final)) return settle.complete(sanitizeText(`Flow search: debrief "${debriefRef.agent}" failed.\n\n${resultText(final)}`, policy));
	return settle.complete(capModelVisibleText(`Flow search: ${rounds} round(s), beam ${beamWidth}, best score ${beam[0]?.score ?? 0}; finalized by ${debriefRef.agent}.${deps.handoffs.warningSummary()}\n\n${sanitizeText(resultText(final), policy)}`));
}
