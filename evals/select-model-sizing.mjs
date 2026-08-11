// Model-sizing predicates for selection-case shapes. Kept out of the main
// scorer so its general topology matcher stays below the repository line cap.
const TIERS = new Set(["fast", "capable", "deep"]);

export function tieredTaskShapeIssues(label, expected) {
	if (expected === undefined) return [];
	if (!Array.isArray(expected) || expected.length === 0) return [`${label}.tieredTasks must be a non-empty array`];
	return expected.flatMap((item, index) => {
		const itemLabel = `${label}.tieredTasks[${index}]`;
		if (!item || typeof item !== "object" || Array.isArray(item)) return [`${itemLabel} must be an object`];
		const issues = [];
		if (!TIERS.has(item.tier)) issues.push(`${itemLabel}.tier must be fast, capable, or deep`);
		if (typeof item.taskPattern !== "string" || item.taskPattern === "") issues.push(`${itemLabel}.taskPattern must be a non-empty string`);
		else try { new RegExp(item.taskPattern, "i"); } catch { issues.push(`${itemLabel}.taskPattern must be a valid regex`); }
		for (const key of Object.keys(item)) if (!["tier", "taskPattern"].includes(key)) issues.push(`${itemLabel}.${key} is unknown`);
		return issues;
	});
}

export function tieredTaskShapeMismatch(tasks, actualMode, expected) {
	if (expected === undefined) return null;
	const actual = actualMode === "parallel" && Array.isArray(tasks) ? [...tasks] : [];
	if (actual.length !== expected.length) return `expected ${expected.length} tier-bound parallel tasks, saw ${actual.length}`;
	for (const item of expected) {
		const match = actual.findIndex((task) => task?.tier === item.tier && new RegExp(item.taskPattern, "i").test(typeof task?.task === "string" ? task.task : ""));
		if (match === -1) return `expected a ${item.tier} parallel task matching /${item.taskPattern}/i`;
		actual.splice(match, 1);
	}
	return null;
}
