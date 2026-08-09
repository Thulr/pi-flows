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
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
 * writes anywhere under the reviewed checkout. Pure and unit-testable.
 */
export function buildReadonlyProfile(realCwd: string): string {
	return ["(version 1)", "(allow default)", `(deny file-write* (subpath ${profilePath(realCwd)}))`, ""].join("\n");
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
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-flow-sb-"));
	const filePath = path.join(dir, "readonly.sb");
	await fs.writeFile(filePath, buildReadonlyProfile(realCwd), "utf8");
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
