import type { Message } from "@earendil-works/pi-ai";

export const PI_FLOWS_VERSION = "0.3.0";

export const MAX_PARALLEL_TASKS = 8;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 60 * 1000;
export const DEFAULT_EVALUATE_ITERATIONS = 3;
export const MAX_EVALUATE_ITERATIONS = 8;
export const MAX_GRAPH_NODES = 16;
export const DEFAULT_LOOP_ITERATIONS = 3;
export const MAX_LOOP_ITERATIONS = 8;
export const DEFAULT_SEARCH_CANDIDATES = 3;
export const DEFAULT_SEARCH_BEAM_WIDTH = 1;
export const DEFAULT_SEARCH_ROUNDS = 2;
export const MAX_WORKFLOW_PHASES = 12;
export const DEFAULT_DEBATE_ROUNDS = 2;
export const MAX_DEBATE_ROUNDS = 3;
export const DEFAULT_MONITOR_CHECKS = 6;
export const MAX_MONITOR_CHECKS = 20;
export const DEFAULT_MONITOR_INTERVAL_MS = 5_000;
export const MAX_MONITOR_INTERVAL_MS = 60_000;
/** Max nesting of flow-within-flow delegation. A flow call at or beyond this depth is refused. */
export const MAX_FLOW_DEPTH = 2;
export const MODEL_VISIBLE_OUTPUT_CAP = 50 * 1024;
export const STDERR_CAPTURE_CAP = 50 * 1024;
export const STDOUT_SAMPLE_CAP = 8 * 1024;
/** Wall-clock cap for an evaluate `checkCommand` (deterministic gate) child process. */
export const DEFAULT_CHECK_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Grace after a child reports a terminal provider error (assistant message with
 * stopReason "error" + errorMessage) before pi-flows terminates it. A child
 * should exit on its own after such an error; when it stalls instead, this
 * bounds the hang at seconds rather than the full timeoutMs (default 10h).
 * Override with PI_FLOWS_ERROR_GRACE_MS.
 */
export const DEFAULT_CHILD_ERROR_GRACE_MS = 30_000;
export const CHECK_OUTPUT_CAP = 16 * 1024;

export type AgentSource = "package" | "user" | "project";
export type AgentScope = "user" | "project" | "all";

/**
 * The single source of the mode union. `RunMode`, `FlowMode`, the contract
 * table in modes/contract.ts (a Record keyed by RunMode), and the derived
 * handler table all flow from this list — adding a mode here without a
 * matching contract entry (or vice versa) is a compile error.
 */
export const RUN_MODE_NAMES = ["single", "parallel", "chain", "evaluate", "vote", "route", "orchestrate", "graph", "loop", "search", "workflow", "worktree", "debate", "dossier", "monitor"] as const;
export type RunMode = (typeof RUN_MODE_NAMES)[number];
export type FlowMode = RunMode | "list" | "config";
export type DiscoveryIssueSeverity = "warning" | "error";
export type VerifyPolicy = "note" | "fail" | "revise";

/**
 * Single source of truth for every error `code` the `flow` tool can return.
 * `FlowErrorCode` is derived from this array, and `tests/pi-flows.test.ts`
 * asserts that `docs/troubleshooting.md` documents every member — so a new code
 * cannot ship undocumented. When you add a code here, add a matching
 * `` ### `CODE` `` entry (cause + fix) to the "Error codes" catalog in
 * docs/troubleshooting.md.
 */
