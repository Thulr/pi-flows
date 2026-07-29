import { canonicalDigest } from "./calibration-key.mjs";

const MODES = ["parallel", "chain", "evaluate", "vote", "route", "orchestrate", "graph", "loop", "search", "workflow", "worktree", "debate", "dossier", "monitor"];

function modeOf(params) {
	if (params?.agent) return "single";
	return MODES.find((mode) => params?.[mode]) ?? "unknown";
}

export function buildEvaluationProvenance(cases, summaries, {
	capUsd,
	timeoutMs,
	armTimeoutMs,
	subjectTrials,
	judgeModel,
	suiteName = "release",
} = {}) {
	const subjects = [...new Set(summaries.map((summary) => summary.model).filter(Boolean))].sort();
	return {
		models: { subjects, judge: judgeModel },
		topology: {
			arm: "flows",
			cases: Object.fromEntries(cases.map((entry) => [entry.name, {
				mode: modeOf(entry.params),
				paramsDigest: canonicalDigest(entry.params, 64),
			}])),
		},
		budgets: {
			subjectTrials,
			defaultMaxCostUsd: capUsd,
			defaultTimeoutMs: timeoutMs,
			armTimeoutMs,
			cases: Object.fromEntries(cases.map((entry) => [entry.name, {
				maxCostUsd: entry.params.maxCostUsd ?? capUsd,
				timeoutMs: Math.min(entry.timeoutMs ?? timeoutMs, armTimeoutMs ?? Number.POSITIVE_INFINITY),
			}])),
		},
		suite: { name: suiteName, caseIds: cases.map((entry) => entry.name).sort() },
	};
}
