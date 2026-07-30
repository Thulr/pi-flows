import * as fsSync from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_CONCURRENCY,
	MAX_FLOW_DEPTH,
	PI_FLOWS_VERSION,
	RUN_MODE_NAMES,
	budgetExceeded,
	chargeBudget,
	flowError,
	formatFlowError,
	type AgentScope,
	type CapturePolicy,
	type FlowAgent,
	type FlowBudget,
	type FlowDetails,
	type FlowError,
	type FlowMode,
	type RunMode,
	type Update,
} from "./types.ts";
import { capModelVisibleText, isFailed, redactText, resultText, safePath, sanitizeText, scanForInjection, stripControlChars } from "./sanitize.ts";
import { appendReturnContract, appendReturnRequirements, canMutateWorkspace, clampIterations, clampLoopIterations, currentFlowDepth, validateConcurrency, validateSharedWriteCwd } from "./validate.ts";
import { extractLastJsonBlock, parseLoopStatus, parseRoute, parseScore, parseSubtasks, parseVerdict, renderTaskTemplate } from "./parse.ts";
import { HandoffWarnings, prepareHandoff, prepareTextHandoff } from "./handoff.ts";
import { createHandoffConsumer } from "./handoff-consumption.ts";
import { loopProtocolInstruction, routeProtocolInstruction, scoreProtocolInstruction, subtasksJsonProtocolInstruction, verdictProtocolInstruction } from "./protocol.ts";
import { appendReflexion, reflexionFile, withReflexion } from "./reflexion.ts";
import { discoverFlowAgents } from "./agents.ts";
import { createAgentCatalog, projectAgentsForRequest, requestedAgentNames, summarizeAgents } from "./agent-catalog.ts";
import { configuredTierModels, resolveAgentModel, runFlowAgent } from "./runner.ts";
import { formatTraceReport, formatUsage, makeTraceSink, parseTraceJsonl, strictTraceError, summarizeTraceSpans, traceSummaryAttributes } from "./trace.ts";
import { DEFAULT_APPROVAL_ACTOR } from "./approval.ts";
import { appendFlowSessionEntry, checkpointApproval, clearFlowUi, flowProgressText, flowsHelpText, parseFlowsCommandArgs } from "./ui.ts";
import { FlowRunRegistry, showFlowInspector } from "./inspector.ts";
import { createFleetPanelController } from "./fleet-panel.ts";
import { renderFlowResultRow } from "./ui-live-row.ts";
import { renderFlowCard } from "./ui-flow-card.ts";
import { RUN_MODE_HANDLERS, detectRunMode } from "./modes/registry.ts";
import { activeRunModes, renderRunModeLabel } from "./modes/contract.ts";
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
export { FlowDelegationContract, FlowReturnEnvelope } from "./schema.ts";

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
	HandoffWarnings,
	prepareHandoff,
	prepareTextHandoff,
	verdictProtocolInstruction,
	loopProtocolInstruction,
	routeProtocolInstruction,
	scoreProtocolInstruction,
	subtasksJsonProtocolInstruction,
	RUN_MODE_NAMES,
	activeRunModes,
	renderRunModeLabel,
	discoverFlowAgents,
	createAgentCatalog,
	projectAgentsForRequest,
	requestedAgentNames,
	flowsHelpText,
	stripControlChars,
	scanForInjection,
	budgetExceeded,
	chargeBudget,
	resolveAgentModel,
	configuredTierModels,
	appendReturnContract,
	appendReturnRequirements,
	canMutateWorkspace,
	validateSharedWriteCwd,
	parseTraceJsonl,
	summarizeTraceSpans,
	formatTraceReport,
	flowProgressText,
};

