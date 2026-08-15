// Flow-lifecycle coordination faults: drivers that try to run the lifecycle out
// of order. The Flow aggregate makes the transitions themselves the only path —
// admission is the sole source of a dispatch capability, dispatch the sole
// source of a settle — so these cases inject the *driver* fault (skip the human
// gate, replay a spent transition) and measure that the aggregate contains it:
// nothing spawns behind a skipped checkpoint, and a replayed transition is
// refused instead of double-spawning or double-settling.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import { Flow, type FlowPorts } from "../extensions/pi-flows/flow.ts";
import { RUN_MODE_HANDLERS, detectRunMode } from "../extensions/pi-flows/modes/registry.ts";
import { handleWorkflow } from "../extensions/pi-flows/modes/workflow.ts";
import { parseTraceJsonl } from "../extensions/pi-flows/trace.ts";
import { formatFlowError, type FlowErrorCode, type ModeOutput } from "../extensions/pi-flows/types.ts";
import { checkpointApproval } from "../extensions/pi-flows/ui.ts";
import { bankedDeliveries, FaultLedger, faultDeps, faultDiscovery, makeFaultAdapter, type FaultAdapter } from "./fault-adapter.ts";
import { FAULT_SUITE, type FaultChecks, type FaultScenario } from "./fault-scenarios.ts";

function workspace(): string {
	return mkdtempSync(path.join(tmpdir(), "pi-flow-fault-lifecycle-"));
}

/**
 * The composition-root wiring, faked at the aggregate's ports: real mode
 * detection, real handlers, the real headless checkpoint predicate, and the
 * fault adapter as the child-run seam — so a lifecycle case exercises the same
 * gates production walks, minus the UI and preset surfaces it does not need.
 */
function flowPorts(params: Record<string, unknown>, adapter: FaultAdapter, cwd: string): FlowPorts {
	const discovery = faultDiscovery();
	const catalog = createAgentCatalog(discovery, "user");
	return {
		params: { why: "fault-injection scenario", ...params },
		policy: { recordContent: true, redactSecrets: true },
		cwd,
		hasUI: false,
		approvalActor: "fault-harness",
		agentScope: "user",
		discovery,
		runChild: adapter.runChild,
		makeDetails: () => (mode, agents) => catalog.makeDetails(mode, agents),
		detectMode: (candidate) => {
			const detected = detectRunMode(candidate);
			return "error" in detected
				? { refusal: { content: [{ type: "text", text: formatFlowError(detected.error) }], details: catalog.makeDetails("list")([], detected.error) } }
				: detected;
		},
		approvePresetTrust: async () => ({ record: () => undefined }),
		preparePresetRun: (call) => ({ params: call.params, runDefaultCwd: cwd }),
		approveProjectAgents: async () => null,
		// The real predicate: headless checkpoints fail closed rather than being skipped.
		checkpoint: (candidate, mode, when, preview, recordEvent) => checkpointApproval(candidate, { hasUI: false }, mode, when, preview, recordEvent),
		handlerFor: (mode) => RUN_MODE_HANDLERS[mode],
		presence: { start: () => undefined, update: () => undefined, settle: () => undefined },
		persist: () => undefined,
	};
}

function observeFlow(output: ModeOutput, ledger: FaultLedger, watched: string[], options: { contained: boolean }): FaultChecks {
	const errorCode = (output.details.error?.code as FlowErrorCode | undefined) ?? null;
	return {
		outcome: { errorCode },
		process: {
			dispatched: ledger.dispatches.filter((dispatch) => dispatch.delivery !== "refused").length,
			refused: ledger.countDelivered("refused"),
			unreached: watched.filter((agent) => !ledger.reached(agent)),
		},
		policy: { contained: options.contained, falselyBlocked: false },
		residualState: {
			retryable: output.details.error?.retryable ?? false,
			acceptedHandoffs: bankedDeliveries(output),
		},
	};
}

function checkpointSkippedScenario(): FaultScenario {
	const cwd = workspace();
	const traceFile = path.join(cwd, "trace.jsonl");
	return {
		id: "checkpoint-skipped-before-spawn",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// No adapter rule: the fault is a headless driver reaching for dispatch
		// across a human gate that was never approved.
		faults: [],
		faultKind: "none",
		description: "A headless run carries a spawn checkpoint no human can answer; the flow must refuse before any child spawns.",
		attackOpportunities: 1,
		benignOpportunities: 0,
		expected: {
			outcome: { errorCode: "CHECKPOINT_APPROVAL_REQUIRED" },
			// Contained before dispatch: the admission walk never yields a capability.
			process: { dispatched: 0, refused: 0, unreached: ["recon", "debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: async () => {
			const adapter: FaultAdapter = {
				runChild: async () => { throw new Error("a refused flow must not reach the child-run seam"); },
				ledger: new FaultLedger(),
			};
			const ports = flowPorts(
				{ task: "edit both files", tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }], checkpoint: {}, traceFile },
				adapter,
				cwd,
			);
			const admission = await Flow.admit(ports);
			if ("admitted" in admission) throw new Error("the skipped checkpoint handed out a dispatch capability");
			// The refusal is evidence, not silence: the trace root must attribute it.
			const parsed = parseTraceJsonl(readFileSync(traceFile, "utf8"));
			const root = parsed.spans.find((span) => span.attributes["flow.span_role"] === "root");
			if (root?.attributes["flow.refused_before_spawn"] !== "CHECKPOINT_APPROVAL_REQUIRED" || root.attributes["flow.child_count"] !== 0) {
				throw new Error("the pre-spawn refusal left no attributable trace evidence");
			}
			return observeFlow(admission.refused, adapter.ledger, ["recon", "debrief"], { contained: true });
		},
	};
}

