import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import { FlowRegistry, flowAgentActivity, sanitizeInspectorText } from "../extensions/pi-flows/inspector.ts";

const stubPi = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));
process.argv[1] = stubPi;

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function result(overrides: Record<string, unknown> = {}): any {
	return { agent: "recon", agentSource: "package", task: "inspect auth", exitCode: -1, messages: [], stderr: "", usage, ...overrides };
}

function details(results: any[]): any {
	return { mode: "single", version: "test", agentScope: "user", config: {}, agentsDir: {}, results };
}

function runtime() {
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	registerPiFlows({
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerShortcut() {},
		registerTool(tool: any) { tools.set(tool.name, tool); },
	} as any);
	return { flow: tools.get("flow"), commands };
}

async function waitForCall(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await readFile(path.join(dir, "calls.jsonl"), "utf8").catch(() => "")).trim()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("stub child did not start");
}

test("inspector activity summarizes text, tool calls, and results safely", () => {
	const activity = flowAgentActivity(result({
		messages: [
			{ role: "assistant", content: [
				{ type: "toolCall", name: "read", arguments: { path: "src/auth.ts" } },
				{ type: "text", text: "Checking\u001b[2J secret=sk-abcde\u2066fghijklmnopqrstuvwxyz" }, // privacy-scan: allow deliberate control-split secret fixture
			] },
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "export function getSession() {}" }] },
		],
	}));

	assert.deepEqual(activity.map((item) => item.kind), ["tool", "text", "result"]);
	const rendered = activity.map((item) => item.text).join("\n");
	assert.match(rendered, /read src\/auth\.ts/);
	assert.match(rendered, /getSession/);
	assert.match(rendered, /\[REDACTED_SECRET\]/);
	assert.doesNotMatch(rendered, /\u001b|\u2066|sk-abcdefghijklmnopqrstuvwxyz/);
	assert.match(sanitizeInspectorText("sk-abcde\u2066fghijklmnopqrstuvwxyz", false), /sk-abcdefghijklmnopqrstuvwxyz/);
});

test("registry exposes queued and running children", () => {
	const registry = new FlowRegistry();
	registry.start("flow-1", "parallel", details([
		result(),
		result({ agent: "analyst", agentSource: "unknown", task: "queued work" }),
	]));
	assert.equal(registry.inspectableAgents().length, 2);
	registry.settle("flow-1", details([]));
	assert.equal(registry.inspectableAgents().length, 0);
});

test("/flows inspect opens the viewer over a live child and closing it does not abort the run", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "pi-flow-inspector-"));
	const previousDir = process.env.PI_STUB_DIR;
	const previousPlan = process.env.PI_STUB_PLAN;
	process.env.PI_STUB_DIR = cwd;
	process.env.PI_STUB_PLAN = JSON.stringify({ recon: { reply: "LIVE_ACTIVITY", delayBeforeReplyMs: 80, holdOpenMs: 80 } });

	try {
		const { flow, commands } = runtime();
		let renderRequests = 0;
		let closed = false;
		let lines: string[] = [];
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };
		const keybindings = {
			matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "x",
			getKeys: (binding: string) => binding === "tui.select.cancel" ? ["x"] : [],
		};
		const ui = {
			confirm: async () => true,
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
			custom: async (factory: any) => {
				const component = factory(
					{ requestRender: () => { renderRequests++; } },
					theme,
					keybindings,
					() => { closed = true; },
				);
				for (let attempt = 0; attempt < 100; attempt++) {
					lines = component.render(80);
					if (/LIVE_ACTIVITY/.test(lines.join("\n"))) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				component.handleInput("x");
				component.dispose();
			},
		};
		const ctx = { cwd, hasUI: true, mode: "tui", ui } as any;
		const running = flow.execute("live-flow", { agent: "recon", task: "inspect auth", why: "inspector test needs a live child" }, new AbortController().signal, undefined, ctx);
		await waitForCall(cwd);
		await commands.get("flows").handler("inspect", ctx);
		const output = await running;

		assert.match(lines.join("\n"), /LIVE_ACTIVITY/);
		assert.doesNotMatch(lines.join("\n"), /\b\d+\.\d+s\b/, "running children should not inherit flow or queue time");
		assert.match(lines.join("\n"), /x close/);
		assert.ok(lines.length <= 16);
		assert.ok(lines.every((line) => visibleWidth(line) <= 80));
		assert.ok(renderRequests > 0, "child updates should rerender the overlay");
		assert.equal(closed, true);
		assert.equal(output.details.results[0].exitCode, 0);
	} finally {
		if (previousDir === undefined) delete process.env.PI_STUB_DIR; else process.env.PI_STUB_DIR = previousDir;
		if (previousPlan === undefined) delete process.env.PI_STUB_PLAN; else process.env.PI_STUB_PLAN = previousPlan;
		await rm(cwd, { recursive: true, force: true });
	}
});
