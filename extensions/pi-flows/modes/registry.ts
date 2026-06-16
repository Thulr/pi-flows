import { flowError, type FlowError, type ModeHandler, type RunMode } from "../types.ts";
import { activeRunModes } from "./contract.ts";
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
	const active = activeRunModes(params);
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
