import { flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnContract } from "../validate.ts";
import { parseRoute, routeProtocolInstruction } from "../protocol.ts";
import { runAgentRef } from "../runner.ts";

export async function handleRoute(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, makeDetails } = deps;
	const spec = params.route ?? {};
	const goal: string | undefined = params.task;
	if (!goal || !goal.trim()) {
		const error = flowError(
			"INVALID_MODE",
			"Route mode requires a task.",
			"route mode classifies `task` and dispatches it to one candidate agent.",
			'Add a `task` string, e.g. { "task": "...", "route": { "candidates": ["recon","strategist"] } }.',
		);
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("route")([], error) };
	}
	const candidates: string[] = Array.isArray(spec.candidates) ? spec.candidates.filter((name: any) => typeof name === "string" && name.trim()) : [];
	if (candidates.length === 0) {
		const error = flowError(
			"INVALID_MODE",
			"Route mode requires candidates.",
			"route.candidates lists the agent names the router may choose from.",
			'Provide route.candidates, e.g. { "route": { "candidates": ["recon","strategist","overwatch"] } }.',
		);
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("route")([], error) };
	}
	const contractedGoal = appendReturnContract(goal, params.returnContract, params.requireEvidence);

	const results: FlowRunResult[] = [];
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
	const routed = await runAgentRef(deps, routerRef, routerTask, "route", 1, results);
	results.push(routed);
	if (isFailed(routed)) {
		return { content: [{ type: "text", text: sanitizeText(`Flow route: router "${routerRef.agent}" failed.\n\n${resultText(routed)}`, policy) }], details: makeDetails("route")(results) };
	}

	let choice = parseRoute(resultText(routed), candidates);
	if (!choice && spec.fallback) choice = spec.fallback;
	if (!choice) {
		const error = flowError(
			"ROUTE_UNRESOLVED",
			"Router did not pick a valid candidate.",
			`The router output did not name any of: ${candidates.join(", ")}.`,
			"Tighten the router prompt, adjust candidates, or set route.fallback to a default agent.",
		);
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("route")([], error) };
	}

	const specialist = await runAgentRef(deps, { agent: choice }, contractedGoal, "route", results.length + 1, results);
	results.push(specialist);
	if (isFailed(specialist)) {
		return {
			content: [{ type: "text", text: sanitizeText(`Flow route: ${routerRef.agent} → ${choice}, but "${choice}" failed.\n\n${resultText(specialist)}`, policy) }],
			details: makeDetails("route")(results),
		};
	}
	return {
		content: [{ type: "text", text: capModelVisibleText(`Flow route: ${routerRef.agent} → ${choice}.\n\n${sanitizeText(resultText(specialist), policy)}`) }],
		details: makeDetails("route")(results),
	};
}
