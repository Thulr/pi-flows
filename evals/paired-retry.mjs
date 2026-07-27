const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryableInfrastructureFailure = (arm) => arm.exclusion?.reason === "infra"
	&& arm.tokensTotal === 0
	&& arm.cost === 0
	&& !/timeout|timed out|aborted/i.test(arm.exclusion.detail ?? "");

const withRetryTotals = (arm, attempts, durationMs, workerTimeMs) => ({
	...arm,
	attempts,
	durationMs,
	workerTimeMs,
});

export function deadlineExpiredArm(prior, { timeoutPlan, task, modelName, snapshotId }) {
	const exclusion = {
		reason: timeoutPlan.debugBudget ? "debug_budget" : "infra",
		detail: `${timeoutPlan.debugBudget ? "debug " : ""}arm deadline expired after ${timeoutPlan.effectiveTimeoutMs}ms (case budget ${timeoutPlan.caseTimeoutMs}ms)`,
	};
	const objective = { pass: false, score: 0, inconclusive: true, notes: exclusion.detail };
	if (prior) return { ...prior, objective, exclusion };
	const tokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, known: false };
	return {
		dims: {},
		judged: { verdict: null, score: null },
		objective,
		reachedModel: null,
		cost: 0,
		answer: "",
		exclusion,
		timeoutPlan,
		result: undefined,
		task,
		modelName,
		reportedModels: [],
		workspaceSnapshotId: snapshotId,
		tokensTotal: 0,
		tokenUsage,
		costKnown: false,
		deadlineExcludedMs: 0,
	};
}

export async function runArmWithRetry({
	runAttempt,
	freshWorkspace,
	maxRetries,
	retryDelayMs,
	timeoutMs,
	now = () => performance.now(),
	wait = sleep,
	onRetry = () => undefined,
	onDeadline = ({ arm }) => arm,
}) {
	let arm;
	const startedAt = now();
	let deadlineExcludedMs = 0;
	let workerTimeMs = 0;
	const elapsedMs = () => Math.max(0, now() - startedAt - deadlineExcludedMs);
	const deadlineResult = (attempts) => withRetryTotals(onDeadline({ arm, attempts }), attempts, elapsedMs(), workerTimeMs);
	for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
		if (timeoutMs - elapsedMs() <= 0) return deadlineResult(attempt - 1);
		const workspace = freshWorkspace(attempt);
		const remainingMs = timeoutMs - elapsedMs();
		if (remainingMs <= 0) return deadlineResult(attempt - 1);
		arm = await runAttempt({ attempt, timeoutMs: remainingMs, workspace });
		deadlineExcludedMs += Number.isFinite(arm.deadlineExcludedMs) ? arm.deadlineExcludedMs : 0;
		workerTimeMs += Number.isFinite(arm.workerTimeMs) ? arm.workerTimeMs : 0;
		if (!retryableInfrastructureFailure(arm) || attempt > maxRetries) {
			return withRetryTotals(arm, attempt, elapsedMs(), workerTimeMs);
		}
		onRetry({ arm, attempt, maxRetries });
		if (retryDelayMs >= timeoutMs - elapsedMs()) {
			return withRetryTotals(arm, attempt, elapsedMs(), workerTimeMs);
		}
		await wait(retryDelayMs);
	}
	return withRetryTotals(arm, maxRetries + 1, elapsedMs(), workerTimeMs);
}
