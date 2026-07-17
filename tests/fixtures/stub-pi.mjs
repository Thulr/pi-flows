#!/usr/bin/env node
// Offline stub of the `pi` CLI for pi-flows integration tests.
//
// pi-flows spawns a child agent as:
//   <runtime> --mode json -p --no-session [--model M]
//             [--no-builtin-tools | --tools a,b] [--append-system-prompt SYS] @TASKFILE
// and reads JSONL events from stdout, reacting to assistant `message_end` events
// (see getPiInvocation / the spawn loop in extensions/pi-flows/index.ts).
//
// This stub mimics just enough of that contract to drive the real execution path
// deterministically — no model, no network:
//   * It identifies the agent from the task-file name `<agent>-task.md`.
//   * It logs every invocation (agent, task, system prompt, args) to
//     `$PI_STUB_DIR/calls.jsonl` so tests can assert wiring and handoffs.
//   * It emits one assistant `message_end` whose text comes from `$PI_STUB_PLAN`
//     (a JSON map of agent name -> reply, or -> [replies] to vary the reply
//     across repeated calls, e.g. an evaluate revise-loop).

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);

const taskArg = argv.find((a) => a.startsWith("@"));
const taskPath = taskArg ? taskArg.slice(1) : null;
const sysIdx = argv.indexOf("--append-system-prompt");
const sysPath = sysIdx >= 0 ? argv[sysIdx + 1] : null;
const modelIdx = argv.indexOf("--model");
const model = modelIdx >= 0 ? argv[modelIdx + 1] : "stub-model";

const task = taskPath && existsSync(taskPath) ? readFileSync(taskPath, "utf8") : "";
const systemPrompt = sysPath && existsSync(sysPath) ? readFileSync(sysPath, "utf8") : "";
const agent = taskPath ? path.basename(taskPath).replace(/-task\.md$/, "") : "unknown";

// Per-agent call counter (persisted) so list-valued plan entries advance across
// repeated calls to the same agent within one flow (evaluate loops, retries).
let callIndex = 0;
const stubDir = process.env.PI_STUB_DIR;
if (stubDir) {
	mkdirSync(stubDir, { recursive: true });
	const counterFile = path.join(stubDir, `count-${agent}.txt`);
	callIndex = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) || 0 : 0;
	writeFileSync(counterFile, String(callIndex + 1));
	appendFileSync(path.join(stubDir, "calls.jsonl"), `${JSON.stringify({ agent, callIndex, task, systemPrompt, args: argv, cwd: process.cwd() })}\n`);
}

const plan = process.env.PI_STUB_PLAN ? JSON.parse(process.env.PI_STUB_PLAN) : {};
let reply = plan[agent];
if (Array.isArray(reply)) {
	const matched = reply.find((candidate) => candidate && typeof candidate === "object" && typeof candidate.whenTaskIncludes === "string" && task.includes(candidate.whenTaskIncludes));
	reply = matched ?? reply[Math.min(callIndex, reply.length - 1)];
}
let exitCode = 0;
if (reply && typeof reply === "object") {
	for (const [relativePath, content] of Object.entries(reply.writes ?? {})) {
		const target = path.resolve(process.cwd(), relativePath);
		if (!target.startsWith(`${process.cwd()}${path.sep}`)) throw new Error(`stub write escapes cwd: ${relativePath}`);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, String(content));
	}
	if (reply.commitMessage) {
		execFileSync("git", ["add", "-A"], { cwd: process.cwd() });
		execFileSync("git", ["-c", "user.name=Stub Agent", "-c", "user.email=stub-agent@example.com", "commit", "-qm", String(reply.commitMessage)], { cwd: process.cwd() });
	}
	if (Array.isArray(reply.gitArgs)) execFileSync("git", reply.gitArgs.map(String), { cwd: process.cwd() });
	exitCode = Number.isInteger(reply.exitCode) ? reply.exitCode : 0;
	reply = reply.reply;
}
if (reply === undefined) reply = `stub reply for ${agent}`;

const event = {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: String(reply) }],
		usage: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 }, totalTokens: 20 },
		model,
		stopReason: "endTurn",
	},
};
process.stdout.write(`${JSON.stringify(event)}\n`);
process.exit(exitCode);
