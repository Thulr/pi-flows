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

test("a terminal provider error followed by a prompt non-zero exit is CHILD_PROVIDER_ERROR", async () => {
	// The sibling of the stalled case above: the child does the normal thing and
	// exits on its own right after reporting the provider failure. That must not
	// fall through to the generic exit-code branch — CHILD_EXIT_NONZERO with an
	// empty stderr replaces the one actionable diagnostic the run produced.
	const { result, text } = await runFlow(
		{ agent: "analyst", task: "research ways to solve gh issue 302" },
		{
			analyst: {
				reply: "partial notes before provider failure",
				stopReason: "error",
				errorMessage: "Provider error: input exceeds this model context window.",
				exitCode: 1,
			},
		},
	);
	const run = result.details.results[0];
	assert.equal(run.error?.code, "CHILD_PROVIDER_ERROR", `prompt provider exit was misclassified as ${run.error?.code}: ${run.error?.cause ?? ""}`);
	assert.equal(run.stopReason, "error");
	assert.match(run.error?.message ?? "", /context window/, "the provider's diagnostic must survive into the structured error");
	// The cause must be truthful: this child exited promptly; pi-flows never
	// terminated a stalled process.
	assert.doesNotMatch(run.error?.cause ?? "", /stalled|terminated it/i, "must not claim a grace-period termination that never happened");
	assert.equal(run.usage.cost, 0.0001, "usage accrued before the failure stays on the ledger");
	assert.match(text, /CHILD_PROVIDER_ERROR/);
	assert.match(text, /context window/);
});

test("a healthy later turn clears the terminal-error state, so an unrelated exit stays CHILD_EXIT_NONZERO", async () => {
	// Recovery is real: a later error-free assistant turn proves the provider
	// error was not terminal, and a subsequent unrelated non-zero exit must keep
	// its generic classification.
	const { result } = await runFlow(
		{ agent: "analyst", task: "research ways to solve gh issue 302" },
		{
			analyst: {
				reply: "first attempt died",
				stopReason: "error",
				errorMessage: "Provider error: transient overload.",
				exitCode: 3,
				extraEvents: [{
					delayMs: 50,
					event: {
						type: "message_end",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "recovered and finished the task" }],
							usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 }, totalTokens: 20 },
							model: "stub-model",
							stopReason: "endTurn",
						},
					},
				}],
			},
		},
	);
	const run = result.details.results[0];
	assert.equal(run.error?.code, "CHILD_EXIT_NONZERO", "a recovered child's later exit is not a provider error");
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
