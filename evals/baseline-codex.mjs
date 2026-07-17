// Direct-Codex control arm for A/B quality measurement. The task is sent over
// stdin, never argv. A temporary HOME/CODEX_HOME prevents user skills, plugins,
// memories, and config from changing the baseline; only auth is copied in.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function codexModelFromPi(model) {
	if (!model) throw new Error("Codex baseline requires an explicit subject model");
	if (model.startsWith("openai-codex/")) return model.slice("openai-codex/".length);
	if (model.includes("/")) throw new Error(`Codex baseline cannot map non-Codex provider model: ${model}`);
	return model;
}

function isolatedCodexEnvironment(baseEnv) {
	const root = mkdtempSync(join(tmpdir(), "pi-codex-baseline-"));
	const codexHome = join(root, "codex");
	mkdirSync(codexHome, { recursive: true });
	const auth = join(homedir(), ".codex", "auth.json");
	if (existsSync(auth)) copyFileSync(auth, join(codexHome, "auth.json"));
	return {
		root,
		env: { ...baseEnv, HOME: root, CODEX_HOME: codexHome },
	};
}

export async function runCodex({ task, cwd, model, reportedModel = model, timeoutMs = 120_000, signal, codexBin = "codex", env = process.env }) {
	const isolated = isolatedCodexEnvironment(env);
	const args = [
		"exec",
		"--json",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--sandbox", "workspace-write",
		"--color", "never",
		"--model", model,
		"--cd", cwd ?? process.cwd(),
		"-",
	];

	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, contextTokens: 0, turns: 0 };
	let finalText = "";
	let stderr = "";
	let stdoutSample = "";
	let parseErrors = 0;
	let sawJson = false;
	let stopReason;
	let errorMessage;

	let exitCode;
	try {
		exitCode = await new Promise((resolveExit) => {
			const proc = spawn(codexBin, args, { cwd: cwd ?? process.cwd(), env: isolated.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
			let buffer = "";
			let closed = false;
			let timedOut = false;
			let aborted = false;
			const timer = timeoutMs > 0
				? setTimeout(() => {
					timedOut = true;
					stopReason = "timeout";
					try { proc.kill("SIGTERM"); } catch {}
					setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 5_000).unref?.();
				}, timeoutMs)
				: null;
			timer?.unref?.();

			const onAbort = () => {
				aborted = true;
				stopReason = "aborted";
				try { proc.kill("SIGTERM"); } catch {}
			};
			const finish = (code) => {
				if (closed) return;
				closed = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener?.("abort", onAbort);
				if (timedOut) errorMessage = `direct Codex timed out after ${timeoutMs}ms`;
				else if (aborted) errorMessage = "direct Codex was aborted";
				resolveExit(code);
			};

			const processLine = (line) => {
				if (!line.trim()) return;
				let event;
				try {
					event = JSON.parse(line);
					sawJson = true;
				} catch {
					parseErrors += 1;
					if (stdoutSample.length < 4096) stdoutSample += `${line}\n`;
					return;
				}
				if (event.type === "item.completed" && event.item?.type === "agent_message") {
					finalText = event.item.text ?? finalText;
				}
				if (event.type === "turn.completed" && event.usage) {
					usage.input += event.usage.input_tokens ?? 0;
					usage.output += event.usage.output_tokens ?? 0;
					usage.cacheRead += event.usage.cached_input_tokens ?? 0;
					usage.contextTokens = usage.input + usage.output;
					usage.turns += 1;
					stopReason = "endTurn";
				}
				if (event.type === "turn.failed" || event.type === "error") {
					errorMessage = event.error?.message ?? event.message ?? "direct Codex turn failed";
					stopReason = "error";
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-8192); });
			proc.on("error", (error) => {
				errorMessage = `direct Codex spawn error: ${error.message}`;
				stopReason = "error";
				finish(1);
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				finish(code ?? 0);
			});
			if (signal?.aborted) onAbort();
			else signal?.addEventListener?.("abort", onAbort, { once: true });
			proc.stdin.end(String(task ?? ""));
		});
	} finally {
		rmSync(isolated.root, { recursive: true, force: true });
	}

	const protocolError = !sawJson && parseErrors > 0;
	if (protocolError) {
		stopReason = "error";
		errorMessage = "direct Codex did not produce valid --json output";
	}
	if ((exitCode ?? 0) !== 0 && !errorMessage) {
		stopReason = "error";
		errorMessage = stderr || `direct Codex exited ${exitCode}`;
	}
	const text = finalText || errorMessage || stderr || "(no output)";
	return {
		content: [{ type: "text", text }],
		details: {
			mode: "codex-baseline",
			results: [{
				agent: "codex-baseline",
				agentSource: "none",
				exitCode: exitCode ?? 0,
				usage,
				model: reportedModel,
				stopReason,
				errorMessage,
				stdoutSample,
			}],
		},
	};
}
