// The budget wrap-up channel's coordination faults (#104), in the shared
// deterministic manifest so the portfolio's denominators and four check
// families cover this failure mode: a notice that never reaches the child must
// keep the hard BUDGET_EXCEEDED loss, and an honored notice must integrate as
// a partial envelope rather than be blocked as a fault.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { handleParallel } from "../extensions/pi-flows/modes/parallel.ts";
import type { DelegationContract } from "../extensions/pi-flows/types.ts";
import { faultDeps, makeFaultAdapter } from "./fault-adapter.ts";
import { FAULT_SUITE, observe, type FaultScenario } from "./fault-scenarios.ts";

function workspace(): string {
	return mkdtempSync(path.join(tmpdir(), "pi-flow-wrapup-fault-"));
}

/** A read-only contract whose total-token ceiling the scripted turns can cross deliberately. */
function boundedContract(): DelegationContract {
	return {
		objective: "Return one bounded finding.",
		constraints: ["Report only what the workspace supports."],
		nonGoals: [],
		dependencies: [],
		authority: { may: ["read the workspace"], mustNot: ["contact the network"], requiresApproval: [] },
		sideEffectClass: "reversible",
		budget: { maxTokens: 50 },
		acceptanceChecks: ["The answer names the artifact it is based on."],
		returnSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false },
		owner: "parent",
	};
}

function envelopeFor(contract: DelegationContract, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract),
		status: "completed",
		summary: "Finding recorded.",
		evidence: [{ claim: "finding is in report.txt", source: "report.txt" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { answer: "report.txt" },
		...overrides,
	});
}

/**
 * The undelivered wrap-up notice (#104/#106): a contract turns its child's soft
 * threshold at 80%, but the child never receives the steered notice (it runs
 * without the pi-flows extension, or the file never landed). The breach must
 * stay a hard BUDGET_EXCEEDED loss — settling it gracefully would return
 * arbitrary truncated output as success. usage 10/10 against maxTokens 50:
 * turn two lands at 80% (notice requested), turn three crosses — with no
 * delivery ever confirmed.
 */
function wrapUpUndeliveredScenario(): FaultScenario {
	const cwd = workspace();
	const contract = boundedContract();
	return {
		id: "wrapup-notice-undelivered",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// No adapter rule: the fault is the child ignoring (never seeing) the
		// steered notice while its scripted turns keep spending.
		faults: [],
		faultKind: "none",
		description: "A child crosses its contract ceiling after a wrap-up notice that was requested but never delivered.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			// The breach surfaces on the failed child inside the fan-out, not as a
			// flow-level refusal — the clean sibling's work is kept.
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// The unsteered breach forfeits its work; the clean sibling's handoff is banked.
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: async () => {
			const adapter = makeFaultAdapter({
				replies: { recon: [{ reply: envelopeFor(contract) }, { reply: "still working, never saw the notice", turns: 3 }] },
				usage: { input: 10, output: 10, cost: 0.001 },
			});
			const deps = faultDeps(
				{ task: "collect two findings", tier: "capable", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }], concurrency: 1 },
				adapter,
				cwd,
			);
			const output = await handleParallel(deps);
			const breached = output.details.results.find((result) => result.error?.code === "BUDGET_EXCEEDED");
			if (!breached?.wrapUpRequested) throw new Error("the wrap-up must have been requested before the breach");
			if (breached.stopReason !== "budget_exceeded") throw new Error("an undelivered notice must keep the hard stop");
			if (!adapter.ledger.eventNames("budget").includes("child.wrap_up")) throw new Error("the wrap-up request left no attributable event behind");
			return observe(output, adapter.ledger, ["debrief"], { attack: true });
		},
	};
}

/**
 * Control twin of wrapup-notice-undelivered: the same ceilings, but the notice
 * is delivered and honored — the child answers the steer with a partial
 * envelope whose turn crosses the ceiling. The breach must settle gracefully
 * and the partial envelope must integrate, not be blocked as a fault.
 */
function wrapUpHonoredControlScenario(): FaultScenario {
	const cwd = workspace();
	const contract = boundedContract();
	const partial = envelopeFor(contract, {
		status: "partial",
		unresolvedQuestions: ["budget exhausted before full coverage"],
	});
	return {
		id: "wrapup-honored-partial",
		suite: FAULT_SUITE,
		portfolio: "control",
		faults: [],
		faultKind: "none",
		description: "A steered child honors the delivered wrap-up notice with a partial envelope that must integrate, not be blocked.",
		attackOpportunities: 0,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: false, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		run: async () => {
			const adapter = makeFaultAdapter({
				replies: { recon: [{ reply: envelopeFor(contract) }, { reply: "reading", turns: 2, wrapUpReply: partial }] },
				usage: { input: 10, output: 10, cost: 0.001 },
			});
			const deps = faultDeps(
				{ task: "collect two findings", tier: "capable", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }], concurrency: 1, incompleteHandoffPolicy: "include" },
				adapter,
				cwd,
			);
			const output = await handleParallel(deps);
			const wrapped = output.details.results.find((result) => result.stopReason === "budget_wrap_up");
			if (!wrapped) throw new Error("the honored wrap-up must settle gracefully");
			if (wrapped.envelope?.status !== "partial") throw new Error("the steered child's partial envelope must validate");
			return observe(output, adapter.ledger, ["debrief"], { attack: false });
		},
	};
}

