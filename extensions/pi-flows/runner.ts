import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CHILD_ERROR_GRACE_MS, STDOUT_SAMPLE_CAP, activeBudgetExceeded, budgetExceeded, budgetExceededError, budgetUnobservableError, chargeBudget, emptyUsage, flowError, type CapturePolicy, type ChildSpanScope, type DelegationContract, type FlowAgent, type FlowAgentRefInput, type FlowBudget, type FlowMode, type FlowRunResult, type ModeDeps, type RunChildOptions, type SpanStage } from "./types.ts";
import { accumulatePiUsage, runJsonlProcess } from "./jsonl-child.mjs";
import { appendCapped, capBytes, captureRawFinalAssistantText, getFinalAssistantText, isFailed, makeEmptyRunResult, sanitizeText, storeMessage, takeRawFinalAssistantText } from "./sanitize.ts";
import { budgetAttributes, delegationIdentityAttributes } from "./trace-attributes.ts";
import { currentFlowDepth, normalizeTimeout, parseToolsOverride } from "./validate.ts";

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

// Portable model tiers: agents (and flow calls) declare a capability tier instead
// of a vendor model, so flows run on whatever model the user has pi set up with.
// No model ids are hard-coded here — pi gives an extension no stable way to enumerate
// a provider's models with cost (its registry is not a public export and
// `pi --list-models` carries no pricing), and a hard-coded map would just go stale
// as providers ship models. So:
//
//   tier: capable  -> omit --model; the child pi uses the user's default model
//   tier: fast     -> PI_FLOWS_FAST_MODEL if the user set one, else the default
//   tier: deep     -> PI_FLOWS_DEEP_MODEL if the user set one, else the default
//   model: <id>    -> explicit pin; always wins (as does a flow `model` override)
//
// The mappings are opt-ins the user owns for their own provider (e.g.
// PI_FLOWS_FAST_MODEL=openai-codex/gpt-5.4-mini) rather than a list we maintain.
export interface TierModels {
	fast?: string;
	deep?: string;
}

export function configuredTierModels(): TierModels {
	return {
		fast: process.env.PI_FLOWS_FAST_MODEL?.trim() || undefined,
		deep: process.env.PI_FLOWS_DEEP_MODEL?.trim() || undefined,
	};
}

function tierModel(tier: string | undefined, tiers: TierModels): string | undefined {
	if (tier === "fast") return tiers.fast;
	if (tier === "deep") return tiers.deep;
	return undefined;
}

function childExtensionsDisabled(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_FLOWS_CHILD_NO_EXTENSIONS?.trim() ?? "");
}

/**
 * Concrete model for a child run: flow model override > flow tier override >
 * agent pin > agent tier > pi default (undefined = omit --model, child uses the
 * user's default). A call-site tier beats an agent's pinned model because the
 * parent is expressing per-task intent — including tier "capable", which always
 * resolves and forces the default model even on a fast/deep agent. Only an
 * *unmapped* fast/deep call-site tier falls through, so flows still run with
 * zero tier configuration.
 */
export function resolveAgentModel(agent: { model?: string; tier?: string }, options: { model?: string; tier?: string }, tiers: TierModels): string | undefined {
	if (options.model) return options.model;
	if (options.tier === "capable") return undefined;
	const optionsTierModel = tierModel(options.tier, tiers);
	if (optionsTierModel) return optionsTierModel;
	if (agent.model) return agent.model;
	return tierModel(agent.tier, tiers);
}

