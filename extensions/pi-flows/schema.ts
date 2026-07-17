import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_CONCURRENCY, DEFAULT_DEBATE_ROUNDS, DEFAULT_EVALUATE_ITERATIONS, DEFAULT_LOOP_ITERATIONS, DEFAULT_MONITOR_CHECKS, DEFAULT_MONITOR_INTERVAL_MS, DEFAULT_SEARCH_BEAM_WIDTH, DEFAULT_SEARCH_CANDIDATES, DEFAULT_SEARCH_ROUNDS, DEFAULT_TIMEOUT_MS, MAX_DEBATE_ROUNDS, MAX_EVALUATE_ITERATIONS, MAX_GRAPH_NODES, MAX_LOOP_ITERATIONS, MAX_MONITOR_CHECKS, MAX_MONITOR_INTERVAL_MS, MAX_PARALLEL_TASKS, MAX_WORKFLOW_PHASES } from "./types.ts";

export const FlowTask = Type.Object({
	agent: Type.String({ minLength: 1, description: "Name of the flow agent to run. Bundled agents include recon, analyst, strategist, operator, overwatch, redteam, controller, commander, and debrief. Never leave this empty." }),
	task: Type.String({ minLength: 1, description: "Complete task for that agent, including the target and expected output. Do not use vague one-word tasks. Chain tasks may use {task} and {previous}." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this agent process" })),
	model: Type.Optional(Type.String({ description: "Optional model override for this agent process" })),
	tools: Type.Optional(
		Type.String({ description: 'Optional comma-separated tool override. Use "none" for no built-in tools or "default" for pi defaults.' }),
	),
	returnContract: Type.Optional(Type.String({ description: "Output contract appended to this agent's task. Use it to specify summary shape, required fields, or max length." })),
	requireEvidence: Type.Optional(Type.Boolean({ description: "Require concrete evidence (file:line, command output, citations, or explicit gaps) in this agent's return.", default: false })),
});

export const FlowAgentRef = Type.Object({
	agent: Type.String({ minLength: 1, description: "Name of the flow agent to run for this role. Bundled agents include recon, analyst, strategist, operator, overwatch, redteam, controller, commander, and debrief. Never leave this empty." }),
	model: Type.Optional(Type.String({ description: "Optional model override for this role" })),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default".' })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this role's process" })),
});

export const FlowEvaluateOperatorRef = Type.Object({
	agent: Type.String({ minLength: 1, description: "Generator agent for evaluate mode. Usually operator." }),
	task: Type.Optional(Type.String({ minLength: 1, description: "Optional alias for the evaluate goal when top-level task is omitted. Prefer top-level task when possible." })),
	model: Type.Optional(Type.String({ description: "Optional model override for the generator" })),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default".' })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the generator process" })),
});

export const FlowEvaluate = Type.Object({
	operator: Type.Optional(FlowEvaluateOperatorRef),
	redteam: Type.Optional(
		Type.Union([FlowAgentRef, Type.Array(FlowAgentRef, { minItems: 1, maxItems: MAX_PARALLEL_TASKS })], {
			description: "The critic. A single agent, or an array of critics (a decomposed panel — e.g. one per dimension: correctness, security, tests). With a panel, PASS requires every critic to pass; their REVISE critiques are merged for the next round.",
		}),
	),
	checkCommand: Type.Optional(
		Type.String({
			description: "Deterministic gate (level-1 / code assertions): a shell command run in the operator's cwd that MUST exit 0 each round. A non-zero exit is an automatic REVISE (the command output becomes the critique) and the LLM critic is skipped that round. PASS requires both the check (exit 0) and the critic(s). This is verification guaranteed by the harness, not requested in the prompt.",
		}),
	),
	maxIterations: Type.Optional(
		Type.Number({
			description: `Max generate→evaluate rounds. Integer 1..${MAX_EVALUATE_ITERATIONS}. Default ${DEFAULT_EVALUATE_ITERATIONS}. The loop also stops early on a PASS verdict.`,
			minimum: 1,
			maximum: MAX_EVALUATE_ITERATIONS,
			default: DEFAULT_EVALUATE_ITERATIONS,
		}),
	),
	passContract: Type.Optional(Type.String({ description: "Explicit acceptance criteria appended to the critic's rubric. Concrete criteria make the verdict reliable." })),
}, {
	description: "Evaluator-optimizer (generator→evaluator) mode: the `operator` builds against `task`, then a separate `redteam` critic (or panel) judges the artifact and returns PASS/REVISE, looping until pass or maxIterations. An optional `checkCommand` adds a deterministic gate. On REVISE the operator is re-shown its prior artifact plus the critique so it revises in place.",
});

