import * as fsSync from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONCURRENCY,
	DEFAULT_SEARCH_CANDIDATES,
	DEFAULT_TIMEOUT_MS,
	MAX_FLOW_DEPTH,
	MAX_PARALLEL_TASKS,
	MODEL_VISIBLE_OUTPUT_CAP,
	PI_FLOWS_VERSION,
	budgetExceeded,
	chargeBudget,
	flowError,
	formatFlowError,
	type AgentScope,
	type CapturePolicy,
	type FlowAgent,
	type FlowBudget,
	type FlowDetails,
	type FlowMode,
	type FlowRunResult,
	type RunMode,
	type Update,
} from "./types.ts";
import { capModelVisibleText, isFailed, redactText, resultText, safePath, sanitizeText, scanForInjection, stripControlChars } from "./sanitize.ts";
import { appendReturnContract, canMutateWorkspace, clampIterations, clampLoopIterations, currentFlowDepth, validateConcurrency, validateSharedWriteCwd } from "./validate.ts";
import { extractLastJsonBlock, parseLoopStatus, parseRoute, parseScore, parseSubtasks, parseVerdict, renderTaskTemplate } from "./parse.ts";
import {
	configSummary,
	discoverFlowAgents,
	projectAgentsForRequest,
	requestedAgentNames,
	safeAgentForDetails,
	summarizeAgents,
	toolErrorDetails,
} from "./agents.ts";
import { configuredFastModel, resolveAgentModel } from "./runner.ts";
import { formatTraceReport, formatUsage, makeTraceSink, parseTraceJsonl, summarizeTraceSpans, traceSummaryAttributes } from "./trace.ts";
import { appendFlowSessionEntry, checkpointApproval, flowStatusText, flowWidgetLines, flowsHelpText, parseFlowsCommandArgs, updateFlowUi } from "./ui.ts";
import { RUN_MODE_HANDLERS, detectRunMode } from "./modes/registry.ts";
import { FlowParams } from "./schema.ts";

// Public API surface: re-export the names the package exposed when the
// extension was a single file, so tests and downstream imports keep working.
export {
	DEFAULT_CONCURRENCY,
	DEFAULT_EVALUATE_ITERATIONS,
	DEFAULT_TIMEOUT_MS,
	FLOW_ERROR_CODES,
	MAX_EVALUATE_ITERATIONS,
	MAX_FLOW_DEPTH,
	MAX_PARALLEL_TASKS,
	MODEL_VISIBLE_OUTPUT_CAP,
	PI_FLOWS_VERSION,
} from "./types.ts";
export { redactText, scanForInjection, stripControlChars } from "./sanitize.ts";