export const FLOW_ERROR_CODES = [
	"UNKNOWN_AGENT",
	"INVALID_MODE",
	"WHY_REQUIRED",
	"INVALID_SCOPE",
	"INVALID_CONCURRENCY",
	"TOO_MANY_TASKS",
	"TOO_FEW_VOTERS",
	"ROUTE_UNRESOLVED",
	"ORCHESTRATE_NO_SUBTASKS",
	"FLOW_DEPTH_EXCEEDED",
	"BUDGET_EXCEEDED",
	"BUDGET_UNOBSERVABLE",
	"CHECK_COMMAND_FAILED",
	"ORCHESTRATE_VERIFY_FAILED",
	"GRAPH_INVALID",
	"GRAPH_CYCLE",
	"LOOP_DID_NOT_CONVERGE",
	"SEARCH_NO_CANDIDATES",
	"WORKFLOW_INVALID",
	"WORKFLOW_STATE_INVALID",
	"WORKFLOW_GATE_FAILED",
	"WORKFLOW_APPROVAL_REQUIRED",
	"WORKFLOW_APPROVAL_DENIED",
	"WORKTREE_NOT_GIT",
	"WORKTREE_DIRTY_SOURCE",
	"WORKTREE_SETUP_FAILED",
	"WORKTREE_INTEGRATION_FAILED",
	"WORKTREE_VERIFY_FAILED",
	"DEBATE_TOO_FEW_PARTICIPANTS",
	"DOSSIER_TOO_FEW_SECTIONS",
	"MONITOR_INVALID",
	"MONITOR_NOT_TRIGGERED",
	"CHECKPOINT_APPROVAL_REQUIRED",
	"CHECKPOINT_APPROVAL_DENIED",
	"SHARED_WRITE_CWD",
	"PROJECT_AGENT_APPROVAL_REQUIRED",
	"PROJECT_AGENT_APPROVAL_DENIED",
	"CHILD_PROTOCOL_ERROR",
	"CHILD_EXIT_NONZERO",
	"CHILD_ABORTED",
	"CHILD_TIMEOUT",
	"CHILD_PROVIDER_ERROR",
] as const;

export type FlowErrorCode = (typeof FLOW_ERROR_CODES)[number];

export interface FlowError {
	code: FlowErrorCode;
	message: string;
	cause: string;
	fix: string;
	retryable?: boolean;
}

export interface DiscoveryIssue {
	severity: DiscoveryIssueSeverity;
	code: string;
	source: AgentSource;
	filePath?: string;
	message: string;
	fix?: string;
}

export interface FlowAgent {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	tier?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface FlowDiscovery {
	agents: FlowAgent[];
	projectAgentsDir: string | null;
	userAgentsDir: string;
	packageAgentsDir: string;
	issues: DiscoveryIssue[];
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	costKnown?: boolean;
	contextTokens: number;
	turns: number;
}

export interface FlowRunResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	/** Redacted task preview for diagnostics. The raw task is passed by temp file, never argv/details. */
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	error?: FlowError;
	step?: number;
	durationMs?: number;
	stdoutParseErrors?: number;
	stdoutSample?: string;
}

export interface FlowDetails {
	mode: FlowMode;
	version: string;
	agentScope: AgentScope;
	config: {
		defaultConcurrency: number;
		maxParallelTasks: number;
		modelVisibleOutputCapBytes: number;
		defaultTimeoutMs: number;
		recordContentDefault: boolean;
		redactSecretsDefault: boolean;
	};
	agentsDir: {
		package: string;
		user: string;
		project: string | null;
	};
	results: FlowRunResult[];
	agents?: Array<Pick<FlowAgent, "name" | "description" | "source" | "filePath" | "model" | "tier" | "tools">>;
	discoveryIssues?: DiscoveryIssue[];
	error?: FlowError;
}

export interface FlowTaskInput {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	tier?: string;
	tools?: string;
	returnContract?: string;
	requireEvidence?: boolean;
}

export interface FlowAgentRefInput {
	agent: string;
	model?: string;
	tier?: string;
	tools?: string;
	cwd?: string;
}

export interface CapturePolicy {
	recordContent: boolean;
	redactSecrets: boolean;
}

/**
 * Cumulative spend ceiling for a whole flow call. The wiki's "Uncontrolled
 * Recursion" anti-pattern names cost — alongside iterations and time — as a
 * dimension that must be hard-bounded. Iterations/time were already capped;
 * this closes the cost dimension. `spent*` accumulate across every child in the
 * delegation tree; once a ceiling is hit, no further child is spawned.
 */
export interface FlowBudget {
	maxCostUsd?: number;
	maxTokens?: number;
	maxGeneratedTokens?: number;
	spentCost: number;
	spentTokens: number;
	spentGeneratedTokens: number;
}

/** Records one completed child run as a trace span. See makeTraceSink. */
export type RecordSpan = (result: FlowRunResult) => void;

