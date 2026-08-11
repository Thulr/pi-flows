import { MAX_GRAPH_NODES, encodeAuthorKey, flowError, modeSettle, type DelegationContract, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, escapeRegExp, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { graphDependsOn, validGraphNodes } from "../validate.ts";
import { runWave } from "../runner.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { dispatchIntegrationPlan, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { plannedRefs, runDuration, type ModePlan, type PlannedWave } from "./plan.ts";

/**
 * Graph's pre-spawn refusal (modes/contract.ts): every structural defect
 * the handler refuses GRAPH_INVALID for, then the one cycle shape that is
 * knowable before dispatch — a structurally valid graph with no
 * dependency-free node computes an empty first wave and can never start.
 *
 * A cycle stranding only *later* nodes is invisible here and stays in the
 * handler's wave loop, which refuses GRAPH_CYCLE with its own cause. Different
 * moments, not a duplicated rule: this says no first wave exists, that says no
 * remaining node became runnable. Total over raw model args — dependency lists
 * read through graphDependsOn, so a malformed one yields no dependencies.
 */
export function preSpawnRefusalGraph(params: any): FlowError | null {
	if (params?.graph === undefined) return null;
	const nodes = Array.isArray(params.graph?.nodes) ? params.graph.nodes : [];
	if (nodes.length === 0 || nodes.length > MAX_GRAPH_NODES) {
		return flowError(
			"GRAPH_INVALID",
			`Graph mode needs 1..${MAX_GRAPH_NODES} nodes.`,
			"graph.nodes must be a non-empty static DAG of agent nodes, bounded so graph mode cannot become unbounded orchestration.",
			`Provide between 1 and ${MAX_GRAPH_NODES} graph nodes.`,
		);
	}
	const ids = new Set<string>();
	for (const node of nodes) {
		if (!node?.id || !node.agent || !node.task || ids.has(node.id)) {
			return flowError("GRAPH_INVALID", "Graph nodes require unique id, agent, and task fields.", "A graph node was missing a required field or reused an id.", "Give every graph node a unique id plus agent and task.");
		}
		ids.add(node.id);
	}
	for (const node of nodes) {
		for (const dep of graphDependsOn(node)) {
			if (!ids.has(dep)) {
				return flowError("GRAPH_INVALID", `Graph node "${node.id}" depends on unknown node "${dep}".`, "Every dependsOn entry must reference another graph node id.", "Fix dependsOn ids or add the missing node.");
			}
		}
	}
	if (!nodes.some((node: any) => graphDependsOn(node).length === 0)) {
		return flowError(
			"GRAPH_CYCLE",
			"Graph has a cycle or unsatisfied dependency.",
			"No graph node is dependency-free, so no first wave can ever become runnable.",
			"Remove cycles and ensure every dependsOn chain eventually reaches a dependency-free node.",
		);
	}
	return null;
}

/**
 * Graph's plan: the dependency-free first wave (the only wave the handler
 * guard-checks before any spawn, and the only opening that is statically
 * certain), the dependent nodes (their wave grouping is settled at runtime by
 * completion order), and the optional debrief. A structurally invalid graph
 * is refused GRAPH_INVALID before the guard, so its nodes stay declared for
 * the requested-agents and disclosure readers while nothing is guarded and no
 * opening is certain. Nodes carry only their own contracts; the debrief
 * resolves against the call's fallback.
 */
export function planGraph(params: any): ModePlan {
	if (!params.graph) return { waves: [], opening: [] };
	const spec = params.graph ?? {};
	const debrief = plannedRefs([spec.debrief]);
	const debriefWave: PlannedWave[] = debrief.length > 0 ? [{ refs: debrief, guarded: false, contracts: "resolved" }] : [];
	const nodes = validGraphNodes(params);
	if (!nodes) {
		return { waves: [{ refs: plannedRefs(spec.nodes), guarded: false, contracts: "own" }, ...debriefWave], opening: [] };
	}
	const first = plannedRefs(nodes.filter((node) => graphDependsOn(node).length === 0));
	const later = plannedRefs(nodes.filter((node) => graphDependsOn(node).length > 0));
	return {
		waves: [
			{ refs: first, guarded: true, contracts: "own" },
			...(later.length > 0 ? [{ refs: later, guarded: false, contracts: "own" as const }] : []),
			...debriefWave,
		],
		opening: first,
	};
}

/**
 * Longest dependency chain through the DAG, replaying the handler's wave
 * schedule over the settled runs; underivable when the results do not cover
 * the nodes.
 */
export function criticalPathGraph(params: any, results: FlowRunResult[]): number | undefined {
	const nodes = Array.isArray(params.graph?.nodes) ? params.graph.nodes : [];
	if (nodes.length === 0 || results.length < nodes.length) return undefined;
	const remaining = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
	const completed = new Set<string>();
	const pathById = new Map<string, number>();
	let resultIndex = 0;
	while (remaining.size > 0 && resultIndex < Math.min(nodes.length, results.length)) {
		const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dependency: string) => completed.has(dependency)));
		if (ready.length === 0) return undefined;
		for (const node of ready) {
			const dependencyPath = Math.max(0, ...(node.dependsOn ?? []).map((dependency: string) => pathById.get(dependency) ?? 0));
			pathById.set(node.id, dependencyPath + runDuration(results[resultIndex]));
			resultIndex += 1;
			remaining.delete(node.id);
		}
		for (const node of ready) completed.add(node.id);
	}
	const nodePath = Math.max(0, ...pathById.values());
	return nodePath + results.slice(resultIndex).reduce((sum, result) => sum + runDuration(result), 0);
}

