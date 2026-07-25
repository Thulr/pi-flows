import { MAX_GRAPH_NODES, flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, escapeRegExp, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { prepareResultHandoff, withInjectionNotice } from "../handoff.ts";
import { appendReturnContract, validateSharedWriteCwd } from "../validate.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";

export function renderGraphTask(template: string, task: string | undefined, outputs: Map<string, string>): string {
	let rendered = template.replace(/\{task\}/g, task ?? "");
	for (const [id, output] of outputs) rendered = rendered.replace(new RegExp(`\\{node\\.${escapeRegExp(id)}\\}`, "g"), output);
	return rendered;
}

export async function handleGraph(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, makeDetails } = deps;
	const spec = params.graph ?? {};
	const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
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
	const contractedTask = params.task ? appendReturnContract(params.task, params.returnContract, params.requireEvidence) : undefined;
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

		const waveItems = ready.map((node) => {
			const depOutputs = new Map(outputs);
			const task = appendReturnContract(renderGraphTask(node.task, contractedTask, depOutputs), node.returnContract ?? params.returnContract, node.requireEvidence ?? params.requireEvidence);
			return { ref: node, task, placeholderTask: node.task };
		});
		const waveRunResults = await runAgentFanout(
			deps,
			"graph",
			waveItems,
			concurrency,
			results,
			(done) => `Flow graph: ${completed.size + done}/${nodes.length} nodes done`,
		);
		const waveResults = waveRunResults.map((result, index) => ({ node: ready[index], result }));
		for (const { node, result } of waveResults) {
			results.push(result);
			remaining.delete(node.id);
			if (isFailed(result)) {
				return { content: [{ type: "text", text: sanitizeText(`Flow graph stopped at node "${node.id}" (${node.agent}) in wave ${wave}:\n\n${resultText(result)}`, policy) }], details: makeDetails("graph")(results) };
			}
			const prep = prepareResultHandoff(result, policy);
			outputs.set(node.id, withInjectionNotice(prep, `graph node ${node.id} output`));
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
		const debriefed = await runAgentRef(deps, debriefRef, debriefTask, "graph", results.length + 1, results);
		results.push(debriefed);
		if (isFailed(debriefed)) return { content: [{ type: "text", text: sanitizeText(`Flow graph: debrief "${debriefRef.agent}" failed.\n\n${resultText(debriefed)}`, policy) }], details: makeDetails("graph")(results) };
		return { content: [{ type: "text", text: capModelVisibleText(`Flow graph: ${nodes.length} nodes completed; synthesized by ${debriefRef.agent}.\n\n${sanitizeText(resultText(debriefed), policy)}`) }], details: makeDetails("graph")(results) };
	}

	return { content: [{ type: "text", text: capModelVisibleText(`Flow graph: ${nodes.length} nodes completed.\n\n${terminalOutputs}`) }], details: makeDetails("graph")(results) };
}
