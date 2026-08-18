import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { DEFAULT_APPROVAL_TTL_MS, MAX_APPROVAL_TTL_MS, MIN_APPROVAL_TTL_MS } from "./approval.ts";
import { DEFAULT_CONCURRENCY, DEFAULT_DEBATE_ROUNDS, DEFAULT_EVALUATE_ITERATIONS, DEFAULT_LOOP_ITERATIONS, DEFAULT_MONITOR_CHECKS, DEFAULT_MONITOR_INTERVAL_MS, DEFAULT_SEARCH_BEAM_WIDTH, DEFAULT_SEARCH_CANDIDATES, DEFAULT_SEARCH_ROUNDS, DEFAULT_TIMEOUT_MS, MAX_DEBATE_ROUNDS, MAX_EVALUATE_ITERATIONS, MAX_GRAPH_NODES, MAX_LOOP_ITERATIONS, MAX_MONITOR_CHECKS, MAX_MONITOR_INTERVAL_MS, MAX_PARALLEL_TASKS, MAX_SUBTASKS, MAX_WORKFLOW_PHASES } from "./types.ts";

const TierDescription = 'Capability tier for this child, portable across providers: "fast" for mechanical scouting/extraction/classification, "capable" (default) for ordinary work, "deep" for the hardest reasoning or final adjudication. Each tier resolves to a concrete model and thinking level derived from the models this install can actually run, so tiers work with no configuration; `flow showConfig:true` or `/flows models` shows what each currently resolves to. Prefer tier over model unless the user named a concrete model.';

const ThinkingDescription = 'Reasoning effort for this child, overriding the level its tier would use: "off"/"minimal"/"low" for mechanical work, "medium"/"high" for ordinary reasoning, "xhigh"/"max" for the hardest adjudication. Automatically lowered to what the resolved model supports. Set this to right-size effort without changing which model runs; omit it to take the tier default (a plain child inherits the parent session\'s level).';
const ThinkingValues = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const FlowTier = StringEnum(["fast", "capable", "deep"] as const, { description: TierDescription });

export const FlowThinking = StringEnum(ThinkingValues, { description: ThinkingDescription });
const FlowHistoricalThinkingLevel = StringEnum(ThinkingValues, { description: "Effective Thinking level recorded by a spent v3 receipt. Migration evidence only: this value never selects or configures a Child." });

const StringList = Type.Array(Type.String({ minLength: 1 }));
const HandoffPolicy = StringEnum(["warn", "quarantine", "fail"] as const);

// The one statement of what prose return requirements are, shared by every
// returnContract/requireEvidence description so the qualifier cannot drift.
const PromptOnlyNote = "Prompt guidance only — never machine-checked.";

export const FlowDelegationContract = Type.Object({
	objective: Type.String({ minLength: 1, description: "The outcome the child owns." }),
	constraints: StringList,
	nonGoals: StringList,
	dependencies: StringList,
	authority: Type.Object({
		may: StringList,
		mustNot: StringList,
		requiresApproval: StringList,
	}),
	sideEffectClass: StringEnum(["none", "read-only", "reversible", "irreversible"] as const),
	budget: Type.Object({
		timeoutMs: Type.Optional(Type.Number({ minimum: 0, description: "Contract-budget timeout for the runs fulfilling this delegation contract." })),
		maxCostUsd: Type.Optional(Type.Number({ minimum: 0, description: "Contract-budget USD cost ceiling, enforced independently of the flow budget." })),
		maxTokens: Type.Optional(Type.Number({ minimum: 0, description: "Contract-budget input+output token ceiling, enforced independently of the flow budget." })),
		maxGeneratedTokens: Type.Optional(Type.Number({ minimum: 0, description: "Contract-budget generated/output token ceiling, enforced independently of the flow budget." })),
	}),
	acceptanceChecks: Type.Array(Type.String({ minLength: 1 }), { description: "Prose acceptance checks carried in the child's instructions. They are not machine-checked: only an independent verifier can establish that the outcome satisfied them." }),
	returnSchema: Type.Record(Type.String(), Type.Any(), { description: "JSON Schema applied to the return envelope's data field." }),
	owner: Type.String({ minLength: 1 }),
}, {
	description: "Optional machine-checked contract, resolved before its task or role spawns. It binds objective, Return shape, timeout, cost/token ceilings, and a validated pi-flows.return-envelope.v1 response. Supplying one proves exactly three things about the Return: attribution to this contract, declared artifact integrity, and return-schema conformance. It never proves the Return's claims are true or that acceptanceChecks were satisfied. Without a contract the child returns an ordinary Result with no machine contract assurance.",
});

