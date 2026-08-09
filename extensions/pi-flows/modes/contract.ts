import { DEFAULT_CONCURRENCY, DEFAULT_SEARCH_CANDIDATES, RUN_MODE_NAMES, type FlowDiscovery, type FlowError, type FlowMode, type FlowRunResult, type ModeHandler, type RunMode } from "../types.ts";
import { validateConcurrency, validateSharedWriteCwd } from "../validate.ts";
import type { ModeCriticalPathFn, ModePlan, ModePlanFn, PlannedRef } from "./plan.ts";
import { criticalPathSingle, handleSingle, planSingle } from "./single.ts";
import { criticalPathParallel, handleParallel, planParallel } from "./parallel.ts";
import { criticalPathChain, handleChain, planChain } from "./chain.ts";
import { criticalPathEvaluate, handleEvaluate, planEvaluate } from "./evaluate.ts";
import { criticalPathVote, handleVote, planVote } from "./vote.ts";
import { criticalPathRoute, handleRoute, planRoute } from "./route.ts";
import { criticalPathOrchestrate, handleOrchestrate, planOrchestrate } from "./orchestrate.ts";
import { criticalPathGraph, handleGraph, planGraph } from "./graph.ts";
import { criticalPathLoop, handleLoop, planLoop } from "./loop.ts";
import { criticalPathSearch, handleSearch, planSearch } from "./search.ts";
import { criticalPathWorkflow, handleWorkflow, planWorkflow } from "./workflow.ts";
import { criticalPathWorktree, handleWorktree, planWorktree } from "./worktree.ts";
import { criticalPathDebate, handleDebate, planDebate } from "./debate.ts";
import { criticalPathDossier, handleDossier, planDossier } from "./dossier.ts";
import { criticalPathMonitor, handleMonitor, planMonitor } from "./monitor.ts";

export interface RunModeContract {
	mode: RunMode;
	/** The params key(s) that activate this mode, as shown in the INVALID_MODE fix text. */
	paramHint: string;
	isActive: (params: any, hasObjectMode: boolean) => boolean;
	/** The mode's declared topology (modes/plan.ts): requested agents, the shared-write mirror, budget disclosure, and the roster rule all derive from it. */
	plan: ModePlanFn;
	/** The mode's declared critical-path arithmetic; undefined is a declared answer, never a fall-through. */
	criticalPath: ModeCriticalPathFn;
	renderLabel: (params: any) => string;
	handler: ModeHandler;
}

/**
 * The single mode table. Adding a mode = one handler file + one entry here +
 * the name in RUN_MODE_NAMES (types.ts) + a params field (schema.ts). The
 * Record key makes a missing or extra entry a compile error; the handler
 * table, mode detection, render labels, requested-agent scans, the pre-spawn
 * admissibility mirror, budget disclosure, the critical-path metric, and the
 * INVALID_MODE hint list all derive from this table.
 */
