import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_CONCURRENCY, DEFAULT_EVALUATE_ITERATIONS, DEFAULT_LOOP_ITERATIONS, DEFAULT_SEARCH_BEAM_WIDTH, DEFAULT_SEARCH_CANDIDATES, DEFAULT_SEARCH_ROUNDS, DEFAULT_TIMEOUT_MS, MAX_EVALUATE_ITERATIONS, MAX_GRAPH_NODES, MAX_LOOP_ITERATIONS, MAX_PARALLEL_TASKS } from "./types.ts";

export const FlowTask = Type.Object({
	agent: Type.String({ description: "Name of the flow agent to run" }),
	task: Type.String({ description: "Task for that agent. Chain tasks may use {task} and {previous}." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this agent process" })),
	model: Type.Optional(Type.String({ description: "Optional model override for this agent process" })),
	tools: Type.Optional(
		Type.String({ description: 'Optional comma-separated tool override. Use "none" for no built-in tools or "default" for pi defaults.' }),
	),
	returnContract: Type.Optional(Type.String({ description: "Output contract appended to this agent's task. Use it to specify summary shape, required fields, or max length." })),
	requireEvidence: Type.Optional(Type.Boolean({ description: "Require concrete evidence (file:line, command output, citations, or explicit gaps) in this agent's return.", default: false })),
});

export const FlowAgentRef = Type.Object({
	agent: Type.String({ description: "Name of the flow agent to run for this role" }),
	model: Type.Optional(Type.String({ description: "Optional model override for this role" })),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default".' })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this role's process" })),
});

export const FlowEvaluate = Type.Object({
	operator: Type.Optional(FlowAgentRef),
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
	maxSubtasks: Type.Optional(Type.Number({ description: `Cap on decomposed subtasks (also bounded by maxParallelTasks). Integer 1..${MAX_PARALLEL_TASKS}.`, minimum: 1, maximum: MAX_PARALLEL_TASKS })),
}, {
	description: "Orchestrator-workers mode: the `commander` decomposes `task` into subtasks, `recon` workers run them in parallel, and the `debrief` agent merges the results. An optional `verify` critic checks the merged answer.",
});

export const FlowGraphNode = Type.Object({
	id: Type.String({ description: "Unique node id. Later nodes can reference this output as {node.<id>}." }),
	agent: Type.String({ description: "Agent to run for this graph node." }),
	task: Type.String({ description: "Task for this graph node. May use {task} and {node.<id>} placeholders for dependency outputs." }),
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
	agent: Type.Optional(Type.String({ description: "Single-agent mode: agent name" })),
	task: Type.Optional(Type.String({ description: "Single-agent task, shared {task} value for chain steps, or the goal/contract for evaluate mode" })),
	tasks: Type.Optional(Type.Array(FlowTask, { description: "Parallel mode: tasks to run concurrently" })),
	chain: Type.Optional(Type.Array(FlowTask, { description: "Chain mode: tasks to run sequentially" })),
	evaluate: Type.Optional(FlowEvaluate),
	vote: Type.Optional(FlowVote),
	route: Type.Optional(FlowRoute),
	orchestrate: Type.Optional(FlowOrchestrate),
	graph: Type.Optional(FlowGraph),
	loop: Type.Optional(FlowLoop),
	search: Type.Optional(FlowSearch),
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
	model: Type.Optional(Type.String({ description: "Model override for single-agent mode" })),
	tools: Type.Optional(
		Type.String({ description: 'Comma-separated tool override for single-agent mode. Use "none" or "default".' }),
	),
});
