// Tool-selection eval for pi-flows. Unlike evals/run.mjs, this does not invoke
// the flow tool directly. It loads the extension into headless pi and checks
// whether the parent model chose `flow` for the prompt. Prompts are written to
// stdin so the eval sees a normal user message without putting raw task text in
// process argv or turning it into an @file attachment.
//
//   npm run eval:select
//   npm run eval:select -- --filter=no-flow
//   npm run eval:select -- --model=openai-codex/gpt-5.4-mini --timeout=60000
//   npm run eval:select -- --dry-run
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { corpusPreflightStep, formatPortfolioReport, portfolioReport } from "./case-contract.mjs";
import { createFlagReader } from "./cli-flags.mjs";
import { EVAL_CORPUS, SELECTION_CASES } from "./corpus.mjs";
import { DEFAULT_EVAL_MODEL } from "./lib.mjs";
import { loadDotenv, runPreflight } from "./preflight.mjs";
import { runJsonlProcess } from "../extensions/pi-flows/jsonl-child.mjs";
// select-scoring.mjs imports the extension's .ts predicates, so this module
// still requires the tsx loader (`node --import tsx`); do not import it from
// a bare-node script such as eval:review or eval:pareto.
import { callAdmissibilityFailure, hasUsefulArguments, parseToolArguments, scoreSelection, selectionExitCode } from "./select-scoring.mjs";

export { callAdmissibilityFailure, flowCallMatchesExpectation, scoreSelection, selectionExitCode } from "./select-scoring.mjs";

process.env.PI_FLOWS_CHILD_NO_EXTENSIONS = "1";

loadDotenv();

const { flag, bool } = createFlagReader(process.argv.slice(2));

const model = flag("model", process.env.PI_FLOWS_EVAL_MODEL ?? DEFAULT_EVAL_MODEL);
const useDefaultModel = ["agent", "default", ""].includes(model);
const timeoutMs = Number(flag("timeout", process.env.PI_FLOWS_TIMEOUT_MS ?? "90000"));
const filter = flag("filter", "");
const dryRun = bool("dry-run");
let admissibility = { knownSubjectModels: [] };

/** Exact references from pi's human-readable available-model table. */
export function modelReferencesFromList(output) {
	return [...new Set(String(output).split(/\r?\n/).flatMap((line) => {
		const fields = line.trim().split(/\s+/);
		const [provider, modelId] = fields;
		return fields.length >= 6 && provider !== "provider" && /^[a-z0-9._-]+$/i.test(provider ?? "") && modelId ? [`${provider}/${modelId}`] : [];
	}))];
}

export function flowCallIdsFromMessage(message) {
	return flowCallsFromMessage(message).map((call) => call.id);
}

export function flowCallsFromMessage(message) {
	const calls = [];
	for (const part of message?.content ?? []) {
		if (part?.type === "toolCall" && part.name === "flow") {
			calls.push({
				id: part.id ?? `flow-call-${calls.length}`,
				arguments: parseToolArguments(part.arguments ?? part.input ?? part.args),
			});
		}
	}
	return calls;
}

function argumentCompleteness(args) {
	if (!hasUsefulArguments(args)) return 0;
	return JSON.stringify(args).length;
}

function recordFlowCall(state, call) {
	const existingIndex = state.flowCalls.findIndex((existing) => existing.id === call.id);
	if (existingIndex === -1) {
		state.flowCallIds.add(call.id);
		state.flowCalls.push(call);
		return;
	}
	if (argumentCompleteness(call.arguments) > argumentCompleteness(state.flowCalls[existingIndex].arguments)) {
		state.flowCalls[existingIndex] = call;
	}
}

