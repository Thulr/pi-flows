import { createHash } from "node:crypto";

export const EXPERIMENT_ARM_NAMES = [
	"direct",
	"full",
	"compute-matched-self-review",
	"deterministic-workflow",
	"no-communication-ensemble",
	"random-routing",
	"oracle-routing",
	"no-integrator",
	"no-verifier",
	"minimal-context",
	"sequential",
	"parallel",
];

const COMPONENTS = {
	direct: "coordination",
	full: "coordination",
	"compute-matched-self-review": "coordination",
	"deterministic-workflow": "adaptive-coordination",
	"no-communication-ensemble": "communication",
	"random-routing": "routing",
	"oracle-routing": "routing",
	"no-integrator": "integration",
	"no-verifier": "verification",
	"minimal-context": "context-scope",
	sequential: "parallelism",
	parallel: "parallelism",
};

const clone = (value) => structuredClone(value);
const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 12);

function modeName(params) {
	if (params.agent) return "single";
	return ["tasks", "chain", "evaluate", "vote", "route", "orchestrate", "graph", "loop", "search", "workflow", "worktree", "debate", "dossier", "monitor"]
		.find((key) => params[key] !== undefined) ?? "unknown";
}

function primaryAgent(params) {
	return params.agent
		?? params.evaluate?.operator?.agent
		?? params.vote?.agent
		?? params.vote?.voters?.[0]?.agent
		?? params.route?.fallback
		?? params.route?.candidates?.[0]
		?? params.orchestrate?.recon?.agent
		?? params.chain?.[0]?.agent
		?? params.tasks?.[0]?.agent
		?? params.workflow?.phases?.find((phase) => phase.agent)?.agent
		?? params.worktree?.tasks?.[0]?.agent
		?? "operator";
}

function baseParams(testCase) {
	const params = testCase.params;
	return {
		task: params.task,
		...(params.why ? { why: params.why } : {}),
		...(params.cwd ? { cwd: params.cwd } : {}),
		...(params.returnContract ? { returnContract: params.returnContract } : {}),
		...(params.requireEvidence !== undefined ? { requireEvidence: params.requireEvidence } : {}),
	};
}

function inapplicable(name, detail) {
	return {
		name,
		component: COMPONENTS[name],
		applicable: false,
		exclusion: { reason: "inapplicable", detail },
		topology: "inapplicable",
		configurationIdentity: `arm:v1:${name}:inapplicable`,
	};
}

function selectedBySeed(candidates, seed) {
	const value = Number.parseInt(hash(seed).slice(0, 8), 16);
	return candidates[value % candidates.length];
}

function removeIntegrator(params) {
	if (params.vote?.debrief) {
		const next = clone(params);
		delete next.vote.debrief;
		return next;
	}
	if (params.graph?.debrief) {
		const next = clone(params);
		delete next.graph.debrief;
		return next;
	}
	if (params.worktree?.integrator) {
		const next = clone(params);
		delete next.worktree.integrator;
		return next;
	}
	return null;
}

function removeVerifier(params) {
	if (params.evaluate) {
		return {
			...baseParams({ params }),
			agent: params.evaluate.operator?.agent ?? "operator",
			...(params.evaluate.operator?.cwd ? { cwd: params.evaluate.operator.cwd } : {}),
			...(params.evaluate.operator?.model ? { model: params.evaluate.operator.model } : {}),
			...(params.evaluate.operator?.tier ? { tier: params.evaluate.operator.tier } : {}),
			...(params.evaluate.operator?.tools ? { tools: params.evaluate.operator.tools } : {}),
		};
	}
	if (params.orchestrate?.verify) {
		const next = clone(params);
		delete next.orchestrate.verify;
		delete next.orchestrate.verifyPolicy;
		delete next.orchestrate.verifyMaxIterations;
		return next;
	}
	if (params.worktree?.verifyCommand) {
		const next = clone(params);
		delete next.worktree.verifyCommand;
		return next;
	}
	return null;
}

function minimizeContext(params) {
	if (params.chain?.length > 1) {
		const next = clone(params);
		next.chain = next.chain.map((step, index) => index === 0 ? step : { ...step, task: step.task.replace(/\{task\}/g, "").replace(/\n{3,}/g, "\n\n").trim() });
		return next;
	}
	if (params.workflow?.phases?.length > 1) {
		const next = clone(params);
		next.workflow.phases = next.workflow.phases.map((phase, index) => index === 0 || !phase.task ? phase : { ...phase, task: phase.task.replace(/\{task\}/g, "").trim() });
		return next;
	}
	return null;
}

