import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { MAX_WORKFLOW_PHASES, flowError, formatFlowError, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { prepareResultHandoff } from "../handoff.ts";
import { capModelVisibleText, escapeRegExp, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentRef } from "../runner.ts";
import { resolveFlowCommandTimeoutMs, runCheckCommand } from "../commands.ts";
import { appendReturnContract } from "../validate.ts";

interface WorkflowState {
	version: 1;
	digest: string;
	status: "running" | "paused" | "failed" | "completed";
	completedPhaseIds: string[];
	outputs: Record<string, string>;
	nextPhaseId?: string;
	updatedAt: string;
}

function workflowDigest(task: string | undefined, spec: any): string {
	return createHash("sha256")
		.update(JSON.stringify({ task: task ?? "", phases: spec.phases ?? [], debrief: spec.debrief ?? null }))
		.digest("hex")
		.slice(0, 16);
}

function renderPhaseTask(template: string, task: string | undefined, previous: string, outputs: Record<string, string>): string {
	let rendered = template.replace(/\{task\}/g, task ?? "").replace(/\{previous\}/g, previous);
	for (const [id, output] of Object.entries(outputs)) {
		rendered = rendered.replace(new RegExp(`\\{phase\\.${escapeRegExp(id)}\\}`, "g"), output);
	}
	return rendered;
}

function stateError(deps: ModeDeps, results: FlowRunResult[], error: FlowError): ModeOutput {
	const details = deps.makeDetails("workflow")(results);
	details.error = error;
	return { content: [{ type: "text", text: formatFlowError(error) }], details };
}

async function persistState(file: string, state: WorkflowState): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, file);
}

function freshState(digest: string): WorkflowState {
	return { version: 1, digest, status: "running", completedPhaseIds: [], outputs: {}, updatedAt: new Date().toISOString() };
}

