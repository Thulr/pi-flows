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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EVAL_MODEL } from "./lib.mjs";
import { SELECTION_CASES } from "./selection-cases.mjs";

process.env.PI_FLOWS_CHILD_NO_EXTENSIONS = "1";

const dotenvPath = join(process.cwd(), ".env");
if (existsSync(dotenvPath)) {
	try { process.loadEnvFile(dotenvPath); } catch { /* ignore a malformed .env */ }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const model = flag("model", process.env.PI_FLOWS_EVAL_MODEL ?? DEFAULT_EVAL_MODEL);
const useDefaultModel = ["agent", "default", ""].includes(model);
const timeoutMs = Number(flag("timeout", process.env.PI_FLOWS_TIMEOUT_MS ?? "90000"));
const filter = flag("filter", "");
const dryRun = args.includes("--dry-run");

export function flowCallIdsFromMessage(message) {
	return flowCallsFromMessage(message).map((call) => call.id);
}

function parseToolArguments(raw) {
	if (!raw) return {};
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw);
		} catch {
			return { __unparsed: raw };
		}
	}
	if (typeof raw === "object") return raw;
	return { __raw: raw };
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

function hasUsefulArguments(args) {
	return !!args && typeof args === "object" && !args.__unparsed && !args.__raw && modeOf(args) !== "unknown";
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
		recordFlowCall(state, { id: event.toolCallId ?? `flow-call-${state.flowCalls.length}`, arguments: parseToolArguments(event.args) });
		state.flowExecutionStarted = true;
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

function values(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function modeOf(args) {
	if (args?.list) return "list";
	if (args?.showConfig) return "config";
	if (Array.isArray(args?.tasks)) return "parallel";
	if (Array.isArray(args?.chain)) return "chain";
	if (args?.evaluate !== undefined) return "evaluate";
	if (args?.vote !== undefined) return "vote";
	if (args?.route !== undefined) return "route";
	if (args?.orchestrate !== undefined) return "orchestrate";
	if (args?.graph !== undefined) return "graph";
	if (args?.loop !== undefined) return "loop";
	if (args?.search !== undefined) return "search";
	if (args?.workflow !== undefined) return "workflow";
	if (args?.worktree !== undefined) return "worktree";
	if (args?.debate !== undefined) return "debate";
	if (args?.dossier !== undefined) return "dossier";
	if (args?.monitor !== undefined) return "monitor";
	if (args?.agent && args?.task) return "single";
	return "unknown";
}

function primaryAgents(args, mode) {
	if (mode === "single") return [args.agent].filter(Boolean);
	if (mode === "parallel") return (args.tasks ?? []).map((task) => task.agent).filter(Boolean);
	if (mode === "evaluate") return [args.evaluate?.operator?.agent ?? "operator"].filter(Boolean);
	if (mode === "orchestrate") return [args.orchestrate?.recon?.agent ?? "recon"].filter(Boolean);
	if (mode === "workflow") return (args.workflow?.phases ?? []).map((phase) => phase.agent).filter(Boolean);
	if (mode === "worktree") return (args.worktree?.tasks ?? []).map((task) => task.agent).filter(Boolean);
	if (mode === "debate") return (args.debate?.participants ?? []).map((participant) => participant.agent).filter(Boolean);
	if (mode === "dossier") return (args.dossier?.sections ?? []).map((section) => section.agent).filter(Boolean);
	if (mode === "monitor") return [args.monitor?.reactor?.agent ?? "analyst"].filter(Boolean);
	return [];
}

function taskCount(args, mode) {
	if (mode === "parallel") return args.tasks?.length ?? 0;
	if (mode === "workflow") return args.workflow?.phases?.length ?? 0;
	if (mode === "worktree") return args.worktree?.tasks?.length ?? 0;
	if (mode === "debate") return args.debate?.participants?.length ?? 0;
	if (mode === "dossier") return args.dossier?.sections?.length ?? 0;
	return 0;
}

function taskText(args) {
	const pieces = [];
	if (typeof args?.task === "string") pieces.push(args.task);
	for (const task of args?.tasks ?? []) {
		if (typeof task?.task === "string") pieces.push(task.task);
	}
	for (const task of args?.chain ?? []) {
		if (typeof task?.task === "string") pieces.push(task.task);
	}
	if (typeof args?.evaluate?.operator?.task === "string") pieces.push(args.evaluate.operator.task);
	if (typeof args?.evaluate?.redteam?.task === "string") pieces.push(args.evaluate.redteam.task);
	for (const critic of Array.isArray(args?.evaluate?.redteam) ? args.evaluate.redteam : []) {
		if (typeof critic?.task === "string") pieces.push(critic.task);
	}
	if (typeof args?.orchestrate?.task === "string") pieces.push(args.orchestrate.task);
	if (typeof args?.orchestrate?.returnContract === "string") pieces.push(args.orchestrate.returnContract);
	for (const node of args?.graph?.nodes ?? []) {
		if (typeof node?.task === "string") pieces.push(node.task);
	}
	for (const phase of args?.workflow?.phases ?? []) {
		if (typeof phase?.task === "string") pieces.push(phase.task);
		if (typeof phase?.approval?.message === "string") pieces.push(phase.approval.message);
		if (typeof phase?.checkCommand === "string") pieces.push(phase.checkCommand);
	}
	for (const task of args?.worktree?.tasks ?? []) {
		if (typeof task?.task === "string") pieces.push(task.task);
	}
	for (const section of args?.dossier?.sections ?? []) {
		if (typeof section?.task === "string") pieces.push(section.task);
	}
	if (typeof args?.monitor?.command === "string") pieces.push(args.monitor.command);
	if (typeof args?.monitor?.pattern === "string") pieces.push(args.monitor.pattern);
	return pieces.join("\n");
}

export function flowCallMatchesExpectation(call, expected) {
	const args = call?.arguments ?? {};
	const actualMode = modeOf(args);
	const expectedModes = values(expected.mode ?? expected.modes);
	if (expectedModes.length > 0 && !expectedModes.includes(actualMode)) {
		return { pass: false, notes: `expected mode ${expectedModes.join("|")}, saw ${actualMode}` };
	}

	const allowedAgents = values(expected.agent ?? expected.agents);
	if (allowedAgents.length > 0) {
		const agents = primaryAgents(args, actualMode);
		if (agents.length === 0 || !agents.every((agent) => allowedAgents.includes(agent))) {
			return { pass: false, notes: `expected primary agent(s) ${allowedAgents.join("|")}, saw ${agents.join(",") || "none"}` };
		}
	}

	const actualTaskCount = taskCount(args, actualMode);
	if (expected.minTasks !== undefined && actualTaskCount < expected.minTasks) {
		return { pass: false, notes: `expected at least ${expected.minTasks} ${actualMode} task(s), saw ${actualTaskCount}` };
	}

	if (expected.taskPattern && !new RegExp(expected.taskPattern, "i").test(taskText(args))) {
		return { pass: false, notes: `task did not match /${expected.taskPattern}/` };
	}

	return { pass: true, notes: `${actualMode} flow call matched` };
}

function scoreFlowCallExpectations(testCase, result) {
	const expectations = values(testCase.expectedFlowCall ?? testCase.expectedFlowCalls);
	if (expectations.length === 0) return { pass: true, notes: "no flow argument expectation" };
	const calls = result.flowCallArgs ?? [];
	for (const expectation of expectations) {
		const matches = calls.map((call) => flowCallMatchesExpectation({ arguments: call }, expectation));
		if (!matches.some((match) => match.pass)) {
			return {
				pass: false,
				notes: `${matches[0]?.notes ?? "no flow call matched"}; calls=${JSON.stringify(calls).slice(0, 800)}`,
			};
		}
	}
	return { pass: true, notes: "flow arguments matched" };
}

export function scoreSelection(testCase, result) {
	if (result.inconclusive || result.timedOut) {
		return {
			pass: false,
			inconclusive: true,
			selectionOk: null,
			answerOk: null,
			argsOk: null,
			flowUsed: (result.flowCalls ?? result.flowCallArgs?.length ?? 0) > 0,
			notes: result.error ?? "selection arm was excluded by infrastructure",
		};
	}
	const flowUsed = (result.flowCalls ?? result.flowCallArgs?.length ?? 0) > 0;
	const selectionOk = flowUsed === testCase.expectFlow;
	const answerRequired = testCase.answerPattern && !(testCase.expectFlow && result.stoppedAfterFlowCall);
	const answerOk = answerRequired ? new RegExp(testCase.answerPattern, "i").test(result.answer ?? "") : true;
	const argsOk = testCase.expectFlow ? scoreFlowCallExpectations(testCase, result) : { pass: true, notes: "no flow expected" };
	return {
		pass: !result.error && selectionOk && answerOk && argsOk.pass,
		selectionOk,
		answerOk,
		argsOk: argsOk.pass,
		flowUsed,
		notes: result.error
			? result.error
			: selectionOk
				? answerOk
					? argsOk.pass ? "selection, arguments, and answer matched" : argsOk.notes
					: "selection matched; answer did not"
				: `expected flow=${testCase.expectFlow}, saw flow=${flowUsed}`,
	};
}

export function selectionExitCode({ failed, comparable }) {
	return failed === 0 && comparable > 0 ? 0 : 1;
}

function emptyState() {
	return {
		flowCallIds: new Set(),
		flowCalls: [],
		flowExecutionStarted: false,
		stoppedAfterFlowCall: false,
		answer: "",
		parseErrors: 0,
		stdoutSample: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	};
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

	let timedOut = false;
	const exitCode = await new Promise((resolveExit) => {
		const proc = spawn("pi", piArgs, { cwd: process.cwd(), shell: false, stdio: ["pipe", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		const timer = caseTimeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					stderr = `${stderr}\nselection eval timed out after ${caseTimeoutMs}ms`;
					try { proc.kill("SIGTERM"); } catch {}
					setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 5000).unref?.();
				}, caseTimeoutMs)
			: null;
		timer?.unref?.();
		signal?.addEventListener?.("abort", () => { try { proc.kill("SIGTERM"); } catch {} }, { once: true });

		const processLine = (line) => collectSelectionEvent(line, state);
		proc.stdin.end(`${testCase.task}\n`);
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
				if (testCase.expectFlow && state.flowExecutionStarted && !state.stoppedAfterFlowCall) {
					state.stoppedAfterFlowCall = true;
					try { proc.kill("SIGTERM"); } catch {}
				}
			}
		});
		proc.stderr.on("data", (data) => { stderr = `${stderr}${data}`.slice(-4096); });
		proc.on("error", (error) => {
			state.error = error.message;
			resolveExit(1);
		});
		proc.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (buffer.trim()) processLine(buffer);
			if (stderr.trim()) state.stderr = stderr.trim();
			resolveExit(code ?? 0);
		});
	});

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