const RETURN_CONTRACT_ID_PATTERN = "^sha256:[a-fA-F0-9]{64}$";

// The claim fields a Return candidate and a validated Return envelope share.
// Fresh sub-schemas per call: TypeBox schemas are plain objects, and two public
// exports must not alias each other's property definitions.
const returnClaimProperties = () => ({
	status: StringEnum(["completed", "partial", "blocked", "failed"] as const),
	summary: Type.String({ minLength: 1 }),
	evidence: Type.Array(Type.Object({ claim: Type.String({ minLength: 1 }), source: Type.String({ minLength: 1 }) })),
	artifactReferences: Type.Array(Type.Object({ path: Type.String({ minLength: 1 }) })),
	digests: Type.Array(Type.Object({
		artifact: Type.String({ minLength: 1 }),
		algorithm: Type.Literal("sha256"),
		value: Type.String({ pattern: "^[a-fA-F0-9]{64}$" }),
	})),
	changedState: StringList,
	unresolvedQuestions: StringList,
	retry: Type.Object({
		retryable: Type.Boolean(),
		reason: Type.Optional(Type.String({ minLength: 1 })),
		afterMs: Type.Optional(Type.Number({ minimum: 0 })),
	}),
	data: Type.Any(),
});

export const FlowReturnCandidate = Type.Object({
	schemaVersion: Type.Literal("pi-flows.return-envelope.v1"),
	contractId: Type.Optional(Type.String({ pattern: RETURN_CONTRACT_ID_PATTERN, description: "The identity the child claimed, kept as parsed. It can be missing or stale, so a rejection stays diagnosable; validation checks it against the resolved contract." })),
	...returnClaimProperties(),
}, {
	description: "Untrusted child output that is structurally a return envelope, offered for contract validation (a Return candidate). A value that satisfies this schema is not a validated Return envelope: validation must first bind it to the resolved contract identity, verify its artifacts, and check its data.",
});

export const FlowReturnEnvelope = Type.Object({
	schemaVersion: Type.Literal("pi-flows.return-envelope.v1"),
	contractId: Type.String({ pattern: RETURN_CONTRACT_ID_PATTERN, description: "The exact resolved delegation-contract identity the Return validated under. Always present: only validation constructs a Return envelope." }),
	...returnClaimProperties(),
	usage: Type.Optional(Type.Object({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		cost: Type.Number({ minimum: 0 }),
		costKnown: Type.Optional(Type.Boolean()),
		contextTokens: Type.Number({ minimum: 0 }),
		turns: Type.Number({ minimum: 0 }),
	})),
}, {
	description: "A validated Return envelope: a child return that passed attribution, integrity, and conformance under a resolved delegation contract. That is the whole assurance — validation never establishes that the Return's claims are true or that prose acceptance checks were satisfied. Validate raw child output against FlowReturnCandidate instead; runtime usage is attached to the validated envelope when available.",
});