export async function writePromptToTempFile(agentName: string, prompt: string, label = "system"): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-flow-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `${safeName}-${label}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	});
	return { dir, filePath };
}

/**
 * What the child span says about this dispatch: which agent and prompt version
 * ran, what it was allowed to touch, under whose authority and contract, and
 * where the budget stood afterwards. Built here because this is the only place
 * that knows the *resolved* agent and tool allowlist rather than the request.
 */
function childSpanAttributes(options: RunChildOptions, agent: FlowAgent | undefined, allowedTools: string[] | undefined, policy: CapturePolicy): Record<string, unknown> {
	return {
		...delegationIdentityAttributes({
			systemPrompt: agent?.systemPrompt ?? "",
			allowedTools,
			contract: options.contract,
			delegationReason: options.delegationReason,
			policy,
		}),
		...budgetAttributes(options.budget),
		...budgetAttributes(options.contractBudget, "flow.contract_budget"),
	};
}

/** Production adapter for the child-run seam (ModeDeps.runChild): one real pi subprocess per call. */
export async function runFlowAgent(options: RunChildOptions): Promise<FlowRunResult> {
	const policy: CapturePolicy = { recordContent: options.recordContent ?? true, redactSecrets: options.redactSecrets ?? true };
	const budgets = [options.budget, options.contractBudget].filter((budget): budget is FlowBudget => Boolean(budget));
	// Cost ceiling: refuse to spawn once the flow tree's cumulative spend is spent.
	const exhaustedBudget = budgets.find((budget) => budgetExceeded(budget));
	if (exhaustedBudget) {
		// A budget refusal spawns nothing, so it produces no child span. Without an
		// event the trace would simply be missing a child and look like loss.
		options.recordEvent?.({
			kind: "budget",
			name: "child.refused",
			ok: false,
			scope: options.scope,
			attributes: {
				"flow.budget.refused_agent": options.agentName,
				// Named against the ceiling that actually refused, so a contract-bound
				// refusal is not reported as a flow-budget one.
				"flow.budget.authority": exhaustedBudget === options.contractBudget ? "contract" : "flow",
				// Prefixed by the ceiling that actually refused: reporting a contract
				// limit under `flow.budget.*` would attribute it to a budget that in a
				// contract-only run does not exist.
				...budgetAttributes(exhaustedBudget, exhaustedBudget === options.contractBudget ? "flow.contract_budget" : "flow.budget"),
			},
		});
		return makeEmptyRunResult(options.agentName, options.task, policy, budgetExceededError(exhaustedBudget));
	}
	const agent = options.agents.find((candidate) => candidate.name === options.agentName);
	if (!agent) {
		const available = options.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		const error = flowError(
			"UNKNOWN_AGENT",
			`Unknown flow agent: "${options.agentName}".`,
			`No discovered agent matched "${options.agentName}". Available agents: ${available}.`,
			"Run `flow` with `{\"list\": true}` or `/flows` to inspect agent names and scopes.",
		);
		options.recordEvent?.({
			kind: "validation",
			name: "dispatch.unknown_agent",
			ok: false,
			scope: options.scope,
			attributes: { "flow.dispatch.requested_agent": options.agentName, "flow.error_code": error.code },
		});
		return makeEmptyRunResult(options.agentName, options.task, policy, error);
	}

	const started = Date.now();
	const timeoutMs = normalizeTimeout(options.timeoutMs);
	const result: FlowRunResult = {
		agent: agent.name,
		agentSource: agent.source,
		task: sanitizeText(options.task, policy, 4 * 1024),
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: resolveAgentModel(agent, { model: options.model, tier: options.tier }, configuredTierModels()),
		step: options.step,
		stdoutParseErrors: 0,
		stdoutSample: "",
	};

	const emitUpdate = (text?: string) => {
		const fallback = `(running ${agent.name} for ${((Date.now() - started) / 1000).toFixed(1)}s...)`;
		options.onUpdate?.({
			content: [{ type: "text", text: sanitizeText(text || getFinalAssistantText(result.messages) || fallback, policy) }],
			details: options.makeDetails([result]),
		});
	};

	const args = ["--mode", "json", "-p", "--no-session"];
	if (childExtensionsDisabled()) args.push("--no-extensions");
	const model = resolveAgentModel(agent, { model: options.model, tier: options.tier }, configuredTierModels());
	if (model) args.push("--model", model);

	const tools = parseToolsOverride(options.tools, agent.tools);
	if (tools !== undefined) {
		if (tools.length === 0) args.push("--no-builtin-tools");
		else args.push("--tools", tools.join(","));
	}

	const tempFiles: Array<{ dir: string; filePath: string }> = [];
	let wasAborted = false;
	let timedOut = false;
	let budgetTerminated = false;
	let budgetUnobservable = false;
	let terminatingBudget: FlowBudget | undefined;
	try {
		if (agent.systemPrompt.trim()) {
			const systemPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt, "system");
			tempFiles.push(systemPrompt);
			args.push("--append-system-prompt", systemPrompt.filePath);
		}

		const taskPrompt = await writePromptToTempFile(agent.name, `Task: ${options.task}\n`, "task");
		tempFiles.push(taskPrompt);
		args.push(`@${taskPrompt.filePath}`);

		const invocation = getPiInvocation(args);
		emitUpdate("starting child pi process...");
		const rawGrace = Number(process.env.PI_FLOWS_ERROR_GRACE_MS);
		const errorGraceMs = Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : DEFAULT_CHILD_ERROR_GRACE_MS;
		let terminalErrorTimer: NodeJS.Timeout | null = null;
		let terminalErrorSeen = false;
		let terminalProviderError = false;
		const run = await runJsonlProcess({
			command: invocation.command,
			args: invocation.args,
			cwd: path.resolve(options.defaultCwd, options.cwd ?? options.defaultCwd),
			env: { ...process.env, PI_FLOWS_DEPTH: String(currentFlowDepth() + 1) },
			timeoutMs,
			signal: options.signal,
			onEvent: (event, controls) => {
				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					if (message.role === "assistant") {
						if (options.captureRawOutput) captureRawFinalAssistantText(result, message);
						const turnUsage = emptyUsage();
						accumulatePiUsage(turnUsage, message);
						accumulatePiUsage(result.usage, message);
						for (const budget of budgets) chargeBudget(budget, turnUsage);
						if (!message.errorMessage && budgets.some((budget) => budget.maxCostUsd !== undefined) && turnUsage.costKnown === false) {
							budgetUnobservable = true;
							controls.terminate();
						} else if (!message.errorMessage) {
							terminatingBudget = budgets.find((budget) => activeBudgetExceeded(budget))
								?? (options.contractBudget && budgetExceeded(options.contractBudget) ? options.contractBudget : undefined);
							if (terminatingBudget) {
								budgetTerminated = true;
								controls.terminate();
							}
						}
						if (!result.model && message.model) result.model = message.model;
						if (message.stopReason) result.stopReason = message.stopReason;
						if (message.errorMessage) result.errorMessage = sanitizeText(message.errorMessage, policy);
						// A terminal provider error (e.g. context window exceeded) marks
						// the child as expected-to-exit; only a later HEALTHY assistant
						// turn (no errorMessage) proves recovery and clears the mark.
						if (message.errorMessage && message.stopReason === "error") terminalErrorSeen = true;
						else if (!message.errorMessage) terminalErrorSeen = false;
					}
					result.messages.push(storeMessage(message, policy));
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(storeMessage(event.message as Message, policy));
					emitUpdate();
				}

				// After a terminal error the child should exit on its own; each event
				// restarts the grace (momentary progress is not recovery), so the
				// timer is never left disarmed while the error state stands. When it
				// fires, the stalled child is terminated instead of hanging until
				// timeoutMs.
				if (terminalErrorTimer) {
					clearTimeout(terminalErrorTimer);
					terminalErrorTimer = null;
				}
				if (terminalErrorSeen) {
					terminalErrorTimer = setTimeout(() => {
						terminalProviderError = true;
						controls.terminate();
					}, errorGraceMs);
					terminalErrorTimer.unref?.();
				}
			},
			onNonJsonLine: (line) => {
				result.stdoutParseErrors = (result.stdoutParseErrors ?? 0) + 1;
				result.stdoutSample = capBytes(`${result.stdoutSample ?? ""}${sanitizeText(line, policy, STDOUT_SAMPLE_CAP)}\n`, STDOUT_SAMPLE_CAP, "Stdout sample");
			},
			onStderr: (chunk) => {
				result.stderr = appendCapped(result.stderr, chunk, policy);
			},
		});
		if (terminalErrorTimer) clearTimeout(terminalErrorTimer);
		timedOut = run.timedOut;
		wasAborted = run.aborted;

		result.exitCode = budgetTerminated || budgetUnobservable ? 1 : run.exitCode;
		if (budgetUnobservable) {
			result.stopReason = "budget_unobservable";
			result.error = budgetUnobservableError();
			result.errorMessage = result.error.message;
		} else if (budgetTerminated) {
			result.stopReason = "budget_exceeded";
			result.error = budgetExceededError(terminatingBudget as FlowBudget);
			result.errorMessage = result.error.message;
		} else if (timedOut) {
			result.stopReason = "timeout";
			result.error = flowError(
				"CHILD_TIMEOUT",
				`Flow agent "${agent.name}" timed out after ${timeoutMs}ms.`,
				"The child pi process did not finish before the configured timeout.",
				"Increase timeoutMs for intentionally long tasks, or inspect child/provider/network stalls.",
				true,
			);
			result.errorMessage = result.error.message;
			result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
		} else if (wasAborted) {
			result.stopReason = "aborted";
			result.error = flowError(
				"CHILD_ABORTED",
				"Flow agent was aborted.",
				"The parent request was interrupted before the child pi process completed.",
				"Retry the flow if the interruption was accidental.",
				true,
			);
			result.errorMessage = result.error.message;
		} else if (terminalProviderError) {
			result.stopReason = "error";
			result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
			result.error = flowError(
				"CHILD_PROVIDER_ERROR",
				`Flow agent "${agent.name}" hit a terminal provider error: ${result.errorMessage ?? "unknown provider error"}`,
				"The child's model provider returned a terminal error and the child process stalled instead of exiting, so pi-flows terminated it after the error grace period rather than waiting out timeoutMs.",
				"Narrow the task or the material the child reads, or pick a larger-context model via tier/model, then retry. PI_FLOWS_ERROR_GRACE_MS tunes the grace (default 30000).",
				true,
			);
			result.errorMessage = result.error.message;
		} else if (run.spawnErrorMessage) {
			result.stderr = appendCapped(result.stderr, run.spawnErrorMessage, policy);
			result.stopReason = "error";
			result.error = flowError(
				"CHILD_EXIT_NONZERO",
				`Could not start flow agent "${agent.name}".`,
				`Spawning child pi failed: ${sanitizeText(run.spawnErrorMessage, policy)}.`,
				"Verify that `pi` is installed and available on PATH, or run pi-flows from the pi CLI.",
				true,
			);
			result.errorMessage = result.error.message;
		} else if (!run.sawJsonEvent && (result.stdoutParseErrors ?? 0) > 0) {
			result.stopReason = "error";
			result.error = flowError(
				"CHILD_PROTOCOL_ERROR",
				`Flow agent "${agent.name}" did not produce valid pi JSON output.`,
				"The child process wrote non-JSON stdout while pi-flows expected `pi --mode json` events.",
				"Run with a current pi version and inspect stdoutSample/stderr for provider or startup failures.",
				true,
			);
			result.errorMessage = result.error.message;
		} else if (run.exitCode !== 0) {
			result.stopReason = "error";
			result.error = flowError(
				"CHILD_EXIT_NONZERO",
				`Flow agent "${agent.name}" exited with code ${run.exitCode}.`,
				result.stderr || "The child pi process returned a non-zero exit code.",
				"Inspect stderr and verify provider auth, model name, cwd, and pi installation.",
				true,
			);
			result.errorMessage = result.error.message;
		} else if (run.exitCode === 0 && result.messages.length === 0) {
			result.stopReason = "error";
			result.exitCode = 1;
			result.error = flowError(
				"CHILD_PROTOCOL_ERROR",
				`Flow agent "${agent.name}" completed without assistant output.`,
				"The child process exited successfully but emitted no usable assistant message.",
				"Inspect stdoutSample/stderr and verify the child pi JSON protocol.",
				true,
			);
			result.errorMessage = result.error.message;
		}
		if (isFailed(result)) takeRawFinalAssistantText(result);
		return result;
	} finally {
		result.durationMs = Date.now() - started;
		options.recordSpan?.(result, { scope: options.scope, attributes: childSpanAttributes(options, agent, tools, policy) });
		if (budgetTerminated || budgetUnobservable) {
			options.recordEvent?.({
				kind: "budget",
				name: budgetUnobservable ? "child.unobservable" : "child.exhausted",
				ok: false,
				scope: options.scope,
				attributes: {
					"flow.budget.terminated_agent": agent.name,
					"flow.budget.authority": (terminatingBudget ?? options.budget) === options.contractBudget ? "contract" : "flow",
					...budgetAttributes(
						terminatingBudget ?? options.budget,
						(terminatingBudget ?? options.budget) === options.contractBudget ? "flow.contract_budget" : "flow.budget",
					),
				},
			});
		}
		await Promise.all(tempFiles.map((tmp) => fs.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined)));
	}
}


// The fan-out/dispatch plumbing moved to dispatch.ts to keep this module focused
// on the seam's production adapter. Handlers import both from here.
export { mapWithConcurrency, runAgentFanout, runAgentRef, type AgentFanoutItem, type AgentRunLimits, type AgentRunPlacement } from "./dispatch.ts";
