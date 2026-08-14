import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CHILD_ERROR_GRACE_MS, STDOUT_SAMPLE_CAP, emptyUsage, flowError, type Budget, type CapturePolicy, type ChildMessage, type ChildMessageBlock, type FlowError, type ChildSpanScope, type DelegationContract, type FlowAgent, type FlowAgentRefInput, type FlowMode, type FlowRunResult, type ModeDeps, type ModelRoster, type RunChildOptions, type SpanStage, type ThinkingLevel } from "./types.ts";
import { resolveChildModel, type ChildModelChoice } from "./child-model.ts";
import { accumulatePiUsage, runJsonlProcess } from "./jsonl-child.mjs";
import { Run } from "./run.ts";
import { appendCapped, capBytes, getFinalAssistantText, isFailed, makeEmptyRunResult, sanitizeText, storeMessage } from "./sanitize.ts";
import { budgetAttributes, delegationIdentityAttributes } from "./trace-attributes.ts";
import { BASH_READONLY_ENV, bashReadonlyGitEnv } from "./bash-readonly.ts";
import { WRAPUP_FILE_ENV, requestWrapUp } from "./wrapup.ts";
import { contractWrapUpRequirement } from "./contract-resolution.ts";
import { ChildBudgets } from "./runner-budget.ts";
import { applyReadonlySandbox } from "./bash-readonly-sandbox.ts";
import { currentFlowDepth, normalizeTimeout } from "./validate.ts";
import { buildChildArgs, getPiInvocation } from "./commands.ts";
import { describeProviderFailure, modelContextWindow, providerFailureGuidance, providerFailureRetryable } from "./provider-failure.ts";

/**
 * The ACL translation for child transcript messages: project the child
 * protocol's message into pi-flows' own ChildMessage, keeping only the fields
 * the domain reads. Everything above this module sees the owned shape.
 */
