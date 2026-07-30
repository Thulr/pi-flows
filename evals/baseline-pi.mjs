// Plain-pi control arm for the flows-vs-plain A/B. Runs a case's raw task through a
// headless `pi` with NO pi-flows — `--no-extensions`, pi's default system prompt,
// default tools — on the SAME model as the flows arm. So the only thing that varies
// between arms is pi-flows' agent profiles + orchestration, which is exactly what
// the comparison is trying to isolate.
//
// It speaks the same `--mode json` protocol the flow tool's children use, and
// returns a result shaped like a flow result ({ content, details.results[] }) so the
// existing objective scorers and the cross-model judge consume it unchanged.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accumulatePiUsage, runJsonlProcess } from "../extensions/pi-flows/jsonl-child.mjs";
import { budgetExceededError, budgetUnobservableError } from "../extensions/pi-flows/types.ts";

function finalAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		for (const part of m.content ?? []) if (part?.type === "text") return part.text;
	}
	return "";
}

/**
 * Run one plain `pi` headlessly on `task`. Returns a flow-shaped result. `model`
 * undefined → omit --model so the child uses pi's default (matches the flows arm's
 * "agent frontmatter" mode).
 */
export async function runPlainPi({ task, cwd, model, timeoutMs = 120000, signal, killGraceMs = 5_000, maxCostUsd, maxGeneratedTokens, command = "pi" }) {
	const startedAt = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "pi-baseline-"));
	const taskFile = join(dir, "task.md");
	writeFileSync(taskFile, `Task: ${task}\n`, { encoding: "utf8", mode: 0o600 });

	// Plain pi: no extensions (so pi-flows is not loaded), no session, default system
	// prompt + default tools. Same JSON protocol the flow children emit.
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (model) args.push("--model", model);
	args.push(`@${taskFile}`);

	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const messages = [];
	let stderr = "";
	let stdoutSample = "";
	let parseErrors = 0;
	let modelOut;
	let stopReason;
	let errorMessage;
	let budgetTerminated = false;
	let budgetUnobservable = false;
	const childEnv = { ...process.env };
	delete childEnv.NODE_TEST_CONTEXT;

	const run = await runJsonlProcess({
		command,
		args,
		cwd: cwd ?? process.cwd(),
		env: childEnv,
		timeoutMs,
		graceMs: killGraceMs,
		signal,
		onEvent: (event, controls) => {
			if (event.type === "message_end" && event.message) {
				const m = event.message;
				if (m.role === "assistant") {
					accumulatePiUsage(usage, m);
					if (!modelOut && m.model) modelOut = m.model;
					if (m.stopReason) stopReason = m.stopReason;
					if (m.errorMessage) errorMessage = m.errorMessage;
					if (!m.errorMessage && maxCostUsd !== undefined && usage.costKnown === false) {
						budgetUnobservable = true;
						stopReason = "budget_unobservable";
						controls.terminate();
					} else if (!m.errorMessage && ((maxCostUsd !== undefined && usage.cost >= maxCostUsd)
						|| (maxGeneratedTokens !== undefined && usage.output >= maxGeneratedTokens))) {
						budgetTerminated = true;
						stopReason = "budget_exceeded";
						controls.terminate();
					}
				}
				messages.push(m);
			} else if (event.type === "tool_result_end" && event.message) {
				messages.push(event.message);
			}
		},
		onNonJsonLine: (line) => {
			parseErrors += 1;
			if (stdoutSample.length < 4096) stdoutSample += `${line}\n`;
		},
		onStderr: (chunk) => { stderr = (stderr + chunk).slice(-8192); },
	});
	if (run.timedOut) stopReason = "timeout";
	else if (run.aborted) stopReason = "aborted";
	if (run.spawnErrorMessage) stderr += `spawn error: ${run.spawnErrorMessage}`;
	const exitCode = budgetTerminated || budgetUnobservable ? 1 : run.exitCode;
	const budgetError = budgetUnobservable ? budgetUnobservableError() : budgetTerminated
		? budgetExceededError({ maxCostUsd, maxGeneratedTokens, spentCost: usage.cost, spentTokens: usage.input + usage.output, spentGeneratedTokens: usage.output }) : undefined;
	if (budgetError) errorMessage = budgetError.message;

	const protocolError = !run.sawJsonEvent && parseErrors > 0;
	const text = finalAssistantText(messages) || errorMessage || stderr || "(no output)";
	return {
		content: [{ type: "text", text }],
		details: {
			mode: "plain-pi",
			results: [
				{
					agent: "plain-pi",
					agentSource: "none",
					exitCode: exitCode ?? 0,
					usage,
					model: modelOut,
					stopReason: protocolError ? "error" : stopReason,
					errorMessage: protocolError ? "plain pi did not produce valid --mode json output" : errorMessage,
					error: budgetError,
					durationMs: Date.now() - startedAt,
					stdoutSample,
				},
			],
		},
	};
}
