export const MAX_SUBJECT_TRIALS = 50;

export function trialIdentity(caseId, trialIndex, subjectTrials) {
	const trialId = `${caseId}::trial-${String(trialIndex).padStart(3, "0")}`;
	return {
		caseId,
		trialId,
		traceCaseId: subjectTrials === 1 ? caseId : trialId,
		trialIndex,
	};
}

/** Wilson 95% score interval. Shared with calibration so every confidence bound in the harness is computed the same way. */
export function wilson95(successes, samples) {
	if (samples === 0) return null;
	const z = 1.96;
	const rate = successes / samples;
	const z2 = z * z;
	const denominator = 1 + z2 / samples;
	const center = (rate + z2 / (2 * samples)) / denominator;
	const margin = (z / denominator) * Math.sqrt((rate * (1 - rate) + z2 / (4 * samples)) / samples);
	return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function drawProbability(successes, samples, k, target) {
	if (k < 1 || samples < k) return null;
	let probability = 1;
	for (let index = 0; index < k; index += 1) {
		const favorable = target === "all-success" ? successes - index : samples - successes - index;
		if (favorable <= 0) return target === "all-success" ? 0 : 1;
		probability *= favorable / (samples - index);
	}
	return target === "all-success" ? probability : 1 - probability;
}

function binaryReliability(trials, k) {
	const samples = trials.length;
	const successes = trials.filter((trial) => trial.pass).length;
	return {
		samples,
		successes,
		failures: samples - successes,
		passAt1: {
			value: samples ? successes / samples : null,
			confidence95: wilson95(successes, samples),
		},
		passAtK: { k, value: drawProbability(successes, samples, k, "any-success") },
		passToK: { k, value: drawProbability(successes, samples, k, "all-success") },
	};
}

function percentile(values, quantile, minimumSamples) {
	const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
	if (sorted.length < minimumSamples) return null;
	const position = (sorted.length - 1) * quantile;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function distribution(trials, field) {
	const values = trials.map((trial) => trial[field]).filter(Number.isFinite);
	return {
		samples: values.length,
		p50: percentile(values, 0.5, 2),
		p95: percentile(values, 0.95, 20),
	};
}

function caseReliability(caseId, trials, subjectTrials) {
	const nominalTrials = trials.filter((trial) => !trial.exclusion);
	const sensitivityTrials = trials.map((trial) => ({ ...trial, pass: !trial.exclusion && trial.pass }));
	return {
		caseId,
		trials,
		nominal: binaryReliability(nominalTrials, subjectTrials),
		sensitivityInvalidAsFailure: binaryReliability(sensitivityTrials, subjectTrials),
		latencyMs: distribution(nominalTrials, "durationMs"),
		costUsd: distribution(nominalTrials, "costUsd"),
	};
}

function portfolioReliability(cases, field, pooledTrials, k) {
	const pooled = binaryReliability(pooledTrials, k);
	const averageCaseMetric = (metric) => {
		const values = cases.map((entry) => entry[field][metric].value).filter((value) => value !== null);
		return { k, value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, supportedCases: values.length };
	};
	return { ...pooled, passAtK: averageCaseMetric("passAtK"), passToK: averageCaseMetric("passToK") };
}

export function buildReliabilityReport(rawTrials, { subjectTrials, judgeSamples, generatedAt = new Date().toISOString(), runId, runtimeTraceFile }) {
	const byCase = new Map();
	for (const trial of rawTrials) byCase.set(trial.caseId, [...(byCase.get(trial.caseId) ?? []), trial]);
	const cases = [...byCase.entries()].map(([caseId, trials]) => caseReliability(caseId, trials, subjectTrials));
	const nominalTrials = rawTrials.filter((trial) => !trial.exclusion);
	const sensitivityTrials = rawTrials.map((trial) => ({ ...trial, pass: !trial.exclusion && trial.pass }));
	return {
		schemaVersion: "pi-flows.reliability.v1",
		generatedAt,
		runId: runId ?? null,
		runtimeTraceFile: runtimeTraceFile ?? null,
		subjectTrials,
		judgeSamples,
		cases,
		overall: {
			nominal: portfolioReliability(cases, "nominal", nominalTrials, subjectTrials),
			sensitivityInvalidAsFailure: portfolioReliability(cases, "sensitivityInvalidAsFailure", sensitivityTrials, subjectTrials),
			latencyMs: distribution(nominalTrials, "durationMs"),
			costUsd: distribution(nominalTrials, "costUsd"),
		},
	};
}

const rate = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const metric = (value, suffix) => value === null ? "n/a" : `${value.toFixed(suffix === "ms" ? 0 : 4)}${suffix}`;

export function formatReliabilitySummary(report) {
	const { nominal, sensitivityInvalidAsFailure: sensitivity, latencyMs, costUsd } = report.overall;
	return [
		`Subject reliability: pass@1 ${rate(nominal.passAt1.value)} (95% CI ${nominal.passAt1.confidence95 ? `${rate(nominal.passAt1.confidence95.lower)}–${rate(nominal.passAt1.confidence95.upper)}` : "n/a"}); pass@${nominal.passAtK.k} ${rate(nominal.passAtK.value)}; pass^${nominal.passToK.k} ${rate(nominal.passToK.value)}`,
		`Sensitivity (infrastructure-invalid trials count as failures): pass@1 ${rate(sensitivity.passAt1.value)}; pass@${sensitivity.passAtK.k} ${rate(sensitivity.passAtK.value)}; pass^${sensitivity.passToK.k} ${rate(sensitivity.passToK.value)}`,
		`Latency: p50 ${metric(latencyMs.p50, "ms")}  p95 ${metric(latencyMs.p95, "ms")}  Cost: p50 ${metric(costUsd.p50, " USD")}  p95 ${metric(costUsd.p95, " USD")}`,
	];
}
