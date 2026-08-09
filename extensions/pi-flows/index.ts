import * as fsSync from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	PI_FLOWS_VERSION,
	RUN_MODE_NAMES,
	flowError,
	formatFlowError,
	type AgentScope,
	type CapturePolicy,
} from "./types.ts";
import { capModelVisibleText, redactText, safePath, scanForInjection, stripControlChars } from "./sanitize.ts";
import { appendReturnContract, appendReturnRequirements, canMutateWorkspace, clampIterations, clampLoopIterations, currentFlowDepth, validateConcurrency, validateSharedWriteCwd, writeCapabilityAttribution } from "./validate.ts";
import { extractLastJsonBlock, parseLoopStatus, parseRoute, parseScore, parseSubtasks, parseVerdict, renderTaskTemplate } from "./parse.ts";
import { HandoffWarnings, prepareHandoff, prepareTextHandoff } from "./handoff.ts";
import { loopProtocolInstruction, routeProtocolInstruction, scoreProtocolInstruction, subtasksJsonProtocolInstruction, verdictProtocolInstruction } from "./protocol.ts";
import { appendReflexion, reflexionFile, withReflexion } from "./reflexion.ts";
import { bashReadonlyEnabled, bashReadonlyRefusal, splitBashReadonly } from "./bash-readonly.ts";
import { registerBashReadonlyGuard } from "./bash-readonly-extension.ts";
import { registerWrapUpSteering } from "./wrapup.ts";
import { discoverFlowAgents } from "./agents.ts";
import { createAgentCatalog, projectAgentsForRequest, requestedAgentNames, summarizeAgents } from "./agent-catalog.ts";
import { resolveChildModel, runFlowAgent } from "./runner.ts";
import { availableModelsFromRegistry, currentModelRoster } from "./roster-source.ts";
import { clampThinking, describeModelRoster, parseModelSpec, resolveModelRoster } from "./model-roster.ts";
import { envRosterConfig, loadRosterConfig } from "./roster-config.ts";
import { formatTraceReport, parseTraceJsonl, summarizeTraceSpans } from "./trace.ts";
import { DEFAULT_APPROVAL_ACTOR } from "./approval.ts";
import { collectBudgetCeilings } from "./budget-disclosure.ts";
import { Flow, type DetailsBuilder, type ResolvedCall } from "./flow.ts";
import { appendFlowSessionEntry, checkpointApproval, clearFlowUi, flowProgressText, flowsHelpText, parseFlowsCommandArgs, showModelRoster } from "./ui.ts";
import { FlowRegistry, showFlowInspector } from "./inspector.ts";
import { createFleetPanelController } from "./fleet-panel.ts";
import { flowCallLines, renderFlowResultRow } from "./ui-live-row.ts";
import { renderFlowCard } from "./ui-flow-card.ts";
import { RUN_MODE_HANDLERS, detectRunMode } from "./modes/registry.ts";
import { activeRunModes, renderRunModeLabel } from "./modes/contract.ts";
import { FlowParams } from "./schema.ts";
import { discoverFlowPresets, formatPresetResult, preparePresetDispatch, presetCapturePolicy, previewFlowPreset, resolveFlowPreset, summarizePresets } from "./presets.ts";
import { attachPresetDetails, attachPresetTraceAttributes, presetConfigSummary, presetResolutionErrorOutput } from "./preset-catalog.ts";
import { approveProjectPreset, traceProjectPresetRefusal } from "./preset-approval.ts";
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
	resolveChildModel,
	resolveModelRoster,
	loadRosterConfig,
	envRosterConfig,
	parseModelSpec,
	clampThinking,
	describeModelRoster,
	availableModelsFromRegistry,
	appendReturnContract,
	appendReturnRequirements,
	canMutateWorkspace,
	validateSharedWriteCwd,
	writeCapabilityAttribution,
	parseTraceJsonl,
	summarizeTraceSpans,
	formatTraceReport,
	flowProgressText,
	discoverFlowPresets,
	resolveFlowPreset,
	summarizePresets,
	bashReadonlyEnabled,
	bashReadonlyRefusal,
	splitBashReadonly,
};

