import { flowError, modeSettle, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements } from "../validate.ts";
import { parseRoute, routeProtocolInstruction } from "../protocol.ts";
import { integrationControl } from "../delegation.ts";
import { dispatchIntegrationPlan, integrationRunPlan } from "../integration.ts";
import { plannedRefs, sumRunDurations, type ModePlan, type PlannedWave } from "./plan.ts";

/**
 * Route's controller, resolved once (CONTEXT.md: Mirror). The declaration below
 * and the handler both read it here, so which agent routes — and the default
 * when the caller names none — is stated once rather than in two places kept in
 * agreement by hand.
 */
export const ROUTE_CONTROLLER_DEFAULT: FlowAgentRefInput = Object.freeze({ agent: "controller" });

/** Route's roles for one call: the caller's controller where given, else the shared default. */
export function routeRoles(params: any): { controller: FlowAgentRefInput } {
	const spec = params?.route ?? {};
	return { controller: spec.controller ?? ROUTE_CONTROLLER_DEFAULT };
}

/** Contracted controller, every selectable candidate, then optional fallback. */
export function planRoute(params: any): ModePlan {
	if (!params.route) return { waves: [], opening: [] };
	const spec = params.route ?? {};
	const controller = plannedRefs([routeRoles(params).controller]);
	const candidates = (Array.isArray(spec.candidates) ? spec.candidates : [])
		.filter((name: unknown): name is string => typeof name === "string")
		.map((name: string) => ({ agent: name }));
	const fallback = typeof spec.fallback === "string" ? [{ agent: spec.fallback }] : [];
	const waves: PlannedWave[] = [
		{ refs: controller, guarded: false, contracts: "own" },
		...(candidates.length > 0 ? [{ refs: candidates, guarded: false }] : []),
		...(fallback.length > 0 ? [{ refs: fallback, guarded: false }] : []),
	];
	return { waves, opening: controller };
}

export function criticalPathRoute(_params: any, results: FlowRunResult[]): number | undefined {
	return sumRunDurations(results);
}

const ROUTER_KEY = "router";
const SELECTION_KEY = "selection";

/** Refuse a missing task or candidate set before the controller spawns. */
export function preSpawnRefusalRoute(params: any): FlowError | null {
	if (params?.route === undefined) return null;
	const spec = params.route ?? {};
	if (typeof params.task !== "string" || !params.task.trim()) {
		return flowError(
			"INVALID_MODE",
			"Route mode requires a task.",
			"route mode classifies `task` and dispatches it to one candidate agent.",
			'Add a `task` string, e.g. { "task": "...", "route": { "candidates": ["recon","strategist"] } }.',
		);
	}
	const candidates = Array.isArray(spec.candidates) ? spec.candidates.filter((name: any) => typeof name === "string" && name.trim()) : [];
	if (candidates.length === 0) {
		return flowError(
			"INVALID_MODE",
			"Route mode requires candidates.",
			"route.candidates lists the agent names the router may choose from.",
			'Provide route.candidates, e.g. { "route": { "candidates": ["recon","strategist","overwatch"] } }.',
		);
	}
	return null;
}

export async function handleRoute(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, discovery, policy } = deps;
	const spec = params.route ?? {};
	const entryRefusal = preSpawnRefusalRoute(params);
	if (entryRefusal) return settle.refuse(entryRefusal);
	const goal = params.task as string;
	const candidates: string[] = spec.candidates.filter((name: any) => typeof name === "string" && name.trim());
	const contractedGoal = appendReturnRequirements(goal, params.returnRequirements, params.requireEvidence);

	const routerRef: FlowAgentRefInput = routeRoles(params).controller;
	const routerTask = [
		"## Task to route",
		goal,
		"\n## Candidate agents (choose exactly one)",
		candidates
			.map((name) => {
				const agent = discovery.agents.find((candidate) => candidate.name === name);
				return `- ${name}${agent ? `: ${agent.description}` : ""}`;
			})
			.join("\n"),
		"\n## Your job",
		`Pick the single best-fit agent for this task. ${routeProtocolInstruction(Boolean(routerRef.contract))}`,
	].join("\n");
	const routerPlan = integrationRunPlan(deps, routerRef, routerTask, { scope: { key: ROUTER_KEY } });
	if (routerPlan.error) return settle.refuse(routerPlan.error);
	const routerDispatch = await dispatchIntegrationPlan(deps, routerPlan.plan!, settle, { payload: "source", enforceCompletion: true });
	if (routerDispatch.status === "failed") {
		return settle.complete(sanitizeText(`Flow route: router "${routerRef.agent}" failed.\n\n${resultText(routerDispatch.result)}`, policy));
	}
	if (routerDispatch.status === "refused") return routerDispatch.output;
	const routed = routerDispatch.result;

	const routingMetadata = routerDispatch.handoff;
	const controlData = integrationControl(routed);
	const parsedChoice = routingMetadata.action === "quarantine" ? null : parseRoute(controlData, candidates);
	let choice = parsedChoice;
	if (!choice && spec.fallback) choice = spec.fallback;
	if (!choice) {
		return settle.refuse(flowError(
			"ROUTE_UNRESOLVED",
			"Router did not pick a valid candidate.",
			`The router output did not name any of: ${candidates.join(", ")}.`,
			"Tighten the router prompt, adjust candidates, or set route.fallback to a default agent.",
		));
	}

	deps.recordEvent?.({ kind: "state", name: "route.selected", scope: { key: SELECTION_KEY, dependsOn: [routingMetadata.dependencyKey] }, attributes: { "flow.route.choice": choice, "flow.route.candidates": candidates.join(","), "flow.route.fallback_used": !parsedChoice, "flow.handoff.policy": deps.handoffs.resolution.effective, "flow.handoff.policy_action": routingMetadata.action } });
	const selectedPlan = integrationRunPlan(deps, { agent: choice }, contractedGoal, { scope: { key: "selected", dependsOn: [SELECTION_KEY] } });
	if (selectedPlan.error) return settle.refuse(selectedPlan.error);
	const selectedDispatch = await dispatchIntegrationPlan(deps, selectedPlan.plan!, settle, { completion: "terminal", payload: "source" });
	if (selectedDispatch.status === "failed") {
		return settle.complete(sanitizeText(`Flow route: ${routerRef.agent} → ${choice}, but "${choice}" failed.\n\n${resultText(selectedDispatch.result)}`, policy));
	}
	if (selectedDispatch.status === "refused") return selectedDispatch.output;
	return settle.complete(capModelVisibleText(`Flow route: ${routerRef.agent} → ${choice}.\n\n${sanitizeText(resultText(selectedDispatch.result), policy)}`));
}
