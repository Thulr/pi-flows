import { flowError, type FlowError, type ModeHandler, type RunMode } from "../types.ts";
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

export const RUN_MODE_HANDLERS: Record<RunMode, ModeHandler> = Object.fromEntries(
	RUN_MODE_CONTRACTS.map((contract) => [contract.mode, contract.handler]),
) as Record<RunMode, ModeHandler>;