export default function (pi: ExtensionAPI) {
	const liveRuns = new FlowRunRegistry();
	const fleetPanel = createFleetPanelController(liveRuns);

	pi.registerShortcut("f8", {
		description: "Toggle the flow fleet panel",
		handler: async (ctx) => fleetPanel.toggle(ctx, true),
	});

	// The durable flow card: re-renders the persisted `pi-flows.run` entry after
	// the live tool row has scrolled away, including on session reload.
	pi.registerEntryRenderer?.("pi-flows.run", (entry, options, theme) => renderFlowCard(entry.data, options.expanded, theme));

	pi.registerCommand("flows", {
		description: "List and inspect first-party flow agents",
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
			if (parsed.kind === "inspect") {
				await showFlowInspector(ctx, liveRuns);
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
			const catalog = createAgentCatalog(discovery, parsed.scope);
			if (parsed.kind === "status") {
				ctx.ui.notify(catalog.configSummary(), discovery.issues.some((issue) => issue.severity === "error") ? "error" : "info");
				return;
			}
			ctx.ui.notify(`Flow agents (${parsed.scope}):\n${catalog.summary()}`, "info");
		},
	});

	pi.registerTool({
		name: "flow",
		label: "Flow",
		description: [
			"Spawn delegated flow agents in isolated pi subprocesses. Each child is a full separate model context that costs real tokens and wall-clock time — typically several times the cost of answering directly, so the isolation must earn its cost.",
			"Call flow only when at least one of these holds: (1) the user explicitly asked for delegation, separate agents, parallel investigation, or an independent reviewer; (2) the work spans more independent reading or writing than one context can hold; (3) the output needs verification that must be isolated from its author (separate critic, vote, or deterministic gate).",
			"If none of those hold, do the work directly in your own context — that is the default. Every spawning call must set `why` with the one-sentence reason delegation beats working directly; calls without it are refused.",
			"Bundled agents: recon, analyst, strategist, operator, overwatch, redteam, controller, commander, debrief.",
			`Core shapes: one delegated scout => {"agent":"recon","task":"inspect X","why":"..."}; parallel fan-out => {"tasks":[{"agent":"recon","task":"inspect A"},{"agent":"recon","task":"inspect B"}],"why":"..."}; build with separate critique => {"task":"...","evaluate":{},"why":"..."}. Further modes (${RUN_MODE_NAMES.filter((mode) => !["single", "parallel", "evaluate"].includes(mode)).join(", ")}) are documented in their parameter schemas.`,
			"Default scope includes bundled agents and ~/.pi/agent/flow-agents; project-local .pi/flow-agents requires agentScope project/all and explicit trust in headless runs.",
		].join(" "),
		promptSnippet: "Work directly by default; call flow only for explicit delegation requests or work that genuinely needs isolated contexts, fan-out, or an independent critic",
		// Editorial guidance, deliberately hand-written: the mechanical mode surface
		// derives from modes/contract.ts, but the plain-English mapping below names
		// modes by intent — when adding a mode, add a line here too if it needs one.
		promptGuidelines: [
			"Default to working directly in your own context. A flow child is a separate pi subprocess with its own full model context — it costs real tokens and latency, so spawning must be justified by isolation, fan-out, or independent verification, not by a mode name that happens to match the task.",
			"Do not use flow for simple factual answers, small code lookups, minor single-file edits, obvious shell commands, or tasks you can complete cheaply in the parent context. When the task is small or already clear, answer or edit directly and reserve flow for later if exploration, verification, or fan-out becomes genuinely necessary.",
			"When the user asks for a separate agent, read-only scout, delegated investigation, parallel inspection, independent reviewer, or critic loop, call flow directly without asking them to invoke it by name; treat 'delegate', 'have agents', 'use a separate agent', and 'split investigation across modules' as explicit flow requests.",
			"Always fill `why` with the one-sentence justification for spawning (which of: explicit user request, fan-out one context cannot hold, author-independent verification). If you cannot state one, that is the signal to work directly instead.",
			"When calling a named agent, copy the complete work request into task; do not send vague one-word tasks like \"Inspect\".",
			"If the user names a bundled agent such as recon, analyst, strategist, operator, redteam, or debrief, call that agent directly; do not call list/showConfig first unless the user asks to inspect available agents.",
			"Map plain English to flow modes: read-only repo scouting -> single recon/analyst; independent areas in parallel -> parallel; implementation plus separate review or command gate -> evaluate; broad codebase mapping -> orchestrate; explicit gated phases or resumable approvals -> workflow; concurrent writers needing isolation and integration -> worktree; explicitly requested opposing advocates/rebuttal/adjudication -> debate; multi-source evidence reconciliation -> dossier; bounded poll-until-event response -> monitor; uncertain agent choice -> route.",
			"Match child model capability to the task with tier, not hard-coded model ids: tier 'fast' for mechanical scouting, extraction, or classification; omit it (capable) for ordinary work; 'deep' for the hardest reasoning or final adjudication. Tiers resolve to models the user configured (PI_FLOWS_FAST_MODEL / PI_FLOWS_DEEP_MODEL) and fall back to their default model, so they stay portable across providers. Pass an explicit model only when the user named one.",
			"Use debate only when the user explicitly requests opposing advocates, rebuttal, or adjudication; direct execution has matched its quality with lower cost. Use worktree only for multiple write-capable agents needing a verified integration branch; use ordinary parallel for read-only fan-out. Use monitor only for bounded polling inside one flow call, never as durable scheduling.",
			"Use checkpoint for human approval before spawning children or before finalizing a result; it fails closed in headless contexts.",
			"When a flow returns retryable:false, treat the unchanged call as terminal. For BUDGET_EXCEEDED, do not automatically replay the same work. Preserve the configured budget unless the user explicitly approves changing it; ask for direction or make a material, visible change that stays within the ceiling by narrowing the task or reducing fan-out before starting another Flow.",
			"Use flow list:true before delegation if you do not know which flow agents are available, and showConfig:true to inspect effective dirs, tier mappings, defaults, and discovery issues.",
			"Use flow agentScope:'all' only for trusted repositories because project-local flow agents are repo-controlled prompts.",
		],
		parameters: FlowParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverFlowAgents(ctx.cwd, agentScope);
			const catalog = createAgentCatalog(discovery, agentScope);
			const policy: CapturePolicy = { recordContent: params.recordContent ?? true, redactSecrets: params.redactSecrets ?? true };
			const makeDetails = catalog.makeDetails;

			if (params.list) {
				return {
					content: [{ type: "text", text: catalog.summary() }],
					details: makeDetails("list")([]),
				};
			}

			if (params.showConfig) {
				return {
					content: [{ type: "text", text: catalog.configSummary() }],
					details: makeDetails("config")([]),
				};
			}

			const detected = detectRunMode(params);
			if ("error" in detected) {
				return {
					content: [{ type: "text", text: `${formatFlowError(detected.error)}\n\nAvailable agents:\n${catalog.summary()}` }],
					details: catalog.errorDetails("list", detected.error),
				};
			}

			const mode: FlowMode = detected.mode;

			// Structural friction against reflexive delegation: a spawning call must
			// articulate why isolation beats doing the work in the parent context.
			if (typeof params.why !== "string" || params.why.trim().length === 0) {
				const error = flowError(
					"WHY_REQUIRED",
					"Flow call refused: `why` is required for any call that spawns agents.",
					`Mode "${mode}" spawns child agent processes, and the call did not say why delegation beats doing the work directly in the parent context.`,
					"Pass why:'<one sentence naming the explicit user request, the fan-out one context cannot hold, or the author-independent verification this needs>'. If no such reason exists, do the work directly instead of calling flow.",
				);
				return {
					content: [{ type: "text", text: formatFlowError(error) }],
					details: catalog.errorDetails(mode, error),
				};
			}

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
					details: catalog.errorDetails(mode, error),
				};
			}

			// Fan-out bounding is dispatch-core policy: validated and resolved once here
			// for every mode, so no handler re-derives it and no new mode can forget it.
			const concurrencyError = validateConcurrency(params.concurrency);
			if (concurrencyError) {
				return {
					content: [{ type: "text", text: formatFlowError(concurrencyError) }],
					details: catalog.errorDetails(mode, concurrencyError),
				};
			}
			const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;

			// Trace evidence as a gate is opt-in. Ordinary user flows stay
			// best-effort; an eval or release run asks for strict, and then a run
			// that cannot prove what it did is a failed run, not a quiet pass.
			const traceStrict = params.traceStrict ?? /^(1|true|yes)$/i.test(process.env.PI_FLOWS_TRACE_STRICT?.trim() ?? "");
			const traceFileParam = params.traceFile ?? process.env.PI_FLOWS_TRACE_FILE;
			if (traceStrict && !traceFileParam) {
				const error = flowError(
					"TRACE_INCOMPLETE",
					"Flow call refused: strict tracing is on but no trace file is configured.",
					"traceStrict (or PI_FLOWS_TRACE_STRICT) requires coordination evidence, and nothing would have been exported.",
					"Set traceFile (or PI_FLOWS_TRACE_FILE) to a writable JSONL path, or turn strict tracing off for ordinary best-effort runs.",
				);
				return {
					content: [{ type: "text", text: formatFlowError(error) }],
					details: catalog.errorDetails(mode, error),
				};
			}

			// The sink is built before the human gates, not after: an approval that is
			// *granted* changes nothing else about the run, so a gate recorded only on
			// refusal would leave a successful checkpoint with no evidence it was ever
			// asked for. Every refusal below finalizes it, so those events never end up
			// orphaned without a root span.
			const traceSink = traceFileParam ? makeTraceSink(path.resolve(ctx.cwd, traceFileParam), mode, policy, params.traceLabel, params.traceContext) : undefined;
			const handoffs = createHandoffConsumer({
				params,
				mode,
				policy,
				defaultCwd: ctx.cwd,
				recordEvent: traceSink?.event,
			});
			const refuse = async (error: FlowError) => {
				const details = catalog.errorDetails(mode, error);
				// The refusal's own trace exists; without the link a caller carrying a
				// traceContext cannot correlate the refusal to the spans that describe it.
				const link = await traceSink?.finalize({ ok: false }, { "flow.child_count": 0, "flow.refused_before_spawn": error.code });
				if (link) details.trace = link;
				return { content: [{ type: "text" as const, text: formatFlowError(error) }], details };
			};

			const projectAgents = catalog.projectAgentsFor(params);
			if ((agentScope === "project" || agentScope === "all") && (params.confirmProjectAgents ?? true) && projectAgents.length > 0) {
				if (!ctx.hasUI) {
					const error = flowError(
						"PROJECT_AGENT_APPROVAL_REQUIRED",
						"Project-local flow agents require explicit trust in non-UI/headless runs.",
						`Requested project-local agents: ${projectAgents.map((agent) => agent.name).join(", ")}. These prompts come from ${safePath(discovery.projectAgentsDir)} and are controlled by the repository.`,
						"Run in an interactive UI to approve, or pass confirmProjectAgents:false only after reviewing the project-local agent files.",
					);
					traceSink?.event({ kind: "approval", name: "project_agents", ok: false, attributes: { "flow.approval.decision": "required", "flow.approval.interactive": false } });
					return refuse(error);
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
					traceSink?.event({ kind: "approval", name: "project_agents", ok: false, attributes: { "flow.approval.decision": "denied", "flow.approval.interactive": true } });
					return refuse(error);
				}
				traceSink?.event({ kind: "approval", name: "project_agents", attributes: { "flow.approval.decision": "approved", "flow.approval.interactive": true } });
			}

			const spawnCheckpointError = await checkpointApproval(params, ctx, mode, "spawn", undefined, traceSink?.event);
			if (spawnCheckpointError) return refuse(spawnCheckpointError);

			const handler = RUN_MODE_HANDLERS[mode as RunMode];
			if (!handler) return refuse(flowError("INVALID_MODE", "Unhandled flow mode.", "Execution fell through all mode handlers.", "Open a bug with the tool parameters that triggered this state."));

			// Cost ceiling (bounds the one "uncontrolled recursion" dimension iteration/time
			// caps miss) and optional trace export (OpenInference JSONL) for the flow tree.
			const budget: FlowBudget | undefined =
				params.maxCostUsd !== undefined || params.maxTokens !== undefined || params.maxGeneratedTokens !== undefined
					? { maxCostUsd: params.maxCostUsd, maxTokens: params.maxTokens, maxGeneratedTokens: params.maxGeneratedTokens, spentCost: 0, spentTokens: 0, spentGeneratedTokens: 0 }
					: undefined;
			// Who to credit on an approval receipt. pi does not hand the extension an
			// authenticated operator identity, so this is an audit label: whatever
			// PI_FLOWS_APPROVAL_ACTOR names, else the channel that answered the prompt.
			const approvalActor = process.env.PI_FLOWS_APPROVAL_ACTOR?.trim() || DEFAULT_APPROVAL_ACTOR;
			let liveDetails = makeDetails(mode)([]);
			liveRuns.start(toolCallId, mode, liveDetails, policy.redactSecrets, budget);
			clearFlowUi(ctx);
			const liveUpdate: Update = (partial) => {
				liveDetails = partial.details;
				liveRuns.update(toolCallId, liveDetails);
				onUpdate?.(partial);
			};

			// Reflexion is a flow-wide cross-cutting concern applied at the dispatch seam:
			// lessons from prior runs are injected into the top-level task before the
			// handler runs, and a lesson is recorded from the final output after it —
			// every mode gets both halves without per-handler wiring.
			const paramsForRun =
				typeof params.task === "string" && params.task.trim() && reflexionFile(ctx.cwd, params)
					? { ...params, task: withReflexion(ctx.cwd, params, params.task, policy) }
					: params;

			try {
				const output = await handler({
					params: paramsForRun,
					discovery,
					policy,
					handoffs,
					agentScope,
					defaultCwd: ctx.cwd,
					signal,
					onUpdate: liveUpdate,
					budget,
					recordSpan: traceSink?.record,
					recordEvent: traceSink?.event,
					requestApproval: async (title, message) => {
						const decision = !ctx.hasUI ? "required" : (await ctx.ui.confirm(title, message) ? "approved" : "denied");
						traceSink?.event({
							kind: "approval",
							name: "mode.approval",
							ok: decision === "approved",
							attributes: { "flow.approval.decision": decision, "flow.approval.actor": approvalActor, "flow.approval.interactive": ctx.hasUI === true },
						});
						return decision;
					},
					approvalActor,
					makeDetails,
					runChild: runFlowAgent,
					concurrency,
				});
				if (handoffs.blockingError && !output.details.error) {
					output.details.error = handoffs.blockingError;
					output.content = [{ type: "text", text: formatFlowError(handoffs.blockingError) }];
				}
				// Record the lesson only when at least one run happened — pre-spawn
				// refusals (validation errors, approvals) are not lessons about the task.
				if (output.details.results.length > 0) {
					await appendReflexion(ctx.cwd, params, mode, output.content[0]?.text ?? "", policy);
				}
				const finalCheckpointError = await checkpointApproval(params, ctx, mode, "finalize", output.content[0]?.text, traceSink?.event);
				if (finalCheckpointError) {
					output.details.error = finalCheckpointError;
					output.content = [{ type: "text", text: formatFlowError(finalCheckpointError) }];
				}
				liveDetails = output.details;
				liveRuns.update(toolCallId, liveDetails);
				if (traceSink) {
					const ok = !liveDetails.error && !liveDetails.results.some((result) => result.exitCode !== -1 && isFailed(result));
					output.details.trace = await traceSink.finalize({ ok }, traceSummaryAttributes(mode, params, output));
				}
				// Strict runs refuse to report a result they cannot evidence. An
				// already-failed run keeps its own error: the incomplete trace is a
				// second problem, not a better explanation of the first.
				const traceError = strictTraceError(output.details.trace, traceStrict);
				if (traceError && !output.details.error) {
					output.details.error = traceError;
					output.content = [{ type: "text", text: `${formatFlowError(traceError)}\n\n${output.content[0]?.text ?? ""}`.trimEnd() }];
					liveDetails = output.details;
					liveRuns.update(toolCallId, liveDetails);
				}
				// Persisted last, so the durable history cannot record a run as `ok`
				// that the caller was told failed — and so it carries the trace link.
				appendFlowSessionEntry(pi, liveDetails);
				return output;
			} finally {
				liveRuns.finish(toolCallId, liveDetails);
			}
		},
		renderCall(args, theme) {
			const scope = args.agentScope ?? "user";
			if (args.showConfig) return new Text(theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `config [${scope}]`), 0, 0);
			if (args.list) return new Text(theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `list [${scope}]`), 0, 0);
			return new Text(
				theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", renderRunModeLabel(args)) + theme.fg("muted", ` [${scope}]`),
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			return renderFlowResultRow(result as Parameters<typeof renderFlowResultRow>[0], { expanded, isPartial }, theme, context, summarizeAgents);
		},
	});
}
