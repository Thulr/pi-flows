// Offline tests for the SHARED_WRITE_CWD refusal message (issue #82): the
// refusal must attribute write-capability to each agent's effective toolset —
// so a name-only retry is visibly futile — and its remediation must lead with
// the recoveries that preserve read-only intent, listing allowSharedWriteCwd
// last. The guard's firing conditions are covered in pi-flows.test.ts and
// integration.test.ts; nothing here changes when it fires.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../extensions/pi-flows/index.ts";

async function makeTempRepo() {
	const dir = path.join(tmpdir(), `pi-flows-swg-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(path.join(dir, ".pi", "flow-agents"), { recursive: true });
	return dir;
}

test("refusal names the tool that classified a read-only agent with a bash override", async () => {
	const repo = await makeTempRepo();
	const discovery = __test.discoverFlowAgents(repo, "user");
	const refs = [
		{ agent: "recon", tools: "read,grep,bash" },
		{ agent: "recon", tools: "read,grep,bash" },
	];
	const error = __test.validateSharedWriteCwd(discovery, repo, refs, false, 4);
	assert.equal(error?.code, "SHARED_WRITE_CWD");
	// The transcript in #82 switched overwatch -> recon and was refused again for
	// the same reason; the message must say the reason is bash, not the name.
	assert.match(error?.cause ?? "", /recon \(effective tools include bash\)/);
	assert.match(error?.cause ?? "", /agent name changes nothing|toolset is what classifies/i);
});

test("refusal renders omitted tools explicitly as pi defaults", async () => {
	const repo = await makeTempRepo();
	const discovery = __test.discoverFlowAgents(repo, "user");
	const error = __test.validateSharedWriteCwd(discovery, repo, [{ agent: "operator" }, { agent: "operator" }], false, 4);
	assert.equal(error?.code, "SHARED_WRITE_CWD");
	assert.match(error?.cause ?? "", /operator \(effective tools are pi defaults, which include bash\/edit\/write\)/);
});

test("remediation names concurrency:1 first and allowSharedWriteCwd last", async () => {
	const repo = await makeTempRepo();
	const discovery = __test.discoverFlowAgents(repo, "user");
	const error = __test.validateSharedWriteCwd(discovery, repo, [{ agent: "overwatch" }, { agent: "overwatch" }], false, 2);
	assert.equal(error?.code, "SHARED_WRITE_CWD");
	const fix = error?.fix ?? "";
	assert.match(fix, /concurrency:1/);
	assert.match(fix, /allowSharedWriteCwd:true/);
	assert.ok(
		fix.indexOf("concurrency:1") < fix.indexOf("allowSharedWriteCwd:true"),
		"serialization must be offered before the bypass",
	);
	assert.match(fix, /last resort/);
});

test("write-capability attribution covers override, bundled, defaulted, and read-only toolsets", async () => {
	const repo = await makeTempRepo();
	const discovery = __test.discoverFlowAgents(repo, "user");
	assert.equal(
		__test.writeCapabilityReason(discovery, { agent: "recon", tools: "read,grep,bash" }),
		"recon (effective tools include bash)",
	);
	assert.equal(
		__test.writeCapabilityReason(discovery, { agent: "overwatch" }),
		"overwatch (effective tools include bash)",
	);
	// Both an omitted tools field and an explicit tools:"default" resolve to pi
	// defaults; the message must not claim omission for the explicit form.
	assert.equal(
		__test.writeCapabilityReason(discovery, { agent: "operator" }),
		"operator (effective tools are pi defaults, which include bash/edit/write)",
	);
	assert.equal(
		__test.writeCapabilityReason(discovery, { agent: "operator", tools: "default" }),
		"operator (effective tools are pi defaults, which include bash/edit/write)",
	);
	// Unreachable through the guard (non-mutating refs are filtered first), but
	// the exported helper must still tell the truth for a read-only toolset.
	assert.equal(
		__test.writeCapabilityReason(discovery, { agent: "recon" }),
		"recon (not write-capable by its effective tools)",
	);
	// bash-ro is bash under a child-enforced allowlist; the attribution must
	// name the token so a reader sees why a shell-carrying role passed.
	assert.equal(
		__test.writeCapabilityReason(discovery, { agent: "recon", tools: "read,grep,find,ls,bash-ro" }),
		"recon (not write-capable: bash-ro is bash under a child-enforced read-only allowlist)",
	);
	// Carrying plain bash alongside bash-ro is write-capable: bash wins.
	assert.equal(
		__test.writeCapabilityReason(discovery, { agent: "recon", tools: "bash,bash-ro" }),
		"recon (effective tools include bash)",
	);
});

test("guard verdicts are unchanged: same accepts and refusals as before the message change", async () => {
	const repo = await makeTempRepo();
	const discovery = __test.discoverFlowAgents(repo, "user");
	// Refusal: concurrent writers sharing one checkout.
	assert.equal(__test.validateSharedWriteCwd(discovery, repo, [{ agent: "operator" }, { agent: "operator" }], false, 4)?.code, "SHARED_WRITE_CWD");
	// Accepts: read-only fan-out, serialized writers, isolated cwds, explicit override.
	assert.equal(__test.validateSharedWriteCwd(discovery, repo, [{ agent: "recon" }, { agent: "recon" }], false, 4), null);
	// bash-ro fan-out is admissible: the allowlist is enforced in the child.
	assert.equal(__test.validateSharedWriteCwd(discovery, repo, [{ agent: "overwatch", tools: "read,grep,find,ls,bash-ro" }, { agent: "overwatch", tools: "read,grep,find,ls,bash-ro" }], false, 4), null);
	assert.equal(__test.validateSharedWriteCwd(discovery, repo, [{ agent: "operator" }, { agent: "operator" }], false, 1), null);
	assert.equal(__test.validateSharedWriteCwd(discovery, repo, [{ agent: "operator", cwd: "wt-a" }, { agent: "operator", cwd: "wt-b" }], false, 4), null);
	assert.equal(__test.validateSharedWriteCwd(discovery, repo, [{ agent: "operator" }, { agent: "operator" }], true, 4), null);
});