export const FlowVote = Type.Object({
	voters: Type.Optional(Type.Array(FlowAgentRef, { description: "Explicit voters. Use different models for vendor-diverse voting that breaks correlated errors. Each runs the same `task`." })),
	agent: Type.Optional(Type.String({ description: "Same-agent voting: run this agent `count` times on the same `task`." })),
	count: Type.Optional(Type.Number({ description: `Number of votes when using \`agent\`. Integer 2..${MAX_PARALLEL_TASKS}. Default 3.`, minimum: 2, maximum: MAX_PARALLEL_TASKS, default: 3 })),
	debrief: Type.Optional(FlowAgentRef),
}, {
	description: "Voting/parallelization mode: run the same `task` across >=2 voters and either aggregate via a `debrief` agent or return all answers. Suppresses non-deterministic errors.",
});

export const FlowRoute = Type.Object({
	controller: Type.Optional(FlowAgentRef),
	candidates: Type.Array(Type.String(), { description: "Agent names the `controller` may choose from.", minItems: 1 }),
	fallback: Type.Optional(Type.String({ description: "Agent to run if the `controller` fails or names no valid candidate." })),
}, {
	description: "Routing mode: the `controller` classifies `task` and dispatches it to exactly one of `candidates`.",
});

export const FlowOrchestrate = Type.Object({
	task: Type.Optional(Type.String({ minLength: 1, description: "Optional alias for the orchestrate goal when top-level task is omitted. Prefer top-level task when possible." })),
	commander: Type.Optional(FlowAgentRef),
	recon: Type.Optional(FlowAgentRef),
	debrief: Type.Optional(FlowAgentRef),
	verify: Type.Optional(FlowAgentRef),
	verifyPolicy: Type.Optional(
		StringEnum(["note", "fail", "revise"] as const, {
			description: 'How to handle a verifier REVISE verdict. "note" appends the verdict (default), "fail" returns ORCHESTRATE_VERIFY_FAILED, "revise" asks debrief to revise and re-verifies.',
			default: "note",
		}),
	),
	verifyMaxIterations: Type.Optional(Type.Number({ description: "Max synthesize->verify rounds when verifyPolicy is revise. Integer 1..4. Default 2.", minimum: 1, maximum: 4, default: 2 })),
	workerReturnContract: Type.Optional(Type.String({ description: "Return contract appended to every worker subtask before fan-out." })),
	returnContract: Type.Optional(Type.String({ description: "Optional alias for top-level returnContract. If top-level task is omitted, this text is also accepted as the orchestrate goal for model-generated calls." })),
	maxSubtasks: Type.Optional(Type.Number({ description: `Cap on decomposed subtasks (also bounded by maxParallelTasks). Integer 1..${MAX_PARALLEL_TASKS}.`, minimum: 1, maximum: MAX_PARALLEL_TASKS })),
}, {
	description: "Orchestrator-workers mode: the `commander` decomposes `task` into subtasks, `recon` workers run them in parallel, and the `debrief` agent merges the results. An optional `verify` critic checks the merged answer.",
});

export const FlowGraphNode = Type.Object({
	id: Type.String({ minLength: 1, description: "Unique node id. Later nodes can reference this output as {node.<id>}." }),
	agent: Type.String({ minLength: 1, description: "Agent to run for this graph node." }),
	task: Type.String({ minLength: 1, description: "Task for this graph node. May use {task} and {node.<id>} placeholders for dependency outputs." }),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Node ids that must complete before this node can run." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this node process" })),
	model: Type.Optional(Type.String({ description: "Optional model override for this node" })),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default".' })),
	returnContract: Type.Optional(Type.String({ description: "Output contract appended to this node's task." })),
	requireEvidence: Type.Optional(Type.Boolean({ description: "Require concrete evidence in this node's return.", default: false })),
});

export const FlowGraph = Type.Object({
	nodes: Type.Array(FlowGraphNode, { minItems: 1, maxItems: MAX_GRAPH_NODES, description: "Static DAG nodes. Ready nodes run in parallel by dependency wave." }),
	debrief: Type.Optional(FlowAgentRef),
}, {
	description: "Static graph/DAG mode: run agent nodes once their dependencies complete, pass dependency outputs through {node.<id>} placeholders, and optionally synthesize terminal outputs via debrief.",
});

