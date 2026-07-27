// Shared helpers for the eval runners — the single-arm harness (run.mjs) and the
// flows-vs-plain A/B (compare.mjs). Kept here so both build the flow tool the same
// way and compute the deterministic objective labels that thulr calibrates against.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import registerPiFlows from "../extensions/pi-flows/index.ts";

export const answerText = (r) => r?.content?.[0]?.text ?? "";
export function answerWithArtifacts(answer, cwd, artifactPaths = [], maxChars = 50_000) {
	let combined = String(answer ?? "");
	const root = resolve(cwd);
	for (const artifactPath of artifactPaths) {
		const target = resolve(root, artifactPath);
		if (target !== root && !target.startsWith(`${root}${sep}`)) continue;
		if (!existsSync(target)) {
			combined += `\n\n## Produced artifact: ${artifactPath}\n\n[missing]`;
			continue;
		}
		const remaining = maxChars - combined.length;
		if (remaining <= 0) break;
		const content = readFileSync(target, "utf8");
		combined += `\n\n## Produced artifact: ${artifactPath}\n\n${content.slice(0, remaining)}`;
	}
	return combined.slice(0, maxChars);
}
export const sumCost = (r) => (r?.details?.results ?? []).reduce((acc, x) => acc + (x?.usage?.cost ?? 0), 0);
export function sumTokenUsage(r) {
	const results = r?.details?.results ?? [];
	const usage = results.reduce((acc, item) => {
		acc.input += item?.usage?.input ?? 0;
		acc.output += item?.usage?.output ?? 0;
		acc.cacheRead += item?.usage?.cacheRead ?? 0;
		acc.cacheWrite += item?.usage?.cacheWrite ?? 0;
		return acc;
	}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	return {
		...usage,
		total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		known: results.length > 0 && results.every((item) => Number.isFinite(item?.usage?.input) && Number.isFinite(item?.usage?.output)),
	};
}
export const sumTokens = (r) => sumTokenUsage(r).total;
export const subjectModelName = (r, fallback) => {
	const models = new Set((r?.details?.results ?? []).map((x) => x?.model).filter(Boolean));
	if (models.size === 1) return [...models][0];
	if (models.size > 1) return [...models].sort().join(",");
	return fallback;
};

export function armBudgetSignal(parentSignal, timeoutMs) {
	const controller = new AbortController();
	let timedOut = false;
	const onParentAbort = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) onParentAbort();
	else parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
	const timer = timeoutMs > 0
		? setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`arm timed out after ${timeoutMs}ms`));
		}, timeoutMs)
		: null;
	timer?.unref?.();
	return {
		signal: controller.signal,
		get timedOut() { return timedOut; },
		dispose() {
			if (timer) clearTimeout(timer);
			parentSignal?.removeEventListener?.("abort", onParentAbort);
		},
	};
}

// Default subject model for the eval suite. The harness standardizes on the
// CHEAPEST model pi's codex provider exposes (gpt-5.4-mini: $0.75/M in, $4.50/M out
// — vs $1.75/$14 for codex-spark, $5/$30 for gpt-5.5), NOT the pi default, so the
// baseline is reproducible, runs stay cheap, and the flows-vs-plain A/B shows the
// extension's lift — a frontier model aces plain pi and hides it. An exact model ID
// (not a fuzzy pattern like "codex") so pi can't silently resolve it elsewhere.
// Override per-run with --model=<provider/id> or PI_FLOWS_EVAL_MODEL.
export const DEFAULT_EVAL_MODEL = process.env.PI_FLOWS_EVAL_MODEL ?? "openai-codex/gpt-5.4-mini";

export function timeoutPlanForCase(testCase, { defaultTimeoutMs, armTimeoutMs = null } = {}) {
	const caseTimeoutMs = testCase?.params?.timeoutMs ?? defaultTimeoutMs;
	const hasArmTimeout = armTimeoutMs !== null && armTimeoutMs !== undefined;
	const effectiveTimeoutMs = hasArmTimeout ? armTimeoutMs : caseTimeoutMs;
	return {
		caseTimeoutMs,
		effectiveTimeoutMs,
		armTimeoutMs: hasArmTimeout ? armTimeoutMs : null,
		debugBudget: hasArmTimeout,
	};
}

export function shouldJudgeProductSpans({ dryRun = false, traceOnly = false, productSpans = 0 } = {}) {
	return !dryRun && !traceOnly && productSpans > 0;
}

export function exclusionForRun({ reachedModel, timeoutPlan }) {
	if (timeoutPlan?.debugBudget && (!reachedModel || /timeout|timed out/i.test(String(reachedModel)))) {
		return {
			reason: "debug_budget",
			detail: `arm-timeout ${timeoutPlan.effectiveTimeoutMs}ms is a smoke/debug override; case budget ${timeoutPlan.caseTimeoutMs}ms`,
		};
	}
	if (reachedModel) return { reason: "infra", detail: reachedModel };
	return null;
}

// pi's configured default, e.g. "openai-codex/gpt-5.5" — used when no --model is given.
export function piDefaultModel() {
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
		if (settings.defaultProvider && settings.defaultModel) return `${settings.defaultProvider}/${settings.defaultModel}`;
		return settings.defaultModel ?? null;
	} catch {
		return null;
	}
}