/**
 * The dishonored wrap-up notice (#112): the notice is delivered — the graceful
 * settlement is latched — but the child answers it with prose instead of the
 * contracted envelope. Delivery is not compliance: envelope validation must
 * revoke the provisional success, so the run carries the validation cause and
 * never renders as `✓` beside the flow's RETURN_ENVELOPE_INVALID.
 */
function wrapUpDishonoredScenario(): FaultScenario {
	const cwd = workspace();
	const contract = boundedContract();
	return {
		id: "wrapup-delivered-dishonored",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// No adapter rule: the fault is the child ignoring the delivered notice's
		// envelope requirement while its graceful settlement is already latched.
		faults: [],
		faultKind: "none",
		description: "A steered child answers the delivered wrap-up notice with prose; the provisional graceful settlement must be revoked at envelope validation.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: "RETURN_ENVELOPE_INVALID" },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// The clean sibling's handoff is banked; the dishonored wrap-up is not.
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: async () => {
			const adapter = makeFaultAdapter({
				replies: { recon: [{ reply: envelopeFor(contract) }, { reply: "reading", turns: 2, wrapUpReply: "wrapped up in confident prose instead of the contracted envelope" }] },
				usage: { input: 10, output: 10, cost: 0.001 },
			});
			const deps = faultDeps(
				{ task: "collect two findings", tier: "capable", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }], concurrency: 1, incompleteHandoffPolicy: "include" },
				adapter,
				cwd,
			);
			const output = await handleParallel(deps);
			const dishonored = output.details.results.find((result) => result.stopReason === "budget_wrap_up");
			if (!dishonored?.wrapUpRequested) throw new Error("the wrap-up must have been requested and delivered before the breach");
			if (dishonored.exitCode === 0) throw new Error("a delivered-but-dishonored wrap-up must not settle as a success");
			if (dishonored.error?.code !== "RETURN_ENVELOPE_INVALID") throw new Error("the dishonored wrap-up must carry the validation cause");
			return observe(output, adapter.ledger, ["debrief"], { attack: true });
		},
	};
}

/**
 * The concurrent-live-sibling case: one child's settled turn crosses 80% of a
 * SHARED flow ceiling while a sibling is still mid-run. The transition must
 * steer the live sibling at that moment — not at its own next settled turn,
 * which can already be the one that crosses the hard ceiling — and the
 * sibling's honored partial envelope must integrate.
 */
function wrapUpBroadcastControlScenario(): FaultScenario {
	const cwd = workspace();
	const contract: DelegationContract = { ...boundedContract(), budget: {} };
	const partial = envelopeFor(contract, {
		status: "partial",
		unresolvedQuestions: ["steered off by a sibling's threshold crossing"],
	});
	return {
		id: "wrapup-broadcast-live-sibling",
		suite: FAULT_SUITE,
		portfolio: "control",
		faults: [],
		faultKind: "none",
		description: "A live sibling on a shared flow ceiling is steered by another child's threshold crossing and integrates a partial envelope.",
		attackOpportunities: 0,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: false, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		run: async () => {
			const { Budget } = await import("../extensions/pi-flows/types.ts");
			const adapter = makeFaultAdapter({
				// The first child's one turn lands exactly at 80% of the shared
				// ceiling; the concurrently armed sibling is steered before charging
				// any turn of its own and answers with the partial envelope.
				replies: { recon: envelopeFor(contract), redteam: { reply: "reading", turns: 2, wrapUpReply: partial } },
				usage: { input: 2, output: 8, cost: 0.001 },
			});
			const deps = faultDeps(
				{ task: "collect two findings", tier: "capable", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "redteam", task: "inspect B" }], incompleteHandoffPolicy: "include" },
				adapter,
				cwd,
				{ budget: Budget.forFlow({ maxGeneratedTokens: 10 }) },
			);
			const output = await handleParallel(deps);
			const steered = output.details.results.find((result) => result.agent === "redteam");
			if (!steered?.wrapUpRequested) throw new Error("the live sibling must be steered by the shared transition");
			if (steered.stopReason !== "budget_wrap_up") throw new Error("the steered sibling's breach must settle gracefully");
			return observe(output, adapter.ledger, ["debrief"], { attack: false });
		},
	};
}