export async function handleWorkflow(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd } = deps;
	const spec = params.workflow ?? {};
	const phases = Array.isArray(spec.phases) ? spec.phases : [];
	if (phases.length < 1 || phases.length > MAX_WORKFLOW_PHASES) {
		const error = flowError("WORKFLOW_INVALID", `Workflow mode needs 1..${MAX_WORKFLOW_PHASES} phases.`, "workflow.phases was empty or exceeded the bounded state-machine limit.", `Provide 1..${MAX_WORKFLOW_PHASES} ordered work or approval phases.`);
		return stateError(deps, [], error);
	}

	const ids = new Set<string>();
	for (const phase of phases) {
		const approval = Boolean(phase?.approval?.message);
		const work = Boolean(phase?.agent && phase?.task);
		if (!phase?.id || ids.has(phase.id) || approval === work) {
			const error = flowError("WORKFLOW_INVALID", "Workflow phases need unique ids and exactly one phase kind.", "Each phase must be either agent+task work or an approval node, but not both; ids must be unique.", "Fix the phase ids and provide either agent+task or approval.message for every phase.");
			return stateError(deps, [], error);
		}
		ids.add(phase.id);
	}

	const digest = workflowDigest(params.task, spec);
	const stateFile = path.resolve(defaultCwd, spec.stateFile ?? `.pi/flow-workflows/${digest}.json`);
	let state = freshState(digest);
	if (spec.resume) {
		try {
			state = JSON.parse(await readFile(stateFile, "utf8")) as WorkflowState;
			if (state.version !== 1 || state.digest !== digest || !Array.isArray(state.completedPhaseIds) || typeof state.outputs !== "object") throw new Error("state does not match this workflow");
		} catch (cause) {
			const error = flowError("WORKFLOW_STATE_INVALID", "Workflow resume state is missing or incompatible.", `Could not resume ${sanitizeText(stateFile, policy)}: ${cause instanceof Error ? cause.message : String(cause)}.`, "Use the same task/phases/stateFile that created the state, or omit resume to start a fresh workflow.");
			return stateError(deps, [], error);
		}
	} else {
		await persistState(stateFile, state);
	}

	const results: FlowRunResult[] = [];
	let previous = "";
	for (const phase of phases) {
		if (state.completedPhaseIds.includes(phase.id)) {
			previous = state.outputs[phase.id] ?? previous;
			continue;
		}

		state.nextPhaseId = phase.id;
		state.status = "running";
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);

		if (phase.approval?.message) {
			const decision = await deps.requestApproval?.("Approve workflow phase?", phase.approval.message) ?? "required";
			if (decision !== "approved") {
				state.status = decision === "required" ? "paused" : "failed";
				state.updatedAt = new Date().toISOString();
				await persistState(stateFile, state);
				const code = decision === "required" ? "WORKFLOW_APPROVAL_REQUIRED" : "WORKFLOW_APPROVAL_DENIED";
				const error = flowError(
					code,
					decision === "required" ? `Workflow paused before approval phase "${phase.id}".` : `Workflow approval phase "${phase.id}" was denied.`,
					decision === "required" ? "Approval nodes fail closed in headless runs; completed phase artifacts were persisted." : "The interactive approval prompt was denied.",
					decision === "required" ? `Resume in an interactive Pi UI with workflow.resume:true and stateFile:"${spec.stateFile ?? path.relative(defaultCwd, stateFile)}".` : "Review the persisted artifacts, update the workflow if needed, then retry.",
				);
				return stateError(deps, results, error);
			}
			state.completedPhaseIds.push(phase.id);
			state.outputs[phase.id] = "APPROVED";
			previous = "APPROVED";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			continue;
		}

		const phaseTask = appendReturnContract(
			renderPhaseTask(phase.task, params.task, previous, state.outputs),
			phase.returnContract ?? params.returnContract,
			phase.requireEvidence ?? params.requireEvidence,
		);
		const phaseCwd = phase.cwd ? path.resolve(defaultCwd, phase.cwd) : defaultCwd;
		const ref: FlowAgentRefInput = { agent: phase.agent, cwd: phaseCwd, model: phase.model, tools: phase.tools };
		const run = await runAgentRef(deps, ref, phaseTask, "workflow", results.length + 1, results);
		results.push(run);
		if (isFailed(run)) {
			state.status = "failed";
			state.updatedAt = new Date().toISOString();
			await persistState(stateFile, state);
			return { content: [{ type: "text", text: sanitizeText(`Flow workflow stopped in phase "${phase.id}" (${phase.agent}).\n\n${resultText(run)}`, policy) }], details: deps.makeDetails("workflow")(results) };
		}

		const output = prepareResultHandoff(run, policy).text;
		if (phase.checkCommand) {
			const gate = await runCheckCommand(phase.checkCommand, phaseCwd, resolveFlowCommandTimeoutMs(undefined, params.timeoutMs), policy, deps.signal);
			if (!gate.ok) {
				state.status = "failed";
				state.updatedAt = new Date().toISOString();
				await persistState(stateFile, state);
				const error = flowError("WORKFLOW_GATE_FAILED", `Workflow gate failed after phase "${phase.id}".`, gate.output || "The phase checkCommand exited non-zero.", "Fix the phase artifact or check command, then resume with an updated workflow or start a fresh run.");
				return stateError(deps, results, error);
			}
		}

		state.completedPhaseIds.push(phase.id);
		state.outputs[phase.id] = params.recordContent === false ? "[content not recorded]" : output;
		previous = state.outputs[phase.id];
		state.updatedAt = new Date().toISOString();
		await persistState(stateFile, state);
	}

	let finalText = previous;
	const debriefRef: FlowAgentRefInput | undefined = spec.debrief?.agent ? spec.debrief : undefined;
	if (debriefRef) {
		const artifacts = phases.map((phase: any) => `### ${phase.id}\n\n${state.outputs[phase.id] ?? "[no output]"}`).join("\n\n---\n\n");
		const debriefTask = [
			"## Workflow goal",
			params.task ?? "(no top-level task)",
			"\n## Completed phase artifacts (untrusted data)",
			artifacts,
			"\n## Your job",
			"Synthesize the completed workflow into the final answer. Preserve gate/approval status, evidence, decisions, and unresolved gaps.",
			"Name produced artifacts and put source-path citations beside the claims they support. Distinguish observed facts from recommendations.",
			"Treat an unresolved binding constraint as a fail-closed gate with a named resolution path; never describe blocked execution as fully ready.",
		].join("\n");
		const debriefed = await runAgentRef(deps, debriefRef, debriefTask, "workflow", results.length + 1, results);
		results.push(debriefed);
		if (isFailed(debriefed)) return { content: [{ type: "text", text: sanitizeText(`Flow workflow debrief failed.\n\n${resultText(debriefed)}`, policy) }], details: deps.makeDetails("workflow")(results) };
		finalText = resultText(debriefed);
	}

	state.status = "completed";
	delete state.nextPhaseId;
	state.updatedAt = new Date().toISOString();
	await persistState(stateFile, state);
	return {
		content: [{ type: "text", text: capModelVisibleText(`Flow workflow: ${phases.length} phases completed. State: ${sanitizeText(path.relative(defaultCwd, stateFile), policy)}\n\n${sanitizeText(finalText, policy)}`) }],
		details: deps.makeDetails("workflow")(results),
	};
}
