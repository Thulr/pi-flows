// Unit tests for the bash-ro vocabulary: the allowlist predicate, the toolset
// split, the env-marker convention, and the child-side tool_call registration.
// The spawn-path behavior (argv translation, env marker, fail-closed refusal)
// lives in tests/bash-readonly-integration.test.ts against the stub pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASH_READONLY_ENV, bashReadonlyEnabled, bashReadonlyEnforcement, bashReadonlyGitEnv, bashReadonlyRefusal, splitBashReadonly } from "../extensions/pi-flows/bash-readonly.ts";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import { bashReadonlyEnforcerArgs, registerBashReadonlyGuard } from "../extensions/pi-flows/bash-readonly-extension.ts";

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
	"git reflog",
	"git reflog show HEAD",
	"sort README.md",
	"uniq README.md",
	"uniq -f 2 README.md",
	"grep -o pattern README.md",
	"grep 'foo$' README.md",
	"grep 'foo[0-9]*' README.md",
	"git log --grep=\"fix bug\"",
	"date",
	"date -Iseconds",
	"date -u",
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
	"git reflog expire --expire=now --all",
	"git reflog delete HEAD@{0}",
	"sort --out=generated.txt README.md",
	"sort --output=generated.txt README.md",
	"sort --compress-program=./mutator -S 1b README.md",
	"sort --co=./mutator -S 1b README.md",
	"sort --comp=./mutator README.md",
	"sort --o generated.txt README.md",
	"git cat-file --filters HEAD:path",
	"git grep --textconv pattern",
	"git --config-env=diff.external=SHELL diff",
	"git grep -Ovi pattern",
	"git grep --open-files-in-pager=vi pattern",
	"sort -o generated.txt README.md",
	"sort -ogenerated.txt README.md",
	"sort -ro generated.txt README.md",
	"sort --output=generated.txt README.md",
	"uniq README.md deduped.txt",
	"uniq -f 2 README.md deduped.txt",
	"cat README.md | uniq - captured.txt",
	"date -s 2020-01-01",
	"date -s2020-01-01",
	"file -C -m magic",
	"file --compile -m magic",
	"rg --pre=sh pattern",
	"git diff --out\\put=escaped.patch",
	"git diff \"--output=quoted.patch\" HEAD~1",
	"git diff '--output=quoted.patch' HEAD~1",
	"git diff --output=$HOME/exfil.patch",
	"git log \"--output=$PWD/x\"",
	"find . -fls generated.txt",
	"cat README.md 2>/dev/nullx",
	"git diff --out{put,put}=generated.patch",
	"git diff * ",
	"cat *.md",
	"rg --hostname-bin=./mutating-script --hyperlink-format='file://{host}/{path}:{line}' pattern",
	"rg --pre sh pattern",
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

test("bashReadonlyEnforcement uses the sandbox first, then the allowlist fallback by default", () => {
	assert.equal(bashReadonlyEnforcement(true, true, false), "sandbox");
	assert.equal(bashReadonlyEnforcement(false, true, false), "sandbox");
	// Off the sandbox the allowlist is the default fallback...
	assert.equal(bashReadonlyEnforcement(true, false, false), "allowlist");
	// ...unless the caller requires the sandbox, or the enforcer can't load.
	assert.equal(bashReadonlyEnforcement(true, false, true), null);
	assert.equal(bashReadonlyEnforcement(false, false, false), null);
});

test("bashReadonlyGitEnv neutralizes repository-configured git exec helpers", () => {
	const env = bashReadonlyGitEnv();
	const count = Number(env.GIT_CONFIG_COUNT);
	const pairs = new Map<string, string>();
	for (let i = 0; i < count; i += 1) pairs.set(env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]);
	assert.equal(pairs.get("core.pager"), "cat");
	assert.equal(pairs.get("core.fsmonitor"), "false");
	assert.equal(pairs.get("core.hooksPath"), "/dev/null");
	// diff.external is deliberately NOT forced off: an empty value makes git try to exec "" and aborts the diff.
	assert.equal(pairs.has("diff.external"), false);
});

test("bashReadonlyEnabled follows the shared env truthiness convention", () => {
	for (const value of ["1", "true", "YES ", " True"]) assert.equal(bashReadonlyEnabled(value), true, value);
	for (const value of ["", "0", "no", undefined]) assert.equal(bashReadonlyEnabled(value as string | undefined), false, String(value));
});

test("splitBashReadonly maps bash-ro to bash and yields the marker only without plain bash", () => {
	assert.deepEqual(splitBashReadonly(["read", "bash-ro"]), { argvTools: ["read", "bash"], readonly: true, sandboxable: true });
	assert.deepEqual(splitBashReadonly(["bash", "bash-ro"]), { argvTools: ["bash"], readonly: false, sandboxable: false });
	assert.deepEqual(splitBashReadonly(["read", "grep"]), { argvTools: ["read", "grep"], readonly: false, sandboxable: false });
	assert.deepEqual(splitBashReadonly([]), { argvTools: [], readonly: false, sandboxable: false });
	// edit/write alongside bash-ro: the shell stays allowlist-restricted (never
	// silently unrestricted), but the process-wide sandbox is skipped so the
	// granted edit/write still works.
	for (const mutating of ["edit", "write"]) {
		const split = splitBashReadonly([mutating, "bash-ro"]);
		assert.equal(split.readonly, true, `${mutating}+bash-ro keeps the allowlist`);
		assert.equal(split.sandboxable, false, `${mutating}+bash-ro must not be sandboxed`);
		assert.deepEqual(split.argvTools, [mutating, "bash"]);
	}
});

function registerWithMarker(marker: string | undefined, register: (pi: any) => void = registerPiFlows) {
	const previous = process.env[BASH_READONLY_ENV];
	const handlers: Array<(event: any) => any> = [];
	try {
		if (marker === undefined) delete process.env[BASH_READONLY_ENV];
		else process.env[BASH_READONLY_ENV] = marker;
		register({
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

test("the standalone enforcer extension registers the same guard for -e loading", () => {
	assert.equal(registerWithMarker(undefined, registerBashReadonlyGuard).length, 0);
	const handlers = registerWithMarker("1", registerBashReadonlyGuard);
	assert.equal(handlers.length, 1);
	assert.equal(handlers[0]({ toolName: "bash", toolCallId: "t1", input: { command: "git push" } })?.block, true);
	assert.equal(handlers[0]({ toolName: "bash", toolCallId: "t2", input: { command: "git log" } }), undefined);
	// A non-string command is refused, never passed through unchecked.
	assert.equal(handlers[0]({ toolName: "bash", toolCallId: "t3", input: {} })?.block, true);
});

test("the enforcer argv names -e and an existing extension file", async () => {
	const [flag, entry] = bashReadonlyEnforcerArgs();
	assert.equal(flag, "-e");
	assert.match(entry, /bash-readonly-extension\.ts$/);
	const { access } = await import("node:fs/promises");
	await access(entry);
});
