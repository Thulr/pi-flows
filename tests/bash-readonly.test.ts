// Unit tests for the bash-ro vocabulary: the allowlist predicate, the toolset
// split, the env-marker convention, and the child-side tool_call registration.
// The spawn-path behavior (argv translation, env marker, fail-closed refusal)
// lives in tests/bash-readonly-integration.test.ts against the stub pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASH_READONLY_ENV, bashReadonlyEnabled, bashReadonlyRefusal, splitBashReadonly } from "../extensions/pi-flows/bash-readonly.ts";
import registerPiFlows from "../extensions/pi-flows/index.ts";

const ALLOWED = [
	"git log --oneline -5",
	"git diff main...HEAD -- src/",
	"git blame -L 1,20 extensions/pi-flows/flow.ts",
	"git rev-parse HEAD",
	"git branch --list",
	"git tag -l",
	"git remote -v",
	"git status && git diff | head -50 ; wc -l README.md",
	"find . -name '*.ts'",
	"grep -rn parseToolsOverride extensions",
	"cat README.md 2>/dev/null",
	"git log 2>&1",
	"npm test",
	"npm run typecheck",
	"node --test tests/pi-flows.test.ts",
];

const REFUSED = [
	"git push",
	"git commit -m x",
	"git checkout .",
	"git branch new-branch",
	"git tag v1.0.0",
	"git -c core.pager=touch log",
	"git log -o /tmp/out",
	"git diff --output=exfil",
	"rm -rf .",
	"git log > out.txt",
	"echo hi | tee captured.txt",
	"git log $(rm -rf .)",
	"git log `id`",
	"find . -delete",
	"find . -exec rm {} \\;",
	"sed -i s/a/b/ file",
	"GIT_PAGER=touch git log",
	"ls; npm install",
	"npm ci",
	"npm install",
	"node scripts/anything.mjs",
	"npx cowsay",
	"env sh -c 'rm -rf .'",
	"",
	"   ",
];

test("bash-ro allowlist accepts read-only inspection and verification commands", () => {
	for (const command of ALLOWED) {
		assert.equal(bashReadonlyRefusal(command), null, `expected allowed: ${command}`);
	}
});

test("bash-ro allowlist refuses mutation, redirection, substitution, and launchers with a reason", () => {
	for (const command of REFUSED) {
		const reason = bashReadonlyRefusal(command);
		assert.ok(reason, `expected refusal: ${command}`);
		assert.match(reason, /bash-ro blocked/);
	}
});

test("bash-ro refusal names the offending segment, not just the whole command", () => {
	const reason = bashReadonlyRefusal("git status; npm install");
	assert.ok(reason);
	assert.match(reason, /npm/);
	assert.doesNotMatch(reason.split(":")[0] + reason.split(":")[1], /git status/);
});

test("bashReadonlyEnabled follows the shared env truthiness convention", () => {
	for (const value of ["1", "true", "YES ", " True"]) assert.equal(bashReadonlyEnabled(value), true, value);
	for (const value of ["", "0", "no", undefined]) assert.equal(bashReadonlyEnabled(value as string | undefined), false, String(value));
});

test("splitBashReadonly maps bash-ro to bash and yields the marker only without plain bash", () => {
	assert.deepEqual(splitBashReadonly(["read", "bash-ro"]), { argvTools: ["read", "bash"], readonly: true });
	assert.deepEqual(splitBashReadonly(["bash", "bash-ro"]), { argvTools: ["bash"], readonly: false });
	assert.deepEqual(splitBashReadonly(["read", "grep"]), { argvTools: ["read", "grep"], readonly: false });
	assert.deepEqual(splitBashReadonly([]), { argvTools: [], readonly: false });
});

function registerWithMarker(marker: string | undefined) {
	const previous = process.env[BASH_READONLY_ENV];
	const handlers: Array<(event: any) => any> = [];
	try {
		if (marker === undefined) delete process.env[BASH_READONLY_ENV];
		else process.env[BASH_READONLY_ENV] = marker;
		registerPiFlows({
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on: (event: string, handler: (event: any) => any) => {
				if (event === "tool_call") handlers.push(handler);
			},
		} as any);
	} finally {
		if (previous === undefined) delete process.env[BASH_READONLY_ENV];
		else process.env[BASH_READONLY_ENV] = previous;
	}
	return handlers;
}

test("the extension registers a blocking tool_call handler only when the marker is set", () => {
	assert.equal(registerWithMarker(undefined).length, 0);
	assert.equal(registerWithMarker("").length, 0);

	const handlers = registerWithMarker("1");
	assert.equal(handlers.length, 1);
	const handler = handlers[0];
	const blocked = handler({ toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /bash-ro blocked/);
	assert.equal(handler({ toolName: "bash", toolCallId: "t2", input: { command: "git log --oneline" } }), undefined);
	assert.equal(handler({ toolName: "read", toolCallId: "t3", input: { path: "x" } }), undefined);
});