function settleWithoutDispatchScenario(): FaultScenario {
	const cwd = workspace();
	return {
		id: "settle-without-dispatch",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// No adapter rule: the fault is a driver replaying spent lifecycle
		// transitions — a second dispatch of one admission, a second settle of one
		// dispatch — after the flow already settled cleanly.
		faults: [],
		faultKind: "none",
		description: "A driver replays spent lifecycle transitions; both replays must be refused without re-spawning or re-settling.",
		attackOpportunities: 2,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// The clean fan-out survives untouched: two terminal reports, banked
			// exactly once and exposing no phantom Handoffs (issue #142).
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: async () => {
			const adapter = makeFaultAdapter({ replies: { recon: ["finding A", "finding B"] } });
			const ports = flowPorts(
				{ task: "collect two findings", tier: "capable", tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
				adapter,
				cwd,
			);
			const admission = await Flow.admit(ports);
			if (!("admitted" in admission)) throw new Error(`the clean flow was refused: ${admission.refused.details.error?.code}`);
			const dispatched = await admission.admitted.dispatch();
			const output = await dispatched.settle();
			let replaysRefused = 0;
			await admission.admitted.dispatch().then(() => undefined, () => { replaysRefused += 1; });
			await dispatched.settle().then(() => undefined, () => { replaysRefused += 1; });
			if (adapter.ledger.dispatches.length !== 2) throw new Error("a replayed transition reached the child-run seam");
			return observeFlow(output, adapter.ledger, ["debrief"], { contained: replaysRefused === 2 });
		},
	};
}

function approvalProfileScenario(drift: boolean): FaultScenario {
	const cwd = workspace();
	const id = drift ? "approval-profile-drift-contained" : "approval-profile-unchanged-control";
	return {
		id,
		suite: FAULT_SUITE,
		portfolio: drift ? "adversarial" : "control",
		faults: [],
		faultKind: "none",
		description: drift
			? "A persisted unspent approval meets an edited effective Agent profile; resume must reopen before dispatch."
			: "A persisted unspent approval meets the unchanged effective Agent profile; resume must not be falsely blocked.",
		attackOpportunities: drift ? 1 : 0,
		benignOpportunities: drift ? 0 : 1,
		expected: {
			outcome: { errorCode: drift ? "WORKFLOW_APPROVAL_REQUIRED" : null },
			process: { dispatched: drift ? 0 : 1, refused: 0, unreached: drift ? ["operator"] : [] },
			policy: { contained: drift, falselyBlocked: false },
			// The terminal work phase exposes no phantom Handoff (issue #142).
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: async () => {
			const roster = {
				fast: { model: "p/model", thinking: "low" as const, why: "fault fixture" },
				capable: { model: "p/model", thinking: "low" as const, why: "fault fixture" },
				deep: { model: "p/model", thinking: "low" as const, why: "fault fixture" },
				available: [{ reference: "p/model", provider: "p", id: "model", reasoning: true, thinkingLevels: ["low" as const], contextWindow: 100_000 }],
				sessionModel: "p/model",
				source: "derived" as const,
				issues: [],
			};
			const base = {
				task: "ship",
				model: "p/model",
				thinking: "low",
				workflow: {
					stateFile: "workflow.json",
					phases: [
						{ id: "approve", approval: { message: "Ship?" } },
						{ id: "ship", agent: "operator", task: "Ship" },
					],
				},
			};
			// A failed first attempt leaves a valid issued receipt on disk.
			const setup = makeFaultAdapter({ replies: { operator: { reply: "provider failed", turnErrored: true } } });
			await handleWorkflow(faultDeps(base, setup, cwd, { requestApproval: async () => "approved", roster }));

			const resumed = makeFaultAdapter({ replies: { operator: "shipped" } });
			const discovery = faultDiscovery();
			if (drift) {
				discovery.agents = discovery.agents.map((agent) => agent.name === "operator" ? { ...agent, systemPrompt: "edited operator prompt" } : agent);
			}
			const output = await handleWorkflow(faultDeps(
				{ ...base, workflow: { ...base.workflow, resume: true } },
				resumed,
				cwd,
				{ discovery, roster },
			));
			return observeFlow(output, resumed.ledger, ["operator"], { contained: drift });
		},
	};
}

export function flowLifecycleScenarios(): FaultScenario[] {
	return [checkpointSkippedScenario(), settleWithoutDispatchScenario(), approvalProfileScenario(true), approvalProfileScenario(false)];
}
