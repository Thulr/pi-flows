import type { Message } from "@earendil-works/pi-ai";
import type { ChildSpanScope, FlowTraceContext, FlowTraceLink, RecordEvent } from "./trace-scope.ts";
import type { HandoffGuard } from "./handoff-types.ts";

// The coordination-trace vocabulary lives in trace-scope.ts (dependency-free so
// it can be re-exported here without a cycle) and is part of this module's
// public surface: downstream consumers import trace types from types.ts.
export type {
	ChildSpanScope,
	CoordinationEvent,
	CoordinationEventKind,
	FlowTraceContext,
	FlowTraceHealth,
	FlowTraceHealthStatus,
	FlowTraceLink,
	RecordEvent,
	SpanStage,
} from "./trace-scope.ts";
export { encodeAuthorKey } from "./trace-scope.ts";
export type { HandoffGuard, PreparedHandoff, ResolvedHandoffPolicy } from "./handoff-types.ts";

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
export type HandoffPolicy = "warn" | "quarantine" | "fail";

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
	"APPROVAL_RECEIPT_INVALID",
	"APPROVAL_RECEIPT_STALE",
	"APPROVAL_RECEIPT_EXPIRED",
	"APPROVAL_RECEIPT_CONSUMED",
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
	"INVALID_DELEGATION_CONTRACT",
	"RETURN_ENVELOPE_INVALID",
	"RETURN_CONTRACT_MISMATCH",
	"RETURN_ENVELOPE_INCOMPLETE",
	"RETURN_DIGEST_MISMATCH",
	"HANDOFF_POLICY_VIOLATION",
	"CHILD_PROTOCOL_ERROR",
	"CHILD_EXIT_NONZERO",
	"CHILD_ABORTED",
	"CHILD_TIMEOUT",
	"CHILD_PROVIDER_ERROR",
	"TRACE_INCOMPLETE",
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
	envelope?: DelegationReturnEnvelope;
	handoff?: DelegationHandoffEnvelope;
}

/**
 * The publishable face of an approval receipt: identifiers and status only. The
 * parameters an approval was granted for stay inside the receipt's binding
 * digest, so a receipt can be surfaced in details, traces, and the final answer
 * without leaking the task text or contract it authorized. Receipt mechanics
 * live in approval.ts.
 */
export interface ApprovalReceiptSummary {
	receiptId: string;
	action: string;
	approvedBy: string;
	issuedAt: string;
	expiresAt: string | null;
	status: "issued" | "consumed";
	consumedBy: string | null;
	/** `unverified` means the receipt's own integrity digest did not match — the audit line says so rather than repeating its claims as fact. */
	validation: "typed" | "legacy-compatibility" | "unverified";
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
		handoffPolicyDefault: HandoffPolicy;
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
	trace?: FlowTraceLink;
	/** Approval receipts this run issued or spent. Identifiers and status only — the approved parameters stay inside the binding digest. */
	approvals?: ApprovalReceiptSummary[];
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
	contract?: DelegationContract;
}

export interface DelegationContract {
	objective: string;
	constraints: string[];
	nonGoals: string[];
	dependencies: string[];
	authority: {
		may: string[];
		mustNot: string[];
		requiresApproval: string[];
	};
	sideEffectClass: "none" | "read-only" | "reversible" | "irreversible";
	budget: {
		timeoutMs?: number;
		maxCostUsd?: number;
		maxTokens?: number;
		maxGeneratedTokens?: number;
	};
	acceptanceChecks: string[];
	returnSchema: Record<string, unknown>;
	owner: string;
}

export interface DelegationReturnEnvelope {
	schemaVersion: "pi-flows.return-envelope.v1";
	contractId?: string;
	status: "completed" | "partial" | "blocked" | "failed";
	summary: string;
	evidence: Array<{ claim: string; source: string }>;
	artifactReferences: Array<{ path: string }>;
	digests: Array<{ artifact: string; algorithm: "sha256"; value: string }>;
	changedState: string[];
	unresolvedQuestions: string[];
	retry: { retryable: boolean; reason?: string; afterMs?: number };
	data: unknown;
	usage?: UsageStats;
}

export interface FlowAgentRefInput {
	agent: string;
	model?: string;
	tier?: string;
	tools?: string;
	cwd?: string;
	contract?: DelegationContract;
}

export type IncompleteHandoffPolicy = "fail" | "include";