export default function (pi: ExtensionAPI) {
	// Child-side bash-ro enforcement: the runner sets the marker on a child
	// whose toolset carried bash-ro and loads bash-readonly-extension.ts via
	// -e; registering here too covers a discovered install and hand-set
	// markers. Coordination safety, not a sandbox.
	registerBashReadonlyGuard(pi);

	// Child-side half of the budget wrap-up channel: when the runner spawned
	// this pi with a wrap-up file path, watch for the parent's notice and steer
	// it into the live session so the child can emit a partial envelope before
	// the hard ceiling binds.
	registerWrapUpSteering(pi);

	const liveFlows = new FlowRegistry();
	const fleetPanel = createFleetPanelController(liveFlows);

	pi.registerShortcut("f8", {
		description: "Toggle the flow fleet panel",
		handler: async (ctx) => fleetPanel.toggle(ctx, true),
	});

	// The durable flow card: re-renders the persisted `pi-flows.run` entry after
	// the live tool row has scrolled away, including on session reload.
	pi.registerEntryRenderer?.("pi-flows.run", (entry, options, theme) => renderFlowCard(entry.data, options.expanded, theme));

	pi.registerCommand("flows", {
		description: "List and inspect workflow presets and flow agents",
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
				await showFlowInspector(ctx, liveFlows);
				return;
			}
			if (parsed.kind === "models") {
				await showModelRoster(ctx, currentModelRoster(ctx), getAgentDir());
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
			const presetDiscovery = discoverFlowPresets(ctx.cwd, parsed.scope);
			const catalog = createAgentCatalog(discovery, parsed.scope);
			if (parsed.kind === "status") {
				// The command context has a live registry just like the tool path, so
				// the roster is resolved here too. Omitting it would print
				// "modelRoster: unresolved" and drop config parse issues from the one
				// command whose whole job is reporting configuration.
				const issues = [...discovery.issues, ...presetDiscovery.issues];
				ctx.ui.notify(`${catalog.configSummary(currentModelRoster(ctx))}\n\n${presetConfigSummary(presetDiscovery)}`, issues.some((issue) => issue.severity === "error") ? "error" : "info");
				return;
			}
			ctx.ui.notify(`Flow presets (${parsed.scope}):\n${summarizePresets(presetDiscovery)}\n\nFlow agents (${parsed.scope}):\n${catalog.summary()}`, "info");
		},
	});

	pi.registerTool({
		name: "flow",
		label: "Flow",
		description: [
			"Spawn delegated flow agents in isolated pi subprocesses. Each child is a full separate model context that costs real tokens and wall-clock time — typically several times the cost of answering directly, so the isolation must earn its cost.",
			"Call flow only when at least one of these holds: (1) the user explicitly asked for delegation, separate agents, parallel investigation, or an independent reviewer; (2) the work spans more independent reading or writing than one context can hold; (3) the output needs verification that must be isolated from its author (separate critic, vote, or deterministic gate).",
			"If none of those hold, do the work directly in your own context — that is the default. Every spawning call must set `why` with the one-sentence reason delegation beats working directly; calls without it are refused.",
			"Prefer bundled workflow presets when the intent matches: scout (one reconnaissance pass), map-codebase (bounded map/reduce), code-review (one two-axis review, never a repeat-until-clean loop). Example: {\"preset\":\"code-review\",\"task\":\"Review HEAD against main and issue #25\",\"why\":\"author-independent verification\"}.",
			"Bundled agents: recon, analyst, strategist, operator, overwatch, redteam, controller, commander, debrief. Raw modes remain available for custom topologies.",
			`Raw shapes: one delegated scout => {"agent":"recon","task":"inspect X","why":"..."}; parallel fan-out => {"tasks":[{"agent":"recon","task":"inspect A"},{"agent":"recon","task":"inspect B"}],"why":"..."}; build with separate critique => {"task":"...","evaluate":{},"why":"..."}. Further modes (${RUN_MODE_NAMES.filter((mode) => !["single", "parallel", "evaluate"].includes(mode)).join(", ")}) are documented in their parameter schemas.`,
			"Default scope includes bundled and user presets/agents; project-local .pi/flow-presets and .pi/flow-agents require agentScope project/all and explicit trust in headless runs.",
		].join(" "),
		promptSnippet: "Work directly by default; call flow only for explicit delegation requests or work that genuinely needs isolated contexts, fan-out, or an independent critic",
		// Editorial guidance, deliberately hand-written: the mechanical mode surface
		// derives from modes/contract.ts, but the plain-English mapping below names
		// modes by intent — when adding a mode, add a line here too if it needs one.
		promptGuidelines: [
			"Default to working directly in your own context. A flow child is a separate pi subprocess with its own full model context — it costs real tokens and latency, so spawning must be justified by isolation, fan-out, or independent verification, not by a mode name that happens to match the task.",
			"Prefer a named workflow preset when it matches the request: scout for one bounded read-only pass, map-codebase for a broad evidence map, and code-review for one author-independent two-axis review. The code-review preset is one-shot; never replay it automatically until CLEAN.",
			"Do not use flow for simple factual answers, small code lookups, minor single-file edits, obvious shell commands, or tasks you can complete cheaply in the parent context. When the task is small or already clear, answer or edit directly and reserve flow for later if exploration, verification, or fan-out becomes genuinely necessary.",
			"When the user asks for a separate agent, read-only scout, delegated investigation, parallel inspection, independent reviewer, or critic loop, call flow directly without asking them to invoke it by name; treat 'delegate', 'have agents', 'use a separate agent', and 'split investigation across modules' as explicit flow requests.",
			"Always fill `why` with the one-sentence justification for spawning (which of: explicit user request, fan-out one context cannot hold, author-independent verification). If you cannot state one, that is the signal to work directly instead.",
			"When calling a named agent, copy the complete work request into task; do not send vague one-word tasks like \"Inspect\".",
			"If the user names a bundled agent such as recon, analyst, strategist, operator, redteam, or debrief, call that agent directly; do not call list/showConfig first unless the user asks to inspect available agents.",
			"Map plain English to flow modes: read-only repo scouting -> single recon/analyst; independent areas in parallel -> parallel; implementation plus separate review or command gate -> evaluate; broad codebase mapping -> orchestrate; explicit gated phases or resumable approvals -> workflow; concurrent writers needing isolation and integration -> worktree; explicitly requested opposing advocates/rebuttal/adjudication -> debate; multi-source evidence reconciliation -> dossier; bounded poll-until-event response -> monitor; uncertain agent choice -> route.",
			"Right-size every child on two independent dials, and set them deliberately rather than by omission. `tier` picks capability: 'fast' for mechanical scouting, extraction, or classification; 'capable' for ordinary work; 'deep' for the hardest reasoning or final adjudication. `thinking` picks effort: 'off'/'minimal'/'low' for mechanical work, 'medium'/'high' for ordinary reasoning, 'xhigh'/'max' for the hardest adjudication. Omitting tier means the child runs your own model, which is the most expensive option available and is usually wrong for scouting, extraction, formatting, or classification — name the tier the task actually needs.",
			"Tiers are portable: each resolves to a concrete model and level derived from the models this install can run, so never hard-code a model id. Pass an explicit `model` only when the user named one. Set `thinking` when effort is what should change while the model stays the same — most often lowering it for bulk mechanical fan-out, or raising it for a single critic or adjudicator. A level above what the resolved model supports is lowered automatically, so asking for more than exists is safe.",
			"Use debate only when the user explicitly requests opposing advocates, rebuttal, or adjudication; direct execution has matched its quality with lower cost. Use worktree only for multiple write-capable agents needing a verified integration branch; use ordinary parallel for read-only fan-out. Use monitor only for bounded polling inside one flow call, never as durable scheduling.",
			"An agent is write-capable when its effective tools include bash, edit, or write, or when tools resolves to pi defaults (omitted or 'default') — regardless of a read-only role name or prompt. `bash-ro` grants bash under a child-enforced read-only allowlist (git/file inspection plus npm test / npm run / node --test) and stays read-only-classified; a toolset carrying both bash and bash-ro is write-capable. For concurrent review or read-only fan-out, use the code-review preset, pick agents whose tools exclude all of bash, edit, and write, or swap bash for bash-ro; after SHARED_WRITE_CWD, a retry must change concurrency, effective tools (bash -> bash-ro counts), or cwd isolation — never set allowSharedWriteCwd:true for work you describe as read-only.",
			"Use checkpoint for human approval before spawning children or before finalizing a result; it fails closed in headless contexts.",
			"When a flow returns retryable:false, treat the unchanged call as terminal. For BUDGET_EXCEEDED, do not automatically replay the same work. Preserve the configured budget unless the user explicitly approves changing it; ask for direction or make a material, visible change that stays within the ceiling by narrowing the task or reducing fan-out before starting another Flow.",
			"Use flow list:true before delegation if you do not know which flow agents are available, and showConfig:true to inspect effective dirs, what each tier currently resolves to, defaults, and discovery issues.",
			"Use flow agentScope:'all' only for trusted repositories because project-local flow agents are repo-controlled prompts.",
		],
		parameters: FlowParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverFlowAgents(ctx.cwd, agentScope);
			const presetDiscovery = discoverFlowPresets(ctx.cwd, agentScope);
			const catalog = createAgentCatalog(discovery, agentScope);
			const requestedPresetTask = typeof params.task === "string" ? params.task : "";
			// Resolved once per call rather than per child: the registry read is
			// synchronous and cheap, but a roster that changed mid-flow would let two
			// children of the same wave disagree about what "deep" meant.
			const roster = currentModelRoster(ctx);
			const callerPolicy: CapturePolicy = { recordContent: params.recordContent ?? true, redactSecrets: params.redactSecrets ?? true };
			// A pure factory over the resolution it is given: the aggregate calls it
			// once with the post-preset state, and the pre-admission paths below call
			// it with the caller's own. Neither copy is shared through a closure.
			const makeDetails = (call: ResolvedCall): DetailsBuilder => {
				const budgetCeilings = collectBudgetCeilings(call.params);
				return (detailsMode, agents) => {
					const build = catalog.makeDetails(detailsMode, agents);
					return (results, error) => {
						const details = build(results, error);
						if (budgetCeilings.length) details.budgetCeilings = budgetCeilings;
						return attachPresetDetails(details, presetDiscovery, call.preset, call.policy);
					};
				};
			};
			// The caller's own unexpanded resolution, and the pre-admission builder
			// made from it: used by the describe port and the preset-resolution
			// refusal, neither of which ever sees post-preset state.
			const callerCall: ResolvedCall = { params, policy: callerPolicy };
			const callerDetails = makeDetails(callerCall);

			// The caller's own trace settings, captured before preset expansion can
			// add repo-controlled ones: a refused project preset records onto these.
			const callerTrace = { traceFile: params.traceFile ?? process.env.PI_FLOWS_TRACE_FILE, traceLabel: params.traceLabel, traceContext: params.traceContext };

			// Everything below is adaptation: each port wraps one subdomain surface
			// as a pure function of what the aggregate hands it — post-preset state
			// (params, policy, preset) arrives as arguments, never through a shared
			// closure, so no port here assigns a local another port reads. The
			// lifecycle itself — which gate runs when, what a refusal does to the
			// trace, what settles in what order — is the Flow aggregate's own
			// (flow.ts), not wiring.
			const admission = await Flow.admit({
				params: callerCall.params,
				policy: callerCall.policy,
				cwd: ctx.cwd,
				hasUI: ctx.hasUI === true,
				// Who to credit on an approval receipt. pi does not hand the extension an
				// authenticated operator identity, so this is an audit label: whatever
				// PI_FLOWS_APPROVAL_ACTOR names, else the channel that answered the prompt.
				approvalActor: process.env.PI_FLOWS_APPROVAL_ACTOR?.trim() || DEFAULT_APPROVAL_ACTOR,
				agentScope,
				discovery,
				roster,
				signal,
				onUpdate,
				runChild: runFlowAgent,
				makeDetails,
				// The two answers-without-spawning, rendered from the caller's own
				// unexpanded resolution. What each surface says — catalogs, effective
				// config — is composition and stays here; that they fire first, list
				// before config, is the aggregate's walk.
				describe: (surface) =>
					surface === "list"
						? {
							content: [{ type: "text", text: `Workflow presets:\n${summarizePresets(presetDiscovery, callerPolicy)}\n\nFlow agents:\n${catalog.summary()}` }],
							details: callerDetails("list")([]),
						}
						: {
							content: [{ type: "text", text: `${catalog.configSummary(roster)}\n\n${presetConfigSummary(presetDiscovery, callerPolicy)}` }],
							details: callerDetails("config")([]),
						},
				resolvePreset: params.preset
					? () => {
						const resolved = resolveFlowPreset(params as Record<string, unknown>, presetDiscovery, callerPolicy);
						if ("error" in resolved) {
							return { refusal: presetResolutionErrorOutput(resolved.error, presetDiscovery, callerDetails("list")([], resolved.error), callerPolicy) };
						}
						const presetPolicy = presetCapturePolicy(callerPolicy, resolved.params);
						return { params: { ...resolved.params, ...presetPolicy }, policy: presetPolicy, preset: resolved.preset };
					}
					: undefined,
				detectMode: (candidate, buildDetails) => {
					const detected = detectRunMode(candidate);
					if ("error" in detected) {
						return {
							refusal: {
								content: [{ type: "text", text: `${formatFlowError(detected.error)}\n\nAvailable agents:\n${catalog.summary()}` }],
								details: buildDetails("list")([], detected.error),
							},
						};
					}
					return detected;
				},
				approvePresetTrust: async (call, mode, buildDetails) => {
					const presetApproval = await approveProjectPreset(call.preset, agentScope, call.params.confirmProjectAgents, ctx, call.policy);
					if (presetApproval.error) {
						const details = buildDetails(mode)([], presetApproval.error);
						const link = await traceProjectPresetRefusal(presetApproval.error, call.preset, callerTrace, mode, call.policy, ctx.cwd, ctx.hasUI);
						if (link) details.trace = link;
						return { refusal: { content: [{ type: "text", text: formatFlowError(presetApproval.error) }], details } };
					}
					return { record: presetApproval.record };
				},
				preparePresetRun: (call, mode) => {
					const preset = call.preset;
					const presetRun = preparePresetDispatch(preset, call.params, requestedPresetTask, mode, ctx.cwd);
					return {
						params: presetRun.params as Record<string, any>,
						runDefaultCwd: presetRun.runDefaultCwd,
						formatResult: preset
							? (output) => formatPresetResult(preset, output, call.policy, presetRun.runDefaultCwd, presetRun.codeReviewRange)
							: undefined,
					};
				},
				approveProjectAgents: async (candidate, recordEvent) => {
					const projectAgents = catalog.projectAgentsFor(candidate);
					if ((agentScope !== "project" && agentScope !== "all") || !(candidate.confirmProjectAgents ?? true) || projectAgents.length === 0) return null;
					if (!ctx.hasUI) {
						recordEvent?.({ kind: "approval", name: "project_agents", ok: false, attributes: { "flow.approval.decision": "required", "flow.approval.interactive": false } });
						return flowError(
							"PROJECT_AGENT_APPROVAL_REQUIRED",
							"Project-local flow agents require explicit trust in non-UI/headless runs.",
							`Requested project-local agents: ${projectAgents.map((agent) => agent.name).join(", ")}. These prompts come from ${safePath(discovery.projectAgentsDir)} and are controlled by the repository.`,
							"Run in an interactive UI to approve, or pass confirmProjectAgents:false only after reviewing the project-local agent files.",
						);
					}
					const ok = await ctx.ui.confirm(
						"Run project-local flow agents?",
						`Agents: ${projectAgents.map((agent) => agent.name).join(", ")}\nSource: ${safePath(discovery.projectAgentsDir)}\n\nProject-local agents are repo-controlled prompts. Continue only for trusted repositories.`,
					);
					if (!ok) {
						recordEvent?.({ kind: "approval", name: "project_agents", ok: false, attributes: { "flow.approval.decision": "denied", "flow.approval.interactive": true } });
						return flowError(
							"PROJECT_AGENT_APPROVAL_DENIED",
							"Canceled: project-local flow agents were not approved.",
							"The interactive approval prompt was denied.",
							"Review the project-local agent files and retry if you trust them.",
						);
					}
					recordEvent?.({ kind: "approval", name: "project_agents", attributes: { "flow.approval.decision": "approved", "flow.approval.interactive": true } });
					return null;
				},
				checkpoint: (candidate, mode, when, preview, recordEvent) => checkpointApproval(candidate, ctx, mode, when, preview, recordEvent),
				handlerFor: (mode) => RUN_MODE_HANDLERS[mode],
				confirm: ctx.hasUI ? (title, message) => ctx.ui.confirm(title, message) : undefined,
				presence: {
					start: (mode, details, redactSecrets, budget) => liveFlows.start(toolCallId, mode, details, redactSecrets, budget),
					update: (details) => liveFlows.update(toolCallId, details),
					settle: (details) => liveFlows.settle(toolCallId, details),
				},
				clearUi: () => clearFlowUi(ctx),
				// Reflexion is a flow-wide cross-cutting concern applied at the dispatch
				// seam: lessons from prior runs are injected into the top-level task
				// before the handler runs, and a lesson is recorded from the final
				// output after it — every mode gets both halves without per-handler wiring.
				resolveTask: (candidate, resolvedPolicy) =>
					typeof candidate.task === "string" && candidate.task.trim() && reflexionFile(ctx.cwd, candidate)
						? { ...candidate, task: withReflexion(ctx.cwd, candidate, candidate.task, resolvedPolicy) }
						: candidate,
				recordLesson: (candidate, mode, text, resolvedPolicy) => appendReflexion(ctx.cwd, candidate, mode, text, resolvedPolicy),
				decorateRootAttributes: (attributes, details, deliverable, preset) => attachPresetTraceAttributes(attributes, preset, details, deliverable),
				persist: (details) => appendFlowSessionEntry(pi, details),
			});
			if ("described" in admission) return admission.described;
			if ("refused" in admission) return admission.refused;
			const dispatched = await admission.admitted.dispatch();
			return dispatched.settle();
		},
		renderCall(args, theme, context) {
			const scope = args.agentScope ?? "user";
			if (args.showConfig) return new Text(theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `config [${scope}]`), 0, 0);
			if (args.list) return new Text(theme.fg("toolTitle", theme.bold("flow ")) + theme.fg("accent", `list [${scope}]`), 0, 0);
			return new Text(flowCallLines(args.preset ? previewFlowPreset(args, context.cwd) : args, theme, args.preset ? `preset ${args.preset}` : renderRunModeLabel(args), scope).join("\n"), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			return renderFlowResultRow(result as Parameters<typeof renderFlowResultRow>[0], { expanded, isPartial }, theme, context, summarizeAgents);
		},
	});
}