// Working directory for a case. `workspace: true` cases get a FRESH temp dir per arm
// so an agent can write/run files in isolation (e.g. the evaluate code-gen gate);
// otherwise the case's static cwd, or the repo root. Skipped under dry-run.
export function caseCwd(testCase, { dryRun = false, arm = "flows" } = {}) {
	if (!testCase.workspace) return testCase.cwd ?? process.cwd();
	if (dryRun) return process.cwd();
	const cwd = mkdtempSync(join(tmpdir(), "pi-eval-ws-"));
	testCase.setupWorkspace?.(cwd, { arm });
	return cwd;
}

export function caseWorkspace(testCase, { dryRun = false, arm = "flows", isolate = false } = {}) {
	if (!isolate || dryRun) return { cwd: caseCwd(testCase, { dryRun, arm }), dispose() {} };
	const cwd = mkdtempSync(join(tmpdir(), "pi-eval-trial-"));
	try {
		if (testCase.workspace) {
			testCase.setupWorkspace?.(cwd, { arm });
		} else if (testCase.cwd) {
			for (const entry of readdirSync(testCase.cwd)) cpSync(join(testCase.cwd, entry), join(cwd, entry), { recursive: true });
		}
	} catch (error) {
		rmSync(cwd, { recursive: true, force: true });
		throw error;
	}
	return {
		cwd,
		dispose() {
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

// Build the `flow` tool from the extension. Zeroing argv[1] makes the extension's
// getPiInvocation resolve a real `pi` from PATH instead of re-running this script.
export function flowTool() {
	process.argv[1] = "";
	const tools = new Map();
	registerPiFlows({ registerCommand() {}, registerShortcut() {}, registerTool(tool) { tools.set(tool.name, tool); } });
	return tools.get("flow");
}

const PROVIDER_CONTEXT = String.raw`(?:provider|model|judge|anthropic|openai|codex|claude)`;
const AUTH_PROBLEM = String.raw`(?:authentication[_ -]?error|authentication (?:failed|required)|auth (?:failed|required))`;
const providerAuthError = new RegExp(String.raw`(?:${PROVIDER_CONTEXT}[^\n]{0,80}${AUTH_PROBLEM}|${AUTH_PROBLEM}[^\n]{0,80}${PROVIDER_CONTEXT}|^\s*(?:error:\s*)?${AUTH_PROBLEM}\.?\s*$)`, "i");
const providerApiKeyError = new RegExp(String.raw`(?:${PROVIDER_CONTEXT}[^\n]{0,80}api[_ -]?key[^\n]{0,40}(?:missing|required|invalid|not found)|api[_ -]?key[^\n]{0,40}(?:missing|required|invalid|not found)[^\n]{0,80}${PROVIDER_CONTEXT})`, "i");
const QUALITY_FLOW_ERROR_CODES = new Set([
	"BUDGET_EXCEEDED",
	"BUDGET_UNOBSERVABLE",
	"CHECK_COMMAND_FAILED",
	"ORCHESTRATE_VERIFY_FAILED",
	"ROUTE_UNRESOLVED",
	"ORCHESTRATE_NO_SUBTASKS",
	"LOOP_DID_NOT_CONVERGE",
	"SEARCH_NO_CANDIDATES",
	"WORKFLOW_GATE_FAILED",
	"WORKTREE_INTEGRATION_FAILED",
	"WORKTREE_VERIFY_FAILED",
	"DOSSIER_TOO_FEW_SECTIONS",
	"MONITOR_NOT_TRIGGERED",
]);

// Distinguish "couldn't reach the model" (auth/credits/network/timeout) from "ran
// but scored low". Returns a short reason string, or null. Works for both a flow
// result and a plain-pi result (both carry details.results child records).
export function infraError(result) {
	if (result?.details?.error && !QUALITY_FLOW_ERROR_CODES.has(result.details.error.code)) {
		return result.details.error.message ?? String(result.details.error.code ?? "flow error");
	}
	const children = result?.details?.results ?? [];
	for (const child of children) {
		const qualityError = child?.error?.code && QUALITY_FLOW_ERROR_CODES.has(child.error.code);
		if (child?.error && !qualityError) return [child.error.code, child.error.message, child.error.cause].filter(Boolean).join(": ") || "child error";
		if (qualityError) continue;
		if ((typeof child?.exitCode === "number" && child.exitCode !== 0) || child?.stopReason === "error" || child?.stopReason === "timeout") {
			return child?.errorMessage ?? `child ${child.stopReason ?? "exited with error"}`;
		}
	}
	if (children.length > 0) return null;
	const text = result?.content?.[0]?.text ?? "";
	if (/"type":\s*"error"|invalid_request_error|out of (extra )?usage|rate.?limit|\b40[13]\b|provider failed/i.test(text) || providerAuthError.test(text) || providerApiKeyError.test(text)) return "provider/API error";
	return null;
}

// Objective-only scoring: the deterministic behaviour check, plus whether the run
// reached the model and what it cost. The quality axis is thulr, which grades the
// emitted answer and calibrates against the objective label this returns.
export async function scoreObjective({ result, thrown, testCase, ctx }) {
	let objective;
	if (thrown) {
		objective = { pass: false, score: 0, notes: `run threw: ${thrown.message}` };
	} else {
		try {
			objective = await testCase.score(result, ctx);
		} catch (error) {
			objective = { pass: false, score: 0, notes: `scorer threw: ${error.message}` };
		}
	}
	const reachedModel = thrown ? thrown.message : (infraError(result) ?? null);
	if (reachedModel) {
		objective = { pass: false, score: 0, inconclusive: true, notes: `infra exclusion: ${reachedModel}; scorer notes: ${objective.notes ?? "n/a"}` };
	}
	return { objective, reachedModel, cost: sumCost(result), answer: answerText(result) };
}
