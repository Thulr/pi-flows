import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { handleLoop } from "../extensions/pi-flows/modes/loop.ts";
import { handleOrchestrate } from "../extensions/pi-flows/modes/orchestrate.ts";
import { handleRoute } from "../extensions/pi-flows/modes/route.ts";
import type { DelegationContract } from "../extensions/pi-flows/types.ts";
import { bankedDeliveries, faultDeps, makeFaultAdapter, type FaultRule } from "./fault-adapter.ts";
import type { FaultScenario } from "./fault-scenarios.ts";

const routeContract: DelegationContract = {
	objective: "Choose the route supported by the task.",
	constraints: ["Choose only a listed candidate."],
	nonGoals: [],
	dependencies: [],
	authority: { may: ["Read the task."], mustNot: ["Run a candidate."], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget: {},
	acceptanceChecks: ["Return one listed route."],
	returnSchema: {
		type: "object",
		required: ["route"],
		properties: { route: { const: "recon" } },
		additionalProperties: false,
	},
	owner: "parent",
};

const judgeContract: DelegationContract = {
	...routeContract,
	objective: "Judge whether the loop artifact is complete.",
	returnSchema: {
		type: "object",
		required: ["verdict", "feedback"],
		properties: { verdict: { enum: ["pass", "revise"] }, feedback: { type: "string" } },
		additionalProperties: false,
	},
};

const commanderContract: DelegationContract = {
	...routeContract,
	objective: "Decompose the goal into independent subtasks.",
	returnSchema: { type: "array", items: { type: "string" } },
};

function envelope(contract: DelegationContract, data: unknown, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract),
		status: "completed",
		summary: "Route selected.",
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data,
		...overrides,
	});
}

/** Coordination faults in contracted Role decisions. */
export function contractRoleScenarios(): FaultScenario[] {
	const staleContract = { ...routeContract, objective: "Choose the route under an earlier contract revision." };
	const stale = envelope(staleContract, { route: "recon" });
	const faults: FaultRule[] = [{ kind: "stale", agent: "controller", replay: stale }];
	return [{
		id: "stale-route-controller-return",
		suite: "fault-injection",
		portfolio: "adversarial",
		faults,
		faultKind: "stale",
		description: "A route controller returns a decision bound to an earlier role contract.",
		attackOpportunities: 1,
		benignOpportunities: 0,
		expected: {
			outcome: { errorCode: "RETURN_CONTRACT_MISMATCH" },
			process: { dispatched: 1, refused: 0, unreached: ["recon"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-role-contract-fault-"));
			const adapter = makeFaultAdapter({
				replies: { controller: envelope(routeContract, { route: "recon" }), recon: "must not run" },
				faults,
			});
			const output = await handleRoute(faultDeps({
				task: "Inspect the implementation.",
				route: { controller: { agent: "controller", contract: routeContract }, candidates: ["recon"] },
			}, adapter, cwd));
			return {
				outcome: { errorCode: output.details.error?.code ?? null },
				process: {
					dispatched: adapter.ledger.dispatches.filter((dispatch) => dispatch.delivery !== "refused").length,
					refused: adapter.ledger.countDelivered("refused"),
					unreached: adapter.ledger.reached("recon") ? [] : ["recon"],
				},
				policy: { contained: Boolean(output.details.error), falselyBlocked: false },
				residualState: {
					retryable: output.details.error?.retryable ?? false,
					acceptedHandoffs: bankedDeliveries(output),
				},
			};
		},
	}, {
		id: "loop-judge-artifact-escape",
		suite: "fault-injection",
		portfolio: "adversarial",
		faults: [],
		faultKind: "none",
		description: "A loop judge returns a passing verdict bound to an artifact outside its child cwd.",
		attackOpportunities: 1,
		benignOpportunities: 0,
		expected: {
			outcome: { errorCode: "RETURN_ENVELOPE_INVALID" },
			process: { dispatched: 2, refused: 0, unreached: [] },
			policy: { contained: true, falselyBlocked: false },
			// The judge's escaped-artifact verdict is refused; only the loop body's
			// Handoff — consumed by the judge — is banked (issue #142).
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-role-contract-fault-"));
			const adapter = makeFaultAdapter({
				replies: {
					operator: ["artifact one", "must not run"],
					redteam: envelope(judgeContract, { verdict: "pass", feedback: "" }, { artifactReferences: [{ path: "../outside.txt" }] }),
				},
				faults: [],
			});
			const output = await handleLoop(faultDeps({
				task: "Finish the bounded task.",
				loop: { body: { agent: "operator" }, judge: { agent: "redteam", contract: judgeContract }, maxIterations: 2 },
			}, adapter, cwd));
			return {
				outcome: { errorCode: output.details.error?.code ?? null },
				process: {
					dispatched: adapter.ledger.dispatches.filter((dispatch) => dispatch.delivery !== "refused").length,
					refused: adapter.ledger.countDelivered("refused"),
					unreached: [],
				},
				policy: { contained: Boolean(output.details.error), falselyBlocked: false },
				residualState: {
					retryable: output.details.error?.retryable ?? false,
					acceptedHandoffs: bankedDeliveries(output),
				},
			};
		},
	}, {
		id: "empty-contracted-commander-list",
		suite: "fault-injection",
		portfolio: "adversarial",
		faults: [],
		faultKind: "none",
		description: "A contracted commander returns an empty but schema-valid subtask array.",
		attackOpportunities: 1,
		benignOpportunities: 0,
		expected: {
			outcome: { errorCode: "ORCHESTRATE_NO_SUBTASKS" },
			process: { dispatched: 1, refused: 0, unreached: ["recon", "debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: async () => {
			const cwd = mkdtempSync(path.join(tmpdir(), "pi-flow-role-contract-fault-"));
			const adapter = makeFaultAdapter({
				replies: {
					commander: envelope(commanderContract, []),
					recon: "must not run",
					debrief: "must not run",
				},
				faults: [],
			});
			const output = await handleOrchestrate(faultDeps({
				task: "Map the system.",
				orchestrate: {
					commander: { agent: "commander", contract: commanderContract },
					recon: { agent: "recon" },
					debrief: { agent: "debrief" },
					maxSubtasks: 2,
				},
			}, adapter, cwd));
			return {
				outcome: { errorCode: output.details.error?.code ?? null },
				process: {
					dispatched: adapter.ledger.dispatches.filter((dispatch) => dispatch.delivery !== "refused").length,
					refused: adapter.ledger.countDelivered("refused"),
					unreached: ["recon", "debrief"].filter((agent) => !adapter.ledger.reached(agent)),
				},
				policy: { contained: Boolean(output.details.error), falselyBlocked: false },
				residualState: {
					retryable: output.details.error?.retryable ?? false,
					acceptedHandoffs: bankedDeliveries(output),
				},
			};
		},
	}];
}
