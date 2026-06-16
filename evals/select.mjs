// Tool-selection eval for pi-flows. Unlike evals/run.mjs, this does not invoke
// the flow tool directly. It loads the extension into headless pi and checks
// whether the parent model chose `flow` for the prompt.
//
//   npm run eval:select
//   npm run eval:select -- --filter=no-flow
//   npm run eval:select -- --model=openai-codex/gpt-5.4-mini --timeout=60000
//   npm run eval:select -- --dry-run
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EVAL_MODEL } from "./lib.mjs";
import { SELECTION_CASES } from "./selection-cases.mjs";

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
	const ids = [];
	for (const part of message?.content ?? []) {
		if (part?.type === "toolCall" && part.name === "flow") ids.push(part.id ?? `flow-call-${ids.length}`);
	}
	return ids;
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
	const messages = [];
	if (event.message) messages.push(event.message);
	if (event.type === "agent_end") messages.push(...(event.messages ?? []));
	for (const message of messages) {
		for (const id of flowCallIdsFromMessage(message)) state.flowCallIds.add(id);
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

export function scoreSelection(testCase, result) {
	const flowUsed = result.flowCalls > 0;
	const selectionOk = flowUsed === testCase.expectFlow;
	const answerOk = testCase.answerPattern ? new RegExp(testCase.answerPattern, "i").test(result.answer ?? "") : true;
	return {
		pass: !result.error && selectionOk && answerOk,
		selectionOk,
		answerOk,
		flowUsed,
		notes: result.error
			? result.error
			: selectionOk
				? answerOk ? "selection and answer matched" : "selection matched; answer did not"
				: `expected flow=${testCase.expectFlow}, saw flow=${flowUsed}`,
	};
}

function emptyState() {
	return {
		flowCallIds: new Set(),
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
			answer: testCase.mock.answer,
			exitCode: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		};
	}

	const dir = mkdtempSync(join(tmpdir(), "pi-flow-select-"));
	const taskFile = join(dir, "task.md");
	writeFileSync(taskFile, testCase.task, { encoding: "utf8", mode: 0o600 });

	const state = emptyState();
	const piArgs = ["--mode", "json", "-p", "--no-session", "--no-context-files", "--no-extensions", "-e", "./extensions/pi-flows/index.ts"];
	if (!useDefaultModel) piArgs.push("--model", model);
	piArgs.push(`@${taskFile}`);

	const exitCode = await new Promise((resolveExit) => {
		const proc = spawn("pi", piArgs, { cwd: process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let stderr = "";
		const timer = timeoutMs > 0
			? setTimeout(() => {
					stderr = `${stderr}\nselection eval timed out after ${timeoutMs}ms`;
					try { proc.kill("SIGTERM"); } catch {}
					setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 5000).unref?.();
				}, timeoutMs)
			: null;
		timer?.unref?.();
		signal?.addEventListener?.("abort", () => { try { proc.kill("SIGTERM"); } catch {} }, { once: true });

		const processLine = (line) => collectSelectionEvent(line, state);
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
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

	const error = exitCode === 0 ? null : (state.stderr || state.stdoutSample || `pi exited ${exitCode}`);
	return {
		flowCalls: state.flowCallIds.size,
		answer: state.answer,
		exitCode,
		error,
		parseErrors: state.parseErrors,
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
	console.log(`pi-flows selection evals - subject ${useDefaultModel ? "(pi default)" : model} - timeout ${Math.round(timeoutMs / 1000)}s/case${dryRun ? " - DRY RUN" : ""}\n`);
	let passed = 0;
	let totalCost = 0;
	for (const testCase of selected) {
		const startedAt = Date.now();
		const result = await runSelectionCase(testCase, signal);
		const scored = scoreSelection(testCase, result);
		totalCost += result.usage?.cost ?? 0;
		if (scored.pass) passed += 1;
		const status = scored.pass ? "PASS" : "FAIL";
		const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`${status} ${testCase.name.padEnd(30)} expected flow=${testCase.expectFlow} saw flow=${scored.flowUsed}  $${(result.usage?.cost ?? 0).toFixed(4)}  ${seconds}s`);
		console.log(`    -> ${scored.notes}`);
	}
	console.log(`\n${passed}/${selected.length} selection cases passed - total $${totalCost.toFixed(4)}`);
	process.exit(passed === selected.length ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`selection eval failed: ${error?.stack ?? error}`);
		process.exit(1);
	});
}
