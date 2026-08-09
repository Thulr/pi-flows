// Offline integration tests for the bash-ro spawn path against the stub pi:
// argv translation, the env marker (including the explicit clear that stops
// grandchild inheritance), and the SHARED_WRITE_CWD interplay. These run with
// the OS sandbox opted out (PI_FLOWS_BASH_RO_NO_SANDBOX): the stub writes its
// calls.jsonl into the child cwd, which a real read-only-checkout sandbox
// would (correctly) block — the sandbox's own behavior is covered directly in
// tests/bash-readonly-sandbox.test.ts, and the enforcement decision in
// tests/bash-readonly.test.ts. The allowlist predicate lives there too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFlow } from "./stub-harness.ts";

// The stub harness opts out of the OS sandbox (it writes calls.jsonl into cwd);
// these tests therefore exercise the argv/marker/allowlist path. The sandbox
// itself is covered in tests/bash-readonly-sandbox.test.ts.
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
	// The enforcer is loaded explicitly: a checkout parent's children re-run
	// the pi entrypoint without its -e flags, so discovery alone can miss it.
	const enforcer = calls[0].args[calls[0].args.indexOf("-e") + 1] ?? "";
	assert.match(enforcer, /bash-readonly-extension\.ts$/);
});

test("bash-ro alongside edit still gets the allowlist enforcer, never a bare shell", async () => {
	const { calls } = await runFlow(
		{ agent: "operator", task: "fix it", tools: "read,edit,bash-ro" },
		{ operator: "FIXED" },
	);
	assert.equal(calls.length, 1);
	const toolsFlag = calls[0].args[calls[0].args.indexOf("--tools") + 1];
	assert.ok(toolsFlag.split(",").includes("edit"), `edit must survive: ${toolsFlag}`);
	assert.ok(toolsFlag.split(",").includes("bash"), `bash-ro must translate to bash: ${toolsFlag}`);
	// The bug this pins: translating bash-ro to bash without the marker/enforcer
	// would silently hand the child an unrestricted shell.
	assert.equal(calls[0].env.PI_FLOWS_BASH_READONLY, "1");
	assert.match(calls[0].args[calls[0].args.indexOf("-e") + 1] ?? "", /bash-readonly-extension\.ts$/);
});

test("bash-ro: plain-tools children do not load the enforcer", async () => {
	const { calls } = await runFlow({ agent: "recon", task: "plain scan", tools: "read,grep,find,ls,bash" }, { recon: "SCANNED" });
	assert.equal(calls[0].args.includes("-e"), false);
});

test("bash-ro: a parent's marker is cleared for children whose toolset never asked for it", async () => {
	await withEnv("PI_FLOWS_BASH_READONLY", "1", async () => {
		const { calls } = await runFlow({ agent: "recon", task: "plain read-only scan" }, { recon: "SCANNED" });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].env.PI_FLOWS_BASH_READONLY, "", "the spread of process.env must not leak the marker into grandchildren");
	});
});

test("bash-ro: child extensions disabled still spawns — the -e enforcer survives --no-extensions", async () => {
	// pi drops only *discovered* extensions under --no-extensions; an explicit
	// -e still loads, so the allowlist enforcer is present and the child is
	// enforced. (Refusal now needs neither sandbox nor enforcer available, which
	// is covered as a pure decision in tests/bash-readonly.test.ts.)
	await withEnv("PI_FLOWS_CHILD_NO_EXTENSIONS", "1", async () => {
		const { calls } = await runFlow(
			{ agent: "recon", task: "review", tools: "read,grep,find,ls,bash-ro" },
			{ recon: "REVIEWED" },
		);
		assert.equal(calls.length, 1);
		assert.ok(calls[0].args.includes("--no-extensions"));
		const enforcer = calls[0].args[calls[0].args.indexOf("-e") + 1] ?? "";
		assert.match(enforcer, /bash-readonly-extension\.ts$/);
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
