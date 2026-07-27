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

export async function runArmWithRetry({
	runAttempt,
	freshWorkspace,
	maxRetries,
	retryDelayMs,
	timeoutMs,
	now = () => performance.now(),
	wait = sleep,
	onRetry = () => undefined,
}) {
	let arm;
	const startedAt = now();
	let deadlineExcludedMs = 0;
	let workerTimeMs = 0;
	const elapsedMs = () => Math.max(0, now() - startedAt - deadlineExcludedMs);
	for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
		if (timeoutMs - elapsedMs() <= 0) return withRetryTotals(arm, attempt - 1, elapsedMs(), workerTimeMs);
		const workspace = freshWorkspace(attempt);
		const remainingMs = timeoutMs - elapsedMs();
		if (remainingMs <= 0) return withRetryTotals(arm, attempt - 1, elapsedMs(), workerTimeMs);
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
