import { makeSettle } from "../settle.ts";
import { flowError, type FlowError, type ModeDeps, type ModeHandler, type RunMode } from "../types.ts";
import { RUN_MODE_CONTRACTS, activeRunModes } from "./contract.ts";

// --- Mode dispatch ------------------------------------------------------------
// Both the handler table and the INVALID_MODE hint list derive from the single
// mode table in contract.ts. Adding a mode never edits this file (OCP).

export function detectRunMode(params: any): { mode: RunMode } | { error: FlowError } {
	const active = activeRunModes(params);
	if (active.length !== 1) {
		const hints = RUN_MODE_CONTRACTS.map((contract) => contract.paramHint);
		return {
			error: flowError(
				"INVALID_MODE",
				"Invalid flow parameters.",
				`Exactly one mode is required: list:true, showConfig:true, ${hints.slice(0, -1).join(", ")}, or ${hints[hints.length - 1]}.`,
				"Choose one mode and remove conflicting keys. Run showConfig:true to inspect defaults before execution.",
			),
		};
	}
	return { mode: active[0] };
}

/**
 * The handler table, each entry wrapped so the deps a handler receives carry a
 * settle (settle.ts) built from THAT entry's mode — the only production
 * construction of a Settle. Binding it here ties the mode identity of every
 * settled output to the registry row by construction: a handler cannot settle
 * under a re-typed mode literal, because it never constructs the settle at
 * all. The wrapper overrides any settle already on the deps for the same
 * reason — an inherited one could carry someone else's identity.
 */
export const RUN_MODE_HANDLERS: Record<RunMode, ModeHandler> = Object.fromEntries(
	RUN_MODE_CONTRACTS.map((contract) => [
		contract.mode,
		(deps: ModeDeps) => contract.handler({ ...deps, settle: makeSettle(contract.mode, deps.makeDetails(contract.mode)) }),
	]),
) as Record<RunMode, ModeHandler>;