const FlowTaskProperties = {
	agent: Type.String({ minLength: 1, description: "Name of the flow agent to run. Bundled agents include recon, analyst, strategist, operator, overwatch, redteam, controller, commander, and debrief. Never leave this empty." }),
	role: Type.Optional(Type.String({ minLength: 1, description: "Human-readable topology slot this agent fills, such as standards or spec. Displayed separately from the agent profile." })),
	task: Type.String({ minLength: 1, description: "Complete task for that agent, including the target and expected output. Do not use vague one-word tasks. Chain tasks may use {task} and {previous}." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this agent process" })),
	model: Type.Optional(Type.String({ description: "Optional exact-model override for this agent process. Prefer tier unless the user named a concrete model." })),
	tier: Type.Optional(FlowTier),
	thinking: Type.Optional(FlowThinking),
	tools: Type.Optional(
		Type.String({ description: 'Optional comma-separated tool override. Use "none" for no built-in tools or "default" for pi defaults. "bash-ro" = bash under a child-enforced read-only allowlist (not write-capable; bash+bash-ro together = plain bash).' }),
	),
	returnContract: Type.Optional(Type.String({ description: `Prose return requirements appended to this agent's task. Use them to specify summary shape, required fields, or max length. ${PromptOnlyNote} Use contract for a machine-checked Return.` })),
	requireEvidence: Type.Optional(Type.Boolean({ description: `Ask for concrete evidence (file:line, command output, citations, or explicit gaps) in this agent's return. ${PromptOnlyNote}`, default: false })),
	contract: Type.Optional(FlowDelegationContract),
};

export const FlowTask = Type.Object(FlowTaskProperties);

export const FlowContractTask = Type.Object(FlowTaskProperties);

export const FlowAgentRef = Type.Object({
	agent: Type.String({ minLength: 1, description: "Name of the flow agent to run for this role. Bundled agents include recon, analyst, strategist, operator, overwatch, redteam, controller, commander, and debrief. Never leave this empty." }),
	role: Type.Optional(Type.String({ minLength: 1, description: "Human-readable topology slot this agent fills." })),
	model: Type.Optional(Type.String({ description: "Optional exact-model override for this role. Prefer tier unless the user named a concrete model." })),
	tier: Type.Optional(FlowTier),
	thinking: Type.Optional(FlowThinking),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default". "bash-ro" = bash under a child-enforced read-only allowlist (not write-capable; bash+bash-ro together = plain bash).' })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this role's process" })),
	contract: Type.Optional(FlowDelegationContract),
}, {
	description: "An agent filling a role. Its optional contract resolves before spawn and validates the Return — attribution, artifact integrity, and schema conformance — before coordination can use it. Without a contract the role returns an ordinary Result.",
});

export const FlowEvaluateOperatorRef = Type.Object({
	agent: Type.String({ minLength: 1, description: "Generator agent for evaluate mode. Usually operator." }),
	task: Type.Optional(Type.String({ minLength: 1, description: "Optional alias for the evaluate goal when top-level task is omitted. Prefer top-level task when possible." })),
	model: Type.Optional(Type.String({ description: "Optional exact-model override for the generator. Prefer tier unless the user named a concrete model." })),
	tier: Type.Optional(FlowTier),
	thinking: Type.Optional(FlowThinking),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default". "bash-ro" = bash under a child-enforced read-only allowlist (not write-capable; bash+bash-ro together = plain bash).' })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the generator process" })),
	contract: Type.Optional(FlowDelegationContract),
});

