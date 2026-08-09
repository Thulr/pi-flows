// Tests for the OS-level read-only-checkout sandbox. The profile builder and
// wrap shape are checked everywhere; the security property (a write into the
// checkout is denied at the kernel while reads and out-of-tree writes work) is
// exercised for real on darwin, where sandbox-exec exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildReadonlyProfile, readonlySandboxAvailable, readonlySandboxDisabled, wrapWithReadonlySandbox } from "../extensions/pi-flows/bash-readonly-sandbox.ts";

const run = promisify(execFile);

test("buildReadonlyProfile denies writes under the checkout and escapes the path", () => {
	const profile = buildReadonlyProfile("/some/checkout");
	assert.match(profile, /\(allow default\)/);
	assert.match(profile, /\(deny file-write\* \(subpath "\/some\/checkout"\)\)/);
	assert.match(buildReadonlyProfile('/w"x\\y'), /subpath "\/w\\"x\\\\y"/);
});

test("buildReadonlyProfile also denies extra paths (a linked worktree's git dir)", () => {
	const profile = buildReadonlyProfile("/wt", ["/main/.git/worktrees/wt"]);
	assert.match(profile, /subpath "\/wt"/);
	assert.match(profile, /subpath "\/main\/.git\/worktrees\/wt"/);
});

test("readonlySandboxDisabled follows the shared env truthiness convention", () => {
	for (const v of ["1", "true", "YES "]) assert.equal(readonlySandboxDisabled(v), true, v);
	for (const v of ["", "0", "no", undefined]) assert.equal(readonlySandboxDisabled(v as string | undefined), false, String(v));
});

test("wrapWithReadonlySandbox returns null off-darwin and a sandbox-exec invocation on it", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "sb-wrap-"));
	try {
		const wrapped = await wrapWithReadonlySandbox("/bin/echo", ["hi"], dir);
		if (!readonlySandboxAvailable()) {
			assert.equal(wrapped, null);
			return;
		}
		assert.ok(wrapped);
		assert.equal(wrapped.command, "/usr/bin/sandbox-exec");
		assert.equal(wrapped.args[0], "-f");
		assert.match(wrapped.args[1], /readonly\.sb$/);
		assert.deepEqual(wrapped.args.slice(2), ["/bin/echo", "hi"]);
		const profile = await readFile(wrapped.args[1], "utf8");
		assert.match(profile, new RegExp(`subpath "${await realpath(dir)}"`));
		await rm(wrapped.dir, { recursive: true, force: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the sandbox denies writes into the checkout but allows reads and out-of-tree writes", { skip: readonlySandboxAvailable() ? false : "sandbox-exec unavailable" }, async () => {
	const checkout = await mkdtemp(path.join(tmpdir(), "sb-checkout-"));
	const scratch = await mkdtemp(path.join(tmpdir(), "sb-scratch-"));
	try {
		await writeFile(path.join(checkout, "file.txt"), "original\n");
		const wrapped = (await wrapWithReadonlySandbox("/bin/bash", ["-c", ""], checkout))!;
		const exec = async (script: string) => {
			try {
				await run(wrapped.command, [...wrapped.args.slice(0, 2), "/bin/bash", "-c", script]);
				return 0;
			} catch (error: any) {
				return error.code ?? 1;
			}
		};
		assert.notEqual(await exec(`echo pwned > ${path.join(checkout, "file.txt")}`), 0, "write into checkout must be denied");
		assert.equal((await readFile(path.join(checkout, "file.txt"), "utf8")).trim(), "original", "the file is untouched");
		assert.equal(await exec(`cat ${path.join(checkout, "file.txt")}`), 0, "reads inside the checkout must work");
		assert.equal(await exec(`echo ok > ${path.join(scratch, "out.txt")}`), 0, "out-of-tree writes must work");
		await rm(wrapped.dir, { recursive: true, force: true });
	} finally {
		await rm(checkout, { recursive: true, force: true });
		await rm(scratch, { recursive: true, force: true });
	}
});

test("a cwd set to a subdirectory still denies writes across the whole worktree", { skip: readonlySandboxAvailable() ? false : "sandbox-exec unavailable" }, async () => {
	const root = await mkdtemp(path.join(tmpdir(), "sb-repo-"));
	try {
		await run("git", ["-C", root, "init", "-q"]);
		await writeFile(path.join(root, "README.md"), "root\n");
		const sub = path.join(root, "src");
		await mkdir(sub);
		await writeFile(path.join(sub, "a.ts"), "code\n");
		// cwd is the subdirectory, but the deny boundary must be the worktree root.
		const wrapped = (await wrapWithReadonlySandbox("/bin/bash", ["-c", ""], sub))!;
		const exec = async (script: string) => {
			try {
				await run(wrapped.command, [...wrapped.args.slice(0, 2), "/bin/bash", "-c", script]);
				return 0;
			} catch (error: any) {
				return error.code ?? 1;
			}
		};
		assert.notEqual(await exec(`echo pwned > ${path.join(root, "README.md")}`), 0, "write to a sibling of cwd (repo root) must be denied");
		assert.equal((await readFile(path.join(root, "README.md"), "utf8")).trim(), "root");
		assert.notEqual(await exec(`echo pwned > ${path.join(sub, "a.ts")}`), 0, "write inside cwd must be denied too");
		await rm(wrapped.dir, { recursive: true, force: true });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
