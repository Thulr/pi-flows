import { test } from "node:test";
import assert from "node:assert/strict";
import {
	EXPERIMENT_ARM_NAMES,
	ablationAttribution,
	parseArmSelection,
	planExperimentArm,
} from "../evals/experiment-arms.mjs";

const binding = { kind: "generated_tokens", value: 4_000, unit: "tokens", source: "cli" };
const baseCase = {
	name: "route-case",
	params: {
		task: "Find the defect.",
		route: { candidates: ["recon", "strategist", "overwatch"], fallback: "recon" },
	},
	experiment: { oracleAgent: "recon" },
};
const typedContract = (objective) => ({
	objective,
	constraints: [],
	nonGoals: [],
	dependencies: [],
	authority: { may: [], mustNot: [], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget: {},
	acceptanceChecks: [],
	returnSchema: { type: "object" },
	owner: "parent",
});

test("comparison arm selection is named, paired, and backwards compatible by default", () => {
	assert.deepEqual(parseArmSelection(null), ["direct", "full"]);
	assert.deepEqual(parseArmSelection("sequential,parallel"), ["sequential", "parallel"]);
	assert.throws(() => parseArmSelection("full"), /exactly two/);
	assert.throws(() => parseArmSelection("full,unknown"), /unknown experiment arm/);
	assert.throws(() => parseArmSelection("direct,no-verifier"), /one component|control with full/);
	assert.ok(EXPERIMENT_ARM_NAMES.includes("compute-matched-self-review"));
	assert.ok(EXPERIMENT_ARM_NAMES.includes("oracle-routing"));
});

test("arm planning derives alternatives without mutating the case definition", () => {
	const before = structuredClone(baseCase);
	const plan = planExperimentArm("deterministic-workflow", baseCase, { bindingConstraint: binding, seed: "trial-1" });

	assert.equal(plan.applicable, true);
	assert.equal(plan.runner, "flow");
	assert.equal(plan.params.workflow.phases.length, 2);
	assert.match(plan.params.why, /controlled deterministic-workflow experiment arm/);
	assert.deepEqual(baseCase, before);
	assert.equal(plan.topology, "sequential-static-workflow");
	assert.match(plan.configurationIdentity, /generated_tokens:4000/);
});

test("supported controls separate compute, ensembling, and routing", () => {
	const selfReview = planExperimentArm("compute-matched-self-review", baseCase, { bindingConstraint: binding, seed: "trial-1" });
	assert.equal(selfReview.runner, "flow");
	assert.equal(selfReview.params.chain.length, 2, "route full arm has controller + selected specialist");
	assert.deepEqual(selfReview.computeAllocation, { modelCalls: 2, binding: "generated_tokens:4000" });
	assert.match(selfReview.configurationIdentity, /calls:2/);
	assert.match(selfReview.params.chain[1].task, /review and revise/i);

	const ensemble = planExperimentArm("no-communication-ensemble", baseCase, { bindingConstraint: binding, seed: "trial-1" });
	assert.equal(ensemble.runner, "flow");
	assert.deepEqual(ensemble.params.vote, { agent: "recon", count: 2 });

	const randomA = planExperimentArm("random-routing", baseCase, { bindingConstraint: binding, seed: "trial-1" });
	const randomB = planExperimentArm("random-routing", baseCase, { bindingConstraint: binding, seed: "trial-1" });
	assert.equal(randomA.params.agent, randomB.params.agent, "routing is reproducible for a paired trial");
	assert.ok(baseCase.params.route.candidates.includes(randomA.params.agent));

	const oracle = planExperimentArm("oracle-routing", baseCase, { bindingConstraint: binding, seed: "trial-1" });
	assert.equal(oracle.params.agent, "recon");
});

test("compute matching excludes topologies whose runtime call count is data-dependent", () => {
	for (const testCase of [
		{ name: "orchestrate", params: { task: "Coordinate.", orchestrate: { maxSubtasks: 4 } } },
		{ name: "worktree", params: { task: "Edit.", worktree: { tasks: [{ id: "a", agent: "operator", task: "Edit a." }] } } },
	]) {
		const plan = planExperimentArm("compute-matched-self-review", testCase, { bindingConstraint: binding, seed: "trial-1" });
		assert.equal(plan.applicable, false, testCase.name);
		assert.equal(plan.exclusion.reason, "inapplicable");
	}
});

test("mode-specific ablations remove integration and verification", () => {
	const voteCase = {
		name: "vote-case",
		params: { task: "Decide.", vote: { voters: [{ agent: "recon" }, { agent: "overwatch" }], debrief: { agent: "debrief" } } },
	};
	const noIntegrator = planExperimentArm("no-integrator", voteCase, { bindingConstraint: binding, seed: "trial-1" });
	assert.equal(noIntegrator.applicable, true);
	assert.equal(noIntegrator.params.vote.debrief, undefined);
	const worktreeCase = {
		name: "worktree",
		params: { task: "Edit.", worktree: { tasks: [{ id: "a", agent: "operator", task: "Edit a." }], integrator: { agent: "debrief" } } },
	};
	assert.equal(planExperimentArm("no-integrator", worktreeCase, { bindingConstraint: binding, seed: "trial-1" }).exclusion.reason, "inapplicable");

	const evaluateCase = {
		name: "evaluate-case",
		params: { task: "Implement.", evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 2 } },
	};
	const noVerifier = planExperimentArm("no-verifier", evaluateCase, { bindingConstraint: binding, seed: "trial-1" });
	assert.equal(noVerifier.applicable, true);
	assert.equal(noVerifier.params.agent, "operator");
	assert.equal(noVerifier.params.evaluate, undefined);
});

