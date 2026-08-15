import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { CHECK_OUTPUT_CAP, DEFAULT_TIMEOUT_MS, mintEvent, type CapturePolicy, type EventAttribution, type FlowError } from "./types.ts";
import { capBytes, sanitizeText } from "./sanitize.ts";
import { splitBashReadonly, type BashReadonlyEnforcement } from "./bash-readonly.ts";
import { bashReadonlyEnforcerArgs, bashReadonlyEnforcerAvailable } from "./bash-readonly-extension.ts";
import { resolveBashReadonlyEnforcement } from "./bash-readonly-sandbox.ts";

/**
 * Assemble the base argv for a child pi process and resolve how its bash-ro
 * toolset (if any) will be enforced. Kept beside getPiInvocation because it is
 * the same concern — how the child is invoked — and to keep the runner's
 * per-run body under its size budget. Returns the parsed tools (for span
 * attribution), the enforcement layer, and a fail-closed error when a bash-ro
 * child can be enforced by no layer; on error the args are not usable.
 */
export function buildChildArgs(params: { model?: string; thinking?: string; noExtensions: boolean; effectiveTools?: string[] }): { args: string[]; tools: string[] | undefined; enforcement: BashReadonlyEnforcement | null; error: FlowError | null } {
	const args = ["--mode", "json", "-p", "--no-session"];
	if (params.noExtensions) args.push("--no-extensions");
	if (params.model) args.push("--model", params.model);
	// Its own flag rather than a `model:level` suffix, so a level still reaches a child running the user's default model.
	if (params.thinking) args.push("--thinking", params.thinking);
	const tools = params.effectiveTools;
	const bashRo = splitBashReadonly(tools ?? []);
	const { enforcement, error } = resolveBashReadonlyEnforcement(bashRo.readonly, bashRo.sandboxable);
	if (error) return { args, tools, enforcement, error };
	if (tools?.length === 0) args.push("--no-builtin-tools");
	else if (tools !== undefined) args.push("--tools", bashRo.argvTools.join(","));
	// The -e allowlist enforcer rides along whenever loadable (defense-in-depth under the sandbox); the OS sandbox is applied to the invocation separately.
	if (bashRo.readonly && bashReadonlyEnforcerAvailable()) args.push(...bashReadonlyEnforcerArgs());
	return { args, tools, enforcement, error: null };
}

export function resolveFlowCommandTimeoutMs(commandTimeoutMs?: number, flowTimeoutMs?: number): number {
	const value = commandTimeoutMs ?? flowTimeoutMs;
	if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
	return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value as number)));
}

function boundedCommand<T>(options: {
	command: string;
	cwd: string;
	timeoutMs: number;
	policy: CapturePolicy;
	signal?: AbortSignal;
	label: string;
	finishForCode: (code: number | null, output: string) => T;
	finishForTimeout: (output: string) => T;
	finishForAbort: (output: string) => T;
	finishForSpawnError: (output: string) => T;
}): Promise<T> {
	return new Promise((resolve) => {
		let output = "";
		let done = false;
		let stopReason: "timeout" | "abort" | null = null;
		let abortListener: (() => void) | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const append = (chunk: string) => {
			output = capBytes(`${output}${sanitizeText(chunk, options.policy, CHECK_OUTPUT_CAP)}`, CHECK_OUTPUT_CAP, options.label);
		};
		const detached = process.platform !== "win32";
		const proc = spawn(options.command, { cwd: options.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: process.env, detached });
		const killTree = (signal: NodeJS.Signals) => {
			try {
				if (detached && proc.pid) process.kill(-proc.pid, signal);
				else proc.kill(signal);
			} catch {
				try { proc.kill(signal); } catch {}
			}
		};
		const finish = (value: T) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
			resolve(value);
		};
		const stop = (reason: "timeout" | "abort") => {
			if (done || stopReason) return;
			stopReason = reason;
			if (reason === "timeout") append(`\n[${options.label.toLowerCase()} timed out]`);
			killTree("SIGTERM");
			killTimer = setTimeout(() => killTree("SIGKILL"), 1_000);
			killTimer.unref?.();
		};
		const timer = setTimeout(() => {
			stop("timeout");
		}, options.timeoutMs);
		timer.unref?.();
		proc.stdout.on("data", (data) => append(data.toString()));
		proc.stderr.on("data", (data) => append(data.toString()));
		proc.on("error", (error) => finish(options.finishForSpawnError(sanitizeText(error.message, options.policy, CHECK_OUTPUT_CAP))));
		proc.on("close", (code) => finish(stopReason === "timeout"
			? options.finishForTimeout(output)
			: stopReason === "abort"
				? options.finishForAbort(output)
				: options.finishForCode(code, output)));
		abortListener = () => {
			stop("abort");
		};
		if (options.signal?.aborted) abortListener();
		else options.signal?.addEventListener("abort", abortListener, { once: true });
	});
}