export const FlowEvaluate = Type.Object({
	operator: Type.Optional(FlowEvaluateOperatorRef),
	redteam: Type.Optional(
		Type.Union([FlowAgentRef, Type.Array(FlowAgentRef, { minItems: 1, maxItems: MAX_PARALLEL_TASKS })], {
			description: "One critic or a decomposed panel. Uncontracted critics return PASS/REVISE prose; contracted critics use validated data.verdict. With a panel, every critic must pass and REVISE critiques are merged.",
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
	description: "Routing mode: the controller classifies task and dispatches one candidate. A contracted controller selects through validated data.route; legacy prose applies only without a contract.",
});

export const FlowOrchestrate = Type.Object({
	task: Type.Optional(Type.String({ minLength: 1, description: "Optional alias for the orchestrate goal when top-level task is omitted. Prefer top-level task when possible." })),
	commander: Type.Optional(FlowAgentRef),
	recon: Type.Optional(FlowAgentRef),
	debrief: Type.Optional(FlowAgentRef),
	review: Type.Optional(FlowAgentRef),
	reviewMaxIterations: Type.Optional(Type.Integer({ description: "Maximum Decomposition-review attempts. Integer 1..4. Default 2.", minimum: 1, maximum: 4, default: 2 })),
	reviewCriteria: Type.Optional(Type.String({ minLength: 1, description: "Additional Decomposition-review criteria. These criteria add to the fixed quality rubric and cannot replace it." })),
	verify: Type.Optional(FlowAgentRef),
	verifyPolicy: Type.Optional(
		StringEnum(["note", "fail", "revise"] as const, {
			description: 'How to handle a verifier REVISE verdict. "note" appends the verdict (default), "fail" returns ORCHESTRATE_VERIFY_FAILED, "revise" asks debrief to revise and re-verifies.',
			default: "note",
		}),
	),
	verifyMaxIterations: Type.Optional(Type.Number({ description: "Max synthesize->verify rounds when verifyPolicy is revise. Integer 1..4. Default 2.", minimum: 1, maximum: 4, default: 2 })),
	workerReturnContract: Type.Optional(Type.String({ description: `Prose return requirements appended to every worker subtask before fan-out. ${PromptOnlyNote}` })),
	returnContract: Type.Optional(Type.String({ description: "Optional alias for top-level returnContract. If top-level task is omitted, this text is also accepted as the orchestrate goal for model-generated calls." })),
	maxSubtasks: Type.Optional(Type.Number({ description: `Cap on the total subtasks in the commander's decomposition, dependent ones included. Integer 1..${MAX_SUBTASKS}. Default ${MAX_PARALLEL_TASKS}. A flat subtask list is silently cut to this cap; a decomposition with dependency edges is refused DECOMPOSITION_INVALID when it exceeds it, because cutting it would sever edges.`, minimum: 1, maximum: MAX_SUBTASKS })),
}, {
	description: "Orchestrator-workers mode. The commander decomposes the task. An optional review role judges the normalized Decomposition. Recon workers run by dependency wave. The debrief role merges results. A REVISE review starts a bounded commander revision. commander.contract carries the Decomposition in validated envelope data. review.contract and verify.contract use validated data.verdict instead of legacy prose.",
});

export const FlowGraphNode = Type.Object({
	id: Type.String({ minLength: 1, description: "Unique node id. Later nodes can reference this output as {node.<id>}." }),
	agent: Type.String({ minLength: 1, description: "Agent to run for this graph node." }),
	task: Type.String({ minLength: 1, description: "Task for this graph node. May use {task} and {node.<id>} placeholders for dependency outputs." }),
	dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Node ids that must complete before this node can run." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this node process" })),
	model: Type.Optional(Type.String({ description: "Optional exact-model override for this node. Prefer tier unless the user named a concrete model." })),
	tier: Type.Optional(FlowTier),
	thinking: Type.Optional(FlowThinking),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default". "bash-ro" = bash under a child-enforced read-only allowlist (not write-capable; bash+bash-ro together = plain bash).' })),
	returnContract: Type.Optional(Type.String({ description: `Prose return requirements appended to this node's task. ${PromptOnlyNote}` })),
	requireEvidence: Type.Optional(Type.Boolean({ description: `Ask for concrete evidence in this node's return. ${PromptOnlyNote}`, default: false })),
	contract: Type.Optional(FlowDelegationContract),
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
	description: 'Generic bounded loop mode. Without role contracts, the body emits "LOOP: DONE" or the judge emits "VERDICT: PASS". Contracted roles use validated data.loop or data.verdict; otherwise the loop stops at maxIterations.',
});