test("no-verifier preserves evaluate aliases and the effective typed contract", () => {
	const options = { bindingConstraint: binding, seed: "trial-1" };
	const operatorTask = planExperimentArm("no-verifier", {
		name: "operator-task", params: { evaluate: { operator: { agent: "operator", task: "Operator-owned goal." } } },
	}, options);
	assert.equal(operatorTask.params.task, "Operator-owned goal.");

	const topContract = typedContract("Top contract goal.");
	const operatorContract = typedContract("Operator contract goal.");
	const contractOnly = planExperimentArm("no-verifier", {
		name: "contract-only", params: { contract: topContract, evaluate: { operator: { agent: "operator" } } },
	}, options);
	assert.equal(contractOnly.params.task, "Top contract goal.");
	assert.deepEqual(contractOnly.params.contract, topContract);
	const override = planExperimentArm("no-verifier", {
		name: "contract-override", params: { contract: topContract, evaluate: { operator: { agent: "operator", contract: operatorContract } } },
	}, options);
	assert.equal(override.params.task, "Operator contract goal.");
	assert.deepEqual(override.params.contract, operatorContract);
});

test("context and execution-order ablations are explicit and case-scoped", () => {
	const chainCase = {
		name: "chain-case",
		params: {
			task: "Overall goal.",
			chain: [
				{ agent: "recon", task: "Inspect {task}" },
				{ agent: "strategist", task: "Use {task} and {previous}" },
			],
		},
	};
	const minimal = planExperimentArm("minimal-context", chainCase, { bindingConstraint: binding, seed: "trial-1" });
	assert.equal(minimal.applicable, true);
	assert.doesNotMatch(minimal.params.chain[1].task, /\{task\}/);
	assert.match(minimal.params.chain[1].task, /\{previous\}/);

	const voteCase = { name: "vote", params: { task: "Decide.", vote: { agent: "recon", count: 2 } } };
	assert.equal(planExperimentArm("sequential", voteCase, { bindingConstraint: binding, seed: "trial-1" }).params.concurrency, 1);
	assert.ok(planExperimentArm("parallel", voteCase, { bindingConstraint: binding, seed: "trial-1" }).params.concurrency > 1);
});

test("inapplicable arm/case pairs carry an explicit reason", () => {
	const single = { name: "single", params: { agent: "recon", task: "Inspect." } };
	for (const arm of ["oracle-routing", "no-integrator", "no-verifier", "minimal-context", "sequential", "parallel"]) {
		const plan = planExperimentArm(arm, single, { bindingConstraint: binding, seed: "trial-1" });
		assert.equal(plan.applicable, false, arm);
		assert.equal(plan.exclusion.reason, "inapplicable");
		assert.ok(plan.exclusion.detail.length > 0);
	}
});

test("ablation attribution names the component and retains the measured lift", () => {
	const attribution = ablationAttribution(
		{ overall: { quality: { meanDelta: 0.125 }, reliability: { meanDelta: 0.25 } } },
		{ reference: { name: "no-verifier", component: "verification" }, candidate: { name: "full", component: "coordination" } },
	);
	assert.deepEqual(attribution, {
		component: "verification",
		referenceArm: "no-verifier",
		candidateArm: "full",
		qualityLift: 0.125,
		reliabilityLift: 0.25,
	});
	const reversed = ablationAttribution(
		{ overall: { quality: { meanDelta: -0.125 }, reliability: { meanDelta: -0.25 } } },
		{ reference: { name: "full", component: "coordination" }, candidate: { name: "no-verifier", component: "verification" } },
	);
	assert.equal(reversed.component, "verification");
});