function toChildMessage(message: Message): ChildMessage {
	const content: ChildMessageBlock[] = Array.isArray(message.content)
		? message.content.map((part: any): ChildMessageBlock => {
				if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
				if (part?.type === "toolCall" && typeof part.name === "string") return { type: "toolCall", name: part.name, arguments: part.arguments };
				return { type: typeof part?.type === "string" ? part.type : "unknown" };
			})
		: [];
	const toolName = (message as { toolName?: unknown }).toolName;
	return { role: message.role, content, ...(typeof toolName === "string" ? { toolName } : {}) };
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

// Child model/level resolution lives in child-model.ts; re-exported here
// because the runner is where every existing consumer of the seam looks.
export { resolveChildModel, type ChildModelChoice };

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
function childSpanAttributes(options: RunChildOptions, agent: FlowAgent | undefined, allowedTools: string[] | undefined, policy: CapturePolicy, choice: ChildModelChoice, bashRoEnforcement?: string): Record<string, unknown> {
	return {
		"flow.bash_ro.enforcement": bashRoEnforcement,
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
		"flow.role": sanitizeRole(options.role, policy),
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

/** A caller or preset controls role labels, so capture them under the same policy as task text. */
function sanitizeRole(role: string | undefined, policy: CapturePolicy): string | undefined {
	return role === undefined ? undefined : sanitizeText(role, policy, 4 * 1024);
}

/** Production adapter for the child-run seam (ModeDeps.runChild): one real pi subprocess per call. */
export async function runFlowAgent(options: RunChildOptions): Promise<FlowRunResult> {
	const policy: CapturePolicy = { recordContent: options.recordContent ?? true, redactSecrets: options.redactSecrets ?? true };
	const capturedRole = sanitizeRole(options.role, policy);
	// Every budget decision — refusal, hard stop, wrap-up, settle, trace events —
	// lives in ChildBudgets (runner-budget.ts); this adapter only asks it.
	const childBudgets = new ChildBudgets(
		[options.budget, options.contractBudget].filter((budget): budget is Budget => Boolean(budget)),
		options.recordEvent,
		options.scope,
		options.contract ? contractWrapUpRequirement(options.contract) : undefined,
	);
	const refusal = childBudgets.refuseSpawn(options.agentName);
	if (refusal) {
		const result = makeEmptyRunResult(options.agentName, options.task, policy, refusal);
		result.role = capturedRole;
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
			minted: true,
			scope: options.scope,
			attributes: { "flow.dispatch.requested_agent": options.agentName, "flow.error_code": error.code },
		});
		const result = makeEmptyRunResult(options.agentName, options.task, policy, error);
		result.role = capturedRole;
		return result;
	}

	const started = Date.now();
	// Stamped again immediately before the process run: per-child setup (the
	// prompt file, the read-only sandbox) is asynchronous, and an interval
	// measured from `started` would show children overlapping before either
	// process existed.
	let spawnedAt: number | undefined;
	const timeoutMs = normalizeTimeout(options.timeoutMs);
	// Resolved once: the same choice fills the result, the span, and the argv, so
	// a run can never report a model or level it did not actually spawn with.
	const choice = resolveChildModel(agent, { model: options.model, tier: options.tier, thinking: options.thinking, flowThinking: options.flowThinking }, options.roster);
	if (choice.refusal) {
		// Spawning anyway would launch the child unpinned — pi's configured
		// default, possibly a model the session scope excludes. Refused like the
		// bash-ro unenforceable case: a structured error, no process.
		const error = flowError(
			"MODEL_SCOPE_UNSATISFIABLE",
			`Flow agent "${agent.name}" was not dispatched: ${choice.refusal}.`,
			"The session's model scope admits no model an automatic tier could name, and no session model or explicit pin was available to anchor to.",
			"Widen the session's model scope (/scoped-models or --models), name a model explicitly on the call, agent, or pi-flows config, or run from a session with a current model.",
		);
		options.recordEvent?.({ kind: "validation", name: "dispatch.model_scope_unsatisfiable", ok: false, minted: true, scope: options.scope, attributes: { "flow.dispatch.requested_agent": options.agentName, "flow.error_code": error.code } });
		return Object.assign(makeEmptyRunResult(options.agentName, options.task, policy, error), { role: capturedRole });
	}
	const result: FlowRunResult = {
		agent: agent.name,
		role: capturedRole,
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

	const { args, tools, enforcement, error: bashRoError } = buildChildArgs({ model: choice.model, thinking: choice.thinking, noExtensions: childExtensionsDisabled(), toolsOverride: options.tools, agentTools: agent.tools });
	if (bashRoError) {
		options.recordEvent?.({ kind: "validation", name: "dispatch.bash_readonly_unenforceable", ok: false, minted: true, scope: options.scope, attributes: { "flow.dispatch.requested_agent": options.agentName, "flow.error_code": bashRoError.code } });
		return Object.assign(makeEmptyRunResult(options.agentName, options.task, policy, bashRoError), { role: capturedRole });
	}

	const tempFiles: Array<{ dir: string; filePath: string }> = [];
	let wasAborted = false;
	let timedOut = false;
	/** Set when the budget refused this child after async setup: the child never ran, so no span or budget outcome is recorded for it. */
	let refusedLate: FlowRunResult | undefined;
	try {
		if (agent.systemPrompt.trim()) {
			const systemPrompt = await writePromptToTempFile(agent.name, agent.systemPrompt, "system");
			tempFiles.push(systemPrompt);
			args.push("--append-system-prompt", systemPrompt.filePath);
		}

		const taskPrompt = await writePromptToTempFile(agent.name, `Task: ${options.task}\n`, "task");
		tempFiles.push(taskPrompt);
		args.push(`@${taskPrompt.filePath}`);
		// The wrap-up channel rides in the task's temp dir so it shares its
		// lifetime; it is offered only to a child that runs under some budget.
		const wrapUpFile = path.join(taskPrompt.dir, "wrap-up.md");

		const childCwd = path.resolve(options.defaultCwd, options.cwd ?? options.defaultCwd);
		let invocation = getPiInvocation(args);
		// null wrap only if the host lost the sandbox since the check; the -e allowlist enforcer already rode along, so the child stays enforced.
		const sandboxed = enforcement === "sandbox" ? await applyReadonlySandbox(invocation, childCwd) : null;
		if (sandboxed) {
			invocation = sandboxed.invocation;
			tempFiles.push(sandboxed.tempFile);
		}
		// Siblings sharing a budget kept settling turns during the awaited prompt
		// and sandbox setup above; a ceiling crossed in that window must refuse
		// this child now — nearsLiveStop stays true past 100%, so checking only
		// the soft threshold here would steer and spawn a child the budget
		// already refuses.
		const lateRefusal = childBudgets.refuseSpawn(options.agentName);
		if (lateRefusal) {
			refusedLate = Object.assign(makeEmptyRunResult(options.agentName, options.task, policy, lateRefusal), { role: capturedRole });
			return refusedLate;
		}
		// Join the wrap-up channel: a shared ceiling already inside the window
		// steers this child now, and a threshold any sibling's turn crosses later
		// steers it the same way — the transition belongs to the budget, not to
		// whichever child's settled turn happened to cross it.
		childBudgets.arm((notice) => {
			result.wrapUpRequested = true;
			requestWrapUp(wrapUpFile, notice);
		});
		emitUpdate("starting child pi process...");
		const rawGrace = Number(process.env.PI_FLOWS_ERROR_GRACE_MS);
		const errorGraceMs = Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : DEFAULT_CHILD_ERROR_GRACE_MS;
		let terminalErrorTimer: NodeJS.Timeout | null = null;
		let terminalErrorSeen = false;
		let terminalProviderError = false;
		let terminalProviderDiagnostic: string | undefined;
		let terminalProviderContextTokens: number | undefined;
		spawnedAt = Date.now();
		const run = await runJsonlProcess({
			command: invocation.command,
			args: invocation.args,
			cwd: childCwd,
			// "" not an omitted key: the spread must not leak a parent's marker into grandchildren. Git-helper neutralization rides along for bash-ro children.
			env: { ...process.env, PI_FLOWS_DEPTH: String(currentFlowDepth() + 1), [BASH_READONLY_ENV]: enforcement ? "1" : "", [WRAPUP_FILE_ENV]: childBudgets.governed ? wrapUpFile : "", ...(enforcement ? bashReadonlyGitEnv() : {}) },

			timeoutMs,
			signal: options.signal,
			onEvent: (event, controls) => {
				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					if (message.role === "assistant") {
						if (options.captureRawOutput) Run.of(result).captureEnvelopeCandidate(toChildMessage(message));
						const turnUsage = emptyUsage();
						accumulatePiUsage(turnUsage, message);
						accumulatePiUsage(result.usage, message);
						if (childBudgets.chargeTurn(turnUsage, !message.errorMessage).terminate) controls.terminate();
						if (message.model && (!result.model || result.model === message.model)) {
							const p = (message as { provider?: unknown }).provider;
							result.model = typeof p === "string" ? `${p}/${message.model}` : message.model;
						}
						if (message.stopReason) result.stopReason = message.stopReason;
						if (message.errorMessage) {
							terminalProviderDiagnostic = sanitizeText(message.errorMessage, policy);
							terminalProviderContextTokens = Number.isFinite(message.usage?.totalTokens) ? message.usage?.totalTokens : undefined;
							result.errorMessage = policy.recordContent ? terminalProviderDiagnostic : "[content omitted: recordContent=false]";
						}
						// Only a later healthy assistant turn proves recovery.
						if (message.errorMessage && message.stopReason === "error") terminalErrorSeen = true;
						else if (!message.errorMessage) terminalErrorSeen = false;
					}
					// The steered wrap-up notice re-enters the child's stream as a user
					// message; seeing it echoed verbatim is the proof of delivery that
					// lets a later exhaustion settle gracefully instead of forfeiting
					// the run. ChildBudgets does the exact comparison.
					if (message.role === "user" && Array.isArray(message.content)) {
						childBudgets.confirmDelivery(message.content.map((part: any) => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("\n"));
					}
					result.messages.push(storeMessage(toChildMessage(message), policy));
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(storeMessage(toChildMessage(event.message as Message), policy));
					emitUpdate();
				}

				// Progress restarts the grace but does not prove provider recovery.
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
		// The child is gone: leave the channel now so a sibling's later
		// transition cannot mark this settled run as steered. The finally-block
		// release stays for the paths that never reach here.
		childBudgets.release();
		timedOut = run.timedOut;
		wasAborted = run.aborted;

		result.exitCode = run.exitCode;
		if (childBudgets.settle(result)) {
			// The budget owned the outcome — graceful wrap-up or hard stop — so the
			// ordinary exit-code cascade below must not reinterpret it.
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
		} else if (terminalProviderError || terminalErrorSeen) {
			// Preserve the provider outcome whether the child exits or the grace kills it.
			result.stopReason = "error";
			result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
			const diagnostic = terminalProviderDiagnostic ?? result.errorMessage ?? "unknown provider error";
			result.providerFailure = describeProviderFailure(
				diagnostic,
				terminalProviderError ? "grace_terminated" : "prompt_exit",
				terminalProviderContextTokens,
				modelContextWindow(options.roster, result.model),
				choice.thinking !== undefined && choice.thinkingVerified,
			);
			if (!policy.recordContent) result.providerFailure.diagnostic = result.errorMessage!;
			result.error = flowError(
				"CHILD_PROVIDER_ERROR",
				`Flow agent "${agent.name}" hit a terminal provider error: ${result.providerFailure.diagnostic}`,
				// Keep prompt exit distinct from grace termination.
				terminalProviderError
					? "The child's model provider returned a terminal error and the child process stalled instead of exiting, so pi-flows terminated it after the error grace period rather than waiting out timeoutMs."
					: "The child's model provider returned a terminal error and the child process then exited on its own.",
				`${providerFailureGuidance(result.providerFailure.category)}${terminalProviderError ? " PI_FLOWS_ERROR_GRACE_MS tunes the grace (default 30000)." : ""}`,
				providerFailureRetryable(result.providerFailure.category),
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
		if (isFailed(result)) Run.of(result).discardEnvelopeCandidate();
		return result;
	} finally {
		// A late refusal spawned nothing: like the pre-setup refusal it records
		// only its budget event (already emitted by refuseSpawn), never a child
		// span for a child that did not run.
		if (!refusedLate) {
			// From the actual spawn when one happened, so [startedAtMs, +durationMs]
			// is the child process interval; a failure before spawn falls back to
			// the run's own start.
			result.durationMs = Date.now() - (spawnedAt ?? started);
			result.startedAtMs = spawnedAt ?? started;
			options.recordSpan?.(result, { scope: options.scope, attributes: childSpanAttributes(options, agent, tools, policy, choice, enforcement ?? undefined) });
			childBudgets.recordOutcome(agent.name);
		}
		// Leave the channel before the temp dir goes: a sibling's later
		// transition must not write into a reclaimed directory.
		childBudgets.release();
		await Promise.all(tempFiles.map((tmp) => fs.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined)));
	}
}