export const FlowSearch = Type.Object({
	generator: Type.Optional(FlowAgentRef),
	scorer: Type.Optional(FlowAgentRef),
	debrief: Type.Optional(FlowAgentRef),
	candidates: Type.Optional(Type.Number({ description: `Candidates generated per round. Integer 1..${MAX_PARALLEL_TASKS}. Default ${DEFAULT_SEARCH_CANDIDATES}.`, minimum: 1, maximum: MAX_PARALLEL_TASKS, default: DEFAULT_SEARCH_CANDIDATES })),
	beamWidth: Type.Optional(Type.Number({ description: `Candidates retained per round. Default ${DEFAULT_SEARCH_BEAM_WIDTH}.`, minimum: 1, maximum: MAX_PARALLEL_TASKS, default: DEFAULT_SEARCH_BEAM_WIDTH })),
	maxRounds: Type.Optional(Type.Number({ description: `Search/refinement rounds. Integer 1..4. Default ${DEFAULT_SEARCH_ROUNDS}.`, minimum: 1, maximum: 4, default: DEFAULT_SEARCH_ROUNDS })),
}, {
	description: "Bounded tree/beam-search mode: generate candidates, score each with legacy SCORE: 0..100 or contracted data.score, retain a beam, repeat, then debrief the winner.",
});

