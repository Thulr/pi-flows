import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CHILD_ERROR_GRACE_MS, STDOUT_SAMPLE_CAP, emptyUsage, flowError, type Budget, type CapturePolicy, type FlowError, type ChildSpanScope, type DelegationContract, type FlowAgent, type FlowAgentRefInput, type FlowMode, type FlowRunResult, type ModeDeps, type ModelRoster, type RunChildOptions, type SpanStage, type ThinkingLevel } from "./types.ts";
import { clampThinking, knownModel, parseModelSpec, rosterAssignment } from "./model-roster.ts";
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
// No model ids are hard-coded here, and none ever will be — a map this repo
// maintained would go stale as providers ship models. What each tier resolves to
// on a given install is derived instead, by ranking the models that install can
// actually run (see model-roster.ts, sourced from pi in roster-source.ts). This
// module owns only the per-call precedence.
//
//   tier: capable  -> the user's default model, at the parent's thinking level
//   tier: fast     -> the roster's cheapest usable model, thinking lowered
//   tier: deep     -> the roster's most capable model, thinking raised
//   model: <id>    -> explicit pin; always wins (as does a flow `model` override)
//
// A pin may carry pi's `:<level>` shorthand (`provider/id:high`), which is
// parsed out rather than passed through, so the level lands on --thinking and
// the recorded model stays a plain reference.

function childExtensionsDisabled(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_FLOWS_CHILD_NO_EXTENSIONS?.trim() ?? "");
}

/** What one child will actually run as. */
export interface ChildModelChoice {
	/** undefined = omit --model, so the child uses the user's default. */
	model?: string;
	/** The level passed on `--thinking`. undefined = omit it, so pi's configured level applies. */
	thinking?: ThinkingLevel;
	/**
	 * Whether that level was checked against the model it will run on.
	 *
	 * False when the child names no model: it then loads pi's *configured*
	 * default, which an extension cannot read, so pi may lower the level
	 * internally and this value is a request rather than an outcome. Reporting it
	 * as the effective level would corrupt any experiment that reads the field as
	 * what actually ran.
	 */
	thinkingVerified: boolean;
}

/**
 * Model and thinking level for a child run.
 *
 * Model: flow model override > flow tier > agent pin > agent tier > pi default.
 * A call-site tier beats an agent's pinned model because the parent is
 * expressing per-task intent. A tier the roster could not resolve at all (no
 * registry) still falls through to the agent pin, so flows keep working when the
 * roster is unavailable.
 *
 * The fall-through tests whether the rung *answered*, not whether it named a
 * model, because "run the pi default" is an answer. Treating it as silence would
 * mean a `deep` call landing on an install whose default is already the
 * strongest model would fall through to a fast agent's pin and run the cheap
 * one — the exact inversion of what was asked for.
 *
 * Thinking follows the same shape one rung at a time, so a call that names only
 * a tier still gets that tier's level, and a call that names only a level keeps
 * whatever model the tier chose. The result is clamped to the resolved model:
 * what is reported is what the child ran at, not what was wished for.
 */
