// Terminal provider errors: a child that reports a fatal provider error
// (assistant message_end with stopReason "error" + errorMessage, e.g. a
// context-window overflow) and then stalls must be terminated after the error
// grace (PI_FLOWS_ERROR_GRACE_MS) instead of hanging until timeoutMs.
// Runs against the stub pi — see tests/stub-harness.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "./stub-harness.ts";

test("a child that stalls after a terminal provider error is terminated with CHILD_PROVIDER_ERROR", async () => {
	// The stub emits an error-shaped assistant message and then holds the
	// process open. The runner must terminate it at the error grace, not wait
	// for holdOpenMs or timeoutMs.
	process.env.PI_FLOWS_ERROR_GRACE_MS = "250";
	try {
		const startedAt = Date.now();
		const { result, text } = await runFlow(
			{ agent: "analyst", task: "research ways to solve gh issue 302" },
			{
				analyst: {
					reply: "partial notes before the provider gave up",
					stopReason: "error",
					errorMessage: "Codex error: Your input exceeds the context window of this model.",
					holdOpenMs: 60_000,
				},
			},
		);
		assert.ok(Date.now() - startedAt < 30_000, "flow must end at the error grace, not holdOpenMs");
		const run = result.details.results[0];
		assert.equal(run.error?.code, "CHILD_PROVIDER_ERROR");
		assert.equal(run.stopReason, "error");
		assert.notEqual(run.exitCode, 0);
		// The tokens the child burned before dying stay visible to the ledger.
		assert.equal(run.usage.cost, 0.0001);
		assert.match(text, /CHILD_PROVIDER_ERROR/);
		assert.match(text, /context window/);
	} finally {
		delete process.env.PI_FLOWS_ERROR_GRACE_MS;
	}
});

test("the provider-error grace re-arms when trailing events precede the stall", async () => {
	// A non-message event (e.g. agent_end) lands AFTER the terminal error, then
	// the child stalls. The grace must restart from that event — not be
	// permanently disarmed by it.
	process.env.PI_FLOWS_ERROR_GRACE_MS = "250";
	try {
		const startedAt = Date.now();
		const { result } = await runFlow(
			{ agent: "analyst", task: "research ways to solve gh issue 302" },
			{
				analyst: {
					reply: "partial notes",
					stopReason: "error",
					errorMessage: "Codex error: Your input exceeds the context window of this model.",
					extraEvents: [{ delayMs: 100, event: { type: "agent_end" } }],
					holdOpenMs: 60_000,
				},
			},
		);
		assert.ok(Date.now() - startedAt < 30_000, "flow must end at the re-armed grace, not holdOpenMs");
		assert.equal(result.details.results[0].error?.code, "CHILD_PROVIDER_ERROR");
	} finally {
		delete process.env.PI_FLOWS_ERROR_GRACE_MS;
	}
});