const CONTRACTS: Record<RunMode, Omit<RunModeContract, "mode">> = {
	single: {
		paramHint: "agent+(task|contract)",
		isActive: (params, hasObjectMode) => Boolean(params.agent && (params.task || params.contract) && !hasObjectMode),
		plan: planSingle,
		criticalPath: criticalPathSingle,
		renderLabel: (params) => params.agent ?? "agent",
		handler: handleSingle,
	},
	parallel: {
		paramHint: "tasks[]",
		isActive: (params) => (params.tasks?.length ?? 0) > 0,
		plan: planParallel,
		criticalPath: criticalPathParallel,
		renderLabel: (params) => `parallel ${params.tasks?.length ?? 0} task${(params.tasks?.length ?? 0) === 1 ? "" : "s"}`,
		handler: handleParallel,
	},
	chain: {
		paramHint: "chain[]",
		isActive: (params) => (params.chain?.length ?? 0) > 0,
		plan: planChain,
		criticalPath: criticalPathChain,
		renderLabel: (params) => `chain ${params.chain?.length ?? 0} step${(params.chain?.length ?? 0) === 1 ? "" : "s"}`,
		handler: handleChain,
	},
	evaluate: {
		paramHint: "evaluate{}",
		isActive: (params) => Boolean(params.evaluate),
		plan: planEvaluate,
		criticalPath: criticalPathEvaluate,
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
		plan: planVote,
		criticalPath: criticalPathVote,
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
		plan: planRoute,
		criticalPath: criticalPathRoute,
		renderLabel: (params) => `route via ${params.route?.controller?.agent ?? "controller"}`,
		handler: handleRoute,
	},
	orchestrate: {
		paramHint: "orchestrate{}",
		isActive: (params) => Boolean(params.orchestrate),
		plan: planOrchestrate,
		criticalPath: criticalPathOrchestrate,
		renderLabel: (params) => `orchestrate ->${params.orchestrate?.recon?.agent ?? "recon"}`,
		handler: handleOrchestrate,
	},
	graph: {
		paramHint: "graph{}",
		isActive: (params) => Boolean(params.graph),
		plan: planGraph,
		criticalPath: criticalPathGraph,
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
		plan: planLoop,
		criticalPath: criticalPathLoop,
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
		plan: planSearch,
		criticalPath: criticalPathSearch,
		renderLabel: (params) => `search ${params.search?.candidates ?? DEFAULT_SEARCH_CANDIDATES}`,
		handler: handleSearch,
	},
	workflow: {
		paramHint: "workflow{}",
		isActive: (params) => Boolean(params.workflow),
		plan: planWorkflow,
		criticalPath: criticalPathWorkflow,
		renderLabel: (params) => `workflow ${params.workflow?.phases?.length ?? 0} phases`,
		handler: handleWorkflow,
	},
	worktree: {
		paramHint: "worktree{}",
		isActive: (params) => Boolean(params.worktree),
		plan: planWorktree,
		criticalPath: criticalPathWorktree,
		renderLabel: (params) => `worktree ${params.worktree?.tasks?.length ?? 0} writers`,
		handler: handleWorktree,
	},
	debate: {
		paramHint: "debate{}",
		isActive: (params) => Boolean(params.debate),
		plan: planDebate,
		criticalPath: criticalPathDebate,
		renderLabel: (params) => `debate ${params.debate?.participants?.length ?? 0} advocates`,
		handler: handleDebate,
	},
	dossier: {
		paramHint: "dossier{}",
		isActive: (params) => Boolean(params.dossier),
		plan: planDossier,
		criticalPath: criticalPathDossier,
		renderLabel: (params) => `dossier ${params.dossier?.sections?.length ?? 0} sources`,
		handler: handleDossier,
	},
	monitor: {
		paramHint: "monitor{}",
		isActive: (params) => Boolean(params.monitor),
		plan: planMonitor,
		criticalPath: criticalPathMonitor,
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

/** One mode's declared plan for one call. The disclosure reader asks by mode (it already resolved exactly one); the mirror readers below ask by activation. */
export function planForMode(mode: RunMode, params: any): ModePlan {
	return CONTRACTS[mode].plan(params ?? {});
}

export function requestedAgentNamesForParams(params: any): Set<string> {
	const requested = new Set<string>();
	for (const contract of RUN_MODE_CONTRACTS) {
		for (const wave of contract.plan(params).waves) {
			for (const ref of wave.refs) requested.add(ref.agent);
		}
	}
	return requested;
}

export function renderRunModeLabel(params: any): string {
	const hasObjectMode = objectModeActive(params);
	const contract = RUN_MODE_CONTRACTS.find((candidate) => candidate.isActive(params, hasObjectMode));
	return contract?.renderLabel(params) ?? params.agent ?? "agent";
}

/**
 * The first active mode's plan, in the table's order — the same activation
 * detectRunMode reads, so the pre-spawn mirror readers below answer for the
 * call the tool would run. A call activating several modes at once is refused
 * by the tool (INVALID_MODE) before any of these readers matter — the
 * selection eval scores that with detectRunMode itself; a standalone caller
 * gets first-activator semantics. Total over raw model args: activation and
 * every plan tolerate arbitrary params.
 */
function activePlan(params: Record<string, any>): ModePlan | undefined {
	const candidate = params ?? {};
	const hasObjectMode = objectModeActive(candidate);
	return RUN_MODE_CONTRACTS.find((contract) => contract.isActive(candidate, hasObjectMode))?.plan(candidate);
}

/**
 * The concurrent ref waves a call would pass to the shared-write guard before
 * any child spawns — the guarded waves of the active mode's declared plan
 * (CONTEXT.md: Mirror). Modes that never run concurrent same-cwd children
 * declare no guarded wave, and a wave an earlier refusal shadows (an over-cap
 * fan-out, an invalid graph, an invalid concurrency below) is declared
 * unguarded, so a refusal that lands before a handler's guard is never
 * mislabeled as the guard. Callers feed model-emitted args verbatim; the
 * plans are total, so malformed shapes yield smaller waves, never a throw.
 * tests/admissibility-scoring.test.ts pins the derivation against the real
 * handlers, and tests/mode-plan.test.ts pins it against the previous
 * hand-maintained mirror.
 */
export function preSpawnSharedWriteWaves(params: Record<string, any>): PlannedRef[][] {
	return (activePlan(params)?.waves ?? []).filter((wave) => wave.guarded).map((wave) => wave.refs);
}

/**
 * The refs a call would spawn before anything else — the active mode's
 * declared opening. The selection eval uses this for the roster rule: a call
 * whose every first-spawn ref names an unknown agent is refused by the runner
 * (UNKNOWN_AGENT) before any child spawns, so admitting it would credit a
 * selection nothing performed. A mode whose first spawn is not statically
 * certain declares an empty opening — monitor's reactor waits on its probe,
 * worktree's writers on a repository scan, a workflow resume on persisted
 * state (#91) — and each declaration says so in its own mode file.
 */
export function firstSpawnAgentRefs(params: Record<string, any>): PlannedRef[] {
	return activePlan(params)?.opening ?? [];
}

/**
 * Would the shared-write guard refuse this call before any child spawns? The
 * selection eval imports this beside spawnJustificationMissing so "would the
 * tool have refused this call" stays one uniform question across refusal
 * codes, answered by the tool's own guard (validateSharedWriteCwd) over the
 * declared plan waves the handlers check.
 */
export function preSpawnSharedWriteRefusal(discovery: FlowDiscovery, defaultCwd: string, params: Record<string, any>): FlowError | null {
	// The dispatch core refuses an invalid concurrency (INVALID_CONCURRENCY)
	// before any handler guard runs, so the guard can never fire behind one;
	// answering SHARED_WRITE_CWD for such a call would mislabel the refusal.
	// The concurrency bound itself is scored by the admissibility seam.
	if (validateConcurrency(params?.concurrency)) return null;
	const concurrency = params?.concurrency ?? DEFAULT_CONCURRENCY;
	for (const wave of preSpawnSharedWriteWaves(params)) {
		const error = validateSharedWriteCwd(discovery, defaultCwd, wave, params?.allowSharedWriteCwd, concurrency);
		if (error) return error;
	}
	return null;
}

/**
 * The critical path of one settled flow, from the mode's declared arithmetic.
 * Undefined when nothing ran, when the mode declares the metric unavailable
 * (orchestrate, monitor — a visible declaration in their files, no longer a
 * fall-through), or for the non-run surfaces (list, config). Wired into Core
 * trace summaries from the composition root — Core receives this resolver as
 * an argument and never imports the table.
 */
export function criticalPathForMode(mode: FlowMode, params: any, results: FlowRunResult[]): number | undefined {
	if (results.length === 0) return undefined;
	return RUN_MODE_CONTRACTS.find((contract) => contract.mode === mode)?.criticalPath(params, results);
}