export function resolveChildModel(
	agent: { model?: string; tier?: string; thinking?: ThinkingLevel },
	options: { model?: string; tier?: string; thinking?: ThinkingLevel; flowThinking?: ThinkingLevel },
	roster: ModelRoster | undefined,
): ChildModelChoice {
	const optionsTier = rosterAssignment(roster, options.tier);
	const agentTier = rosterAssignment(roster, agent.tier);
	const optionsPin = options.model ? parseModelSpec(options.model) : undefined;
	const agentPin = agent.model ? parseModelSpec(agent.model) : undefined;

	// `null` from any rung means "the pi default", and is normalized to undefined
	// only here, at the point the answer becomes argv.
	const answered = (assignment: { model?: string | null } | undefined) => assignment?.model !== undefined;
	const model = optionsPin?.model
		?? (answered(optionsTier)
			? optionsTier?.model ?? undefined
			: agentPin?.model ?? (answered(agentTier) ? agentTier?.model ?? undefined : undefined));

	// One ordered list rather than nested conditionals: every source of a level,
	// narrowest first. The tier rungs sit below the explicit statements so naming
	// a level never gets overruled by the rung that supplied the model.
	const requested = [
		options.thinking,
		optionsPin?.thinking,
		options.flowThinking,
		optionsTier?.thinking,
		agent.thinking,
		agentPin?.thinking,
		agentTier?.thinking,
	].find((level) => level !== undefined);

	const resolved = knownModel(roster, model);
	return {
		model,
		thinking: clampThinking(requested, resolved),
		thinkingVerified: requested === undefined || resolved !== undefined,
	};
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
function childSpanAttributes(options: RunChildOptions, agent: FlowAgent | undefined, allowedTools: string[] | undefined, policy: CapturePolicy, choice: ChildModelChoice): Record<string, unknown> {
	return {
		// Sibling of the span's `llm.model_name`, and recorded here for the same
		// reason as the rest of this block: it is the *resolved* level, after tier
		// and clamping, not the one the call asked for. Without it two children of
		// an experiment that varies only effort have identical span identities, and
		// a recorded result cannot say whether it ran at low or max.
		"flow.thinking_level": choice.thinking,
		// Whether that level is an outcome or only a request. A child that names no
		// model runs pi's configured default, which cannot be read here, so the
		// level may be lowered inside pi without this ever seeing it.
		"flow.thinking_level_verified": choice.thinking === undefined ? undefined : choice.thinkingVerified,
		"flow.role": options.role,
		...delegationIdentityAttributes({
			systemPrompt: agent?.systemPrompt ?? "",
			allowedTools,
			contract: options.contract,
			delegationReason: options.delegationReason,
			policy,
		}),
		...budgetAttributes(options.budget?.snapshot()),
		...budgetAttributes(options.contractBudget?.snapshot()),
	};
}

/** Production adapter for the child-run seam (ModeDeps.runChild): one real pi subprocess per call. */
export async function runFlowAgent(options: RunChildOptions): Promise<FlowRunResult> {
	const policy: CapturePolicy = { recordContent: options.recordContent ?? true, redactSecrets: options.redactSecrets ?? true };
	const budgets = [options.budget, options.contractBudget].filter((budget): budget is Budget => Boolean(budget));
	// Flow or contract ceiling: refuse to spawn once the applicable budget is spent.
	// Everything downstream — the event's authority, its attribute prefix, the
	// error's label and ceiling — comes from the budget that refused, so a
	// contract-bound refusal can never be reported as a flow-budget one.
	const exhaustedBudget = budgets.find((budget) => budget.refusesSpawn());
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
				"flow.budget.authority": exhaustedBudget.authority,
				...budgetAttributes(exhaustedBudget.snapshot()),
			},
		});
		const result = makeEmptyRunResult(options.agentName, options.task, policy, exhaustedBudget.exhaustedError());
		result.role = options.role;
		return result;
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
		const result = makeEmptyRunResult(options.agentName, options.task, policy, error);
		result.role = options.role;
		return result;
	}

	const started = Date.now();
	const timeoutMs = normalizeTimeout(options.timeoutMs);
	// Resolved once: the same choice fills the result, the span, and the argv, so
	// a run can never report a model or level it did not actually spawn with.
	const choice = resolveChildModel(agent, { model: options.model, tier: options.tier, thinking: options.thinking, flowThinking: options.flowThinking }, options.roster);
	const result: FlowRunResult = {
		agent: agent.name,
		role: options.role,
		agentSource: agent.source,
		task: sanitizeText(options.task, policy, 4 * 1024),
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: choice.model,
		thinking: choice.thinking,
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
	if (choice.model) args.push("--model", choice.model);
	// Passed as its own flag rather than as a `model:level` suffix, so a level
	// still reaches a child that is running the user's default model.
	if (choice.thinking) args.push("--thinking", choice.thinking);

	const tools = parseToolsOverride(options.tools, agent.tools);
	if (tools !== undefined) {
		if (tools.length === 0) args.push("--no-builtin-tools");
		else args.push("--tools", tools.join(","));
	}

	const tempFiles: Array<{ dir: string; filePath: string }> = [];
	let wasAborted = false;
	let timedOut = false;
	/**
	 * The budget decision that stopped this run: which budget, and whether it was
	 * exhausted or could not be enforced at all. One value rather than a flag pair
	 * plus a separate budget reference, because those three could disagree — a
	 * turn arriving between `terminate()` and the child actually exiting used to
	 * be able to clear the budget while the flag stayed latched.
	 */
	let budgetStop: { budget: Budget; reason: "exhausted" | "unobservable"; error: FlowError } | undefined;
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
						for (const budget of budgets) budget.charge(turnUsage);
						// Latched on the first decision to stop: a turn that arrives after
						// terminate() must not overwrite the budget that caused it. Named
						// against the budget that actually bound, so a contract-only ceiling
						// is never reported as a flow-budget one.
						if (!budgetStop && !message.errorMessage) {
							const unenforceable = turnUsage.costKnown === false ? budgets.find((budget) => budget.enforcesCost) : undefined;
							// Which ceilings bite mid-stream depends on the budget's authority;
							// the budget decides, this loop only asks. See Budget.stopsLiveRun.
							const stopped = unenforceable ?? budgets.find((budget) => budget.stopsLiveRun());
							if (stopped) {
								// The error is built HERE, not at the end. A budget keeps charging
								// for turns that arrive between terminate() and the child actually
								// exiting, so a ceiling crossed only afterwards could otherwise
								// out-rank the one that caused the stop and be reported as the
								// cause. This freezes the reason at the moment it became true.
								budgetStop = {
									budget: stopped,
									reason: unenforceable ? "unobservable" : "exhausted",
									error: unenforceable ? stopped.unobservableError() : stopped.exhaustedError(),
								};
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

		result.exitCode = budgetStop ? 1 : run.exitCode;
		if (budgetStop) {
			result.stopReason = budgetStop.reason === "unobservable" ? "budget_unobservable" : "budget_exceeded";
			result.error = budgetStop.error;
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
		options.recordSpan?.(result, { scope: options.scope, attributes: childSpanAttributes(options, agent, tools, policy, choice) });
		if (budgetStop) {
			// Its own unit, depending on the child. Reusing the child's key would
			// leave the event unable to rebind it — the span already owns it — so the
			// termination would carry the same name with no link to what caused it.
			const terminationScope = options.scope?.key
				? { stage: options.scope.stage, key: `${options.scope.key}.budget`, dependsOn: [options.scope.key] }
				: options.scope;
			options.recordEvent?.({
				kind: "budget",
				name: budgetStop.reason === "unobservable" ? "child.unobservable" : "child.exhausted",
				ok: false,
				scope: terminationScope,
				attributes: {
					"flow.budget.terminated_agent": agent.name,
					"flow.budget.authority": budgetStop.budget.authority,
					...budgetAttributes(budgetStop.budget.snapshot()),
				},
			});
		}
		await Promise.all(tempFiles.map((tmp) => fs.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined)));
	}
}


// The fan-out/dispatch plumbing moved to dispatch.ts to keep this module focused
// on the seam's production adapter. Handlers import both from here.
export { mapWithConcurrency, runAgentFanout, runAgentRef, type AgentFanoutItem, type AgentRunLimits, type AgentRunPlacement } from "./dispatch.ts";
