// Direct-Codex control arm for A/B quality measurement. The task is sent over
// stdin, never argv. A temporary HOME/CODEX_HOME prevents user skills, plugins,
// memories, and config from changing the baseline; only auth is copied in.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { runJsonlProcess } from "../extensions/pi-flows/jsonl-child.mjs";

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

export async function runCodex({ task, cwd, model, reportedModel = model, timeoutMs = 120_000, signal, codexBin = "codex", env = process.env, killGraceMs = 5_000 }) {
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

	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false, costEstimated: false, totalTokens: 0, contextTokens: 0, turns: 0 };
	let finalText = "";
	let stderr = "";
	let stdoutSample = "";
	let parseErrors = 0;
	let stopReason;
	let errorMessage;

	let run;
	try {
		run = await runJsonlProcess({
			command: codexBin,
			args,
			cwd: cwd ?? process.cwd(),
			env: isolated.env,
			timeoutMs,
			graceMs: killGraceMs,
			signal,
			stdin: String(task ?? ""),
			onEvent: (event) => {
				if (event.type === "item.completed" && event.item?.type === "agent_message") {
					finalText = event.item.text ?? finalText;
				}
				if (event.type === "turn.completed" && event.usage) {
					const input = event.usage.input_tokens ?? 0;
					const cached = event.usage.cached_input_tokens ?? 0;
					usage.input += Math.max(0, input - cached);
					usage.output += event.usage.output_tokens ?? 0;
					usage.cacheRead += cached;
					usage.totalTokens += input + (event.usage.output_tokens ?? 0);
					usage.contextTokens = usage.totalTokens;
					usage.turns += 1;
					stopReason = "endTurn";
				}
				if (event.type === "turn.failed" || event.type === "error") {
					errorMessage = event.error?.message ?? event.message ?? "direct Codex turn failed";
					stopReason = "error";
				}
			},
			onNonJsonLine: (line) => {
				parseErrors += 1;
				if (stdoutSample.length < 4096) stdoutSample += `${line}\n`;
			},
			onStderr: (chunk) => { stderr = (stderr + chunk).slice(-8192); },
		});
	} finally {
		rmSync(isolated.root, { recursive: true, force: true });
	}

	const exitCode = run.exitCode;
	if (run.timedOut) {
		stopReason = "timeout";
		errorMessage = `direct Codex timed out after ${timeoutMs}ms`;
	} else if (run.aborted) {
		stopReason = "aborted";
		errorMessage = "direct Codex was aborted";
	} else if (run.spawnErrorMessage) {
		errorMessage = `direct Codex spawn error: ${run.spawnErrorMessage}`;
		stopReason = "error";
	}

	const protocolError = !run.sawJsonEvent && parseErrors > 0;
	if (protocolError) {
		stopReason = "error";
		errorMessage = "direct Codex did not produce valid --json output";
	}
	if ((exitCode ?? 0) !== 0 && !errorMessage) {
		stopReason = "error";
		errorMessage = stderr || `direct Codex exited ${exitCode}`;
	}
	const text = finalText || errorMessage || stderr || "(no output)";
	const pricing = getModel("openai-codex", model)?.cost;
	if (pricing) {
		usage.cost = ((pricing.input * usage.input) + (pricing.output * usage.output) + (pricing.cacheRead * usage.cacheRead) + (pricing.cacheWrite * usage.cacheWrite)) / 1_000_000;
		usage.costKnown = true;
		usage.costEstimated = true;
	}
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