export const FlowWorkflowPhase = Type.Object({
	id: Type.String({ minLength: 1, description: "Stable phase id used by persisted resume state and {phase.<id>} placeholders." }),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Agent for a work phase. Omit only for an approval phase." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Work phase task. Supports {task}, {previous}, and {phase.<id>} output placeholders." })),
	approval: Type.Optional(Type.Object({
		message: Type.String({ minLength: 1, description: "Approval question shown in an interactive UI. Consent binds every gated Role's selected Agent source, prompt digest, effective tools, resolved cwd, model, and Thinking level; headless runs pause and persist resumable state." }),
	})),
	checkCommand: Type.Optional(Type.String({ minLength: 1, description: "Deterministic gate run after this work phase. The workflow stops if it exits non-zero." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this phase and its checkCommand." })),
	model: Type.Optional(Type.String({ description: "Optional exact-model override for this phase. Prefer tier unless the user named a concrete model." })),
	tier: Type.Optional(FlowTier),
	thinking: Type.Optional(FlowThinking),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default". "bash-ro" = bash under a child-enforced read-only allowlist (not write-capable; bash+bash-ro together = plain bash).' })),
	returnContract: Type.Optional(Type.String({ description: `Prose return requirements appended to this phase task. ${PromptOnlyNote}` })),
	requireEvidence: Type.Optional(Type.Boolean({ description: `Ask for concrete evidence in this phase output. ${PromptOnlyNote}`, default: false })),
	contract: Type.Optional(FlowDelegationContract),
});

const FlowHistoricalThinking = Type.Object({
	phases: Type.Optional(Type.Record(Type.String({ minLength: 1 }), FlowHistoricalThinkingLevel, { maxProperties: MAX_WORKFLOW_PHASES })),
	debrief: Type.Optional(FlowHistoricalThinkingLevel),
}, {
	description: "Optional v3 migration witness: effective historical Thinking levels by gated phase id and debrief. Values never control dispatch and are accepted only when they reproduce the spent receipt's binding digest.",
});

export const FlowWorkflow = Type.Object({
	phases: Type.Array(FlowWorkflowPhase, { minItems: 1, maxItems: MAX_WORKFLOW_PHASES, description: "Ordered work and approval phases. Exactly one of agent+task or approval is required per phase." }),
	stateFile: Type.Optional(Type.String({ description: "Persist redacted phase state for audit/resume. Defaults to .pi/flow-workflows/<workflow-digest>.json." })),
	resume: Type.Optional(Type.Boolean({ description: "Resume completed phases from stateFile. The workflow digest must match and outstanding receipts are rechecked against the effective Agent profiles that would run now. An already completed workflow is an audit-only no-op.", default: false })),
	historicalThinking: Type.Optional(FlowHistoricalThinking),
	approvalTtlMs: Type.Optional(Type.Number({ description: `How long an approval receipt authorizes its gated action, in milliseconds. A resume after this window needs a fresh approval. Default ${DEFAULT_APPROVAL_TTL_MS} (24h).`, minimum: MIN_APPROVAL_TTL_MS, maximum: MAX_APPROVAL_TTL_MS, default: DEFAULT_APPROVAL_TTL_MS })),
	debrief: Type.Optional(FlowAgentRef),
}, {
	description: "Phase-gated state-machine mode: execute ordered work phases, enforce deterministic gates, bind durable approval to effective Agent profiles, persist artifacts, then optionally debrief the completed phase outputs.",
});

export const FlowWorktreeTask = Type.Object({
	id: Type.String({ minLength: 1, description: "Stable task id used in worker and branch labels." }),
	agent: Type.String({ minLength: 1, description: "Write-capable agent that works in its own git worktree." }),
	task: Type.String({ minLength: 1, description: "Independent implementation task for this worktree." }),
	model: Type.Optional(Type.String({ description: "Optional exact-model override for this worker. Prefer tier unless the user named a concrete model." })),
	tier: Type.Optional(FlowTier),
	thinking: Type.Optional(FlowThinking),
	tools: Type.Optional(Type.String({ description: 'Optional comma-separated tool override. "none" or "default". "bash-ro" = bash under a child-enforced read-only allowlist (not write-capable; bash+bash-ro together = plain bash).' })),
	returnContract: Type.Optional(Type.String({ description: `Prose return requirements appended to this worker task. ${PromptOnlyNote}` })),
	requireEvidence: Type.Optional(Type.Boolean({ description: `Ask for evidence in this worker output. ${PromptOnlyNote}`, default: true })),
	contract: Type.Optional(FlowDelegationContract),
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
	trigger: Type.Optional(StringEnum(["success", "failure", "match"] as const, { description: 'Trigger on exit 0, non-zero exit, or a regex "pattern" match.', default: "success" })),
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
	maxEntries: Type.Optional(Type.Number({ description: "Recent lessons appended to the top-level task before the mode runs. Default 5, cap 20.", minimum: 1, maximum: 20, default: 5 })),
});

export const FlowParams = Type.Object({
	list: Type.Optional(Type.Boolean({ description: "List available workflow presets and flow agents instead of running one" })),
	showConfig: Type.Optional(Type.Boolean({ description: "Show effective flow config, preset and agent dirs, tier mappings, discovery issues, and defaults without running an agent" })),
	preset: Type.Optional(Type.String({ minLength: 1, description: "Named workflow preset to expand before mode validation. Bundled presets include scout, map-codebase, and code-review. Prefer a preset when it matches the user's intent." })),
	why: Type.Optional(
		Type.String({
			minLength: 1,
			description: "One sentence: why this work needs isolated children instead of direct execution in the parent context (explicit user request for delegation, fan-out one context cannot hold, or author-independent verification). Required for every mode that runs children; list/showConfig do not need it. If you cannot state a reason, do the work directly instead of calling flow.",
		}),
	),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Single-agent mode: agent name, e.g. recon for a read-only scout or analyst for deeper investigation. Use with task; never pass an empty agent." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Single-agent task, shared {task} value for chain steps, or the goal paired with a delegation contract in evaluate mode. For a named-agent request like 'ask recon to inspect package.json', set agent:'recon' and put the complete requested work here; never use a vague one-word task." })),
	contract: Type.Optional(FlowDelegationContract),
	tasks: Type.Optional(Type.Array(FlowTask, { description: "Parallel mode: tasks to run concurrently. With two or more raw tasks, set tier or model on every task; set one flow-wide tier or model only when uniform sizing is intentional." })),
	chain: Type.Optional(Type.Array(FlowContractTask, { description: "Chain mode: tasks to run sequentially" })),
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
		Type.Boolean({ description: "Prompt before using project-local agents or presets. Default true. In non-UI contexts, true refuses them; set false only for trusted repos.", default: true }),
	),
	concurrency: Type.Optional(Type.Number({ description: "Parallel mode concurrency. Must be an integer from 1 to 8.", minimum: 1, maximum: 8, default: DEFAULT_CONCURRENCY })),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-agent child process timeout in milliseconds. Default 36000000 (10 hours).", minimum: 1000, default: DEFAULT_TIMEOUT_MS })),
	maxCostUsd: Type.Optional(Type.Number({ description: "Flow-budget USD cost ceiling across every child in this flow. It does not cross the process boundary: a nested flow started by a child is bounded only by the ceilings that call sets, and is uncapped when it sets none. At 80% live children are steered to wrap up and emit a partial envelope; once the ceiling is reached at a completed model-response boundary, the active child stops (gracefully if its notice was delivered, else BUDGET_EXCEEDED) and no further child is spawned. Omit to run uncapped.", minimum: 0 })),
	maxTokens: Type.Optional(Type.Number({ description: "Flow-budget input+output token ceiling across every child in this flow. It does not cross the process boundary: a nested flow started by a child is bounded only by the ceilings that call sets, and is uncapped when it sets none. A between-run spawn gate only: once reached, no further child is spawned (BUDGET_EXCEEDED), but it never stops or steers the live run - a contract maxTokens does both. Omit to run uncapped.", minimum: 0 })),
	maxGeneratedTokens: Type.Optional(Type.Number({ description: "Flow-budget generated/output token ceiling across every child in this flow. It does not cross the process boundary: a nested flow started by a child is bounded only by the ceilings that call sets, and is uncapped when it sets none. At 80% live children are steered to wrap up and emit a partial envelope; once the ceiling is reached at a completed model-response boundary, the active child stops (gracefully if its notice was delivered, else BUDGET_EXCEEDED) and no further child is spawned. Omit to run uncapped.", minimum: 0 })),
	traceFile: Type.Optional(Type.String({ description: "Append OpenInference-shaped JSON spans to this file (JSONL any OpenTelemetry pipeline can ingest): one per delegated child, one per stage (wave/round/iteration/phase), one per coordination event (approval, state, retry, budget, validation, handoff, artifact), plus a root span for the flow call, with redacted token/cost/model/status attributes. Also settable via PI_FLOWS_TRACE_FILE. Relative paths resolve against cwd." })),
	traceLabel: Type.Optional(Type.String({ description: "Use-case label attached to trace spans so reports can group execution success, verified outcome success, and TPSO by journey." })),
	traceContext: Type.Optional(Type.Object({
		runId: Type.String({ minLength: 1, description: "Stable identifier for the enclosing eval or runtime run." }),
		caseId: Type.String({ minLength: 1, description: "Stable case identifier." }),
		trialId: Type.String({ minLength: 1, description: "Unique trial identifier within the run." }),
		trialIndex: Type.Optional(Type.Number({ minimum: 1 })),
		arm: Type.Optional(Type.String({ minLength: 1, description: "Paired-comparison or experiment arm identity." })),
		attempt: Type.Optional(Type.Number({ minimum: 1, description: "Execution attempt within a retried trial arm." })),
	}, { description: "Stable runtime trace linkage supplied by eval harnesses. Identifiers are copied to every span and returned with the exact root span reference." })),
	traceStrict: Type.Optional(Type.Boolean({ description: "Require complete trace evidence. Default false (best-effort tracing that never fails a flow). When true, a missing traceFile, a trace with dropped spans or failed exports, or an export that is complete but does not read back as a span tree fails the call with TRACE_INCOMPLETE — intended for evaluation and release gates, not ordinary user flows. Also settable via PI_FLOWS_TRACE_STRICT.", default: false })),
	handoffPolicy: Type.Optional(StringEnum(["warn", "quarantine", "fail"] as const, {
		description: 'Call-level handling for injection warnings at inter-agent boundaries. "warn" preserves compatibility, "quarantine" withholds flagged payloads, and "fail" stops before the recipient is spawned. Default "warn".',
		default: "warn",
	})),
	modeHandoffPolicy: Type.Optional(Type.Object({
		single: Type.Optional(HandoffPolicy),
		parallel: Type.Optional(HandoffPolicy),
		chain: Type.Optional(HandoffPolicy),
		evaluate: Type.Optional(HandoffPolicy),
		vote: Type.Optional(HandoffPolicy),
		route: Type.Optional(HandoffPolicy),
		orchestrate: Type.Optional(HandoffPolicy),
		graph: Type.Optional(HandoffPolicy),
		loop: Type.Optional(HandoffPolicy),
		search: Type.Optional(HandoffPolicy),
		workflow: Type.Optional(HandoffPolicy),
		worktree: Type.Optional(HandoffPolicy),
		debate: Type.Optional(HandoffPolicy),
		dossier: Type.Optional(HandoffPolicy),
		monitor: Type.Optional(HandoffPolicy),
	}, {
		description: "Minimum handoff policy required by each mode. The effective policy is the stricter of this mode requirement and handoffPolicy, so a high-consequence mode cannot be downgraded by a call-level override.",
	})),
	incompleteHandoffPolicy: Type.Optional(StringEnum(["fail", "include"] as const, {
		description: 'How integration modes handle return envelopes with partial or blocked status. "fail" is the default; "include" is an explicit decision to synthesize while preserving incomplete status and provenance.',
		default: "fail",
	})),
	returnContract: Type.Optional(Type.String({ description: `Prose return requirements appended to delegated and synthesis tasks. Use them to prevent summary loss on handoffs. ${PromptOnlyNote} Use contract for a machine-checked Return.` })),
	requireEvidence: Type.Optional(Type.Boolean({ description: `Ask for concrete evidence in delegated outputs when return requirements are appended. ${PromptOnlyNote}`, default: false })),
	allowSharedWriteCwd: Type.Optional(Type.Boolean({ description: "Allow concurrent write-capable agents to share a cwd. Default false; prefer distinct cwd/worktrees.", default: false })),
	recordContent: Type.Optional(Type.Boolean({ description: "Store and return child message content after redaction. Set false to retain only structural usage/status data.", default: true })),
	redactSecrets: Type.Optional(Type.Boolean({ description: "Redact secret-shaped strings, emails, and home-directory paths from content/details. Default true.", default: true })),
	cwd: Type.Optional(Type.String({ description: "Working directory for single-agent mode" })),
	model: Type.Optional(Type.String({ description: "Flow-wide exact-model fallback. Applies to every delegated role unless that task or role sets its own model. On a multi-task raw parallel call, setting this explicitly acknowledges intentional uniform sizing. Prefer tier unless the user named a concrete model." })),
	tier: Type.Optional(StringEnum(["fast", "capable", "deep"] as const, { description: `Flow-wide capability tier fallback. Applies to every delegated role unless that task or role sets its own tier or model. On a multi-task raw parallel call, setting this explicitly acknowledges intentional uniform sizing. ${TierDescription}` })),
	thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: `Flow-wide thinking-level fallback. Applies to every delegated role unless that task or role sets its own thinking. ${ThinkingDescription}` })),
	tools: Type.Optional(
		Type.String({ description: 'Comma-separated tool override for single-agent mode. Use "none" or "default". "bash-ro" = bash under a child-enforced read-only allowlist (not write-capable; bash+bash-ro together = plain bash).' }),
	),
}, {
	description: "Prefer a named preset when it matches the intent, e.g. {\"preset\":\"code-review\",\"task\":\"Review changes against main and issue #25\",\"why\":\"author-independent review\"}. Otherwise provide exactly one raw flow mode. Every spawning call must set why.",
});

const checkFlowParams = Compile(FlowParams);

/** The public flow schema's own verdict, one error at a time. Preset expansion validates its expanded params with this, and the selection eval imports it so a call pi would refuse at parameter validation — before execute ever runs — is never scored as admissible. */
export function flowParamsSchemaError(value: unknown): string | null {
	for (const item of checkFlowParams.Errors(value)) {
		return `${item.instancePath || "/"} ${item.message}`;
	}
	return null;
}
