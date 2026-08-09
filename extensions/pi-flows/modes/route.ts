import { flowError, modeSettle, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements } from "../validate.ts";
import { parseRoute, routeProtocolInstruction } from "../protocol.ts";
import { runAgentRef } from "../runner.ts";
import { plannedRefs, sumRunDurations, type ModePlan, type PlannedWave } from "./plan.ts";

/**
 * Route's plan: the controller, then the candidate step — every name the
 * controller may choose from (one of them runs), then the fallback if named.
 * Nothing is guarded (two sequential single-ref spawns cannot collide) and no
 * wave carries contract budgets: the route opener dispatches with no contract
 * limits.
 */
export function planRoute(params: any): ModePlan {
	if (!params.route) return { waves: [], opening: [] };
	const spec = params.route ?? {};
	const controller = plannedRefs([spec.controller ?? { agent: "controller" }]);
	const candidates = (Array.isArray(spec.candidates) ? spec.candidates : [])
		.filter((name: unknown): name is string => typeof name === "string")
		.map((name: string) => ({ agent: name }));
	const fallback = typeof spec.fallback === "string" ? [{ agent: spec.fallback }] : [];
	const waves: PlannedWave[] = [
		{ refs: controller, guarded: false },
		...(candidates.length > 0 ? [{ refs: candidates, guarded: false }] : []),
		...(fallback.length > 0 ? [{ refs: fallback, guarded: false }] : []),
	];
	return { waves, opening: controller };
}

/** Router, then exactly one selected candidate: sequential. */
export function criticalPathRoute(_params: any, results: FlowRunResult[]): number | undefined {
	return sumRunDurations(results);
}

/** One place each route unit key is derived, so the selected run's dependency link names the router that chose it. */
const ROUTER_KEY = "router";
const SELECTION_KEY = "selection";

export async function handleRoute(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, discovery, policy } = deps;
	const spec = params.route ?? {};
	const goal: string | undefined = params.task;
	if (!goal || !goal.trim()) {
		return settle.refuse(flowError(
			"INVALID_MODE",
			"Route mode requires a task.",
			"route mode classifies `task` and dispatches it to one candidate agent.",
			'Add a `task` string, e.g. { "task": "...", "route": { "candidates": ["recon","strategist"] } }.',
		));
	}
	const candidates: string[] = Array.isArray(spec.candidates) ? spec.candidates.filter((name: any) => typeof name === "string" && name.trim()) : [];
	if (candidates.length === 0) {
		return settle.refuse(flowError(
			"INVALID_MODE",
			"Route mode requires candidates.",
			"route.candidates lists the agent names the router may choose from.",
			'Provide route.candidates, e.g. { "route": { "candidates": ["recon","strategist","overwatch"] } }.',
		));
	}
	const contractedGoal = appendReturnRequirements(goal, params.returnContract, params.requireEvidence);

	const routerRef: FlowAgentRefInput = spec.controller ?? { agent: "controller" };
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
		`Pick the single best-fit agent for this task. ${routeProtocolInstruction()}`,
	].join("\n");
	const routed = await runAgentRef(deps, routerRef, routerTask, settle.mode, settle.nextStep, [...settle.results], { scope: { key: ROUTER_KEY } });
	settle.track(routed);
	if (isFailed(routed)) {
		return settle.complete(sanitizeText(`Flow route: router "${routerRef.agent}" failed.\n\n${resultText(routed)}`, policy));
	}

	const routingMetadata = deps.handoffs.consumeResult({ result: routed, scope: { key: ROUTER_KEY }, payload: "source" });
	if (routingMetadata.error) return settle.refuse(routingMetadata.error);
	let choice = parseRoute(routingMetadata.text, candidates);
	if (!choice && spec.fallback) choice = spec.fallback;
	if (!choice) {
		return settle.refuse(flowError(
			"ROUTE_UNRESOLVED",
			"Router did not pick a valid candidate.",
			`The router output did not name any of: ${candidates.join(", ")}.`,
			"Tighten the router prompt, adjust candidates, or set route.fallback to a default agent.",
		));
	}

	deps.recordEvent?.({ kind: "state", name: "route.selected", scope: { key: SELECTION_KEY, dependsOn: [routingMetadata.dependencyKey!] }, attributes: { "flow.route.choice": choice, "flow.route.candidates": candidates.join(","), "flow.route.fallback_used": !parseRoute(routingMetadata.text, candidates), "flow.handoff.policy": deps.handoffs.resolution.effective, "flow.handoff.policy_action": routingMetadata.action } });
	const selected = await runAgentRef(deps, { agent: choice }, contractedGoal, settle.mode, settle.nextStep, [...settle.results], { scope: { key: "selected", dependsOn: [SELECTION_KEY] } });
	settle.track(selected);
	if (isFailed(selected)) {
		return settle.complete(sanitizeText(`Flow route: ${routerRef.agent} → ${choice}, but "${choice}" failed.\n\n${resultText(selected)}`, policy));
	}
	return settle.complete(capModelVisibleText(`Flow route: ${routerRef.agent} → ${choice}.\n\n${sanitizeText(resultText(selected), policy)}`));
}