/**
 * The mixed-ceiling shared budget: the flow's total-token spawn gate is spent
 * by the same turn that brings its generated ceiling to 80%. The gate only
 * refuses LATER spawns — the children legitimately still running must be
 * steered for the generated ceiling, not silenced by the spent gate, and the
 * steered sibling's partial envelope must integrate.
 */
function wrapUpMixedCeilingControlScenario(): FaultScenario {
	const cwd = workspace();
	const contract: DelegationContract = { ...boundedContract(), budget: {} };
	const partial = envelopeFor(contract, {
		status: "partial",
		unresolvedQuestions: ["steered off under a mixed-ceiling flow budget"],
	});
	return {
		id: "wrapup-mixed-ceiling-gate",
		suite: FAULT_SUITE,
		portfolio: "control",
		faults: [],
		faultKind: "none",
		description: "A spent flow total-token spawn gate must not suppress the wrap-up steer for the generated ceiling still governing live children.",
		attackOpportunities: 0,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: false, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		run: async () => {
			const { Budget } = await import("../extensions/pi-flows/types.ts");
			const adapter = makeFaultAdapter({
				// One turn spends the total gate (22+8=30) and lands generated at
				// exactly 80% (8 of 10); the live sibling must still be steered.
				replies: { recon: envelopeFor(contract), redteam: { reply: "reading", turns: 2, wrapUpReply: partial } },
				usage: { input: 22, output: 8, cost: 0.001 },
			});
			const deps = faultDeps(
				{ task: "collect two findings", tier: "capable", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "redteam", task: "inspect B" }], incompleteHandoffPolicy: "include" },
				adapter,
				cwd,
				{ budget: Budget.forFlow({ maxTokens: 30, maxGeneratedTokens: 10 }) },
			);
			const output = await handleParallel(deps);
			const steered = output.details.results.find((result) => result.agent === "redteam");
			if (!steered?.wrapUpRequested) throw new Error("the spent spawn gate must not silence the generated-ceiling steer");
			if (steered.stopReason !== "budget_wrap_up") throw new Error("the steered sibling's breach must settle gracefully");
			return observe(output, adapter.ledger, ["debrief"], { attack: false });
		},
	};
}

/**
 * A provider-errored turn still meters spend: its charge can move a shared
 * ceiling into the wrap-up window, and the live sibling that transition
 * endangers must be steered even though the charging turn was unhealthy. The
 * errored child itself surfaces as failed (never a hard budget stop — the
 * hard latch is healthy-only); the steered sibling integrates its partial.
 */
function wrapUpErroredTurnScenario(): FaultScenario {
	const cwd = workspace();
	const contract: DelegationContract = { ...boundedContract(), budget: {} };
	const partial = envelopeFor(contract, {
		status: "partial",
		unresolvedQuestions: ["steered off after a sibling's errored turn moved the ceiling"],
	});
	return {
		id: "wrapup-broadcast-errored-turn",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// No adapter rule: the fault is the scripted provider-error turn whose
		// metered usage moves the shared ceiling.
		faults: [],
		faultKind: "none",
		description: "A provider-errored turn moves the shared ceiling into the wrap-up window; the live sibling must still be steered.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			// The provider error surfaces on the failed child inside the fan-out.
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// The errored child banks nothing; the steered sibling's partial does.
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: async () => {
			const { Budget } = await import("../extensions/pi-flows/types.ts");
			const adapter = makeFaultAdapter({
				// The recon turn errors terminally but still meters 8 generated
				// tokens — exactly 80% of the shared ceiling.
				replies: { recon: { reply: "provider blew up mid-review", turnErrored: true }, redteam: { reply: "reading", turns: 2, wrapUpReply: partial } },
				usage: { input: 2, output: 8, cost: 0.001 },
			});
			const deps = faultDeps(
				{ task: "collect two findings", tier: "capable", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "redteam", task: "inspect B" }], incompleteHandoffPolicy: "include" },
				adapter,
				cwd,
				{ budget: Budget.forFlow({ maxGeneratedTokens: 10 }) },
			);
			const output = await handleParallel(deps);
			const errored = output.details.results.find((result) => result.agent === "recon");
			if (errored?.error?.code !== "CHILD_PROVIDER_ERROR") throw new Error("the errored child must surface its provider error, not a budget stop");
			const steered = output.details.results.find((result) => result.agent === "redteam");
			if (!steered?.wrapUpRequested) throw new Error("the sibling must be steered by usage the errored turn charged");
			if (steered.stopReason !== "budget_wrap_up") throw new Error("the steered sibling's breach must settle gracefully");
			return observe(output, adapter.ledger, ["debrief"], { attack: true });
		},
	};
}

export function wrapUpScenarios(): FaultScenario[] {
	return [wrapUpUndeliveredScenario(), wrapUpHonoredControlScenario(), wrapUpDishonoredScenario(), wrapUpBroadcastControlScenario(), wrapUpMixedCeilingControlScenario(), wrapUpErroredTurnScenario()];
}
