import { DEFAULT_SEARCH_CANDIDATES, type FlowAgentRefInput, type RunMode } from "../types.ts";

export interface RunModeContract {
	mode: RunMode;
	isActive: (params: any, hasObjectMode: boolean) => boolean;
	requestedAgents: (params: any) => string[];
	renderLabel: (params: any) => string;
}

function refAgent(ref: FlowAgentRefInput | undefined, fallback?: string): string[] {
	const agent = ref?.agent ?? fallback;
	return agent ? [agent] : [];
}

function objectModeActive(params: any): boolean {
	return OBJECT_RUN_MODE_CONTRACTS.some((contract) => contract.isActive(params, false));
}

export const SINGLE_RUN_MODE_CONTRACT: RunModeContract = {
	mode: "single",
	isActive: (params, hasObjectMode) => Boolean(params.agent && params.task && !hasObjectMode),
	requestedAgents: (params) => (params.agent ? [params.agent] : []),
	renderLabel: (params) => params.agent ?? "agent",
};

export const OBJECT_RUN_MODE_CONTRACTS: RunModeContract[] = [
	{
		mode: "parallel",
		isActive: (params) => (params.tasks?.length ?? 0) > 0,
		requestedAgents: (params) => (params.tasks ?? []).map((task: any) => task.agent).filter(Boolean),
		renderLabel: (params) => `parallel ${params.tasks?.length ?? 0} task${(params.tasks?.length ?? 0) === 1 ? "" : "s"}`,
	},
	{
		mode: "chain",
		isActive: (params) => (params.chain?.length ?? 0) > 0,
		requestedAgents: (params) => (params.chain ?? []).map((step: any) => step.agent).filter(Boolean),
		renderLabel: (params) => `chain ${params.chain?.length ?? 0} step${(params.chain?.length ?? 0) === 1 ? "" : "s"}`,
	},
	{
		mode: "evaluate",
		isActive: (params) => Boolean(params.evaluate),
		requestedAgents: (params) => {
			if (!params.evaluate) return [];
			const critics = Array.isArray(params.evaluate.redteam) ? params.evaluate.redteam : [params.evaluate.redteam];
			return [
				params.evaluate.operator?.agent ?? "operator",
				...(critics.some((critic: any) => critic?.agent) ? critics.flatMap((critic: any) => refAgent(critic)) : ["redteam"]),
			];
		},
		renderLabel: (params) => {
			const generator = params.evaluate?.operator?.agent ?? "operator";
			const redteam = params.evaluate?.redteam;
			const evaluator = Array.isArray(redteam) ? `${redteam.length} critics` : redteam?.agent ?? "redteam";
			const gate = params.evaluate?.checkCommand ? " +check" : "";
			return `evaluate ${generator}->${evaluator}${gate}`;
		},
	},
	{
		mode: "vote",
		isActive: (params) => Boolean(params.vote),
		requestedAgents: (params) => {
			if (!params.vote) return [];
			return [
				...(params.vote.agent ? [params.vote.agent] : []),
				...(params.vote.voters ?? []).flatMap((voter: any) => refAgent(voter)),
				...refAgent(params.vote.debrief),
			];
		},
		renderLabel: (params) => {
			const count = params.vote?.voters?.length ?? params.vote?.count ?? 3;
			const suffix = params.vote?.debrief?.agent ? `->${params.vote.debrief.agent}` : "";
			return `vote ${count}${suffix}`;
		},
	},
	{
		mode: "route",
		isActive: (params) => Boolean(params.route),
		requestedAgents: (params) => {
			if (!params.route) return [];
			return [
				params.route.controller?.agent ?? "controller",
				...(params.route.candidates ?? []).filter((candidate: any) => typeof candidate === "string"),
				...(typeof params.route.fallback === "string" ? [params.route.fallback] : []),
			];
		},
		renderLabel: (params) => `route via ${params.route?.controller?.agent ?? "controller"}`,
	},
	{
		mode: "orchestrate",
		isActive: (params) => Boolean(params.orchestrate),
		requestedAgents: (params) => {
			if (!params.orchestrate) return [];
			return [
				params.orchestrate.commander?.agent ?? "commander",
				params.orchestrate.recon?.agent ?? "recon",
				params.orchestrate.debrief?.agent ?? "debrief",
				...refAgent(params.orchestrate.verify),
			];
		},
		renderLabel: (params) => `orchestrate ->${params.orchestrate?.recon?.agent ?? "recon"}`,
	},
	{
		mode: "graph",
		isActive: (params) => Boolean(params.graph),
		requestedAgents: (params) => [
			...(params.graph?.nodes ?? []).flatMap((node: any) => refAgent(node)),
			...refAgent(params.graph?.debrief),
		],
		renderLabel: (params) => {
			const count = params.graph?.nodes?.length ?? 0;
			const suffix = params.graph?.debrief?.agent ? `->${params.graph.debrief.agent}` : "";
			return `graph ${count}${suffix}`;
		},
	},
	{
		mode: "loop",
		isActive: (params) => Boolean(params.loop),
		requestedAgents: (params) => [...refAgent(params.loop?.body), ...refAgent(params.loop?.judge)],
		renderLabel: (params) => {
			const body = params.loop?.body?.agent ?? "agent";
			const judge = params.loop?.judge?.agent ? `->${params.loop.judge.agent}` : "";
			return `loop ${body}${judge}`;
		},
	},
	{
		mode: "search",
		isActive: (params) => Boolean(params.search),
		requestedAgents: (params) => params.search
			? [
					params.search.generator?.agent ?? "strategist",
					params.search.scorer?.agent ?? "redteam",
					params.search.debrief?.agent ?? "debrief",
				]
			: [],
		renderLabel: (params) => `search ${params.search?.candidates ?? DEFAULT_SEARCH_CANDIDATES}`,
	},
	{
		mode: "workflow",
		isActive: (params) => Boolean(params.workflow),
		requestedAgents: (params) => [
			...(params.workflow?.phases ?? []).flatMap((phase: any) => phase.agent ? [phase.agent] : []),
			...refAgent(params.workflow?.debrief),
		],
		renderLabel: (params) => `workflow ${params.workflow?.phases?.length ?? 0} phases`,
	},
	{
		mode: "worktree",
		isActive: (params) => Boolean(params.worktree),
		requestedAgents: (params) => [
			...(params.worktree?.tasks ?? []).flatMap((task: any) => refAgent(task)),
			...refAgent(params.worktree?.integrator, "operator"),
		],
		renderLabel: (params) => `worktree ${params.worktree?.tasks?.length ?? 0} writers`,
	},
	{
		mode: "debate",
		isActive: (params) => Boolean(params.debate),
		requestedAgents: (params) => [
			...(params.debate?.participants ?? []).flatMap((participant: any) => refAgent(participant)),
			...refAgent(params.debate?.adjudicator, "analyst"),
		],
		renderLabel: (params) => `debate ${params.debate?.participants?.length ?? 0} advocates`,
	},
	{
		mode: "dossier",
		isActive: (params) => Boolean(params.dossier),
		requestedAgents: (params) => [
			...(params.dossier?.sections ?? []).flatMap((section: any) => refAgent(section)),
			...refAgent(params.dossier?.debrief, "debrief"),
		],
		renderLabel: (params) => `dossier ${params.dossier?.sections?.length ?? 0} sources`,
	},
	{
		mode: "monitor",
		isActive: (params) => Boolean(params.monitor),
		requestedAgents: (params) => refAgent(params.monitor?.reactor, "analyst"),
		renderLabel: (params) => `monitor ${params.monitor?.maxChecks ?? 6} checks`,
	},
];

export const RUN_MODE_CONTRACTS: RunModeContract[] = [SINGLE_RUN_MODE_CONTRACT, ...OBJECT_RUN_MODE_CONTRACTS];
export const RUN_MODE_NAMES = RUN_MODE_CONTRACTS.map((contract) => contract.mode);

export function activeRunModes(params: any): RunMode[] {
	const hasObjectMode = objectModeActive(params);
	return RUN_MODE_CONTRACTS.filter((contract) => contract.isActive(params, hasObjectMode)).map((contract) => contract.mode);
}

export function requestedAgentNamesForParams(params: any): Set<string> {
	const requested = new Set<string>();
	for (const contract of RUN_MODE_CONTRACTS) {
		for (const agent of contract.requestedAgents(params)) requested.add(agent);
	}
	return requested;
}

export function renderRunModeLabel(params: any): string {
	const hasObjectMode = objectModeActive(params);
	const contract = RUN_MODE_CONTRACTS.find((candidate) => candidate.isActive(params, hasObjectMode));
	return contract?.renderLabel(params) ?? params.agent ?? "agent";
}
