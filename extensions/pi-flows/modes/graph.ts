import { MAX_GRAPH_NODES, encodeAuthorKey, flowError, formatFlowError, type DelegationContract, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, escapeRegExp, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { validateSharedWriteCwd } from "../validate.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { integrationRunPlan, runIntegrationPlan, type IntegrationRunPlan } from "../integration.ts";

export function renderGraphTask(template: string, task: string | undefined, outputs: Map<string, string>): string {
	let rendered = template.replace(/\{task\}/g, task ?? "");
	for (const [id, output] of outputs) rendered = rendered.replace(new RegExp(`\\{node\\.${escapeRegExp(id)}\\}`, "g"), output);
	return rendered;
}

export async function handleGraph(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, makeDetails } = deps;
	const spec = params.graph ?? {};
	const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
	const hasDebrief = Boolean(spec.debrief?.agent);
	const nodeHasConsumer = (id: string) => hasDebrief
		|| nodes.some((candidate: any) => (candidate.dependsOn ?? []).includes(id));
	if (nodes.length === 0 || nodes.length > MAX_GRAPH_NODES) {
		const error = flowError(
			"GRAPH_INVALID",
			"Graph mode needs 1..16 nodes.",
			"graph.nodes must be a non-empty static DAG of agent nodes, bounded so graph mode cannot become unbounded orchestration.",
			`Provide between 1 and ${MAX_GRAPH_NODES} graph nodes.`,
		);
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("graph")([], error) };
	}

	const ids = new Set<string>();
	for (const node of nodes) {
		if (!node?.id || !node.agent || !node.task || ids.has(node.id)) {
			const error = flowError("GRAPH_INVALID", "Graph nodes require unique id, agent, and task fields.", "A graph node was missing a required field or reused an id.", "Give every graph node a unique id plus agent and task.");
			return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("graph")([], error) };
		}
		ids.add(node.id);
	}
	for (const node of nodes) {
		for (const dep of node.dependsOn ?? []) {
			if (!ids.has(dep)) {
				const error = flowError("GRAPH_INVALID", `Graph node "${node.id}" depends on unknown node "${dep}".`, "Every dependsOn entry must reference another graph node id.", "Fix dependsOn ids or add the missing node.");
				return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("graph")([], error) };
			}
		}
	}

	const { concurrency } = deps;
	const results: FlowRunResult[] = [];
	const outputs = new Map<string, string>();
	const completed = new Set<string>();
	const remaining = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
	const contractedTask = params.task;
	let wave = 0;

	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dep: string) => completed.has(dep)));
		if (ready.length === 0) {
			const error = flowError("GRAPH_CYCLE", "Graph has a cycle or unsatisfied dependency.", "No remaining graph node is runnable even though some nodes are incomplete.", "Remove cycles and ensure every dependsOn chain eventually reaches a dependency-free node.");
			return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("graph")(results, error) };
		}
		wave += 1;
		const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, ready, params.allowSharedWriteCwd, concurrency);
		if (sharedWriteError) return { content: [{ type: "text", text: formatFlowError(sharedWriteError) }], details: makeDetails("graph")(results, sharedWriteError) };

		const waveItems: IntegrationRunPlan[] = [];
		for (const node of ready) {
			const depOutputs = new Map(outputs);
			const planned = integrationRunPlan(deps, node, renderGraphTask(node.task, contractedTask, depOutputs), {
				returnContract: node.returnContract ?? params.returnContract,
				requireEvidence: node.requireEvidence ?? params.requireEvidence,
				placeholderTask: node.task,
				// A node's dependencies are links, not parentage: node b consumed node
				// a's output but was scheduled by the wave, not spawned by a.
				scope: { key: encodeAuthorKey(node.id), dependsOn: (node.dependsOn ?? []).map((dependency: string) => `${encodeAuthorKey(dependency)}.handoff`) },
			});
			if (planned.error) {
				return { content: [{ type: "text", text: formatFlowError(planned.error) }], details: makeDetails("graph")(results, planned.error) };
			}
			waveItems.push(planned.plan!);
		}
		const waveRunResults = await runAgentFanout(
			deps,
			"graph",
			waveItems,
			concurrency,
			results,
			(settled) => `Flow graph: ${completed.size + settled}/${nodes.length} nodes settled`,
			{ key: `wave-${wave}`, name: `wave ${wave}` },
		);
		const preparedOutputs = new Map<FlowRunResult, ReturnType<typeof deps.handoffs.consumeResult>>();
		for (const [index, result] of waveRunResults.entries()) {
			if (isFailed(result)) continue;
			const node = ready[index];
			const consumed = nodeHasConsumer(node.id);
			const handoff = deps.handoffs.consumeResult({
				plan: waveItems[index],
				result,
				consumed,
				noticeLabel: `graph node ${node.id} output`,
			});
			if (handoff.error) {
				results.push(...waveRunResults);
				return { content: [{ type: "text", text: formatFlowError(handoff.error) }], details: makeDetails("graph")(results, handoff.error) };
			}
			preparedOutputs.set(result, handoff);
		}
		const waveResults = waveRunResults.map((result, index) => ({ node: ready[index], result }));
		for (const { node, result } of waveResults) {
			results.push(result);
			remaining.delete(node.id);
			if (isFailed(result)) {
				return { content: [{ type: "text", text: sanitizeText(`Flow graph stopped at node "${node.id}" (${node.agent}) in wave ${wave}:\n\n${resultText(result)}`, policy) }], details: makeDetails("graph")(results) };
			}
			outputs.set(node.id, preparedOutputs.get(result)?.text ?? "");
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
			scope: { key: "debrief", dependsOn: terminalIds.map((id: string) => `${id}.handoff`) },
		});
		if (planned.error) return { content: [{ type: "text", text: formatFlowError(planned.error) }], details: makeDetails("graph")(results, planned.error) };
		const debriefed = await runIntegrationPlan(deps, planned.plan!, "graph", results.length + 1, results);
		results.push(debriefed);
		if (isFailed(debriefed)) return { content: [{ type: "text", text: sanitizeText(`Flow graph: debrief "${debriefRef.agent}" failed.\n\n${resultText(debriefed)}`, policy) }], details: makeDetails("graph")(results) };
		const handoff = deps.handoffs.consumeResult({ plan: planned.plan!, result: debriefed, consumed: false });
		if (handoff.error) return { content: [{ type: "text", text: formatFlowError(handoff.error) }], details: makeDetails("graph")(results, handoff.error) };
		return { content: [{ type: "text", text: capModelVisibleText(`Flow graph: ${nodes.length} nodes completed; synthesized by ${debriefRef.agent}.${incompleteHandoffSummary(results)}\n\n${sanitizeText(resultText(debriefed), policy)}`) }], details: makeDetails("graph")(results) };
	}

	return { content: [{ type: "text", text: capModelVisibleText(`Flow graph: ${nodes.length} nodes completed.${incompleteHandoffSummary(results)}\n\n${terminalOutputs}`) }], details: makeDetails("graph")(results) };
}
