import type { DecompositionSubtask } from "./decomposition.ts";

/**
 * The dependency-graph walks over a Decomposition's subtasks: which subtasks
 * could run concurrently, and whether any dependency cycle exists. Split from
 * decomposition.ts on size alone — the validator (decomposition.ts) remains
 * the one place these answers become refusals, and nothing else reads them.
 */

/**
 * The subtasks that could run at the same time as some other subtask: those
 * that are dependency-independent of at least one peer. Neither being an
 * ancestor of the other is what makes two subtasks concurrent, because the wave
 * schedule releases a subtask as soon as its own dependencies succeed.
 *
 * The Decomposition is known acyclic before this runs, so the reachability walk
 * terminates.
 */
export function concurrentSubtasks(subtasks: readonly DecompositionSubtask[]): DecompositionSubtask[] {
	const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
	const reachable = new Map<string, Set<string>>();
	const dependenciesOf = (id: string): Set<string> => {
		const known = reachable.get(id);
		if (known) return known;
		const transitive = new Set<string>();
		reachable.set(id, transitive);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			transitive.add(dep);
			for (const inherited of dependenciesOf(dep)) transitive.add(inherited);
		}
		return transitive;
	};
	const ordered = (a: DecompositionSubtask, b: DecompositionSubtask) => dependenciesOf(a.id).has(b.id) || dependenciesOf(b.id).has(a.id);
	return subtasks.filter((subtask) => subtasks.some((peer) => peer !== subtask && !ordered(subtask, peer)));
}

/** The first dependency cycle, as the chain that closes it, or null when the Decomposition is acyclic. */
export function findCycle(subtasks: readonly DecompositionSubtask[]): string[] | null {
	const byId = new Map(subtasks.map((subtask) => [subtask.id, subtask]));
	const visiting = new Set<string>();
	const settled = new Set<string>();
	const path: string[] = [];
	const walk = (id: string): string[] | null => {
		if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
		if (settled.has(id)) return null;
		visiting.add(id);
		path.push(id);
		for (const dep of byId.get(id)?.dependsOn ?? []) {
			const cycle = walk(dep);
			if (cycle) return cycle;
		}
		path.pop();
		visiting.delete(id);
		settled.add(id);
		return null;
	};
	for (const subtask of subtasks) {
		const cycle = walk(subtask.id);
		if (cycle) return cycle;
	}
	return null;
}
