import { test } from "node:test";
import assert from "node:assert/strict";
import { runArmWithRetry } from "../evals/paired-retry.mjs";

test("infrastructure retries use fresh workspaces and one outer deadline", async () => {
	let clock = 0;
	const attemptTimeouts: number[] = [];
	const workspaces: string[] = [];
	const waits: number[] = [];
	const arm = await runArmWithRetry({
		maxRetries: 1,
		retryDelayMs: 10,
		timeoutMs: 100,
		now: () => clock,
		wait: async (ms) => {
			waits.push(ms);
			clock += 12;
		},
		freshWorkspace: (attempt) => {
			if (attempt > 1) clock += 2;
			return { cwd: `attempt-${attempt}` };
		},
		onRetry: () => { clock += 1; },
		runAttempt: async ({ attempt, timeoutMs, workspace }) => {
			attemptTimeouts.push(timeoutMs);
			workspaces.push(workspace.cwd);
			if (attempt === 1) {
				clock += 85;
				return { exclusion: { reason: "infra", detail: "startup failed" }, tokensTotal: 0, cost: 0, durationMs: 80, workerTimeMs: 80, deadlineExcludedMs: 5 };
			}
			clock += timeoutMs + 5;
			return { exclusion: null, tokensTotal: 10, cost: 0.1, durationMs: timeoutMs, workerTimeMs: timeoutMs, deadlineExcludedMs: 5 };
		},
	});

	assert.deepEqual(workspaces, ["attempt-1", "attempt-2"]);
	assert.deepEqual(waits, [10]);
	assert.deepEqual(attemptTimeouts, [100, 5]);
	assert.equal(arm.attempts, 2);
	assert.equal(arm.durationMs, 100);
	assert.equal(arm.workerTimeMs, 85);
});
