/**
 * The OS-level half of bash-ro: wrap a child pi invocation in the host's
 * sandbox so writes to the reviewed checkout are impossible at the kernel,
 * not merely refused by an in-child command allowlist. With this in place the
 * allowlist (bash-readonly.ts) stops being the security boundary and becomes
 * defense-in-depth plus early, legible refusals — which is why chasing every
 * individual mutating flag stops being the only line of defence.
 *
 * Generic/adapter: this module speaks a foreign boundary (the macOS Seatbelt
 * profile language and the `sandbox-exec` wrapper). It is darwin-only today;
 * `readonlySandboxAvailable()` is the single predicate the runner consults,
 * so adding a Linux backend (bwrap) later is a change here, not above.
 *
 * The threat model is coordination safety: two read-only reviewers sharing
 * one checkout must not mutate it. So the profile denies writes to the cwd
 * subtree only and allows everything else — pi's own temp/session files and
 * out-of-tree caches (npm, node) keep working; writes *into* the shared
 * checkout, which are exactly the conflict the SHARED_WRITE_CWD guard exists
 * for, are what fails.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { bashReadonlyEnforcement, bashReadonlyUnenforceableError, type BashReadonlyEnforcement } from "./bash-readonly.ts";
import { bashReadonlyEnforcerAvailable } from "./bash-readonly-extension.ts";
import type { FlowError } from "./types.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Truthy env opt-out: skip OS sandboxing and fall back to the allowlist. */
export function readonlySandboxDisabled(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value?.trim() ?? "");
}

/** Whether this host can enforce a read-only checkout at the OS level. */
export function readonlySandboxAvailable(): boolean {
	return process.platform === "darwin" && fsSync.existsSync(SANDBOX_EXEC);
}

function sandboxUsable(): boolean {
	return readonlySandboxAvailable() && !readonlySandboxDisabled(process.env.PI_FLOWS_BASH_RO_NO_SANDBOX);
}

/** Opt-in to refuse rather than use the best-effort allowlist where the OS sandbox is unavailable. */
function requireSandbox(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_FLOWS_BASH_RO_REQUIRE_SANDBOX?.trim() ?? "");
}

/**
 * Resolve how (or whether) a bash-ro child can be enforced on this host. The
 * runner refuses the spawn when `error` is set, otherwise wraps per
 * `enforcement`. A non-readonly toolset resolves to no enforcement and no error.
 */
export function resolveBashReadonlyEnforcement(readonly: boolean): { enforcement: BashReadonlyEnforcement | null; error: FlowError | null } {
	if (!readonly) return { enforcement: null, error: null };
	const enforcement = bashReadonlyEnforcement(bashReadonlyEnforcerAvailable(), sandboxUsable(), requireSandbox());
	return { enforcement, error: enforcement === null ? bashReadonlyUnenforceableError() : null };
}

/** A Seatbelt path literal: quote it and escape the two characters that would break the string. */
function profilePath(dir: string): string {
	return `"${dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The Seatbelt profile: allow everything the child normally does, then deny
 * writes under the reviewed checkout and under any extra paths (a linked
 * worktree's git dir lives outside the checkout, so its index must be denied
 * too). Duplicates and paths already inside the checkout are harmless. Pure
 * and unit-testable.
 */
export function buildReadonlyProfile(realCwd: string, extraDenies: string[] = []): string {
	const denies = [realCwd, ...extraDenies];
	return ["(version 1)", "(allow default)", ...denies.map((dir) => `(deny file-write* (subpath ${profilePath(dir)}))`), ""].join("\n");
}

const runGit = promisify(execFile);

/**
 * The paths whose subtrees the sandbox must deny writes to for a checkout: the
 * worktree root (so a cwd set to a subdirectory still protects the whole
 * checkout, not just that subdir) plus the git dir and common dir (a linked
 * worktree's live outside the root). All realpath-resolved. Empty when `cwd` is
 * not in a git repo — the caller falls back to denying `cwd` itself.
 */
async function gitDenyRoots(cwd: string): Promise<string[]> {
	try {
		const { stdout } = await runGit("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], { encoding: "utf8" });
		const dirs = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
		return await Promise.all(dirs.map((dir) => fs.realpath(dir).catch(() => path.resolve(dir))));
	} catch {
		return [];
	}
}

/** Drop paths already covered by an earlier subpath in the list (dedupe/containment). */
function minimalSubpaths(dirs: string[]): string[] {
	const kept: string[] = [];
	for (const dir of dirs) {
		if (kept.some((root) => dir === root || dir.startsWith(`${root}${path.sep}`))) continue;
		kept.push(dir);
	}
	return kept;
}

/**
 * Wrap an inner `{command, args}` so it runs under a read-only-checkout
 * sandbox. Returns the wrapped invocation and the temp dir holding the
 * profile (for the caller to clean up), or null when the host cannot enforce
 * it. `cwd` is resolved through realpath because Seatbelt matches canonical
 * paths (e.g. /tmp -> /private/tmp).
 */
export async function wrapWithReadonlySandbox(command: string, args: string[], cwd: string): Promise<{ command: string; args: string[]; dir: string } | null> {
	if (!readonlySandboxAvailable()) return null;
	const realCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	// Deny the whole worktree root (and external git dirs), not just cwd, so a
	// cwd set to a subdirectory can't leave the rest of the checkout writable.
	const denyRoots = minimalSubpaths([...(await gitDenyRoots(realCwd)), realCwd]);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-flow-sb-"));
	const filePath = path.join(dir, "readonly.sb");
	await fs.writeFile(filePath, buildReadonlyProfile(denyRoots[0], denyRoots.slice(1)), "utf8");
	return { command: SANDBOX_EXEC, args: ["-f", filePath, command, ...args], dir };
}

/**
 * Apply the sandbox to a child invocation, returning the wrapped invocation
 * plus the temp entry to clean up, or null when the host cannot wrap (the
 * caller then relies on the in-child allowlist that already rode along).
 */
export async function applyReadonlySandbox(invocation: { command: string; args: string[] }, cwd: string): Promise<{ invocation: { command: string; args: string[] }; tempFile: { dir: string; filePath: string } } | null> {
	const wrapped = await wrapWithReadonlySandbox(invocation.command, invocation.args, cwd);
	if (!wrapped) return null;
	return { invocation: { command: wrapped.command, args: wrapped.args }, tempFile: { dir: wrapped.dir, filePath: path.join(wrapped.dir, "readonly.sb") } };
}
