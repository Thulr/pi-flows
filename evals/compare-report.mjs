const scoreText = (value) => Number.isFinite(value) ? value.toFixed(2) : "n/a";
const exclusionText = (arm) => {
	if (!arm.exclusion) return "";
	if (arm.exclusion.reason === "debug_budget") return `debug arm-timeout ${formatDuration(arm.timeoutPlan.effectiveTimeoutMs)} (case budget ${formatDuration(arm.timeoutPlan.caseTimeoutMs)})`;
	return arm.exclusion.detail;
};

function dimsByCase(evalRun) {
	const out = new Map();
	for (const c of evalRun.cases ?? []) out.set(c.case_id, c.dims ?? {});
	return out;
}

function duelWinner(outcome) {
	const normalized = String(outcome ?? "").toLowerCase();
	if (["wina", "win_a", "a"].includes(normalized)) return "plain";
	if (["winb", "win_b", "b"].includes(normalized)) return "flows";
	if (normalized === "flip") return "flip";
	return "tie";
}

function skippedDuelCases(report) {
	const skipped = new Map();
	for (const entry of report?.skipped ?? []) {
		if (Array.isArray(entry)) skipped.set(entry[0], entry[1] ?? "skipped");
		else if (entry?.case_id) skipped.set(entry.case_id, entry.reason ?? "skipped");
	}
	return skipped;
}

export const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "n/a");
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const fixed = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);
export const formatDuration = (ms) => ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
export const formatTokenCount = (n) => Math.round(n).toLocaleString("en-US");
export { scoreText };

export function formatTokenComparison(candidateLabel, candidate, baselineLabel, baseline) {
	const candidateText = candidate?.known ? formatTokenCount(candidate.total) : "n/a";
	const baselineText = baseline?.known ? formatTokenCount(baseline.total) : "n/a";
	const ratio = candidate?.known && baseline?.known && baseline.total > 0
		? `    (${(candidate.total / baseline.total).toFixed(1)}x baseline)`
		: "";
	return `tokens         ${candidateLabel} ${candidateText}    ${baselineLabel} ${baselineText}${ratio}`;
}

export function formatCostComparison(candidateLabel, candidateCost, candidateKnown, baselineLabel, baselineCost, baselineKnown) {
	const candidateText = candidateKnown ? `$${candidateCost.toFixed(4)}` : "n/a (model price unavailable)";
	const baselineText = baselineKnown ? `$${baselineCost.toFixed(4)}` : "n/a (model price unavailable)";
	const ratio = candidateKnown && baselineKnown && baselineCost > 0 ? `    (${(candidateCost / baselineCost).toFixed(1)}x baseline)` : "";
	return `est. cost      ${candidateLabel} ${candidateText}    ${baselineLabel} ${baselineText}${ratio}`;
}

export const aggregateTokenUsage = (rows, kind) => ({
	input: rows.reduce((total, row) => total + (row[kind].tokenUsage?.input ?? 0), 0),
	output: rows.reduce((total, row) => total + (row[kind].tokenUsage?.output ?? 0), 0),
	cacheRead: rows.reduce((total, row) => total + (row[kind].tokenUsage?.cacheRead ?? 0), 0),
	cacheWrite: rows.reduce((total, row) => total + (row[kind].tokenUsage?.cacheWrite ?? 0), 0),
	total: rows.reduce((total, row) => total + (row[kind].tokenUsage?.total ?? 0), 0),
	known: rows.every((row) => row[kind].tokenUsage?.known === true),
});

/**
 * A freshly-run arm, explicitly unjudged. Exactly one of applyJudgedRows,
 * dryRunJudgements, or markUnjudgedRows fills `dims`/`judged` in afterwards;
 * seeding them at construction means armLine, pickArm, and judgeDelta can never
 * read an undefined `judged` if a new code path forgets to call one of the three.
 */
export const unjudgedArm = () => ({ dims: {}, judged: { verdict: null, score: null } });

export function applyJudgedRows(rows, flowsRun, plainRun) {
	const flows = dimsByCase(flowsRun);
	const plain = dimsByCase(plainRun);
	for (const row of rows) {
		row.flows.dims = flows.get(row.name) ?? {};
		row.plain.dims = plain.get(row.name) ?? {};
		row.flows.judged = row.flowsTraceOk ? row.flows.dims.criterion ?? { verdict: false, score: 0 } : { verdict: null, score: null };
		row.plain.judged = row.plainTraceOk ? row.plain.dims.criterion ?? { verdict: false, score: 0 } : { verdict: null, score: null };
	}
}

export function dryRunJudgements(rows) {
	for (const row of rows) {
		row.flows.dims = { criterion: { verdict: row.flows.objective.pass, score: row.flows.objective.score ?? 0 } };
		row.plain.dims = { criterion: { verdict: row.plain.objective.pass, score: row.plain.objective.score ?? 0 } };
		row.flows.judged = row.flows.exclusion ? { verdict: null, score: null } : row.flows.dims.criterion;
		row.plain.judged = row.plain.exclusion ? { verdict: null, score: null } : row.plain.dims.criterion;
	}
}

export function markUnjudgedRows(rows) {
	for (const row of rows) {
		row.flows.dims = {};
		row.plain.dims = {};
		row.flows.judged = { verdict: null, score: null };
		row.plain.judged = { verdict: null, score: null };
	}
}

