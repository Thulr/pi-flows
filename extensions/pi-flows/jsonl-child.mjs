// The one child-process protocol module: spawn a process that speaks
// line-delimited JSON on stdout, stream-parse it, and terminate it under a
// bounded SIGTERM -> SIGKILL escalation. The extension runner and the evals
// baselines are both adapters over this seam — a protocol bug is fixed here,
// once. Plain .mjs with JSDoc so both TypeScript (runner.ts) and plain-node
// evals can import it.
import { spawn } from "node:child_process";

/**
 * @typedef {object} JsonlProcessOptions
 * @property {string} command
 * @property {string[]} args
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env]
 * @property {number} [timeoutMs] Wall-clock cap; 0 or undefined disables it.
 * @property {number} [graceMs] SIGTERM -> SIGKILL escalation delay (default 5000).
 * @property {AbortSignal} [signal]
 * @property {string} [stdin] When set, written to the child's stdin (then closed); otherwise stdin is ignored.
 * @property {(event: any, controls: { terminate: () => void }) => void} [onEvent] Called per parsed JSON stdout line. controls.terminate() stops the child early under the same bounded escalation.
 * @property {(line: string) => void} [onNonJsonLine] Called per non-JSON, non-blank stdout line.
 * @property {(line: string, controls: { terminate: () => void }) => void} [onLine] Raw-line mode: called per non-blank stdout line INSTEAD of JSON parsing (onEvent/onNonJsonLine are not called and sawJsonEvent stays false). controls.terminate() stops the child early under the same bounded escalation.
 * @property {(chunk: string) => void} [onStderr] Called per stderr chunk.
 */

/**
 * @typedef {object} JsonlProcessResult
 * @property {number} exitCode
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {boolean} sawJsonEvent True when at least one stdout line parsed as JSON.
 * @property {string | undefined} spawnErrorMessage Set when the process could not start (exitCode is 1).
 */

/**
 * Run a line-delimited-JSON child process to completion. Never rejects: spawn
 * failures, timeouts, and aborts are reported in the result so callers map
 * them to their own error contracts.
 *
 * @param {JsonlProcessOptions} options
 * @returns {Promise<JsonlProcessResult>}
 */
export function runJsonlProcess(options) {
	return new Promise((resolve) => {
		const proc = spawn(options.command, options.args, {
			cwd: options.cwd,
			shell: false,
			stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
			env: options.env,
		});

		let buffer = "";
		let sawJsonEvent = false;
		let closed = false;
		let timedOut = false;
		let aborted = false;
		/** @type {string | undefined} */
		let spawnErrorMessage;
		/** @type {NodeJS.Timeout | null} */
		let timer = null;
		/** @type {NodeJS.Timeout | null} */
		let forceKillTimer = null;
		/** @type {(() => void) | null} */
		let abortListener = null;

		const terminate = () => {
			if (closed) return;
			try { proc.kill("SIGTERM"); } catch {}
			if (forceKillTimer) return;
			forceKillTimer = setTimeout(() => {
				forceKillTimer = null;
				try { if (!closed) proc.kill("SIGKILL"); } catch {}
			}, options.graceMs ?? 5000);
			forceKillTimer.unref?.();
		};

		const finish = (/** @type {number} */ exitCode) => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (abortListener) options.signal?.removeEventListener("abort", abortListener);
			resolve({ exitCode, timedOut, aborted, sawJsonEvent, spawnErrorMessage });
		};

		if (options.timeoutMs && options.timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, options.timeoutMs);
			timer.unref?.();
		}

		const controls = { terminate };
		const processLine = (/** @type {string} */ line) => {
			if (!line.trim()) return;
			if (options.onLine) {
				options.onLine(line, controls);
				return;
			}
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				options.onNonJsonLine?.(line);
				return;
			}
			sawJsonEvent = true;
			options.onEvent?.(event, controls);
		};

		proc.stdout?.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr?.on("data", (data) => {
			options.onStderr?.(data.toString());
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});

		proc.on("error", (error) => {
			spawnErrorMessage = error?.message ?? String(error);
			finish(1);
		});

		abortListener = () => {
			aborted = true;
			terminate();
		};
		if (options.signal?.aborted) abortListener();
		else options.signal?.addEventListener("abort", abortListener, { once: true });

		if (options.stdin !== undefined) proc.stdin?.end(options.stdin);
	});
}

/**
 * Accumulate a pi `message_end` assistant message's usage into a mutable
 * usage tally. Shared by the extension runner and the evals baselines so the
 * two never disagree about what a token or a dollar is.
 *
 * @param {{ input: number, output: number, cacheRead: number, cacheWrite: number, cost: number, costKnown?: boolean, contextTokens: number, turns: number }} tally
 * @param {any} message An assistant message from a pi `message_end` event.
 */
export function accumulatePiUsage(tally, message) {
	tally.turns += 1;
	const usage = message?.usage;
	if (!usage) return;
	tally.input += usage.input || 0;
	tally.output += usage.output || 0;
	tally.cacheRead += usage.cacheRead || 0;
	tally.cacheWrite += usage.cacheWrite || 0;
	tally.costKnown = tally.costKnown !== false && Number.isFinite(usage.cost?.total);
	tally.cost += usage.cost?.total || 0;
	tally.contextTokens = usage.totalTokens || tally.contextTokens;
}
