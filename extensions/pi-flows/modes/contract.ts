import { DEFAULT_SEARCH_CANDIDATES, RUN_MODE_NAMES, type FlowAgentRefInput, type ModeHandler, type RunMode } from "../types.ts";
import { handleSingle } from "./single.ts";
import { handleParallel } from "./parallel.ts";
import { handleChain } from "./chain.ts";
import { handleEvaluate } from "./evaluate.ts";
import { handleVote } from "./vote.ts";
import { handleRoute } from "./route.ts";
import { handleOrchestrate } from "./orchestrate.ts";
import { handleGraph } from "./graph.ts";
import { handleLoop } from "./loop.ts";
import { handleSearch } from "./search.ts";
import { handleWorkflow } from "./workflow.ts";
import { handleWorktree } from "./worktree.ts";
import { handleDebate } from "./debate.ts";
import { handleDossier } from "./dossier.ts";
import { handleMonitor } from "./monitor.ts";

export interface RunModeContract {
	mode: RunMode;
	/** The params key(s) that activate this mode, as shown in the INVALID_MODE fix text. */
	paramHint: string;
	isActive: (params: any, hasObjectMode: boolean) => boolean;
	requestedAgents: (params: any) => string[];
	renderLabel: (params: any) => string;
	handler: ModeHandler;
}

function refAgent(ref: FlowAgentRefInput | undefined, fallback?: string): string[] {
	const agent = ref?.agent ?? fallback;
	return agent ? [agent] : [];
}

/**
 * The single mode table. Adding a mode = one handler file + one entry here +
 * the name in RUN_MODE_NAMES (types.ts) + a params field (schema.ts). The
 * Record key makes a missing or extra entry a compile error; the handler
 * table, mode detection, render labels, requested-agent scans, and the
 * INVALID_MODE hint list all derive from this table.
 */
const CONTRACTS: Record<RunMode, Omit<RunModeContract, "mode">> = {
	single: {
		paramHint: "agent+(task|contract)",
		isActive: (params, hasObjectMode) => Boolean(params.agent && (params.task || params.contract) && !hasObjectMode),
		requestedAgents: (params) => (params.agent ? [params.agent] : []),
		renderLabel: (params) => params.agent ?? "agent",
		handler: handleSingle,
	},
	parallel: {
		paramHint: "tasks[]",
		isActive: (params) => (params.tasks?.length ?? 0) > 0,
		requestedAgents: (params) => (params.tasks ?? []).map((task: any) => task.agent).filter(Boolean),
		renderLabel: (params) => `parallel ${params.tasks?.length ?? 0} task${(params.tasks?.length ?? 0) === 1 ? "" : "s"}`,
		handler: handleParallel,
	},
	chain: {
		paramHint: "chain[]",
		isActive: (params) => (params.chain?.length ?? 0) > 0,
		requestedAgents: (params) => (params.chain ?? []).map((step: any) => step.agent).filter(Boolean),
		renderLabel: (params) => `chain ${params.chain?.length ?? 0} step${(params.chain?.length ?? 0) === 1 ? "" : "s"}`,
		handler: handleChain,
	},
	evaluate: {
		paramHint: "evaluate{}",
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
		handler: handleEvaluate,
	},
	vote: {
		paramHint: "vote{}",
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
		handler: handleVote,
	},
	route: {
		paramHint: "route{}",
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
		handler: handleRoute,
	},
	orchestrate: {
		paramHint: "orchestrate{}",
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
		handler: handleOrchestrate,
	},
	graph: {
		paramHint: "graph{}",
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
		handler: handleGraph,
	},
	loop: {
		paramHint: "loop{}",
		isActive: (params) => Boolean(params.loop),
		requestedAgents: (params) => [...refAgent(params.loop?.body), ...refAgent(params.loop?.judge)],
		renderLabel: (params) => {
			const body = params.loop?.body?.agent ?? "agent";
			const judge = params.loop?.judge?.agent ? `->${params.loop.judge.agent}` : "";
			return `loop ${body}${judge}`;
		},
		handler: handleLoop,
	},
	search: {
		paramHint: "search{}",
		isActive: (params) => Boolean(params.search),
		requestedAgents: (params) => params.search
			? [
					params.search.generator?.agent ?? "strategist",
					params.search.scorer?.agent ?? "redteam",
					params.search.debrief?.agent ?? "debrief",
				]
			: [],
		renderLabel: (params) => `search ${params.search?.candidates ?? DEFAULT_SEARCH_CANDIDATES}`,
		handler: handleSearch,
	},
	workflow: {
		paramHint: "workflow{}",
		isActive: (params) => Boolean(params.workflow),
		requestedAgents: (params) => [
			...(params.workflow?.phases ?? []).flatMap((phase: any) => phase.agent ? [phase.agent] : []),
			...refAgent(params.workflow?.debrief),
		],
		renderLabel: (params) => `workflow ${params.workflow?.phases?.length ?? 0} phases`,
		handler: handleWorkflow,
	},
	worktree: {
		paramHint: "worktree{}",
		isActive: (params) => Boolean(params.worktree),
		requestedAgents: (params) => [
			...(params.worktree?.tasks ?? []).flatMap((task: any) => refAgent(task)),
			...refAgent(params.worktree?.integrator, "operator"),
		],
		renderLabel: (params) => `worktree ${params.worktree?.tasks?.length ?? 0} writers`,
		handler: handleWorktree,
	},
	debate: {
		paramHint: "debate{}",
		isActive: (params) => Boolean(params.debate),
		requestedAgents: (params) => [
			...(params.debate?.participants ?? []).flatMap((participant: any) => refAgent(participant)),
			...refAgent(params.debate?.adjudicator, "analyst"),
		],
		renderLabel: (params) => `debate ${params.debate?.participants?.length ?? 0} advocates`,
		handler: handleDebate,
	},
	dossier: {
		paramHint: "dossier{}",
		isActive: (params) => Boolean(params.dossier),
		requestedAgents: (params) => [
			...(params.dossier?.sections ?? []).flatMap((section: any) => refAgent(section)),
			...refAgent(params.dossier?.debrief, "debrief"),
		],
		renderLabel: (params) => `dossier ${params.dossier?.sections?.length ?? 0} sources`,
		handler: handleDossier,
	},
	monitor: {
		paramHint: "monitor{}",
		isActive: (params) => Boolean(params.monitor),
		requestedAgents: (params) => refAgent(params.monitor?.reactor, "analyst"),
		renderLabel: (params) => `monitor ${params.monitor?.maxChecks ?? 6} checks`,
		handler: handleMonitor,
	},
};

export const RUN_MODE_CONTRACTS: RunModeContract[] = RUN_MODE_NAMES.map((mode) => ({ mode, ...CONTRACTS[mode] }));

function objectModeActive(params: any): boolean {
	return RUN_MODE_CONTRACTS.some((contract) => contract.mode !== "single" && contract.isActive(params, false));
}

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
