// Plain-pi control arm for the flows-vs-plain A/B. Runs a case's raw task through a
// headless `pi` with NO pi-flows — `--no-extensions`, pi's default system prompt,
// default tools — on the SAME model as the flows arm. So the only thing that varies
// between arms is pi-flows' specialist agents + orchestration, which is exactly what
// the comparison is trying to isolate.
//
// It speaks the same `--mode json` protocol the flow tool's children use, and
// returns a result shaped like a flow result ({ content, details.results[] }) so the
// existing objective scorers and the cross-model judge consume it unchanged.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function finalAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		for (const part of m.content ?? []) if (part?.type === "text") return part.text;
	}
	return "";
}

/**
 * Run one plain `pi` headlessly on `task`. Returns a flow-shaped result. `model`
 * undefined → omit --model so the child uses pi's default (matches the flows arm's
 * "agent frontmatter" mode).
 */
export async function runPlainPi({ task, cwd, model, timeoutMs = 120000, signal }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-baseline-"));
	const taskFile = join(dir, "task.md");
	writeFileSync(taskFile, `Task: ${task}\n`, { encoding: "utf8", mode: 0o600 });

	// Plain pi: no extensions (so pi-flows is not loaded), no session, default system
	// prompt + default tools. Same JSON protocol the flow children emit.
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	if (model) args.push("--model", model);
	args.push(`@${taskFile}`);

	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	const messages = [];
	let stderr = "";
	let stdoutSample = "";
	let parseErrors = 0;
	let sawJson = false;
	let modelOut;
	let stopReason;
	let errorMessage;

	const exitCode = await new Promise((resolveExit) => {
		const proc = spawn("pi", args, { cwd: cwd ?? process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let buffer = "";
		let closed = false;
		const timer = timeoutMs > 0
			? setTimeout(() => {
					stopReason = "timeout";
					try { proc.kill("SIGTERM"); } catch {}
					setTimeout(() => { try { if (!proc.killed) proc.kill("SIGKILL"); } catch {} }, 5000).unref?.();
				}, timeoutMs)
			: null;
		timer?.unref?.();
		const finish = (code) => {
			if (closed) return;
			closed = true;
			if (timer) clearTimeout(timer);
			resolveExit(code);
		};
		const onAbort = () => { try { proc.kill("SIGTERM"); } catch {} };
		signal?.addEventListener?.("abort", onAbort, { once: true });

		const processLine = (line) => {
			if (!line.trim()) return;
			let event;
			try {
				event = JSON.parse(line);
				sawJson = true;
			} catch {
				parseErrors += 1;
				if (stdoutSample.length < 4096) stdoutSample += `${line}\n`;
				return;
			}
			if (event.type === "message_end" && event.message) {
				const m = event.message;
				if (m.role === "assistant") {
					usage.turns += 1;
					const u = m.usage;
					if (u) {
						usage.input += u.input || 0;
						usage.output += u.output || 0;
						usage.cacheRead += u.cacheRead || 0;
						usage.cacheWrite += u.cacheWrite || 0;
						usage.cost += u.cost?.total || 0;
						usage.contextTokens = u.totalTokens || usage.contextTokens;
					}
					if (!modelOut && m.model) modelOut = m.model;
					if (m.stopReason) stopReason = m.stopReason;
					if (m.errorMessage) errorMessage = m.errorMessage;
				}
				messages.push(m);
			} else if (event.type === "tool_result_end" && event.message) {
				messages.push(event.message);
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-8192); });
		proc.on("error", (err) => { stderr += `spawn error: ${err.message}`; finish(1); });
		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});
	});

	const protocolError = !sawJson && parseErrors > 0;
	const text = finalAssistantText(messages) || errorMessage || stderr || "(no output)";
	return {
		content: [{ type: "text", text }],
		details: {
			mode: "plain-pi",
			results: [
				{
					agent: "plain-pi",
					agentSource: "none",
					exitCode: exitCode ?? 0,
					usage,
					model: modelOut,
					stopReason: protocolError ? "error" : stopReason,
					errorMessage: protocolError ? "plain pi did not produce valid --mode json output" : errorMessage,
					stdoutSample,
				},
			],
		},
	};
}