export function budgetExceeded(budget: FlowBudget | undefined): boolean {
	if (!budget) return false;
	if (budget.maxCostUsd !== undefined && budget.spentCost >= budget.maxCostUsd) return true;
	if (budget.maxTokens !== undefined && budget.spentTokens >= budget.maxTokens) return true;
	if (budget.maxGeneratedTokens !== undefined && budget.spentGeneratedTokens >= budget.maxGeneratedTokens) return true;
	return false;
}

export function chargeBudget(budget: FlowBudget | undefined, usage: UsageStats): void {
	if (!budget) return;
	budget.spentCost += usage.cost || 0;
	budget.spentTokens += (usage.input || 0) + (usage.output || 0);
	budget.spentGeneratedTokens += usage.output || 0;
}

export function budgetExceededError(budget: FlowBudget): FlowError {
	const spent = budget.maxCostUsd !== undefined
		? `$${budget.spentCost.toFixed(4)} of $${budget.maxCostUsd.toFixed(4)}`
		: budget.maxGeneratedTokens !== undefined
			? `${budget.spentGeneratedTokens} of ${budget.maxGeneratedTokens} generated tokens`
			: `${budget.spentTokens} of ${budget.maxTokens} total tokens`;
	return flowError(
		"BUDGET_EXCEEDED",
		`Flow budget exhausted (${spent}).`,
		"Cumulative child spend reached a configured cost or token ceiling, so no further child was spawned. This bounds the cost dimension of runaway delegation that iteration/time caps do not cover.",
		"Raise the configured budget, narrow the task, or reduce fan-out (fewer voters/subtasks/iterations). Omit budget fields to run uncapped.",
	);
}

export function budgetUnobservableError(): FlowError {
	return flowError(
		"BUDGET_UNOBSERVABLE",
		"Flow cost budget cannot be enforced because the provider omitted cost telemetry.",
		"The child completed a model response without a numeric usage.cost.total value, so treating its spend as zero would make maxCostUsd non-binding.",
		"Use a provider/model that reports cost telemetry, or bind the run by maxTokens, maxGeneratedTokens, or timeoutMs instead.",
	);
}

export function flowError(code: FlowErrorCode, message: string, cause: string, fix: string, retryable = false): FlowError {
	return { code, message, cause, fix, retryable };
}

export function formatFlowError(error: FlowError): string {
	return [`${error.message}`, `Cause: ${error.cause}`, `Fix: ${error.fix}`, `Code: ${error.code}`].join("\n");
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export type Update = (partial: { content: Array<{ type: "text"; text: string }>; details: FlowDetails }) => void;

/**
 * Everything needed to execute one child run. This is the interface of the
 * child-run seam: the production adapter is `runFlowAgent` in runner.ts (a real
 * pi subprocess); tests inject an in-process fake through `ModeDeps.runChild`
 * so mode coordination logic runs without spawning anything.
 */
export interface RunChildOptions {
	defaultCwd: string;
	agents: FlowAgent[];
	agentName: string;
	task: string;
	cwd?: string;
	model?: string;
	tier?: string;
	tools?: string;
	timeoutMs?: number;
	recordContent?: boolean;
	redactSecrets?: boolean;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: Update;
	budget?: FlowBudget;
	recordSpan?: RecordSpan;
	makeDetails: (results: FlowRunResult[]) => FlowDetails;
}

export type RunChild = (options: RunChildOptions) => Promise<FlowRunResult>;

export interface ModeDeps {
	params: any;
	discovery: FlowDiscovery;
	policy: CapturePolicy;
	agentScope: AgentScope;
	defaultCwd: string;
	signal?: AbortSignal;
	onUpdate?: Update;
	budget?: FlowBudget;
	recordSpan?: RecordSpan;
	requestApproval?: (title: string, message: string) => Promise<"approved" | "required" | "denied">;
	makeDetails: (mode: FlowMode, agents?: FlowAgent[]) => (results: FlowRunResult[], error?: FlowError) => FlowDetails;
	/** The child-run seam. Handlers reach it via the runner helpers (runAgentRef/runAgentFanout), which execute every child through this — so tests can inject an in-process fake. */
	runChild: RunChild;
	/** Fan-out concurrency, validated and defaulted by the dispatch core — handlers never re-derive it. */
	concurrency: number;
}

export type ModeOutput = { content: Array<{ type: "text"; text: string }>; details: FlowDetails };
export type ModeHandler = (deps: ModeDeps) => Promise<ModeOutput>;
