import { flowError, type FlowError, type ModeHandler, type RunMode } from "../types.ts";
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

// --- Mode handlers ------------------------------------------------------------
// Each run-mode is a self-contained handler registered in RUN_MODE_HANDLERS.
// New orchestration patterns are added by writing a handler + a detectRunMode
// discriminator + schema fields, without editing the dispatch core (OCP).


export function detectRunMode(params: any): { mode: RunMode } | { error: FlowError } {
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasEvaluate = Boolean(params.evaluate);
	const hasVote = Boolean(params.vote);
	const hasRoute = Boolean(params.route);
	const hasOrchestrate = Boolean(params.orchestrate);
	const hasGraph = Boolean(params.graph);
	const hasLoop = Boolean(params.loop);
	const hasSearch = Boolean(params.search);
	const hasObjectMode = hasChain || hasTasks || hasEvaluate || hasVote || hasRoute || hasOrchestrate || hasGraph || hasLoop || hasSearch;
	// Single is the fallback shape (agent + task) only when no richer mode object is present.
	const hasSingle = Boolean(params.agent && params.task && !hasObjectMode);

	const signals: Array<[boolean, RunMode]> = [
		[hasSingle, "single"],
		[hasTasks, "parallel"],
		[hasChain, "chain"],
		[hasEvaluate, "evaluate"],
		[hasVote, "vote"],
		[hasRoute, "route"],
		[hasOrchestrate, "orchestrate"],
		[hasGraph, "graph"],
		[hasLoop, "loop"],
		[hasSearch, "search"],
	];
	const active = signals.filter(([on]) => on).map(([, mode]) => mode);
	if (active.length !== 1) {
		return {
			error: flowError(
				"INVALID_MODE",
				"Invalid flow parameters.",
				"Exactly one mode is required: list:true, showConfig:true, agent+task, tasks[], chain[], evaluate{}, vote{}, route{}, orchestrate{}, graph{}, loop{}, or search{}.",
				"Choose one mode and remove conflicting keys. Run showConfig:true to inspect defaults before execution.",
			),
		};
	}
	return { mode: active[0] };
}

export const RUN_MODE_HANDLERS: Record<RunMode, ModeHandler> = {
	single: handleSingle,
	parallel: handleParallel,
	chain: handleChain,
	evaluate: handleEvaluate,
	vote: handleVote,
	route: handleRoute,
	orchestrate: handleOrchestrate,
	graph: handleGraph,
	loop: handleLoop,
	search: handleSearch,
};