function supportsConcurrency(params) {
	return Boolean(params.tasks || params.vote || params.orchestrate || params.graph || params.worktree || params.debate || params.dossier);
}

function armTransform(name, testCase, seed) {
	const params = clone(testCase.params);
	const task = params.task;
	const agent = primaryAgent(params);
	if (name === "direct") return { runner: "baseline", task, topology: "single-context-direct" };
	if (name === "full") return { runner: "flow", params, topology: `flow-${modeName(params)}` };
	if (name === "compute-matched-self-review") {
		return { runner: "baseline", task: `${task}\n\nBefore returning, review and revise your own result against the task. Fix any defects you find, then return only the revised result.`, topology: "single-context-self-review" };
	}
	if (name === "deterministic-workflow") {
		return {
			runner: "flow",
			params: {
				...baseParams(testCase),
				workflow: {
					phases: [
						{ id: "solve", agent, task: "{task}" },
						{ id: "self-review", agent, task: "Review the previous result against the original task, repair it, and return the final result.\n\n{previous}" },
					],
				},
			},
			topology: "sequential-static-workflow",
		};
	}
	if (name === "no-communication-ensemble") {
		return { runner: "flow", params: { ...baseParams(testCase), vote: { agent, count: 2 }, concurrency: 1 }, topology: "independent-ensemble-no-integrator" };
	}
	if (name === "random-routing" || name === "oracle-routing") {
		const candidates = params.route?.candidates ?? [];
		if (candidates.length === 0) return null;
		const selected = name === "oracle-routing" ? testCase.experiment?.oracleAgent : selectedBySeed(candidates, `${testCase.name}:${seed}`);
		if (!selected || !candidates.includes(selected)) return null;
		return { runner: "flow", params: { ...baseParams(testCase), agent: selected }, topology: name };
	}
	if (name === "no-integrator") {
		const transformed = removeIntegrator(params);
		return transformed ? { runner: "flow", params: transformed, topology: `${modeName(params)}-without-integrator` } : null;
	}
	if (name === "no-verifier") {
		const transformed = removeVerifier(params);
		return transformed ? { runner: "flow", params: transformed, topology: `${modeName(params)}-without-verifier` } : null;
	}
	if (name === "minimal-context") {
		const transformed = minimizeContext(params);
		return transformed ? { runner: "flow", params: transformed, topology: `${modeName(params)}-minimal-context` } : null;
	}
	if (name === "sequential" || name === "parallel") {
		if (!supportsConcurrency(params)) return null;
		return { runner: "flow", params: { ...params, concurrency: name === "sequential" ? 1 : Math.max(2, params.concurrency ?? 4) }, topology: `${modeName(params)}-${name}` };
	}
	throw new Error(`unknown experiment arm: ${name}`);
}

export function parseArmSelection(raw) {
	const names = raw === null || raw === undefined || raw === "" ? ["direct", "full"] : String(raw).split(",").map((name) => name.trim()).filter(Boolean);
	if (names.length !== 2 || names[0] === names[1]) throw new Error("--arms must name exactly two distinct experiment arms");
	for (const name of names) {
		if (!EXPERIMENT_ARM_NAMES.includes(name)) throw new Error(`unknown experiment arm "${name}"; choose from ${EXPERIMENT_ARM_NAMES.join(", ")}`);
	}
	return names;
}

export function experimentArmInfo(name) {
	if (!EXPERIMENT_ARM_NAMES.includes(name)) throw new Error(`unknown experiment arm: ${name}`);
	return { name, component: COMPONENTS[name], runner: ["direct", "compute-matched-self-review"].includes(name) ? "baseline" : "flow" };
}

export function planExperimentArm(name, testCase, { bindingConstraint, seed }) {
	const transformed = armTransform(name, testCase, seed);
	if (!transformed) return inapplicable(name, `${name} does not apply to case ${testCase.name} with topology ${modeName(testCase.params)}.`);
	const configurationIdentity = [
		"arm:v1",
		name,
		transformed.topology,
		`${bindingConstraint.kind}:${bindingConstraint.value}`,
		hash(transformed.params ?? transformed.task ?? ""),
	].join(":");
	return {
		name,
		component: COMPONENTS[name],
		applicable: true,
		...transformed,
		configurationIdentity,
	};
}

export function ablationAttribution(analysis, arms) {
	const component = arms.reference.component === arms.candidate.component ? arms.reference.component : arms.reference.component;
	return {
		component,
		referenceArm: arms.reference.name,
		candidateArm: arms.candidate.name,
		qualityLift: analysis.overall.quality.meanDelta,
		reliabilityLift: analysis.overall.reliability.meanDelta,
	};
}