export const FlowLoop = Type.Object({
	body: FlowAgentRef,
	judge: Type.Optional(FlowAgentRef),
	maxIterations: Type.Optional(Type.Number({ description: `Max loop iterations. Integer 1..${MAX_LOOP_ITERATIONS}. Default ${DEFAULT_LOOP_ITERATIONS}.`, minimum: 1, maximum: MAX_LOOP_ITERATIONS, default: DEFAULT_LOOP_ITERATIONS })),
}, {
	description: 'Generic bounded loop mode. The body repeats until it emits "LOOP: DONE" (without judge) or an optional judge emits "VERDICT: PASS"; otherwise it stops at maxIterations.',
});

export const FlowSearch = Type.Object({
	generator: Type.Optional(FlowAgentRef),
	scorer: Type.Optional(FlowAgentRef),
	debrief: Type.Optional(FlowAgentRef),
	candidates: Type.Optional(Type.Number({ description: `Candidates generated per round. Integer 1..${MAX_PARALLEL_TASKS}. Default ${DEFAULT_SEARCH_CANDIDATES}.`, minimum: 1, maximum: MAX_PARALLEL_TASKS, default: DEFAULT_SEARCH_CANDIDATES })),
	beamWidth: Type.Optional(Type.Number({ description: `Candidates retained per round. Default ${DEFAULT_SEARCH_BEAM_WIDTH}.`, minimum: 1, maximum: MAX_PARALLEL_TASKS, default: DEFAULT_SEARCH_BEAM_WIDTH })),
	maxRounds: Type.Optional(Type.Number({ description: `Search/refinement rounds. Integer 1..4. Default ${DEFAULT_SEARCH_ROUNDS}.`, minimum: 1, maximum: 4, default: DEFAULT_SEARCH_ROUNDS })),
}, {
	description: "Bounded tree/beam-search mode: generate candidate paths, score each with SCORE: 0..100, retain a beam, repeat, then debrief the winning beam.",
});

export const FlowWorkflowPhase = Type.Object({
	id: Type.String({ minLength: 1, description: "Stable phase id used by persisted resume state and {phase.<id>} placeholders." }),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Agent for a work phase. Omit only for an approval phase." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Work phase task. Supports {task}, {previous}, and {phase.<id>} output placeholders." })),
	approval: Type.Optional(Type.Object({
		message: Type.String({ minLength: 1, description: "Approval question shown in an interactive UI. Headless runs pause and persist resumable state." }),
	})),
	checkCommand: Type.Optional(Type.String({ minLength: 1, description: "Deterministic gate run after this work phase. The workflow stops if it exits non-zero." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this phase and its checkCommand." })),
	model: Type.Optional(Type.String({ description: "Optional model override for this phase." })),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default".' })),
	returnContract: Type.Optional(Type.String({ description: "Output contract appended to this phase task." })),
	requireEvidence: Type.Optional(Type.Boolean({ description: "Require concrete evidence in this phase output.", default: false })),
});

export const FlowWorkflow = Type.Object({
	phases: Type.Array(FlowWorkflowPhase, { minItems: 1, maxItems: MAX_WORKFLOW_PHASES, description: "Ordered work and approval phases. Exactly one of agent+task or approval is required per phase." }),
	stateFile: Type.Optional(Type.String({ description: "Persist redacted phase state for audit/resume. Defaults to .pi/flow-workflows/<workflow-digest>.json." })),
	resume: Type.Optional(Type.Boolean({ description: "Resume completed phases from stateFile. The workflow digest must match.", default: false })),
	debrief: Type.Optional(FlowAgentRef),
}, {
	description: "Phase-gated state-machine mode: execute ordered work phases, enforce deterministic gates, pause at resumable human approval nodes, persist artifacts, then optionally debrief the completed phase outputs.",
});

export const FlowWorktreeTask = Type.Object({
	id: Type.String({ minLength: 1, description: "Stable task id used in worker and branch labels." }),
	agent: Type.String({ minLength: 1, description: "Write-capable agent that works in its own git worktree." }),
	task: Type.String({ minLength: 1, description: "Independent implementation task for this worktree." }),
	model: Type.Optional(Type.String({ description: "Optional model override for this worker." })),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default".' })),
	returnContract: Type.Optional(Type.String({ description: "Output contract appended to this worker task." })),
	requireEvidence: Type.Optional(Type.Boolean({ description: "Require evidence in this worker output.", default: true })),
});

export const FlowWorktree = Type.Object({
	tasks: Type.Array(FlowWorktreeTask, { minItems: 2, maxItems: MAX_PARALLEL_TASKS, description: "Independent write tasks, each provisioned on a separate branch and git worktree." }),
	baseRef: Type.Optional(Type.String({ description: "Git ref all worker and integration branches start from. Default HEAD." })),
	integrator: Type.Optional(FlowAgentRef),
	checkCommand: Type.Optional(Type.String({ description: "Deterministic verification command run on the merged integration branch." })),
	checkTimeoutMs: Type.Optional(Type.Number({ minimum: 1000, description: "Verification command timeout. Defaults to the flow timeout." })),
	requireClean: Type.Optional(Type.Boolean({ description: "Refuse to omit uncommitted source-checkout changes from worker branches. Default true.", default: true })),
}, {
	description: "Isolated worktree fan-out: create one git worktree per writer, commit each result, merge them into a durable integration branch, run an integrator review and optional deterministic check, then clean temporary worktrees.",
});

export const FlowDebate = Type.Object({
	participants: Type.Array(FlowAgentRef, { minItems: 2, maxItems: MAX_PARALLEL_TASKS, description: "Independent advocates. Use different agents/models to reduce correlated reasoning." }),
	adjudicator: Type.Optional(FlowAgentRef),
	rounds: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_DEBATE_ROUNDS, default: DEFAULT_DEBATE_ROUNDS, description: "Opening plus rebuttal rounds. Integer 1..3; default 2." })),
}, {
	description: "Adjudicated debate: independent advocates produce positions, inspect one another's arguments in bounded rebuttal rounds, then a separate adjudicator decides against the original constraints.",
});

