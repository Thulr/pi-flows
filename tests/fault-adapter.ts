// A deterministic, model-free fault injector for the child-run seam.
//
// Coordination failures are the ones pi-flows is supposed to contain, and they
// are exactly the ones a live-model test cannot reproduce on demand: a response
// that never arrives, one that arrives twice, one that arrives against the wrong
// request, one that is stale, one that is confidently wrong. This adapter
// replaces `ModeDeps.runChild` with a scripted responder and applies those
// faults on rules — no subprocess, no network, no wall-clock sleeping, and the
// same result on every run.
//
// Time is virtual. A "slow" child does not sleep; it reports a duration, and the
// adapter models what the real runner would do with it (a delay past the
// effective timeout becomes CHILD_TIMEOUT). That keeps a latency fault instant
// and deterministic instead of flaky and slow.
//
// What this fake does NOT prove: it re-states two of the real adapter's own
// pre-spawn rules — refuse once a ceiling is spent, and stop a child that runs
// past its timeout — so a scenario resting on them is testing the *mode's*
// behaviour given a seam that enforces them, not the enforcement itself. That
// enforcement is covered where it lives, against the real runner, in
// tests/flow-budget.test.ts and tests/provider-error.test.ts.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import { createHandoffGuard, resolveHandoffPolicy } from "../extensions/pi-flows/handoff.ts";
import { budgetAttributes } from "../extensions/pi-flows/trace-attributes.ts";
import { budgetExceeded, budgetExceededError, chargeBudget, emptyUsage, flowError, type FlowAgent, type FlowBudget, type FlowDiscovery, type FlowErrorCode, type FlowRunResult, type ModeDeps, type RecordEvent, type RunChildOptions } from "../extensions/pi-flows/types.ts";

export type FaultKind = "delay" | "loss" | "duplicate" | "reorder" | "failure" | "stale";

export interface FaultRule {
	kind: FaultKind;
	/** Restrict the rule to one agent. Omitted means every dispatch matches. */
	agent?: string;
	/** Apply to the nth (1-based) matching dispatch. Omitted means every match. */
	occurrence?: number;
	/** `delay`: virtual milliseconds the child takes. Past the effective timeout it becomes a timeout. */
	delayMs?: number;
	/** `failure`: the error the child comes back with. */
	errorCode?: FlowErrorCode;
	/** `stale` / `duplicate`: the body served instead of the fresh one. */
	replay?: string;
}

export interface DispatchRecord {
	index: number;
	agent: string;
	unitKey?: string;
	step?: number;
	task: string;
	/** Faults applied to this dispatch, in rule order. */
	faults: FaultKind[];
	/** How the reply was delivered: normally, not at all, as another dispatch's reply, or never spawned. */
	delivery: "fresh" | "lost" | "replayed" | "swapped" | "failed" | "refused";
	/** Virtual completion time, so a reordered or delayed run has a checkable ordering. */
	completedAtMs: number;
	durationMs: number;
}

/**
 * Every dispatch and delivery the run made. Residual-state checks read this
 * rather than inferring coordination from the final answer, which is precisely
 * the inference a persuasive-but-wrong child defeats.
 */
export class FaultLedger {
	readonly dispatches: DispatchRecord[] = [];
	readonly events: Array<{ kind: string; name: string; ok: boolean; attributes: Record<string, unknown> }> = [];

	countDelivered(delivery: DispatchRecord["delivery"]): number {
		return this.dispatches.filter((dispatch) => dispatch.delivery === delivery).length;
	}

	reached(agent: string): boolean {
		return this.dispatches.some((dispatch) => dispatch.agent === agent);
	}

	/** Coordination events the run attributed, so a scenario can assert on the trace record rather than on prose. */
	eventNames(kind?: string): string[] {
		return this.events.filter((event) => !kind || event.kind === kind).map((event) => event.name);
	}
}

/**
 * A scripted child turn. `writes` lets a child actually produce workspace files,
 * so an artifact scenario can corrupt a real file and a partial run can leave
 * real residue for a retry — rather than the test seeding both sides itself and
 * checking a file nothing ever wrote.
 */
export interface ScriptedReply {
	reply: string;
	writes?: Record<string, string>;
}

export type ReplyScript = string | ScriptedReply | Array<string | ScriptedReply>;

export interface FaultAdapterOptions {
	/** Reply per agent. A list advances across repeated dispatches to that agent. */
	replies: Record<string, ReplyScript>;
	faults?: FaultRule[];
	/** Per-turn usage the fake child reports, so budget scenarios can exhaust a real ceiling. */
	usage?: { input: number; output: number; cost: number };
}

const DEFAULT_USAGE = { input: 40, output: 20, cost: 0.02 };

