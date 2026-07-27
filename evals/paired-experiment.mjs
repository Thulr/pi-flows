export const BINDING_CONSTRAINT_KINDS = ["cost", "generated_tokens", "deadline"];

export function parseBindingConstraint(raw, defaultDeadlineMs) {
	const declaration = raw ?? `deadline:${defaultDeadlineMs}`;
	const [kind, valueText, ...extra] = String(declaration).split(":");
	const value = Number(valueText);
	if (!BINDING_CONSTRAINT_KINDS.includes(kind) || extra.length > 0 || !Number.isFinite(value) || value <= 0) {
		throw new Error("--constraint must be cost|generated_tokens|deadline:<positive value>");
	}
	return {
		kind,
		value,
		unit: kind === "cost" ? "USD" : kind === "generated_tokens" ? "tokens" : "ms",
		source: raw === null ? "default" : "cli",
	};
}

export function parsePromotionRule(improvementMargin, nonInferiorityMargin) {
	if (improvementMargin !== null && nonInferiorityMargin !== null) {
		throw new Error("choose only one promotion margin: --improvement-margin or --non-inferiority-margin");
	}
	const raw = improvementMargin ?? nonInferiorityMargin;
	if (raw === null) return null;
	const margin = Number(raw);
	if (!Number.isFinite(margin) || margin < 0) {
		throw new Error("promotion margins must be non-negative numbers");
	}
	return {
		kind: improvementMargin !== null ? "improvement" : "non_inferiority",
		margin,
	};
}

function constraintObservation(arm, constraint) {
	if (constraint.kind === "cost") return { known: arm.costKnown !== false, value: arm.cost };
	if (constraint.kind === "generated_tokens") return { known: arm.tokenUsage?.known === true, value: arm.tokenUsage?.output };
	return { known: Number.isFinite(arm.durationMs), value: arm.durationMs };
}

export function evaluateBindingConstraint(arm, constraint) {
	const observed = constraintObservation(arm, constraint);
	const status = !observed.known ? "unknown" : observed.value <= constraint.value ? "within" : "exceeded";
	return { status, observed: observed.known ? observed.value : null, limit: constraint.value, unit: constraint.unit };
}

export function evaluatePairConstraint(flows, baseline, constraint) {
	const flowStatus = evaluateBindingConstraint(flows, constraint);
	const baselineStatus = evaluateBindingConstraint(baseline, constraint);
	return {
		kind: constraint.kind,
		pairEligible: !flows.exclusion && !baseline.exclusion && flowStatus.status === "within" && baselineStatus.status === "within",
		flows: flowStatus,
		baseline: baselineStatus,
	};
}

export function armExecutionTiming(result, durationMs) {
	const childDurations = (result?.details?.results ?? []).map((child) => child?.durationMs).filter(Number.isFinite);
	return {
		durationMs,
		workerTimeMs: childDurations.length > 0 ? childDurations.reduce((total, value) => total + value, 0) : durationMs,
	};
}

const T95 = [null, null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045];
const round = (value) => value === null ? null : Number(value.toFixed(12));
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function confidence95(values) {
	if (values.length < 2) return null;
	const mean = average(values);
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
	const critical = T95[values.length] ?? 1.96;
	const margin = critical * Math.sqrt(variance / values.length);
	return { lower: round(mean - margin), upper: round(mean + margin) };
}

function clusteredPairedDelta(rows, field, unit) {
	const pairs = rows.flatMap((row) => {
		if (!row.comparable) return [];
		const flows = field(row.flows);
		const baseline = field(row.baseline);
		return Number.isFinite(flows) && Number.isFinite(baseline) ? [{ caseId: row.caseId, flows, baseline, delta: flows - baseline }] : [];
	});
	const byCase = new Map();
	for (const pair of pairs) byCase.set(pair.caseId, [...(byCase.get(pair.caseId) ?? []), pair]);
	const clusters = [...byCase.values()].map((entries) => ({
		flows: average(entries.map((entry) => entry.flows)),
		baseline: average(entries.map((entry) => entry.baseline)),
		delta: average(entries.map((entry) => entry.delta)),
	}));
	return {
		method: "case-clustered paired mean with 95% t interval",
		unit,
		pairedRows: pairs.length,
		caseClusters: clusters.length,
		flowsMean: clusters.length ? round(average(clusters.map((cluster) => cluster.flows))) : null,
		baselineMean: clusters.length ? round(average(clusters.map((cluster) => cluster.baseline))) : null,
		meanDelta: clusters.length ? round(average(clusters.map((cluster) => cluster.delta))) : null,
		confidence95: confidence95(clusters.map((cluster) => cluster.delta)),
	};
}

function binomialCoefficient(n, k) {
	let value = 1;
	for (let index = 1; index <= k; index += 1) value = (value * (n - index + 1)) / index;
	return value;
}

function exactSignP(positive, negative) {
	const nonTies = positive + negative;
	if (nonTies === 0) return 1;
	const tail = Math.min(positive, negative);
	let probability = 0;
	for (let successes = 0; successes <= tail; successes += 1) {
		probability += binomialCoefficient(nonTies, successes) * (0.5 ** nonTies);
	}
	return round(Math.min(1, probability * 2));
}