export const FlowDossier = Type.Object({
	sections: Type.Array(FlowTask, { minItems: 2, maxItems: MAX_PARALLEL_TASKS, description: "Independent evidence-extraction assignments, normally one per source or claim family." }),
	debrief: Type.Optional(FlowAgentRef),
}, {
	description: "Evidence dossier/map-reduce mode: extract source-grounded evidence in parallel, then synthesize claims, citations, conflicts, confidence, and unresolved gaps without smoothing disagreements away.",
});

export const FlowMonitor = Type.Object({
	command: Type.String({ minLength: 1, description: "Deterministic probe command polled in cwd. This is bounded monitoring inside one flow call, not a durable daemon." }),
	trigger: StringEnum(["success", "failure", "match"] as const, { description: 'Trigger on exit 0, non-zero exit, or a regex "pattern" match.', default: "success" }),
	pattern: Type.Optional(Type.String({ description: 'Required when trigger is "match". JavaScript regular expression matched against capped probe output.' })),
	intervalMs: Type.Optional(Type.Number({ minimum: 10, maximum: MAX_MONITOR_INTERVAL_MS, default: DEFAULT_MONITOR_INTERVAL_MS, description: "Delay between probes, 10..60000ms." })),
	maxChecks: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_MONITOR_CHECKS, default: DEFAULT_MONITOR_CHECKS, description: "Hard bound on probe attempts, 1..20." })),
	checkTimeoutMs: Type.Optional(Type.Number({ minimum: 1000, description: "Per-probe command timeout. Defaults to the flow timeout." })),
	reactor: Type.Optional(FlowAgentRef),
}, {
	description: "Bounded monitor-trigger-react mode: poll a deterministic probe until a typed trigger fires or the check budget is exhausted, then hand the captured event to a reactor agent.",
});

export const FlowCheckpoint = Type.Object({
	before: Type.Optional(
		StringEnum(["spawn", "finalize"] as const, {
			description: '"spawn" asks for approval before any child agents run. "finalize" asks after children run before returning the final answer.',
			default: "spawn",
		}),
	),
	message: Type.Optional(Type.String({ description: "Human-readable approval message shown in the UI." })),
});

export const FlowReflexion = Type.Object({
	enabled: Type.Boolean({ description: "Opt in to local cross-run lessons for this flow call. Disabled by default." }),
	file: Type.Optional(Type.String({ description: "JSONL file for lessons, relative to cwd. Default .pi/flow-reflections.jsonl." })),
	maxEntries: Type.Optional(Type.Number({ description: "Recent lessons to prepend to compatible prompts. Default 5, cap 20.", minimum: 1, maximum: 20, default: 5 })),
});