export function armLine(label, arm) {
	const excluded = arm.exclusion ? `  EXCLUDED ${arm.exclusion.reason}: ${exclusionText(arm)}` : "";
	const judgeScore = arm.exclusion ? "n/a" : Number.isFinite(arm.judged?.score) ? arm.judged.score.toFixed(2) : "n/a";
	const objScore = arm.exclusion ? "n/a" : scoreText(arm.objective.score ?? 0);
	const cost = arm.costKnown === true ? `$${arm.cost.toFixed(4)}` : "cost n/a";
	const tokens = arm.tokenUsage?.known ? `${formatTokenCount(arm.tokenUsage.total)} tok` : "tokens n/a";
	return `   ${label}  judge ${judgeScore}${arm.judged?.verdict === false ? "!" : ""}  obj ${objScore}${!arm.exclusion && arm.objective.pass ? "" : arm.exclusion ? "" : "!"}  ${cost}  ${tokens}  ${(arm.durationMs / 1000).toFixed(1)}s${excluded}`;
}

export const pickArm = (a) => ({
	arm: a.arm ?? null,
	dims: a.dims ?? {},
	judgePass: a.judged?.verdict ?? null,
	judgeScore: a.judged?.score ?? null,
	objPass: a.exclusion ? null : a.objective.pass,
	objScore: a.exclusion ? null : a.objective.score,
	cost: a.cost,
	costKnown: a.costKnown === true,
	tokens: a.tokenUsage,
	generatedTokens: a.tokenUsage?.known ? a.tokenUsage.output : null,
	durationMs: a.durationMs,
	workerTimeMs: a.workerTimeMs,
	infra: a.reachedModel ?? null,
	excluded: a.exclusion ?? null,
	debugBudget: a.timeoutPlan?.debugBudget ?? false,
	timeoutMs: a.timeoutPlan?.effectiveTimeoutMs ?? null,
	caseBudgetMs: a.timeoutPlan?.caseTimeoutMs ?? null,
	attempts: a.attempts ?? 1,
	task: a.task,
	model: a.modelName,
	workspaceSnapshotId: a.workspaceSnapshotId,
	answer: a.exclusion ? "" : (a.answer ?? "").slice(0, 1000),
	evidence: {
		objective: a.objective?.notes ?? null,
		answer: a.exclusion ? "" : (a.answer ?? "").slice(0, 4000),
	},
});

const judgeScore = (arm) => arm.judged?.score ?? 0;

/**
 * The signed judge-score lift for one case (flows minus baseline), or null when
 * the pair is inconclusive — only rows where BOTH arms produced judgeable output
 * can be compared, so one excluded arm makes the whole row unusable.
 */
export const judgeDelta = (row) => (row.flowsTraceOk && row.plainTraceOk ? judgeScore(row.flows) - judgeScore(row.plain) : null);

/**
 * Every headline number in the A/B summary, in one pass over the rows.
 *
 * Quality numbers (means, criterion passes, per-case wins) come from comparable
 * rows only; efficiency numbers (cost, tokens, wall-clock) come from ALL rows,
 * because an arm that burned tokens and then failed still cost real money. A
 * per-case delta under 0.001 is a tie, not a win — judge noise is larger than that.
 */
export function comparisonTotals(rows) {
	const qualityRows = rows.filter((row) => row.flowsTraceOk && row.plainTraceOk);
	return {
		qualityRows,
		flowsJudgeMean: mean(qualityRows.map((row) => judgeScore(row.flows))),
		plainJudgeMean: mean(qualityRows.map((row) => judgeScore(row.plain))),
		flowsCriterionPasses: qualityRows.filter((row) => row.flows.judged?.verdict === true).length,
		plainCriterionPasses: qualityRows.filter((row) => row.plain.judged?.verdict === true).length,
		wins: qualityRows.filter((row) => judgeDelta(row) > 0.001).length,
		losses: qualityRows.filter((row) => -judgeDelta(row) > 0.001).length,
		flowsCost: rows.reduce((total, row) => total + row.flows.cost, 0),
		plainCost: rows.reduce((total, row) => total + row.plain.cost, 0),
		flowsTokens: aggregateTokenUsage(rows, "flows"),
		plainTokens: aggregateTokenUsage(rows, "plain"),
		flowsSeconds: rows.reduce((total, row) => total + row.flows.durationMs, 0) / 1000,
		plainSeconds: rows.reduce((total, row) => total + row.plain.durationMs, 0) / 1000,
		flowsCostKnown: rows.every((row) => row.flows.costKnown === true),
		baselineCostKnown: rows.every((row) => row.plain.costKnown === true),
	};
}

export function exclusionSummary(rows) {
	const count = (kind, reason) => rows.filter((row) => row[kind].exclusion?.reason === reason).length;
	return {
		flows: { infra: count("flows", "infra"), debug_budget: count("flows", "debug_budget") },
		plain: { infra: count("plain", "infra"), debug_budget: count("plain", "debug_budget") },
		pair_inconclusive: rows.filter((row) => !row.flowsTraceOk || !row.plainTraceOk).length,
	};
}

export function applyDuelRows(rows, duelReport) {
	const byCase = new Map((duelReport?.cases ?? []).map((item) => [item.case_id, item]));
	const skipped = skippedDuelCases(duelReport);
	for (const row of rows) {
		const item = byCase.get(row.name);
		if (item) {
			row.duel = { ...item, winner: duelWinner(item.outcome) };
		} else if (skipped.has(row.name)) {
			row.duel = { outcome: "skipped", winner: "skipped", reason: skipped.get(row.name) };
		} else {
			row.duel = null;
		}
	}
}

export function duelQualitySummary(rows) {
	const qualityRows = rows.filter((row) => row.duel && row.duel.winner !== "skipped");
	const count = (winner) => qualityRows.filter((row) => row.duel?.winner === winner).length;
	return {
		decided: qualityRows.length,
		flows: count("flows"),
		plain: count("plain"),
		ties: count("tie"),
		flips: count("flip"),
		skipped: rows.filter((row) => row.duel?.winner === "skipped").length,
	};
}