export const __test = {
	redactText,
	capModelVisibleText,
	parseFlowsCommandArgs,
	validateConcurrency,
	renderTaskTemplate,
	detectRunMode,
	parseVerdict,
	parseLoopStatus,
	parseScore,
	clampIterations,
	clampLoopIterations,
	currentFlowDepth,
	parseRoute,
	parseSubtasks,
	extractLastJsonBlock,
	discoverFlowAgents,
	projectAgentsForRequest,
	requestedAgentNames,
	flowsHelpText,
	stripControlChars,
	scanForInjection,
	budgetExceeded,
	chargeBudget,
	resolveAgentModel,
	configuredFastModel,
	appendReturnContract,
	canMutateWorkspace,
	validateSharedWriteCwd,
	parseTraceJsonl,
	summarizeTraceSpans,
	formatTraceReport,
	flowStatusText,
	flowWidgetLines,
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("flows", {
		description: "List available first-party flow agents",
		handler: async (args, ctx) => {
			const parsed = parseFlowsCommandArgs(args);
			if (parsed.kind === "error") {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			if (parsed.kind === "help") {
				ctx.ui.notify(flowsHelpText(), "info");
				return;
			}
			if (parsed.kind === "version") {
				ctx.ui.notify(`pi-flows ${PI_FLOWS_VERSION}`, "info");
				return;
			}
			if (parsed.kind === "report") {
				const traceFile = path.resolve(ctx.cwd, parsed.traceFile ?? process.env.PI_FLOWS_TRACE_FILE ?? "flow-trace.jsonl");
				try {
					const parsedTrace = parseTraceJsonl(fsSync.readFileSync(traceFile, "utf8"));
					ctx.ui.notify(formatTraceReport(summarizeTraceSpans(parsedTrace.spans, parsedTrace.parseErrors, traceFile)), "info");
				} catch (error) {
					ctx.ui.notify(`Could not read flow trace report from ${safePath(traceFile)}: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			const discovery = discoverFlowAgents(ctx.cwd, parsed.scope);
			if (parsed.kind === "status") {
				ctx.ui.notify(configSummary(discovery, parsed.scope), discovery.issues.some((issue) => issue.severity === "error") ? "error" : "info");
				return;
			}
			ctx.ui.notify(`Flow agents (${parsed.scope}):\n${summarizeAgents(discovery.agents, discovery.issues)}`, "info");
		},
	});

	pi.registerTool({
		name: "flow",
		label: "Flow",
		description: [
			"Run first-party flow agents in isolated pi subprocesses for substantial delegated work.",
			"Do not use this as the default path for simple answers, small lookups, tiny edits, or shell commands the parent can do directly.",
			"Modes: list, showConfig, single (agent + task), parallel (tasks array), chain (sequential chain array with {task}/{previous}), evaluate (generator→evaluator loop that revises until PASS or maxIterations), vote (same task across N voters, optionally aggregated), route (classify task and dispatch to one candidate), orchestrate (decompose task → fan out workers → synthesize), graph (static DAG), loop (generic bounded loop), search (bounded beam search).",
			"Default scope includes bundled agents and ~/.pi/agent/flow-agents; project-local .pi/flow-agents requires agentScope project/all and explicit trust in headless runs.",
			"Bundled agents: recon, analyst, strategist, operator, overwatch, redteam, controller, commander, debrief.",
			"Exact argument examples: ask recon to inspect X => {\"agent\":\"recon\",\"task\":\"inspect X\"}; inspect A and B in parallel => {\"tasks\":[{\"agent\":\"recon\",\"task\":\"inspect A\"},{\"agent\":\"recon\",\"task\":\"inspect B\"}]}; build with separate critique => {\"task\":\"...\",\"evaluate\":{}}; split and synthesize a broad map => {\"task\":\"map X\",\"orchestrate\":{}}.",
		].join(" "),
		promptSnippet: "Delegate substantial work to first-party flow agents with isolated context windows",
		promptGuidelines: [
			"Use flow only when the added child-process cost is justified by isolation, parallelism, a separate reviewer, or a bounded multi-step workflow.",
			"Do not use flow for simple factual answers, small code lookups, minor single-file edits, obvious shell commands, or tasks you can complete cheaply in the parent context.",
			"When the task is small or already clear, answer or edit directly and reserve flow for later if exploration, verification, or fan-out becomes necessary.",
			"When the user asks for a separate agent, read-only scout, delegated investigation, parallel inspection, independent reviewer, or critic loop, call flow directly without asking them to invoke it by name.",
			"When calling a named agent, copy the complete work request into task; do not send vague one-word tasks like \"Inspect\".",
			"Map plain English to flow modes: read-only repo scouting -> single recon/analyst; independent areas in parallel -> parallel; implementation plus separate review or command gate -> evaluate; broad codebase mapping that should be split and synthesized -> orchestrate; uncertain specialist choice -> route.",
			"If the user names a bundled agent such as recon, analyst, strategist, operator, redteam, or debrief, call that agent directly; do not call list/showConfig first unless the user asks to inspect available agents.",
			"Argument examples: ask recon to inspect X -> {\"agent\":\"recon\",\"task\":\"inspect X\"}; inspect A and B in parallel -> {\"tasks\":[{\"agent\":\"recon\",\"task\":\"inspect A\"},{\"agent\":\"recon\",\"task\":\"inspect B\"}]}; build with separate critique -> {\"task\":\"...\",\"evaluate\":{}}; split and synthesize a broad map -> {\"task\":\"map X\",\"orchestrate\":{}}.",
			"Use flow evaluate when output quality must be checked by a separate critic (generate → evaluate → revise) instead of trusting a single pass.",
			"Use flow vote (especially with different models) to suppress non-deterministic errors on a high-stakes question; add an aggregator to get one synthesized answer.",
			"Use flow route to classify a heterogeneous request and dispatch it to the right specialist; use orchestrate to split a big task into parallel subtasks and synthesize the results.",
			"Use flow graph for explicit dependency DAGs, loop for bounded repeat-until-done work, and search for generate-score-refine candidate exploration.",
			"Use checkpoint for human approval before spawning children or before finalizing a result; it fails closed in headless contexts.",
			"Use flow list:true before delegation if you do not know which flow agents are available.",
			"Use flow showConfig:true to inspect effective dirs, defaults, and discovery issues before debugging.",
			"Use flow agentScope:'all' only for trusted repositories because project-local flow agents are repo-controlled prompts.",
		],
		parameters: FlowParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverFlowAgents(ctx.cwd, agentScope);
			const policy: CapturePolicy = { recordContent: params.recordContent ?? true, redactSecrets: params.redactSecrets ?? true };
			const makeDetails =
				(mode: FlowMode, agents = discovery.agents) =>
				(results: FlowRunResult[]): FlowDetails => ({
					mode,
					version: PI_FLOWS_VERSION,
					agentScope,
					config: {
						defaultConcurrency: DEFAULT_CONCURRENCY,
						maxParallelTasks: MAX_PARALLEL_TASKS,
						modelVisibleOutputCapBytes: MODEL_VISIBLE_OUTPUT_CAP,
						defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
						recordContentDefault: true,
						redactSecretsDefault: true,
					},
					agentsDir: {
						package: safePath(discovery.packageAgentsDir) ?? discovery.packageAgentsDir,
						user: safePath(discovery.userAgentsDir) ?? discovery.userAgentsDir,
						project: safePath(discovery.projectAgentsDir),
					},
					results,
					agents: agents.map(safeAgentForDetails),
					discoveryIssues: discovery.issues,
				});

			if (params.list) {
				return {
					content: [{ type: "text", text: summarizeAgents(discovery.agents, discovery.issues) }],
					details: makeDetails("list")([]),
				};
			}

			if (params.showConfig) {
				return {
					content: [{ type: "text", text: configSummary(discovery, agentScope) }],
					details: makeDetails("config")([]),
				};
			}

			const detected = detectRunMode(params);
			if ("error" in detected) {
				return {
					content: [{ type: "text", text: `${formatFlowError(detected.error)}\n\nAvailable agents:\n${summarizeAgents(discovery.agents, discovery.issues)}` }],
					details: toolErrorDetails(discovery, "list", agentScope, detected.error),
				};
			}

			const mode: FlowMode = detected.mode;

			const flowDepth = currentFlowDepth();
			if (flowDepth >= MAX_FLOW_DEPTH) {
				const error = flowError(
					"FLOW_DEPTH_EXCEEDED",
					`Flow delegation depth limit reached (${flowDepth}/${MAX_FLOW_DEPTH}).`,
					"This flow agent is itself running inside a flow subprocess; spawning more children would risk runaway nested delegation.",
					"Flatten the delegation — do the work in this agent, or restructure so deep nesting is not required. The cap is intentional harness discipline.",
				);
				return {
					content: [{ type: "text", text: formatFlowError(error) }],
					details: toolErrorDetails(discovery, mode, agentScope, error),
				};
			}

			const projectAgents = projectAgentsForRequest(discovery, params);
			if ((agentScope === "project" || agentScope === "all") && (params.confirmProjectAgents ?? true) && projectAgents.length > 0) {
				if (!ctx.hasUI) {
					const error = flowError(
						"PROJECT_AGENT_APPROVAL_REQUIRED",
						"Project-local flow agents require explicit trust in non-UI/headless runs.",
						`Requested project-local agents: ${projectAgents.map((agent) => agent.name).join(", ")}. These prompts come from ${safePath(discovery.projectAgentsDir)} and are controlled by the repository.`,
						"Run in an interactive UI to approve, or pass confirmProjectAgents:false only after reviewing the project-local agent files.",
					);
					return {
						content: [{ type: "text", text: formatFlowError(error) }],
						details: toolErrorDetails(discovery, mode, agentScope, error),
					};
				}

				const ok = await ctx.ui.confirm(
					"Run project-local flow agents?",
					`Agents: ${projectAgents.map((agent) => agent.name).join(", ")}\nSource: ${safePath(discovery.projectAgentsDir)}\n\nProject-local agents are repo-controlled prompts. Continue only for trusted repositories.`,
				);
				if (!ok) {
					const error = flowError(
						"PROJECT_AGENT_APPROVAL_DENIED",
						"Canceled: project-local flow agents were not approved.",
						"The interactive approval prompt was denied.",
						"Review the project-local agent files and retry if you trust them.",
					);
					return {
						content: [{ type: "text", text: formatFlowError(error) }],
						details: toolErrorDetails(discovery, mode, agentScope, error),
					};
				}
			}

			const spawnCheckpointError = await checkpointApproval(params, ctx, mode, "spawn");
			if (spawnCheckpointError) {
				return {
					content: [{ type: "text", text: formatFlowError(spawnCheckpointError) }],
					details: toolErrorDetails(discovery, mode, agentScope, spawnCheckpointError),
				};
			}

			const handler = RUN_MODE_HANDLERS[mode as RunMode];
			if (!handler) {
				const error = flowError("INVALID_MODE", "Unhandled flow mode.", "Execution fell through all mode handlers.", "Open a bug with the tool parameters that triggered this state.");
				return {
					content: [{ type: "text", text: formatFlowError(error) }],
					details: toolErrorDetails(discovery, "list", agentScope, error),
				};
			}

			// Cost ceiling (bounds the one "uncontrolled recursion" dimension iteration/time
			// caps miss) and optional trace export (OpenInference JSONL) for the flow tree.
			const budget: FlowBudget | undefined =
				params.maxCostUsd !== undefined || params.maxTokens !== undefined
					? { maxCostUsd: params.maxCostUsd, maxTokens: params.maxTokens, spentCost: 0, spentTokens: 0 }
					: undefined;
			const traceFileParam = params.traceFile ?? process.env.PI_FLOWS_TRACE_FILE;
			const traceSink = traceFileParam ? makeTraceSink(path.resolve(ctx.cwd, traceFileParam), mode, policy, params.traceLabel) : undefined;
			updateFlowUi(ctx, makeDetails(mode)([]));
			const statusOnUpdate: Update = (partial) => {
				updateFlowUi(ctx, partial.details);
				onUpdate?.(partial);
			};

			const output = await handler({ params, discovery, policy, agentScope, defaultCwd: ctx.cwd, signal, onUpdate: statusOnUpdate, budget, recordSpan: traceSink?.record, makeDetails });
			const finalCheckpointError = await checkpointApproval(params, ctx, mode, "finalize", output.content[0]?.text);
			if (finalCheckpointError) {
				output.details.error = finalCheckpointError;
				output.content = [{ type: "text", text: formatFlowError(finalCheckpointError) }];
			}
			updateFlowUi(ctx, output.details);
			appendFlowSessionEntry(pi, output.details);
			if (traceSink) {
				const ok = !output.details.error && !output.details.results.some((result) => result.exitCode !== -1 && isFailed(result));
				await traceSink.finalize({ ok }, traceSummaryAttributes(mode, params, output));
			}
			return output;
		},
		renderCall(args, theme) {
			const scope = args.agentScope ?? "user";
			if (args.showConfig) return new Text(theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `config [${scope}]`), 0, 0);
			if (args.list) return new Text(theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `list [${scope}]`), 0, 0);
			if (args.chain?.length) {
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) +
						theme.fg("accent", `chain ${args.chain.length} step${args.chain.length === 1 ? "" : "s"}`) +
						theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.tasks?.length) {
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) +
						theme.fg("accent", `parallel ${args.tasks.length} task${args.tasks.length === 1 ? "" : "s"}`) +
						theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.evaluate) {
				const generator = args.evaluate.operator?.agent ?? "operator";
				const redteam = args.evaluate.redteam;
				const evaluator = Array.isArray(redteam) ? `${redteam.length} critics` : redteam?.agent ?? "redteam";
				const gate = args.evaluate.checkCommand ? " +check" : "";
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) +
						theme.fg("accent", `evaluate ${generator}→${evaluator}${gate}`) +
						theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.vote) {
				const count = args.vote.voters?.length ?? args.vote.count ?? 3;
				const suffix = args.vote.debrief?.agent ? `→${args.vote.debrief.agent}` : "";
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `vote ${count}${suffix}`) + theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.route) {
				const router = args.route.controller?.agent ?? "controller";
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `route via ${router}`) + theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.orchestrate) {
				const worker = args.orchestrate.recon?.agent ?? "recon";
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `orchestrate →${worker}`) + theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.graph) {
				const count = args.graph.nodes?.length ?? 0;
				const suffix = args.graph.debrief?.agent ? `→${args.graph.debrief.agent}` : "";
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `graph ${count}${suffix}`) + theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.loop) {
				const body = args.loop.body?.agent ?? "agent";
				const judge = args.loop.judge?.agent ? `→${args.loop.judge.agent}` : "";
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `loop ${body}${judge}`) + theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			if (args.search) {
				const count = args.search.candidates ?? DEFAULT_SEARCH_CANDIDATES;
				return new Text(
					theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `search ${count}`) + theme.fg("muted", ` [${scope}]`),
					0,
					0,
				);
			}
			return new Text(
				theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", args.agent ?? "agent") + theme.fg("muted", ` [${scope}]`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as FlowDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			if (details.mode === "list" || details.mode === "config") {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : summarizeAgents((details.agents ?? []) as FlowAgent[], details.discoveryIssues ?? []), 0, 0);
			}

			const done = details.results.filter((item) => item.exitCode !== -1).length;
			const failed = details.results.filter((item) => item.exitCode !== -1 && isFailed(item)).length;
			const icon = done < details.results.length ? theme.fg("warning", "⏳") : failed ? theme.fg("warning", "◐") : theme.fg("success", "✓");

			if (!expanded) {
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(`flow ${details.mode}`))} ${theme.fg("accent", `${done}/${details.results.length}`)}`;
				for (const item of details.results.slice(0, 5)) {
					const itemIcon = item.exitCode === -1 ? theme.fg("warning", "⏳") : isFailed(item) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					text += `\n${itemIcon} ${theme.fg("accent", item.agent)} ${theme.fg("dim", formatUsage(item.usage, item.model, item.durationMs))}`;
				}
				if (details.results.length > 5) text += `\n${theme.fg("muted", `... +${details.results.length - 5} more`)}`;
				text += `\n${theme.fg("muted", "Ctrl+O to expand")}`;
				return new Text(text, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(`flow ${details.mode}`))}`, 0, 0));
			const mdTheme = getMarkdownTheme();

			for (const item of details.results) {
				const itemIcon = item.exitCode === -1 ? theme.fg("warning", "⏳") : isFailed(item) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(`${itemIcon} ${theme.fg("accent", item.agent)} ${theme.fg("muted", `(${item.agentSource})`)}`, 0, 0),
				);
				container.addChild(new Text(theme.fg("dim", item.task), 0, 0));
				const usage = formatUsage(item.usage, item.model, item.durationMs);
				if (usage) container.addChild(new Text(theme.fg("muted", usage), 0, 0));
				const output = resultText(item).trim();
				if (output) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(capModelVisibleText(output), 0, 0, mdTheme));
				}
			}

			return container;
		},
	});
}
