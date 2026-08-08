import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { CHECK_OUTPUT_CAP, DEFAULT_TIMEOUT_MS, type CapturePolicy } from "./types.ts";
import { capBytes, sanitizeText } from "./sanitize.ts";

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

/** Run a deterministic acceptance gate and return bounded, redacted output. */
export function runCheckCommand(command: string, cwd: string, timeoutMs: number, policy: CapturePolicy, signal?: AbortSignal): Promise<{ ok: boolean; output: string; spawnFailed: boolean }> {
	return boundedCommand<{ ok: boolean; output: string; spawnFailed: boolean }>({
		command, cwd, timeoutMs, policy, signal, label: "Check output",
		finishForCode: (code, output) => ({ ok: code === 0, output, spawnFailed: false }),
		finishForTimeout: (output) => ({ ok: false, output, spawnFailed: false }),
		finishForAbort: (output) => ({ ok: false, output, spawnFailed: false }),
		finishForSpawnError: (output) => ({ ok: false, output, spawnFailed: true }),
	});
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