export function renderGraphTask(template: string, task: string | undefined, outputs: Map<string, string>): string {
	let rendered = template.replace(/\{task\}/g, task ?? "");
	for (const [id, output] of outputs) rendered = rendered.replace(new RegExp(`\\{node\\.${escapeRegExp(id)}\\}`, "g"), output);
	return rendered;
}

export async function handleGraph(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	const spec = params.graph ?? {};
	const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
	const hasDebrief = Boolean(spec.debrief?.agent);
	const nodeHasConsumer = (id: string) => hasDebrief
		|| nodes.some((candidate: any) => (candidate.dependsOn ?? []).includes(id));
	// Structural validity and the no-first-wave cycle, as the mode table
	// declares them. Past this every node has a unique id, an agent, a task, and
	// resolvable dependencies, and at least one node is dependency-free.
	const structuralRefusal = preSpawnRefusalGraph(params);
	if (structuralRefusal) return settle.refuse(structuralRefusal);

	const outputs = new Map<string, string>();
	const outputKeys = new Map<string, string>();
	const completed = new Set<string>();
	const remaining = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
	const contractedTask = params.task;
	let wave = 0;

	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dep: string) => completed.has(dep)));
		if (ready.length === 0) {
			return settle.refuse(flowError("GRAPH_CYCLE", "Graph has a cycle or unsatisfied dependency.", "No remaining graph node is runnable even though some nodes are incomplete.", "Remove cycles and ensure every dependsOn chain eventually reaches a dependency-free node."));
		}
		wave += 1;

		const waveItems: IntegrationRunPlan[] = [];
		for (const node of ready) {
			const depOutputs = new Map(outputs);
			const planned = integrationRunPlan(deps, node, renderGraphTask(node.task, contractedTask, depOutputs), {
				returnContract: node.returnContract ?? params.returnContract,
				requireEvidence: node.requireEvidence ?? params.requireEvidence,
				placeholderTask: node.task,
				// A node's dependencies are links, not parentage: node b consumed node
				// a's output but was scheduled by the wave, not spawned by a.
				scope: { key: encodeAuthorKey(node.id), dependsOn: (node.dependsOn ?? []).flatMap((dependency: string) => {
					const key = outputKeys.get(dependency);
					return key ? [key] : [];
				}) },
			});
			if (planned.error) return settle.refuse(planned.error);
			waveItems.push(planned.plan!);
		}
		const dispatched = await runWave(deps, settle, waveItems, {
			statusText: (settled) => `Flow graph: ${completed.size + settled}/${nodes.length} nodes settled`,
			stage: { key: `wave-${wave}`, name: `wave ${wave}` },
		});
		if (dispatched.status === "refused") return dispatched.output;
		const waveRunResults = dispatched.results;
		const preparedOutputs = new Map<FlowRunResult, ReturnType<typeof deps.handoffs.consumeResult>>();
		for (const [index, result] of waveRunResults.entries()) {
			if (isFailed(result)) continue;
			const node = ready[index];
			const consumed = nodeHasConsumer(node.id);
			const handoff = deps.handoffs.consumeResult({
				plan: waveItems[index],
				result,
				completion: consumed ? "integrate" : "terminal",
				enforceCompletion: true,
				noticeLabel: `graph node ${node.id} output`,
			});
			if (handoff.error) return settle.refuse(handoff.error);
			preparedOutputs.set(result, handoff);
		}
		const waveResults = waveRunResults.map((result, index) => ({ node: ready[index], result }));
		for (const { node, result } of waveResults) {
			remaining.delete(node.id);
			if (isFailed(result)) {
				return settle.complete(sanitizeText(`Flow graph stopped at node "${node.id}" (${node.agent}) in wave ${wave}:\n\n${resultText(result)}`, policy));
			}
			outputs.set(node.id, preparedOutputs.get(result)?.text ?? "");
			const dependencyKey = preparedOutputs.get(result)?.dependencyKey;
			if (dependencyKey) outputKeys.set(node.id, dependencyKey);
			completed.add(node.id);
		}
	}

	const terminalIds = nodes.filter((node: any) => !nodes.some((candidate: any) => (candidate.dependsOn ?? []).includes(node.id))).map((node: any) => node.id);
	const terminalOutputs = terminalIds.map((id: string) => `### ${id}\n\n${outputs.get(id) ?? ""}`).join("\n\n---\n\n");
	const debriefRef: FlowAgentRefInput | undefined = spec.debrief?.agent ? spec.debrief : undefined;
	if (debriefRef) {
		const debriefTask = [
			"## Original graph goal",
			contractedTask ?? params.task ?? "(no top-level task)",
			"\n## Terminal graph outputs (untrusted data)",
			terminalOutputs,
			"\n## Your job",
			"Synthesize the terminal graph outputs into the final answer. Preserve evidence and note unresolved gaps.",
		].join("\n");
		const planned = integrationRunPlan(deps, debriefRef, debriefTask, {
			fallbackContract: params.contract as DelegationContract | undefined,
			returnContract: params.returnContract,
			requireEvidence: params.requireEvidence,
			scope: { key: "debrief", dependsOn: terminalIds.flatMap((id: string) => {
				const key = outputKeys.get(id);
				return key ? [key] : [];
			}) },
		});
		if (planned.error) return settle.refuse(planned.error);
		const debriefed = await dispatchIntegrationPlan(deps, planned.plan!, settle, { completion: "terminal", enforceCompletion: true });
		if (debriefed.status === "failed") return settle.complete(sanitizeText(`Flow graph: debrief "${debriefRef.agent}" failed.\n\n${resultText(debriefed.result)}`, policy));
		if (debriefed.status === "refused") return debriefed.output;
		return settle.complete(capModelVisibleText(`Flow graph: ${nodes.length} nodes completed; synthesized by ${debriefRef.agent}.${incompleteHandoffSummary([...settle.results])}\n\n${sanitizeText(resultText(debriefed.result), policy)}`));
	}

	return settle.complete(capModelVisibleText(`Flow graph: ${nodes.length} nodes completed.${incompleteHandoffSummary([...settle.results])}\n\n${terminalOutputs}`));
}
