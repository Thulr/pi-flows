// Shared helpers for the eval runners — the single-arm harness (run.mjs) and the
// flows-vs-plain A/B (compare.mjs). Kept here so both build the flow tool the same
// way and score every case through the identical two-axis path.
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import { judge } from "./judge.mjs";

export const answerText = (r) => r?.content?.[0]?.text ?? "";
export const sumCost = (r) => (r?.details?.results ?? []).reduce((acc, x) => acc + (x?.usage?.cost ?? 0), 0);
export const sumTokens = (r) => (r?.details?.results ?? []).reduce((acc, x) => acc + (x?.usage?.input ?? 0) + (x?.usage?.output ?? 0), 0);

// Default subject model for the eval suite. The harness standardizes on the
// CHEAPEST model pi's codex provider exposes (gpt-5.4-mini: $0.75/M in, $4.50/M out
// — vs $1.75/$14 for codex-spark, $5/$30 for gpt-5.5), NOT the pi default, so the
// baseline is reproducible, runs stay cheap, and the flows-vs-plain A/B shows the
// extension's lift — a frontier model aces plain pi and hides it. An exact model ID
// (not a fuzzy pattern like "codex") so pi can't silently resolve it elsewhere.
// Override per-run with --model=<provider/id> or PI_FLOWS_EVAL_MODEL.
export const DEFAULT_EVAL_MODEL = process.env.PI_FLOWS_EVAL_MODEL ?? "openai-codex/gpt-5.4-mini";

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
export function caseCwd(testCase, { dryRun = false } = {}) {
	if (testCase.workspace) return dryRun ? process.cwd() : mkdtempSync(join(tmpdir(), "pi-eval-ws-"));
	return testCase.cwd ?? process.cwd();
}

// Build the `flow` tool from the extension. Zeroing argv[1] makes the extension's
// getPiInvocation resolve a real `pi` from PATH instead of re-running this script.
export function flowTool() {
	process.argv[1] = "";
	const tools = new Map();
	registerPiFlows({ registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
	return tools.get("flow");
}

// Distinguish "couldn't reach the model" (auth/credits/network/timeout) from "ran
// but scored low". Returns a short reason string, or null. Works for both a flow
// result and a plain-pi result (both carry details.results child records).
export function infraError(result) {
	if (result?.details?.error) return result.details.error.message ?? String(result.details.error.code ?? "flow error");
	for (const child of result?.details?.results ?? []) {
		if (child?.error) return child.error.message ?? "child error";
		if ((typeof child?.exitCode === "number" && child.exitCode !== 0) || child?.stopReason === "error" || child?.stopReason === "timeout") {
			return child?.errorMessage ?? `child ${child.stopReason ?? "exited with error"}`;
		}
	}
	const text = result?.content?.[0]?.text ?? "";
	if (/"type":\s*"error"|invalid_request_error|authentication|out of (extra )?usage|rate.?limit|\b40[13]\b|api[_ -]?key/i.test(text)) return "provider/API error";
	return null;
}

// Objective-only scoring: the deterministic behaviour check, plus whether the run
// reached the model and what it cost. run.mjs uses this — the quality axis is no
// longer an in-process LLM judge but thulr, which grades the emitted answer and
// calibrates against the objectiveScore this returns. compare.mjs still uses the
// two-axis scoreArm below so its flows-vs-plain arms are graded identically.
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
	return { objective, reachedModel, cost: sumCost(result), answer: answerText(result) };
}

// Score one arm's result on two independent axes — objective (deterministic) and
// the cross-model LLM judge — and combine. A case passes only when both agree. Used
// identically by run.mjs and compare.mjs so flows and plain arms are graded the same.
export async function scoreArm({ result, thrown, testCase, ctx, judgeCtx }) {
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

	let judged = { pass: true, score: 1, reasoning: "(no criterion)", cost: 0, infra: null };
	if (!thrown && testCase.criterion) {
		try {
			judged = await judge(judgeCtx, { criteria: testCase.criterion, answer: answerText(result) });
		} catch (error) {
			judged = { pass: false, score: 0, reasoning: `judge threw: ${error.message}`, cost: 0, infra: `judge threw: ${error.message}` };
		}
	}

	const pass = objective.pass && judged.pass;
	const score = Math.min(objective.score ?? 0, judged.score ?? 0);
	const reachedModel = thrown ? thrown.message : (infraError(result) ?? judged.infra ?? null);
	const cost = sumCost(result) + (judged.cost ?? 0);
	return { pass, score, objective, judged, reachedModel, cost };
}
