// Model-sizing predicates for selection-case shapes. Kept out of the main
// scorer so its general topology matcher stays below the repository line cap.
export function taskTierShapeMismatch(tasks, actualMode, expectedTiers) {
	if (expectedTiers === undefined) return null;
	const actual = actualMode === "parallel" && Array.isArray(tasks)
		? tasks.map((task) => typeof task?.tier === "string" ? task.tier : "(omitted)").sort()
		: [];
	const expected = [...expectedTiers].sort();
	return actual.length === expected.length && actual.every((tier, index) => tier === expected[index])
		? null
		: `expected parallel task tiers ${expected.join(",")}, saw ${actual.join(",") || "none"}`;
}