function textFromMessage(message) {
	return (message?.content ?? [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

export function collectSelectionEvent(line, state) {
	if (!line.trim()) return;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		state.parseErrors += 1;
		state.stdoutSample = `${state.stdoutSample}${line}\n`.slice(-4096);
		return;
	}
	if (event.type === "tool_execution_start" && event.toolName === "flow") {
		const args = parseToolArguments(event.args);
		recordFlowCall(state, { id: event.toolCallId ?? `flow-call-${state.flowCalls.length}`, arguments: args });
		state.flowExecutionStarted = true;
		(state.flowExecutions ??= []).push(args);
	}
	const messages = [];
	if (event.message) messages.push(event.message);
	if (event.type === "agent_end") messages.push(...(event.messages ?? []));
	for (const message of messages) {
		for (const call of flowCallsFromMessage(message)) {
			recordFlowCall(state, call);
		}
		if (event.type === "message_end" && message.role === "assistant") {
			const text = textFromMessage(message);
			if (text) state.answer = text;
			const usage = message.usage;
			if (usage) {
				state.usage.input += usage.input || 0;
				state.usage.output += usage.output || 0;
				state.usage.cacheRead += usage.cacheRead || 0;
				state.usage.cacheWrite += usage.cacheWrite || 0;
				state.usage.cost += usage.cost?.total || 0;
			}
		}
	}
}

function emptyState() {
	return {
		flowCallIds: new Set(),
		flowCalls: [],
		flowExecutions: [],
		flowExecutionStarted: false,
		stoppedAfterFlowCall: false,
		answer: "",
		parseErrors: 0,
		stdoutSample: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
}

// A run that keeps burning refused executions stops producing selection
// signal past the budget any case would set; cap it instead of letting the
// refusal loop spend the whole case timeout. The cap must sit above the
// case's own refused-call budget — a cap at the budget would terminate the
// run with exactly budget-many refusals observed, so the budget could never
// be exceeded and a budget-only case would pass without one admitted call.
const MAX_OBSERVED_FLOW_EXECUTIONS = 5;
export function observationCap(testCase) {
	return Math.max(MAX_OBSERVED_FLOW_EXECUTIONS, (testCase.maxRefusedCalls ?? 0) + 2);
}

// A call the scored admissibility vocabulary flags as refused may play out —
// that refusal returns before any child spawns, and what the model does next
// is exactly what the sequence predicates score. Everything else terminates
// before it can act: admitted calls, unparseable args, pre-dispatch refusals
// the vocabulary cannot name (a failed preset resolution, say), and refusals
// that would still write — the extension creates and finalizes a trace sink
// at a caller-controlled traceFile even for refused calls, so a refusal
// carrying one could append spans to any writable path. The cap stops
// runaway refusal loops.
// Only refusals that provably precede all work may play out: the dispatch
// core's own gates (returned before any handler runs) and the entry guards
// of the fan-out handlers (checked before those handlers act). Runner-level
// refusals (UNKNOWN_AGENT, BUDGET_EXCEEDED) precede all work only in
// stateless modes: monitor runs its probe command, workflow persists its
// state file, and worktree creates branches before the runner's gates — and
// a raw preset reference hides its expanded shape from this layer — so for
// those the refusal terminates like an admitted call.
const PLAYOUT_SAFE_CODES = new Set([
	"INVALID_MODE", "WHY_REQUIRED", "FLOW_DEPTH_EXCEEDED", "INVALID_CONCURRENCY",
	"TRACE_INCOMPLETE", "CHECKPOINT_APPROVAL_REQUIRED", "TOO_MANY_TASKS", "PARALLEL_SIZING_REQUIRED", "SHARED_WRITE_CWD",
	"GRAPH_CYCLE", "PRESET_EXPANSION_INVALID", "PRESET_TASK_REQUIRED", "MONITOR_INVALID",
	"WORKFLOW_INVALID", "SCHEMA_INVALID", "INVALID_DELEGATION_CONTRACT",
]);

// Runner-level refusals precede all work only when nothing acts before the
// runner; any code in neither set — including one a future vocabulary
// extension forgets to classify — terminates, never plays out.
const RUNNER_LEVEL_CODES = new Set(["UNKNOWN_AGENT", "BUDGET_EXCEEDED"]);

function actsBeforeRunner(args) {
	return args?.monitor !== undefined || args?.workflow !== undefined || args?.worktree !== undefined
		|| Boolean(typeof args?.preset === "string" && args.preset);
}

export function letRefusalPlayOut(args, observedCount, testCase, context = {}) {
	if (!hasUsefulArguments(args)) return false;
	const refusal = callAdmissibilityFailure(args, context);
	if (!refusal) return false;
	if (!PLAYOUT_SAFE_CODES.has(refusal.code)) {
		if (!RUNNER_LEVEL_CODES.has(refusal.code)) return false;
		if (actsBeforeRunner(args)) return false;
	}
	// The sink path is params.traceFile ?? PI_FLOWS_TRACE_FILE in the
	// extension, and the spawned subject inherits this process's environment
	// (loadDotenv included) — either source makes the refusal a writer. So
	// does reflexion: a runner-level refusal produces a FAILED RESULT, which
	// counts as a run, and appendReflexion then writes to the caller-named
	// reflexion file.
	if (args?.traceFile || process.env.PI_FLOWS_TRACE_FILE) return false;
	if (args?.reflexion) return false;
	return observedCount < observationCap(testCase);
}

async function runSelectionCase(testCase, signal) {
	if (dryRun) {
		return {
			flowCalls: testCase.mock.flowCalls,
			flowCallArgs: testCase.mock.flowCallArgs ?? [],
			answer: testCase.mock.answer,
			exitCode: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		};
	}

	const state = emptyState();
	const caseTimeoutMs = Number(testCase.timeoutMs ?? timeoutMs);
	const piArgs = ["--mode", "json", "-p", "--no-session", "--no-context-files", "--no-extensions", "-e", "./extensions/pi-flows/index.ts"];
	if (!useDefaultModel) piArgs.push("--model", model);

	let stderr = "";
	const run = await runJsonlProcess({
		command: "pi",
		args: piArgs,
		cwd: process.cwd(),
		timeoutMs: caseTimeoutMs,
		signal,
		stdin: `${testCase.task}\n`,
		onLine: (line, controls) => {
			collectSelectionEvent(line, state);
			if (!testCase.expectFlow || state.stoppedAfterFlowCall || !state.flowExecutionStarted) return;
			if (letRefusalPlayOut(state.flowExecutions.at(-1), state.flowExecutions.length, testCase, admissibility)) return;
			state.stoppedAfterFlowCall = true;
			controls.terminate();
		},
		onStderr: (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); },
	});
	const timedOut = run.timedOut;
	if (timedOut) stderr = `${stderr}\nselection eval timed out after ${caseTimeoutMs}ms`;
	if (run.spawnErrorMessage) state.error = run.spawnErrorMessage;
	if (stderr.trim()) state.stderr = stderr.trim();
	const exitCode = run.exitCode;

	const error = exitCode === 0 || state.stoppedAfterFlowCall ? null : (state.stderr || state.stdoutSample || `pi exited ${exitCode}`);
	return {
		flowCalls: state.flowCallIds.size,
		flowCallArgs: state.flowCalls.map((call) => call.arguments),
		answer: state.answer,
		exitCode,
		error,
		timedOut,
		inconclusive: timedOut,
		timeoutMs: caseTimeoutMs,
		parseErrors: state.parseErrors,
		stoppedAfterFlowCall: state.stoppedAfterFlowCall,
		usage: state.usage,
	};
}

async function preflight() {
	if (!runPreflight([corpusPreflightStep(EVAL_CORPUS)])) return null;
	if (dryRun) return [];
	return new Promise((resolve) => {
		let stdout = "";
		const proc = spawn("pi", ["--no-extensions", "--list-models"], { stdio: ["ignore", "pipe", "ignore"] });
		proc.stdout.on("data", (chunk) => { stdout += chunk; });
		proc.on("error", () => resolve(null));
		proc.on("close", (code) => resolve(code === 0 ? modelReferencesFromList(stdout) : null));
	});
}

async function main() {
	// The spawned subject inherits this, so the extension under test discovers
	// the same bundled-only roster the scorer resolves admissibility against
	// (matching eval:run). Without it, a user-level agent shadowing a bundled
	// name with a different toolset makes the scored SHARED_WRITE_CWD verdict
	// disagree with the enforced one — the harness could keep running a call
	// the real tool admits, or terminate and score one it refuses. Set here,
	// not at module top: importing this module for its helpers must not
	// mutate process.env.
	process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = "1";
	const knownSubjectModels = await preflight();
	if (knownSubjectModels === null) {
		console.error("FAIL `pi --list-models` could not provide the subject roster. Check pi/provider setup, or smoke-test with: npm run eval:select -- --dry-run");
		process.exit(2);
	}
	admissibility = { knownSubjectModels };

	const selected = SELECTION_CASES.filter((testCase) => !filter || testCase.name.includes(filter));
	if (selected.length === 0) {
		console.error(`No selection cases match --filter=${filter}. Available: ${SELECTION_CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const signal = new AbortController().signal;
	console.log(`pi-flows selection evals - subject ${useDefaultModel ? "(pi default)" : model} - fallback timeout ${Math.round(timeoutMs / 1000)}s/case${dryRun ? " - DRY RUN" : ""}\n`);
	let passed = 0;
	let failed = 0;
	let inconclusive = 0;
	let totalCost = 0;
	const excludedIds = [];
	for (const testCase of selected) {
		const startedAt = Date.now();
		const result = await runSelectionCase(testCase, signal);
		const scored = scoreSelection(testCase, result, admissibility);
		totalCost += result.usage?.cost ?? 0;
		if (scored.inconclusive) {
			inconclusive += 1;
			excludedIds.push(testCase.id);
		}
		else if (scored.pass) passed += 1;
		else failed += 1;
		const status = scored.inconclusive ? "INCONCLUSIVE" : scored.pass ? "PASS" : "FAIL";
		const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`${status} ${testCase.name.padEnd(30)} expected flow=${testCase.expectFlow} saw flow=${scored.flowUsed}  $${(result.usage?.cost ?? 0).toFixed(4)}  ${seconds}s`);
		console.log(`    -> ${scored.notes}`);
	}
	const comparable = selected.length - inconclusive;
	console.log(`\n${passed}/${comparable} comparable selection cases passed - ${inconclusive} infra exclusion(s) - total $${totalCost.toFixed(4)}`);
	console.log(formatPortfolioReport(portfolioReport(selected, { excluded: excludedIds })));
	process.exit(selectionExitCode({ failed, comparable }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`selection eval failed: ${error?.stack ?? error}`);
		process.exit(1);
	});
}