export interface DelegationHandoffEnvelope {
	schemaVersion: "pi-flows.handoff-envelope.v1";
	contractId: string | null;
	compatibility: "typed" | "legacy-prose";
	status: "completed" | "partial" | "blocked" | "failed";
	summary: string;
	evidence: Array<{ claim: string; source: string }>;
	artifactReferences: Array<{ path: string }>;
	digests: Array<{ artifact: string; algorithm: "sha256"; value: string }>;
	changedState: string[];
	unresolvedQuestions: string[];
	retry: { retryable: boolean; reason?: string; afterMs?: number };
	data: unknown;
	provenance: {
		agent: string;
		step?: number;
	};
	usage?: UsageStats;
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

/** Everything the sink needs beyond the run itself to place and describe a child span. */
export interface ChildSpanContext {
	scope?: ChildSpanScope;
	attributes?: Record<string, unknown>;
}

/** Records one completed child run as a trace span. See makeTraceSink. */
export type RecordSpan = (result: FlowRunResult, span?: ChildSpanContext) => void;

export function budgetExceeded(budget: FlowBudget | undefined): boolean {
	if (activeBudgetExceeded(budget)) return true;
	if (!budget) return false;
	if (budget.maxTokens !== undefined && budget.spentTokens >= budget.maxTokens) return true;
	return false;
}

export function activeBudgetExceeded(budget: FlowBudget | undefined): boolean {
	if (!budget) return false;
	if (budget.maxCostUsd !== undefined && budget.spentCost >= budget.maxCostUsd) return true;
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
	const costLimit = budget.maxCostUsd;
	const generatedLimit = budget.maxGeneratedTokens;
	const totalLimit = budget.maxTokens;
	const costExceeded = costLimit !== undefined && budget.spentCost >= costLimit;
	const generatedExceeded = generatedLimit !== undefined && budget.spentGeneratedTokens >= generatedLimit;
	const totalExceeded = totalLimit !== undefined && budget.spentTokens >= totalLimit;
	const spent = costExceeded
		? `$${budget.spentCost.toFixed(4)} of $${costLimit.toFixed(4)}`
		: generatedExceeded
			? `${budget.spentGeneratedTokens} of ${generatedLimit} generated tokens`
			: totalExceeded
				? `${budget.spentTokens} of ${totalLimit} total tokens`
				: "configured ceiling (usage unavailable)";
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
	captureRawOutput?: boolean;
	contractBudget?: FlowBudget;
	/** The typed contract this child was dispatched under, for trace identity attributes. */
	contract?: DelegationContract;
	/** The call's `why` — the delegation reason recorded alongside the child span. */
	delegationReason?: string;
	/** Where this child sits in the span tree: enclosing stage, own key, dependency links. */
	scope?: ChildSpanScope;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: Update;
	budget?: FlowBudget;
	recordSpan?: RecordSpan;
	recordEvent?: RecordEvent;
	makeDetails: (results: FlowRunResult[]) => FlowDetails;
}

export type RunChild = (options: RunChildOptions) => Promise<FlowRunResult>;

export interface ModeDeps {
	params: any;
	discovery: FlowDiscovery;
	policy: CapturePolicy;
	/** Flow-scoped injection policy and bounded cross-handoff detection state. */
	handoffGuard: HandoffGuard;
	agentScope: AgentScope;
	defaultCwd: string;
	signal?: AbortSignal;
	onUpdate?: Update;
	budget?: FlowBudget;
	recordSpan?: RecordSpan;
	/** Attribute a coordination boundary (artifact, state, retry, approval, budget, validation, handoff) to the trace. */
	recordEvent?: RecordEvent;
	requestApproval?: (title: string, message: string) => Promise<"approved" | "required" | "denied">;
	/** Audit label recorded as the approving actor on an approval receipt. An attribution label for the audit trail, not an authenticated identity. */
	approvalActor?: string;
	makeDetails: (mode: FlowMode, agents?: FlowAgent[]) => (results: FlowRunResult[], error?: FlowError) => FlowDetails;
	/** The child-run seam. Handlers reach it via the runner helpers (runAgentRef/runAgentFanout), which execute every child through this — so tests can inject an in-process fake. */
	runChild: RunChild;
	/** Fan-out concurrency, validated and defaulted by the dispatch core — handlers never re-derive it. */
	concurrency: number;
}

export type ModeOutput = { content: Array<{ type: "text"; text: string }>; details: FlowDetails };
export type ModeHandler = (deps: ModeDeps) => Promise<ModeOutput>;
