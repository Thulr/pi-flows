import type { Message } from "@earendil-works/pi-ai";
import type { Budget, BudgetAuthority } from "./budget.ts";
import type { ChildSpanScope, FlowTraceContext, FlowTraceLink, RecordEvent } from "./trace-scope.ts";
import type { HandoffGuard } from "./handoff-types.ts";
import type { HandoffConsumer } from "./handoff-consumption.ts";
import type { ModelRoster, ThinkingLevel } from "./roster-types.ts";
import type { FlowPreset, FlowPresetSelection } from "./preset-types.ts";

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
export type { FlowPreset, FlowPresetDiscovery, FlowPresetDiscoveryIssue, FlowPresetSelection, PresetSource } from "./preset-types.ts";
// Model-selection vocabulary, same arrangement: the terms live in a
// dependency-free module and the policy that produces a roster lives in
// model-roster.ts, which the kernel may not import.
export { ROSTER_CONFIG_FILE, THINKING_LEVELS, USE_DEFAULT_MODEL } from "./roster-types.ts";
export type { AvailableModel, ModelRoster, RosterAssignment, RosterConfig, RosterLayer, RosterOverride, ThinkingLevel } from "./roster-types.ts";

export const PI_FLOWS_VERSION = "0.6.0";

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
	"UNKNOWN_PRESET",
	"PRESET_TASK_REQUIRED",
	"PRESET_OVERRIDE_INVALID",
	"PRESET_EXPANSION_INVALID",
	"PROJECT_PRESET_APPROVAL_REQUIRED",
	"PROJECT_PRESET_APPROVAL_DENIED",
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
	/** Exact configured ceiling that bound a BUDGET_EXCEEDED result. */
	budgetCeiling?: BudgetCeiling;
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
	thinking?: ThinkingLevel;
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
	/** The topology slot this run filled; distinct from the selected agent profile. */
	role?: string;
	agentSource: AgentSource | "unknown";
	/** Redacted task preview for diagnostics. The raw task is passed by temp file, never argv/details. */
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	/**
	 * The level passed to the child on `--thinking`, lowered to its model's limits
	 * when that model is known. Undefined when no level was named anywhere.
	 *
	 * Not always the level it *ran* at: a child naming no model loads pi's
	 * configured default, which this extension cannot read, so pi may lower this
	 * further. `flow.thinking_level_verified` on the span says which case applies.
	 */
	thinking?: ThinkingLevel;
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
 * One configured cost/token ceiling, paired with the authority that owns it, for
 * disclosure in compact UI surfaces. Not `BudgetCeilings` (budget.ts), which is
 * the unlabelled *set* of ceilings a budget is constructed with and enforces.
 */
export interface BudgetCeiling {
	authority: BudgetAuthority;
	maxCostUsd?: number;
	maxTokens?: number;
	maxGeneratedTokens?: number;
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
	presetsDir?: {
		package: string;
		user: string;
		project: string | null;
	};
	preset?: FlowPresetSelection;
	presetOutcome?: "CLEAN" | "FINDINGS" | "PARTIAL";
	presets?: Array<Pick<FlowPreset, "name" | "description" | "source" | "filePath" | "overrides" | "result">>;
	results: FlowRunResult[];
	agents?: Array<Pick<FlowAgent, "name" | "description" | "source" | "filePath" | "model" | "tier" | "thinking" | "tools">>;
	discoveryIssues?: DiscoveryIssue[];
	error?: FlowError;
	trace?: FlowTraceLink;
	/** Static configured ceilings, including nested delegation-contract budgets. */
	budgetCeilings?: BudgetCeiling[];
	/** Approval receipts this run issued or spent. Identifiers and status only — the approved parameters stay inside the binding digest. */
	approvals?: ApprovalReceiptSummary[];
}

export interface FlowTaskInput {
	agent: string;
	role?: string;
	task: string;
	cwd?: string;
	model?: string;
	tier?: string;
	thinking?: ThinkingLevel;
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
	role?: string;
	model?: string;
	tier?: string;
	thinking?: ThinkingLevel;
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
 * Budgets are objects, not records: a ceiling is fixed at construction, spend
 * moves only through `charge`, and each budget knows its own authority. Build
 * one with `Budget.forFlow` or `Budget.forContract` — see budget.ts.
 */
export { Budget } from "./budget.ts";
export type { BudgetAuthority, BudgetCeilings, BudgetSnapshot } from "./budget.ts";

/** Everything the sink needs beyond the run itself to place and describe a child span. */
export interface ChildSpanContext {
	scope?: ChildSpanScope;
	attributes?: Record<string, unknown>;
}

/** Records one completed child run as a trace span. See makeTraceSink. */
export type RecordSpan = (result: FlowRunResult, span?: ChildSpanContext) => void;

export function flowError(code: FlowErrorCode, message: string, cause: string, fix: string, retryable = false): FlowError {
	return { code, message, cause, fix, retryable };
}

export function formatFlowError(error: FlowError): string {
	return [`${error.message}`, `Cause: ${error.cause}`, `Retryable unchanged: ${error.retryable === true ? "yes" : "no"}`, `Fix: ${error.fix}`, `Code: ${error.code}`].join("\n");
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
	role?: string;
	task: string;
	cwd?: string;
	model?: string;
	tier?: string;
	thinking?: ThinkingLevel;
	/** The flow-wide `thinking` fallback, kept apart from the role's own so specificity survives to resolution. */
	flowThinking?: ThinkingLevel;
	/** The resolved per-install roster a tier is read against. Omitted only where no pi runtime supplied one. */
	roster?: ModelRoster;
	tools?: string;
	timeoutMs?: number;
	recordContent?: boolean;
	redactSecrets?: boolean;
	captureRawOutput?: boolean;
	contractBudget?: Budget;
	/** The delegation contract this child was dispatched under, for trace identity attributes. */
	contract?: DelegationContract;
	/** The call's `why` — the delegation reason recorded alongside the child span. */
	delegationReason?: string;
	/** Where this child sits in the span tree: enclosing stage, own key, dependency links. */
	scope?: ChildSpanScope;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: Update;
	budget?: Budget;
	recordSpan?: RecordSpan;
	recordEvent?: RecordEvent;
	makeDetails: (results: FlowRunResult[]) => FlowDetails;
}

export type RunChild = (options: RunChildOptions) => Promise<FlowRunResult>;

export interface ModeDeps {
	params: any;
	discovery: FlowDiscovery;
	policy: CapturePolicy;
	/** Deep Handoff-consumption module: validation, preparation, policy, evidence, and warning locality. */
	handoffs: HandoffConsumer;
	agentScope: AgentScope;
	defaultCwd: string;
	/** What each tier resolves to for this run. Resolved once at the composition root, where the pi model registry is reachable. */
	roster?: ModelRoster;
	signal?: AbortSignal;
	onUpdate?: Update;
	budget?: Budget;
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