function pairedReliability(rows) {
	const valid = rows.filter((row) => row.comparable && typeof row.flows.judgePass === "boolean" && typeof row.baseline.judgePass === "boolean");
	const passed = (arm) => arm.judgePass === true && arm.objPass === true;
	const byCase = new Map();
	for (const row of valid) {
		const delta = Number(passed(row.flows)) - Number(passed(row.baseline));
		byCase.set(row.caseId, [...(byCase.get(row.caseId) ?? []), delta]);
	}
	const caseDeltas = [...byCase.values()].map(average);
	const flowsFavoredCases = caseDeltas.filter((delta) => delta > 0).length;
	const baselineFavoredCases = caseDeltas.filter((delta) => delta < 0).length;
	const tiedCases = caseDeltas.length - flowsFavoredCases - baselineFavoredCases;
	return {
		...clusteredPairedDelta(valid, (arm) => passed(arm) ? 1 : 0, "pass-rate"),
		analysis: "case-clustered paired binary sign test",
		caseSignTest: {
			flowsFavoredCases,
			baselineFavoredCases,
			tiedCases,
			nonTiedCases: flowsFavoredCases + baselineFavoredCases,
			exactTwoSidedP: exactSignP(flowsFavoredCases, baselineFavoredCases),
		},
	};
}

function metricSet(rows) {
	return {
		quality: clusteredPairedDelta(rows, (arm) => arm.judgeScore, "judge-score"),
		reliability: pairedReliability(rows),
		costUsd: clusteredPairedDelta(rows, (arm) => arm.costKnown === false ? null : arm.cost, "USD"),
		generatedTokens: clusteredPairedDelta(rows, (arm) => arm.generatedTokens, "tokens"),
		totalTokens: clusteredPairedDelta(rows, (arm) => arm.tokens?.known === true ? arm.tokens.total : null, "tokens"),
		endToEndLatencyMs: clusteredPairedDelta(rows, (arm) => arm.durationMs, "ms"),
		workerTimeMs: clusteredPairedDelta(rows, (arm) => arm.workerTimeMs, "ms"),
	};
}

function groupedMetrics(rows, field) {
	const groups = new Map();
	for (const row of rows) {
		const key = row[field] ?? "unspecified";
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => [key, metricSet(group)]));
}

function invalidRunCounts(rows) {
	const armCounts = (arm) => ({
		excluded: rows.filter((row) => row[arm].excluded).length,
		constraint: rows.filter((row) => row.constraint?.[arm]?.status !== "within").length,
	});
	return {
		pairs: rows.filter((row) => !row.comparable).length,
		flows: armCounts("flows"),
		baseline: armCounts("baseline"),
	};
}

function promotionOutcome(quality, rule) {
	if (!rule) return { rule: null, threshold: null, decision: "not_requested" };
	const threshold = rule.kind === "improvement" ? rule.margin : -rule.margin;
	const lower = quality.confidence95?.lower;
	return {
		rule,
		threshold,
		decision: lower === undefined || lower === null ? "insufficient_evidence" : lower >= threshold ? "promote" : "do_not_promote",
	};
}

export function buildPairedAnalysis(rawRows, promotionRule = null) {
	const overall = metricSet(rawRows);
	return {
		overall,
		slices: {
			bySuite: groupedMetrics(rawRows, "suite"),
			byTaskFamily: groupedMetrics(rawRows, "taskFamily"),
		},
		invalidRuns: invalidRunCounts(rawRows),
		promotion: promotionOutcome(overall.quality, promotionRule),
	};
}

function formatDelta(label, metric) {
	const interval = metric.confidence95 ? `[${metric.confidence95.lower}, ${metric.confidence95.upper}]` : "n/a";
	return `  ${label}: delta ${metric.meanDelta ?? "n/a"} ${metric.unit}; 95% CI ${interval}; ${metric.pairedRows} pairs / ${metric.caseClusters} cases`;
}

export function formatPairedAnalysis(analysis) {
	const { overall, invalidRuns, promotion } = analysis;
	const lines = [
		"Paired case-clustered analysis",
		formatDelta("quality", overall.quality),
		formatDelta("reliability", overall.reliability),
		`  reliability case sign test: flows-favored ${overall.reliability.caseSignTest.flowsFavoredCases}, baseline-favored ${overall.reliability.caseSignTest.baselineFavoredCases}, ties ${overall.reliability.caseSignTest.tiedCases}, exact p ${overall.reliability.caseSignTest.exactTwoSidedP}`,
		formatDelta("cost", overall.costUsd),
		formatDelta("generated tokens", overall.generatedTokens),
		formatDelta("total tokens", overall.totalTokens),
		formatDelta("end-to-end latency", overall.endToEndLatencyMs),
		formatDelta("worker time", overall.workerTimeMs),
		`  invalid runs: ${invalidRuns.pairs} pairs; flows exclusions ${invalidRuns.flows.excluded}, constraint ${invalidRuns.flows.constraint}; baseline exclusions ${invalidRuns.baseline.excluded}, constraint ${invalidRuns.baseline.constraint}`,
		`  slices: suites ${Object.keys(analysis.slices.bySuite).join(", ") || "none"}; task families ${Object.keys(analysis.slices.byTaskFamily).join(", ") || "none"}`,
	];
	if (promotion.rule) lines.push(`  promotion (${promotion.rule.kind}, margin ${promotion.rule.margin}): ${promotion.decision}; threshold ${promotion.threshold}`);
	return lines;
}
