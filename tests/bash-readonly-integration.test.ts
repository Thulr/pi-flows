// Offline integration tests for the bash-ro spawn path against the stub pi:
// argv translation, the env marker (including the explicit clear that stops
// grandchild inheritance), the fail-closed refusal when child extensions are
// disabled, and the SHARED_WRITE_CWD interplay. The allowlist predicate's
// unit tests live in tests/bash-readonly.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "./stub-harness.ts";

function withEnv(name: string, value: string | undefined, run: () => Promise<void>) {
	const previous = process.env[name];
	const restore = () => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	};
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	return run().finally(restore);
}

test("bash-ro: child argv carries bash and the env marker, never the raw token", async () => {
	const { calls } = await runFlow(
		{ agent: "recon", task: "review the change set", tools: "read,grep,find,ls,bash-ro" },
		{ recon: "REVIEWED" },
	);

	assert.equal(calls.length, 1);
	const toolsFlag = calls[0].args[calls[0].args.indexOf("--tools") + 1];
	assert.ok(toolsFlag.split(",").includes("bash"), `--tools should include bash: ${toolsFlag}`);
	assert.ok(!toolsFlag.includes("bash-ro"), `--tools must not leak bash-ro to pi: ${toolsFlag}`);
	assert.equal(calls[0].env.PI_FLOWS_BASH_READONLY, "1");
});

test("bash-ro: a parent's marker is cleared for children whose toolset never asked for it", async () => {
	await withEnv("PI_FLOWS_BASH_READONLY", "1", async () => {
		const { calls } = await runFlow({ agent: "recon", task: "plain read-only scan" }, { recon: "SCANNED" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].env.PI_FLOWS_BASH_READONLY, "", "the spread of process.env must not leak the marker into grandchildren");
	});
});

test("bash-ro: refused fail-closed when child extensions are disabled", async () => {
	await withEnv("PI_FLOWS_CHILD_NO_EXTENSIONS", "1", async () => {
		const refused = await runFlow(
			{ agent: "recon", task: "review", tools: "read,grep,find,ls,bash-ro" },
			{ recon: "should not run" },
		);
		assert.equal(refused.calls.length, 0, "an unenforceable bash-ro child must never spawn");
		assert.equal(refused.result.details.results[0]?.error?.code, "BASH_READONLY_UNENFORCEABLE");

		const plainBash = await runFlow(
			{ agent: "recon", task: "review", tools: "read,grep,find,ls,bash" },
			{ recon: "RAN" },
		);
		assert.equal(plainBash.calls.length, 1, "plain bash is unaffected by the extension isolation");
	});
});

test("bash-ro: two bash-ro reviewers share a cwd at concurrency 2 without SHARED_WRITE_CWD", async () => {
	const { result, calls } = await runFlow(
		{
			tasks: [
				{ agent: "recon", task: "standards review", tools: "read,grep,find,ls,bash-ro" },
				{ agent: "recon", task: "spec review", tools: "read,grep,find,ls,bash-ro" },
			],
			concurrency: 2,
		},
		{ recon: "REVIEWED" },
	);

	assert.equal(result.details.error, undefined);
	assert.equal(calls.length, 2);
	for (const call of calls) assert.equal(call.env.PI_FLOWS_BASH_READONLY, "1");
});
