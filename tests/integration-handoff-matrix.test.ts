import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import type { DelegationContract } from "../extensions/pi-flows/types.ts";
import { freshDir, runFlow } from "./stub-harness.ts";

const contract: DelegationContract = {
	objective: "Return answer 42.",
	constraints: ["Read only."],
	nonGoals: [],
	dependencies: [],
	authority: { may: ["Read files."], mustNot: [], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget: {},
	acceptanceChecks: ["Return answer 42."],
	returnSchema: {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "number" } },
		additionalProperties: false,
	},
	owner: "parent",
};

type Scenario = "success" | "partial" | "stale" | "invalid";

function envelope(scenario: Scenario = "success") {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: scenario === "stale" ? `sha256:${"0".repeat(64)}` : delegationContractId(contract),
		status: scenario === "partial" ? "partial" : "completed",
		summary: `Typed ${scenario} result.`,
		evidence: [{ claim: "The answer is 42.", source: "answer.txt:1" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: scenario === "partial" ? ["Need confirmation."] : [],
		retry: { retryable: scenario === "partial" },
		data: scenario === "invalid" ? { wrong: true } : { answer: 42 },
	});
}

const expectedError: Record<Scenario, string | undefined> = {
	success: undefined,
	partial: "RETURN_ENVELOPE_INCOMPLETE",
	stale: "RETURN_CONTRACT_MISMATCH",
	invalid: "RETURN_ENVELOPE_INVALID",
};

type ModeFixture = {
	params: Record<string, unknown>;
	plan: Record<string, unknown>;
	cwd?: string;
};

async function fixture(mode: string, scenario: Scenario): Promise<ModeFixture> {
	const typed = envelope(scenario);
	const complete = envelope();
	if (mode === "parallel") {
		return {
			params: { tasks: [{ agent: "recon", task: "answer", contract }] },
			plan: { recon: typed },
		};
	}
	if (mode === "graph") {
		return {
			params: { graph: { nodes: [{ id: "answer", agent: "recon", task: "answer", contract }] } },
			plan: { recon: typed },
		};
	}
	if (mode === "workflow") {
		return {
			params: { workflow: { phases: [{ id: "answer", agent: "recon", task: "answer", contract }] } },
			plan: { recon: typed },
		};
	}
	if (mode === "orchestrate") {
		return {
			params: {
				task: "Answer from one finding.",
				orchestrate: { recon: { agent: "recon", contract }, maxSubtasks: 1 },
			},
			plan: { commander: '["find answer"]', recon: typed, debrief: "synthesized" },
		};
	}
	if (mode === "vote") {
		return {
			params: {
				task: "Vote on the answer.",
				vote: { voters: [{ agent: "recon", contract }, { agent: "analyst", contract }] },
			},
			plan: { recon: typed, analyst: complete },
		};
	}
	if (mode === "debate") {
		return {
			params: {
				task: "Debate the answer.",
				debate: {
					participants: [{ agent: "recon", contract }, { agent: "analyst", contract }],
					adjudicator: { agent: "debrief" },
					rounds: 1,
				},
			},
			plan: { recon: typed, analyst: complete, debrief: "decision" },
		};
	}
	if (mode === "dossier") {
		return {
			params: {
				task: "Build the answer dossier.",
				dossier: {
					sections: [
						{ agent: "recon", task: "source one", contract },
						{ agent: "analyst", task: "source two", contract },
					],
				},
			},
			plan: { recon: typed, analyst: complete, debrief: "dossier" },
		};
	}
	if (mode === "worktree") {
		const cwd = await freshDir();
		await writeFile(`${cwd}/a.txt`, "old a\n");
		await writeFile(`${cwd}/b.txt`, "old b\n");
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["add", "."], { cwd });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd });
		return {
			cwd,
			params: {
				task: "Update both files.",
				worktree: {
					tasks: [
						{ id: "a", agent: "operator", task: "update a.txt", contract },
						{ id: "b", agent: "operator", task: "update b.txt", contract },
					],
					integrator: { agent: "debrief" },
				},
			},
			plan: {
				operator: [
					{ whenTaskIncludes: "assignment (a)", reply: typed, writes: { "a.txt": "new a\n" } },
					{ whenTaskIncludes: "assignment (b)", reply: complete, writes: { "b.txt": "new b\n" } },
				],
				debrief: "integration reviewed",
			},
		};
	}
	throw new Error(`unknown mode: ${mode}`);
}

test("every integration mode covers successful, partial, stale, and invalid typed envelopes", async (t) => {
	const modes = ["parallel", "orchestrate", "graph", "workflow", "worktree", "vote", "debate", "dossier"];
	const scenarios: Scenario[] = ["success", "partial", "stale", "invalid"];
	for (const mode of modes) {
		for (const scenario of scenarios) {
			await t.test(`${mode}: ${scenario}`, async () => {
				const built = await fixture(mode, scenario);
				const { result } = await runFlow(built.params, built.plan, { cwd: built.cwd });
				assert.equal(result.details.error?.code, expectedError[scenario]);
				if (scenario === "success") {
					assert.ok(result.details.results.some((run: any) => run.handoff?.contractId === delegationContractId(contract)));
				}
			});
		}
	}
});