export const FlowParams = Type.Object({
	list: Type.Optional(Type.Boolean({ description: "List available flow agents instead of running one" })),
	showConfig: Type.Optional(Type.Boolean({ description: "Show effective flow config, agent dirs, discovery issues, and defaults without running an agent" })),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Single-agent mode: agent name, e.g. recon for a read-only scout or analyst for deeper investigation. Use with task; never pass an empty agent." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Single-agent task, shared {task} value for chain steps, or the goal/contract for evaluate mode. For a named-agent request like 'ask recon to inspect package.json', set agent:'recon' and put the complete requested work here; never use a vague one-word task." })),
	tasks: Type.Optional(Type.Array(FlowTask, { description: "Parallel mode: tasks to run concurrently" })),
	chain: Type.Optional(Type.Array(FlowTask, { description: "Chain mode: tasks to run sequentially" })),
	evaluate: Type.Optional(FlowEvaluate),
	vote: Type.Optional(FlowVote),
	route: Type.Optional(FlowRoute),
	orchestrate: Type.Optional(FlowOrchestrate),
	graph: Type.Optional(FlowGraph),
	loop: Type.Optional(FlowLoop),
	search: Type.Optional(FlowSearch),
	workflow: Type.Optional(FlowWorkflow),
	worktree: Type.Optional(FlowWorktree),
	debate: Type.Optional(FlowDebate),
	dossier: Type.Optional(FlowDossier),
	monitor: Type.Optional(FlowMonitor),
	checkpoint: Type.Optional(FlowCheckpoint),
	reflexion: Type.Optional(FlowReflexion),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "all"] as const, {
			description: 'Agent scope. "user" = bundled + ~/.pi/agent/flow-agents (default). "project" = bundled + .pi/flow-agents. "all" = all sources.',
			default: "user",
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default true. In non-UI contexts, true refuses project agents; set false only for trusted repos.", default: true }),
	),
	concurrency: Type.Optional(Type.Number({ description: "Parallel mode concurrency. Must be an integer from 1 to 8.", minimum: 1, maximum: 8, default: DEFAULT_CONCURRENCY })),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-agent child process timeout in milliseconds. Default 600000 (10 minutes).", minimum: 1000, default: DEFAULT_TIMEOUT_MS })),
	maxCostUsd: Type.Optional(Type.Number({ description: "Cumulative USD cost ceiling across every child in this flow tree. Once reached, no further child is spawned (BUDGET_EXCEEDED). Bounds the cost dimension of runaway delegation that iteration/time caps do not cover. Omit to run uncapped.", minimum: 0 })),
	maxTokens: Type.Optional(Type.Number({ description: "Cumulative input+output token ceiling across every child in this flow tree. Once reached, no further child is spawned (BUDGET_EXCEEDED). Omit to run uncapped.", minimum: 0 })),
	traceFile: Type.Optional(Type.String({ description: "Append an OpenInference-shaped JSON span per child run to this file (JSONL any OpenTelemetry pipeline can ingest). One span per delegated agent plus a root span for the flow call, with redacted token/cost/model/status attributes. Also settable via PI_FLOWS_TRACE_FILE. Relative paths resolve against cwd." })),
	traceLabel: Type.Optional(Type.String({ description: "Use-case label attached to trace spans so reports can group TPSO and success rate by journey." })),
	returnContract: Type.Optional(Type.String({ description: "Output contract appended to delegated agent prompts and synthesis prompts. Use it to prevent summary loss on handoffs." })),
	requireEvidence: Type.Optional(Type.Boolean({ description: "Require concrete evidence in delegated outputs when a return contract is appended.", default: false })),
	allowSharedWriteCwd: Type.Optional(Type.Boolean({ description: "Allow concurrent write-capable agents to share a cwd. Default false; prefer distinct cwd/worktrees.", default: false })),
	recordContent: Type.Optional(Type.Boolean({ description: "Store and return child message content after redaction. Set false to retain only structural usage/status data.", default: true })),
	redactSecrets: Type.Optional(Type.Boolean({ description: "Redact secret-shaped strings, emails, and home-directory paths from content/details. Default true.", default: true })),
	cwd: Type.Optional(Type.String({ description: "Working directory for single-agent mode" })),
	model: Type.Optional(Type.String({ description: "Flow-wide model fallback. Applies to every delegated role unless that task or role sets its own model." })),
	tools: Type.Optional(
		Type.String({ description: 'Comma-separated tool override for single-agent mode. Use "none" or "default".' }),
	),
}, {
	description: "Exactly one flow mode per call. For a named agent request, fill both agent and task, e.g. {\"agent\":\"recon\",\"task\":\"inspect package.json\"}. For parallel inspection, use tasks with concrete agent names. For implementation plus critique, use {\"task\":\"...\",\"evaluate\":{}}.",
});