function replyFor(replies: FaultAdapterOptions["replies"], agent: string, occurrence: number): ScriptedReply {
	const scripted = replies[agent];
	if (scripted === undefined) return { reply: `stub reply for ${agent}` };
	const turn = Array.isArray(scripted) ? scripted[Math.min(occurrence - 1, scripted.length - 1)] : scripted;
	return typeof turn === "string" ? { reply: turn } : turn;
}

function applyWrites(cwd: string, writes: Record<string, string> | undefined): void {
	for (const [name, content] of Object.entries(writes ?? {})) {
		const target = path.resolve(cwd, name);
		if (!target.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error(`scripted write escapes cwd: ${name}`);
		writeFileSync(target, content, "utf8");
	}
}

function matches(rule: FaultRule, agent: string, occurrence: number): boolean {
	if (rule.agent !== undefined && rule.agent !== agent) return false;
	return rule.occurrence === undefined || rule.occurrence === occurrence;
}

function baseResult(options: RunChildOptions, text: string, usage: FaultAdapterOptions["usage"]): FlowRunResult {
	const spend = usage ?? DEFAULT_USAGE;
	return {
		agent: options.agentName,
		agentSource: "package",
		task: options.task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
		stderr: "",
		usage: { ...emptyUsage(), input: spend.input, output: spend.output, cost: spend.cost, turns: 1 },
		step: options.step,
	};
}

function failedResult(options: RunChildOptions, code: FlowErrorCode, message: string, cause: string, retryable: boolean): FlowRunResult {
	const result = baseResult(options, message, { input: 0, output: 0, cost: 0 });
	result.exitCode = 1;
	result.stopReason = code === "CHILD_TIMEOUT" ? "timeout" : "error";
	result.error = flowError(code, message, cause, "Retry the contained child once the fault is cleared.", retryable);
	result.errorMessage = message;
	return result;
}

export interface FaultAdapter {
	runChild: ModeDeps["runChild"];
	ledger: FaultLedger;
}

/**
 * Build the scripted child-run seam. Faults are applied in rule order to the
 * matching dispatch; `reorder` and `duplicate` both need the previous reply, so
 * the adapter keeps the bodies it has already served.
 */
export function makeFaultAdapter(options: FaultAdapterOptions): FaultAdapter {
	const ledger = new FaultLedger();
	const occurrences = new Map<string, number>();
	const servedByAgent = new Map<string, string[]>();
	const pendingSwap = new Map<string, string>();
	let clockMs = 0;

	const runChild: ModeDeps["runChild"] = async (childOptions) => {
		const agent = childOptions.agentName;
		const occurrence = (occurrences.get(agent) ?? 0) + 1;
		occurrences.set(agent, occurrence);

		// The seam's own pre-spawn policy, modelled faithfully: the real adapter
		// refuses to spawn once a ceiling is spent, and a fake that ignored budgets
		// would let a budget-exhaustion scenario "pass" without a budget ever biting.
		const budgets = [childOptions.budget, childOptions.contractBudget].filter((budget): budget is FlowBudget => Boolean(budget));
		const exhausted = budgets.find((budget) => budgetExceeded(budget));
		if (exhausted) {
			// The same event the real adapter emits, so a scenario can observe the
			// refusal that leaves no child span behind.
			childOptions.recordEvent?.({
				kind: "budget",
				name: "child.refused",
				ok: false,
				scope: childOptions.scope,
				attributes: { "flow.budget.refused_agent": agent, ...budgetAttributes(exhausted) },
			});
			const refused = baseResult(childOptions, "", { input: 0, output: 0, cost: 0 });
			refused.exitCode = 1;
			refused.error = budgetExceededError(exhausted);
			refused.errorMessage = refused.error.message;
			refused.stopReason = "budget_exceeded";
			refused.durationMs = 0;
			ledger.dispatches.push({
				index: ledger.dispatches.length,
				agent,
				unitKey: childOptions.scope?.key,
				step: childOptions.step,
				task: childOptions.task,
				faults: [],
				delivery: "refused",
				completedAtMs: clockMs,
				durationMs: 0,
			});
			return refused;
		}

		const applied: FaultKind[] = [];
		let delivery: DispatchRecord["delivery"] = "fresh";
		const scripted = replyFor(options.replies, agent, occurrence);
		let body = scripted.reply;
		let durationMs = 5;
		let failure: { code: FlowErrorCode; message: string; cause: string; retryable: boolean } | null = null;

		for (const rule of options.faults ?? []) {
			if (!matches(rule, agent, occurrence)) continue;
			applied.push(rule.kind);
			if (rule.kind === "delay") {
				durationMs = rule.delayMs ?? 0;
			} else if (rule.kind === "loss") {
				// A response that never arrives is indistinguishable from a timeout at
				// this seam, which is exactly how the real runner reports it.
				delivery = "lost";
				failure = {
					code: "CHILD_TIMEOUT",
					message: `Flow agent "${agent}" produced no response.`,
					cause: "The injected coordination fault dropped the child's response.",
					retryable: true,
				};
			} else if (rule.kind === "failure") {
				delivery = "failed";
				failure = {
					code: rule.errorCode ?? "CHILD_EXIT_NONZERO",
					message: `Flow agent "${agent}" failed under an injected fault.`,
					cause: "The injected coordination fault failed the child run.",
					retryable: true,
				};
			} else if (rule.kind === "duplicate") {
				const previous = rule.replay ?? servedByAgent.get(agent)?.at(-1);
				if (previous !== undefined) {
					body = previous;
					delivery = "replayed";
				}
			} else if (rule.kind === "stale") {
				body = rule.replay ?? body;
				delivery = "replayed";
			} else if (rule.kind === "reorder") {
				// Swap this reply with the next matching one: a response delivered
				// against the wrong request, not merely a late one.
				const held = pendingSwap.get(agent);
				if (held === undefined) {
					pendingSwap.set(agent, body);
					body = replyFor(options.replies, agent, occurrence + 1).reply;
				} else {
					body = held;
					pendingSwap.delete(agent);
				}
				delivery = "swapped";
			}
		}

		// The real runner turns an over-long child into CHILD_TIMEOUT; model that
		// here so a latency fault is contained by the same ceiling in the test.
		const effectiveTimeout = childOptions.timeoutMs;
		if (!failure && effectiveTimeout !== undefined && durationMs > effectiveTimeout) {
			delivery = "lost";
			failure = {
				code: "CHILD_TIMEOUT",
				message: `Flow agent "${agent}" timed out after ${effectiveTimeout}ms.`,
				cause: `The child took ${durationMs}ms against a ${effectiveTimeout}ms ceiling.`,
				retryable: true,
			};
		}

		// Writes belong to the turn that was actually delivered. A replayed or
		// swapped body came from a different turn and carries that turn's (absent)
		// writes, so applying this turn's would leave the workspace describing work
		// the parent never received.
		if (!failure && delivery === "fresh") {
			applyWrites(path.resolve(childOptions.defaultCwd, childOptions.cwd ?? childOptions.defaultCwd), scripted.writes);
		}
		clockMs += durationMs;
		const result = failure
			? failedResult(childOptions, failure.code, failure.message, failure.cause, failure.retryable)
			: baseResult(childOptions, body, options.usage);
		result.durationMs = durationMs;
		for (const budget of budgets) chargeBudget(budget, result.usage);
		if (!failure) servedByAgent.set(agent, [...(servedByAgent.get(agent) ?? []), body]);

		ledger.dispatches.push({
			index: ledger.dispatches.length,
			agent,
			unitKey: childOptions.scope?.key,
			step: childOptions.step,
			task: childOptions.task,
			faults: applied,
			delivery,
			completedAtMs: clockMs,
			durationMs,
		});
		childOptions.recordSpan?.(result, { scope: childOptions.scope });
		return result;
	};

	return { runChild, ledger };
}

export const FAULT_AGENTS: FlowAgent[] = [
	{ name: "recon", description: "read-only scout", tools: ["read"], systemPrompt: "recon prompt", source: "package", filePath: "/pkg/recon.md" },
	{ name: "operator", description: "write-capable implementer", tools: ["read", "write"], systemPrompt: "operator prompt", source: "package", filePath: "/pkg/operator.md" },
	{ name: "redteam", description: "critic", tools: ["read"], systemPrompt: "redteam prompt", source: "package", filePath: "/pkg/redteam.md" },
	{ name: "debrief", description: "synthesizer", tools: ["read"], systemPrompt: "debrief prompt", source: "package", filePath: "/pkg/debrief.md" },
];

export function faultDiscovery(): FlowDiscovery {
	return {
		agents: FAULT_AGENTS,
		projectAgentsDir: null,
		userAgentsDir: "/tmp/fault-user-agents",
		packageAgentsDir: "/tmp/fault-package-agents",
		issues: [],
	};
}

/** ModeDeps wired to the fault adapter, with coordination events captured in the ledger. */
export function faultDeps(params: Record<string, unknown>, adapter: FaultAdapter, cwd: string, overrides: Partial<ModeDeps> = {}): ModeDeps {
	const discovery = faultDiscovery();
	const catalog = createAgentCatalog(discovery, "user");
	const recordEvent: RecordEvent = (event) => {
		adapter.ledger.events.push({ kind: event.kind, name: event.name, ok: event.ok !== false, attributes: event.attributes ?? {} });
	};
	return {
		params: { why: "fault-injection scenario", ...params },
		discovery,
		policy: { recordContent: true, redactSecrets: true },
		handoffGuard: createHandoffGuard(resolveHandoffPolicy(params, "parallel")),
		agentScope: "user",
		defaultCwd: cwd,
		makeDetails: catalog.makeDetails,
		runChild: adapter.runChild,
		recordEvent,
		concurrency: 4,
		...overrides,
	};
}
