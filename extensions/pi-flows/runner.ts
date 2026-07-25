import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { STDOUT_SAMPLE_CAP, budgetExceeded, budgetExceededError, chargeBudget, emptyUsage, flowError, type CapturePolicy, type FlowAgent, type FlowAgentRefInput, type FlowBudget, type FlowDetails, type FlowMode, type FlowRunResult, type ModeDeps, type RecordSpan, type Update } from "./types.ts";
import { appendCapped, capBytes, getFinalAssistantText, makeEmptyRunResult, sanitizeText, storeMessage } from "./sanitize.ts";
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

export async function runFlowAgent(options: {
	defaultCwd: string;
	agents: FlowAgent[];
	agentName: string;
	task: string;
	cwd?: string;
	model?: string;
	tier?: string;
	tools?: string;
	timeoutMs?: number;
	recordContent?: boolean;
	redactSecrets?: boolean;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: Update;
	budget?: FlowBudget;
	recordSpan?: RecordSpan;
	makeDetails: (results: FlowRunResult[]) => FlowDetails;
}): Promise<FlowRunResult> {
	const policy: CapturePolicy = { recordContent: options.recordContent ?? true, redactSecrets: options.redactSecrets ?? true };
	// Cost ceiling: refuse to spawn once the flow tree's cumulative spend is spent.
	if (budgetExceeded(options.budget)) {
		return makeEmptyRunResult(options.agentName, options.task, policy, budgetExceededError(options.budget as FlowBudget));
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
	try {
		if (agent.systemPrompt.trim()) {
			const systemPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt, "system");
			tempFiles.push(systemPrompt);
			args.push("--append-system-prompt", systemPrompt.filePath);
		}

		const taskPrompt = await writePromptToTempFile(agent.name, `Task: ${options.task}\n`, "task");
		tempFiles.push(taskPrompt);
		args.push(`@${taskPrompt.filePath}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: path.resolve(options.defaultCwd, options.cwd ?? options.defaultCwd),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_FLOWS_DEPTH: String(currentFlowDepth() + 1) },
			});

			emitUpdate("starting child pi process...");
			let buffer = "";
			let sawJsonEvent = false;
			let closed = false;
			let timer: NodeJS.Timeout | null = null;
			let forceKillTimer: NodeJS.Timeout | null = null;
			let abortListener: (() => void) | null = null;
			const terminate = () => {
				if (closed) return;
				try { proc.kill("SIGTERM"); } catch {}
				if (forceKillTimer) return;
				forceKillTimer = setTimeout(() => {
					forceKillTimer = null;
					try { if (!closed) proc.kill("SIGKILL"); } catch {}
				}, 5000);
				forceKillTimer.unref?.();
			};

			const finish = (code: number) => {
				if (closed) return;
				closed = true;
				if (timer) clearTimeout(timer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
				if (abortListener) options.signal?.removeEventListener("abort", abortListener);
				resolve(code);
			};

			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					result.stopReason = "timeout";
					result.error = flowError(
						"CHILD_TIMEOUT",
						`Flow agent "${agent.name}" timed out after ${timeoutMs}ms.`,
						"The child pi process did not finish before the configured timeout.",
						"Increase timeoutMs for intentionally long tasks, or inspect child/provider/network stalls.",
						true,
					);
					result.errorMessage = result.error.message;
					terminate();
				}, timeoutMs);
				timer.unref?.();
			}

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
					sawJsonEvent = true;
				} catch {
					result.stdoutParseErrors = (result.stdoutParseErrors ?? 0) + 1;
					result.stdoutSample = capBytes(`${result.stdoutSample ?? ""}${sanitizeText(line, policy, STDOUT_SAMPLE_CAP)}\n`, STDOUT_SAMPLE_CAP, "Stdout sample");
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					if (message.role === "assistant") {
						result.usage.turns += 1;
						const usage = message.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
						}
						if (!result.model && message.model) result.model = message.model;
						if (message.stopReason) result.stopReason = message.stopReason;
						if (message.errorMessage) result.errorMessage = sanitizeText(message.errorMessage, policy);
					}
					result.messages.push(storeMessage(message, policy));
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(storeMessage(event.message as Message, policy));
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr = appendCapped(result.stderr, data.toString(), policy);
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (!sawJsonEvent && (result.stdoutParseErrors ?? 0) > 0 && !result.error) {
					result.stopReason = "error";
					result.error = flowError(
						"CHILD_PROTOCOL_ERROR",
						`Flow agent "${agent.name}" did not produce valid pi JSON output.`,
						"The child process wrote non-JSON stdout while pi-flows expected `pi --mode json` events.",
						"Run with a current pi version and inspect stdoutSample/stderr for provider or startup failures.",
						true,
					);
					result.errorMessage = result.error.message;
				}
				finish(code ?? 0);
			});

			proc.on("error", (error) => {
				result.stderr = appendCapped(result.stderr, error.message, policy);
				result.stopReason = "error";
				result.error = flowError(
					"CHILD_EXIT_NONZERO",
					`Could not start flow agent "${agent.name}".`,
					`Spawning child pi failed: ${sanitizeText(error.message, policy)}.`,
					"Verify that `pi` is installed and available on PATH, or run pi-flows from the pi CLI.",
					true,
				);
				result.errorMessage = result.error.message;
				finish(1);
			});

			abortListener = () => {
				wasAborted = true;
				result.stopReason = "aborted";
				terminate();
			};
			if (options.signal?.aborted) abortListener();
			else options.signal?.addEventListener("abort", abortListener, { once: true });
		});

		result.exitCode = exitCode;
		if (timedOut) {
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
		} else if (exitCode !== 0 && !result.error) {
			result.stopReason = "error";
			result.error = flowError(
				"CHILD_EXIT_NONZERO",
				`Flow agent "${agent.name}" exited with code ${exitCode}.`,
				result.stderr || "The child pi process returned a non-zero exit code.",
				"Inspect stderr and verify provider auth, model name, cwd, and pi installation.",
				true,
			);
			result.errorMessage = result.error.message;
		} else if (exitCode === 0 && result.messages.length === 0 && !result.error) {
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
		return result;
	} finally {
		result.durationMs = Date.now() - started;
		chargeBudget(options.budget, result.usage);
		options.recordSpan?.(result);
		await Promise.all(tempFiles.map((tmp) => fs.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined)));
	}
}

export async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});

	await Promise.all(workers);
	return results;
}

export interface AgentFanoutItem {
	ref: FlowAgentRefInput;
	task: string;
	placeholderTask?: string;
}

export async function runAgentFanout(
	deps: ModeDeps,
	mode: FlowMode,
	items: AgentFanoutItem[],
	concurrency: number,
	priorResults: FlowRunResult[],
	statusText: (done: number, total: number) => string,
): Promise<FlowRunResult[]> {
	const liveResults: FlowRunResult[] = items.map((item) => makeEmptyRunResult(item.ref.agent, item.placeholderTask ?? item.task, deps.policy));
	const completed = new Set<number>();
	const emit = () => {
		deps.onUpdate?.({
			content: [{ type: "text", text: statusText(completed.size, liveResults.length) }],
			details: deps.makeDetails(mode)([...priorResults, ...liveResults]),
		});
	};
	const baseStep = priorResults.length;
	return mapWithConcurrency(items, concurrency, async (item, index) => {
		const result = await runFlowAgent({
			defaultCwd: deps.defaultCwd,
			agents: deps.discovery.agents,
			agentName: item.ref.agent,
			task: item.task,
			cwd: item.ref.cwd,
			model: item.ref.model ?? deps.params.model,
			tier: item.ref.tier ?? deps.params.tier,
			tools: item.ref.tools,
			timeoutMs: deps.params.timeoutMs,
			recordContent: deps.params.recordContent,
			redactSecrets: deps.params.redactSecrets,
			step: baseStep + index + 1,
			signal: deps.signal,
			budget: deps.budget,
			recordSpan: deps.recordSpan,
			onUpdate: (partial) => {
				const current = partial.details.results[0];
				if (current) liveResults[index] = current;
				emit();
			},
			makeDetails: deps.makeDetails(mode),
		});
		liveResults[index] = result;
		completed.add(index);
		emit();
		return result;
	});
}

/** Run one agent role with the standard param plumbing, emitting live updates appended to `priorResults`. */
export function runAgentRef(deps: ModeDeps, ref: FlowAgentRefInput, task: string, mode: FlowMode, step: number, priorResults: FlowRunResult[]): Promise<FlowRunResult> {
	return runFlowAgent({
		defaultCwd: deps.defaultCwd,
		agents: deps.discovery.agents,
		agentName: ref.agent,
		task,
		cwd: ref.cwd,
		model: ref.model ?? deps.params.model,
		tier: ref.tier ?? deps.params.tier,
		tools: ref.tools,
		timeoutMs: deps.params.timeoutMs,
		recordContent: deps.params.recordContent,
		redactSecrets: deps.params.redactSecrets,
		step,
		signal: deps.signal,
		budget: deps.budget,
		recordSpan: deps.recordSpan,
		onUpdate: (partial) => {
			const current = partial.details.results[0];
			deps.onUpdate?.({ content: partial.content, details: deps.makeDetails(mode)([...priorResults, ...(current ? [current] : [])]) });
		},
		makeDetails: deps.makeDetails(mode),
	});
}