function preflight() {
	if (dryRun) return true;
	return new Promise((resolve) => {
		const proc = spawn("pi", ["--version"], { stdio: "ignore" });
		proc.on("error", () => resolve(false));
		proc.on("close", (code) => resolve(code === 0));
	});
}

async function main() {
	if (!(await preflight())) {
		console.error("FAIL `pi` was not found on PATH. Smoke-test with: npm run eval:select -- --dry-run");
		process.exit(2);
	}

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
	for (const testCase of selected) {
		const startedAt = Date.now();
		const result = await runSelectionCase(testCase, signal);
		const scored = scoreSelection(testCase, result);
		totalCost += result.usage?.cost ?? 0;
		if (scored.inconclusive) inconclusive += 1;
		else if (scored.pass) passed += 1;
		else failed += 1;
		const status = scored.inconclusive ? "INCONCLUSIVE" : scored.pass ? "PASS" : "FAIL";
		const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`${status} ${testCase.name.padEnd(30)} expected flow=${testCase.expectFlow} saw flow=${scored.flowUsed}  $${(result.usage?.cost ?? 0).toFixed(4)}  ${seconds}s`);
		console.log(`    -> ${scored.notes}`);
	}
	const comparable = selected.length - inconclusive;
	console.log(`\n${passed}/${comparable} comparable selection cases passed - ${inconclusive} infra exclusion(s) - total $${totalCost.toFixed(4)}`);
	process.exit(selectionExitCode({ failed, comparable }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`selection eval failed: ${error?.stack ?? error}`);
		process.exit(1);
	});
}
