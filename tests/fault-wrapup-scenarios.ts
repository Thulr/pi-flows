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
				{ task: "collect two findings", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }], concurrency: 1 },
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
				{ task: "collect two findings", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }], concurrency: 1, incompleteHandoffPolicy: "include" },
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
				{ task: "collect two findings", contract, tasks: [{ agent: "recon", task: "inspect A" }, { agent: "redteam", task: "inspect B" }], incompleteHandoffPolicy: "include" },
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

export function wrapUpScenarios(): FaultScenario[] {
	return [wrapUpUndeliveredScenario(), wrapUpHonoredControlScenario(), wrapUpBroadcastControlScenario()];
}
