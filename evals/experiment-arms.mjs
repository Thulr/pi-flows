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

const MODE_EXPERIMENTS = [
	{ name: "single", active: (p) => Boolean(p.agent), primary: (p) => p.agent, calls: () => 1 },
	{ name: "parallel", active: (p) => Boolean(p.tasks), primary: (p) => p.tasks[0]?.agent, calls: (p) => p.tasks.length },
	{ name: "chain", active: (p) => Boolean(p.chain), primary: (p) => p.chain[0]?.agent, calls: (p) => p.chain.length },
	{
		name: "evaluate",
		active: (p) => Boolean(p.evaluate),
		primary: (p) => p.evaluate.operator?.agent,
		calls: () => null,
	},
	{
		name: "vote",
		active: (p) => Boolean(p.vote),
		primary: (p) => p.vote.agent ?? p.vote.voters?.[0]?.agent,
		calls: (p) => (p.vote.voters?.length ?? p.vote.count ?? 3) + (p.vote.debrief ? 1 : 0),
	},
	{ name: "route", active: (p) => Boolean(p.route), primary: (p) => p.route.fallback ?? p.route.candidates?.[0], calls: () => 2 },
	{
		name: "orchestrate",
		active: (p) => Boolean(p.orchestrate),
		primary: (p) => p.orchestrate.recon?.agent,
		calls: () => null,
	},
	{ name: "graph", active: (p) => Boolean(p.graph), primary: (p) => p.graph.nodes[0]?.agent, calls: (p) => p.graph.nodes.length + (p.graph.debrief ? 1 : 0) },
	{ name: "loop", active: (p) => Boolean(p.loop), primary: (p) => p.loop.body?.agent, calls: () => null },
	{ name: "search", active: (p) => Boolean(p.search), primary: (p) => p.search.generator?.agent, calls: () => null },
	{ name: "workflow", active: (p) => Boolean(p.workflow), primary: (p) => p.workflow.phases.find((phase) => phase.agent)?.agent, calls: () => null },
	{ name: "worktree", active: (p) => Boolean(p.worktree), primary: (p) => p.worktree.tasks[0]?.agent, calls: () => null },
	{ name: "debate", active: (p) => Boolean(p.debate), primary: (p) => p.debate.participants[0]?.agent, calls: (p) => p.debate.participants.length * (p.debate.rounds ?? 2) + 1 },
	{ name: "dossier", active: (p) => Boolean(p.dossier), primary: (p) => p.dossier.sections[0]?.agent, calls: () => null },
	{ name: "monitor", active: (p) => Boolean(p.monitor), primary: (p) => p.monitor.reactor?.agent, calls: () => null },
];

const experimentMode = (params) => MODE_EXPERIMENTS.find((mode) => mode.active(params));

function modeName(params) {
	return experimentMode(params)?.name ?? "unknown";
}

function primaryAgent(params) {
	return experimentMode(params)?.primary(params) ?? "operator";
}

function expectedModelCalls(params) {
	return experimentMode(params)?.calls(params) ?? null;
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
	return null;
}

function removeVerifier(params) {
	if (params.evaluate) {
		const operator = params.evaluate.operator ?? {};
		const contract = operator.contract ?? params.contract;
		const task = params.task ?? operator.task ?? contract?.objective;
		if (!task) return null;
		return {
			...baseParams({ params }),
			task,
			agent: operator.agent ?? "operator",
			...(contract ? { contract } : {}),
			...(operator.cwd ?? params.cwd ? { cwd: operator.cwd ?? params.cwd } : {}),
			...(operator.model ?? params.model ? { model: operator.model ?? params.model } : {}),
			...(operator.tier ?? params.tier ? { tier: operator.tier ?? params.tier } : {}),
			...(operator.tools ?? params.tools ? { tools: operator.tools ?? params.tools } : {}),
		};
	}
	if (params.orchestrate?.verify) {
		const next = clone(params);
		delete next.orchestrate.verify;
		delete next.orchestrate.verifyPolicy;
		delete next.orchestrate.verifyMaxIterations;
		return next;
	}
	if (params.worktree?.checkCommand) {
		const next = clone(params);
		delete next.worktree.checkCommand;
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

function armTransform(name, testCase, seed, bindingConstraint) {
	const params = clone(testCase.params);
	const task = params.task;
	const agent = primaryAgent(params);
	if (name === "direct") return { runner: "baseline", task, topology: "single-context-direct" };
	if (name === "full") return { runner: "flow", params, topology: `flow-${modeName(params)}` };
	if (name === "compute-matched-self-review") {
		const modelCalls = expectedModelCalls(params);
		if (!Number.isInteger(modelCalls) || modelCalls < 1) return null;
		const chain = Array.from({ length: modelCalls }, (_, index) => ({
			agent,
			task: index === 0
				? "Complete the original task directly. Return your best concrete result.\n\n{task}"
				: "Review and revise the previous result against the original task. Fix defects, preserve correct evidence, and return only the improved result.\n\n{previous}",
		}));
		return {
			runner: "flow",
			params: { ...baseParams(testCase), chain, concurrency: 1 },
			topology: "single-agent-self-review",
			computeAllocation: { modelCalls, binding: `${bindingConstraint.kind}:${bindingConstraint.value}` },
		};
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
	const components = names.map((name) => COMPONENTS[name]);
	if (components[0] !== components[1] && !names.includes("full")) {
		throw new Error("--arms must compare two arms of one component or compare a control with full");
	}
	return names;
}

export function experimentArmInfo(name) {
	if (!EXPERIMENT_ARM_NAMES.includes(name)) throw new Error(`unknown experiment arm: ${name}`);
	return { name, component: COMPONENTS[name], runner: name === "direct" ? "baseline" : "flow" };
}

export function planExperimentArm(name, testCase, { bindingConstraint, seed }) {
	const transformed = armTransform(name, testCase, seed, bindingConstraint);
	if (!transformed) return inapplicable(name, `${name} does not apply to case ${testCase.name} with topology ${modeName(testCase.params)}.`);
	if (transformed.runner === "flow" && !transformed.params.why) {
		transformed.params = { ...transformed.params, why: `controlled ${name} experiment arm requires isolated child execution` };
	}
	const configurationIdentity = [
		"arm:v1",
		name,
		transformed.topology,
		`${bindingConstraint.kind}:${bindingConstraint.value}`,
		transformed.computeAllocation ? `calls:${transformed.computeAllocation.modelCalls}` : "calls:topology",
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
	const component = arms.reference.component === arms.candidate.component
		? arms.reference.component
		: arms.reference.name === "full" ? arms.candidate.component : arms.reference.component;
	return {
		component,
		referenceArm: arms.reference.name,
		candidateArm: arms.candidate.name,
		qualityLift: analysis.overall.quality.meanDelta,
		reliabilityLift: analysis.overall.reliability.meanDelta,
	};
}
