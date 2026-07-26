import { DEFAULT_DEBATE_ROUNDS, DEFAULT_SEARCH_CANDIDATES, DEFAULT_SEARCH_ROUNDS, MAX_DEBATE_ROUNDS, MAX_PARALLEL_TASKS, type FlowRunResult } from "./types.ts";
import { isFailed } from "./sanitize.ts";

export function debateRounds(spec: any): number {
	return Number.isFinite(spec?.rounds) ? Math.max(1, Math.min(MAX_DEBATE_ROUNDS, Math.floor(spec.rounds))) : DEFAULT_DEBATE_ROUNDS;
}

export function searchTopology(spec: any): { candidateCount: number; rounds: number } {
	const candidateCount = Number.isFinite(spec?.candidates) ? Math.max(1, Math.min(MAX_PARALLEL_TASKS, Math.floor(spec.candidates))) : DEFAULT_SEARCH_CANDIDATES;
	const rounds = Number.isFinite(spec?.maxRounds) ? Math.max(1, Math.min(4, Math.floor(spec.maxRounds))) : DEFAULT_SEARCH_ROUNDS;
	return { candidateCount, rounds };
}

export function successfulRuns(results: FlowRunResult[]): FlowRunResult[] {
	return results.filter((result) => !isFailed(result));
}