/**
 * Run a deterministic acceptance gate and return bounded, redacted output.
 *
 * The gate mints its own validation evidence (#128): the outcome event is
 * recorded here, on the one path every check command runs through, the same
 * way a child span is impossible to skip because runner.ts records it — so a
 * mode cannot run a gate without leaving the trace fact that it ran, and the
 * required attribution makes a caller without a sink state that rather than
 * forget it. The caller owns the attribution; `flow.check.passed` and the
 * outcome are this seam's, assembled through the Core `mintEvent` home so the
 * merge order is spelled once. A gate that could not start is recorded too
 * (`flow.check.spawn_failed`) — evaluate's refuse-first path previously left
 * no evidence of that spend.
 */
export async function runCheckCommand(command: string, cwd: string, timeoutMs: number, policy: CapturePolicy, attribution: EventAttribution, signal?: AbortSignal): Promise<{ ok: boolean; output: string; spawnFailed: boolean }> {
	const result = await boundedCommand<{ ok: boolean; output: string; spawnFailed: boolean }>({
		command, cwd, timeoutMs, policy, signal, label: "Check output",
		finishForCode: (code, output) => ({ ok: code === 0, output, spawnFailed: false }),
		finishForTimeout: (output) => ({ ok: false, output, spawnFailed: false }),
		finishForAbort: (output) => ({ ok: false, output, spawnFailed: false }),
		finishForSpawnError: (output) => ({ ok: false, output, spawnFailed: true }),
	});
	mintEvent(attribution, {
		kind: "validation",
		ok: result.ok,
		attributes: {
			"flow.check.passed": result.ok,
			...(result.spawnFailed ? { "flow.check.spawn_failed": true } : {}),
		},
	});
	return result;
}

/** Capture one bounded shell probe without treating expected non-zero exits as agent errors. */
export function runProbeCommand(command: string, cwd: string, timeoutMs: number, policy: CapturePolicy, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string; timedOut: boolean; spawnFailed: boolean; aborted: boolean }> {
	return boundedCommand<{ exitCode: number | null; output: string; timedOut: boolean; spawnFailed: boolean; aborted: boolean }>({
		command, cwd, timeoutMs, policy, signal, label: "Probe output",
		finishForCode: (exitCode, output) => ({ exitCode, output, timedOut: false, spawnFailed: false, aborted: false }),
		finishForTimeout: (output) => ({ exitCode: null, output, timedOut: true, spawnFailed: false, aborted: false }),
		finishForAbort: (output) => ({ exitCode: null, output, timedOut: false, spawnFailed: false, aborted: true }),
		finishForSpawnError: (output) => ({ exitCode: null, output, timedOut: false, spawnFailed: true, aborted: false }),
	});
}

/** How a child pi process is invoked: re-run the current entrypoint when it is a real script, else fall back to `pi` on PATH. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fsSync.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executableName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}
