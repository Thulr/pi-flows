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
	wait = sleep,
	onRetry = () => undefined,
}) {
	let arm;
	let durationMs = 0;
	let workerTimeMs = 0;
	for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
		const remainingMs = timeoutMs - durationMs;
		if (remainingMs <= 0) return withRetryTotals(arm, attempt - 1, durationMs, workerTimeMs);
		arm = await runAttempt({ attempt, timeoutMs: remainingMs, workspace: freshWorkspace(attempt) });
		durationMs += Number.isFinite(arm.durationMs) ? arm.durationMs : 0;
		workerTimeMs += Number.isFinite(arm.workerTimeMs) ? arm.workerTimeMs : 0;
		if (!retryableInfrastructureFailure(arm) || attempt > maxRetries) {
			return withRetryTotals(arm, attempt, durationMs, workerTimeMs);
		}
		onRetry({ arm, attempt, maxRetries });
		if (retryDelayMs >= timeoutMs - durationMs) {
			return withRetryTotals(arm, attempt, durationMs, workerTimeMs);
		}
		await wait(retryDelayMs);
		durationMs += retryDelayMs;
	}
	return withRetryTotals(arm, maxRetries + 1, durationMs, workerTimeMs);
}
