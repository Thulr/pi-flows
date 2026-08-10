/**
 * Terminal demo harness for the subagent UI surfaces. Drives the *real*
 * renderers — the live tool-row board, the F8 fleet panel, and the durable
 * flow card — with a scripted, fully fictional timeline (no model calls, no
 * child processes, no real paths). Used by the VHS tapes in scripts/demo/ to
 * record the visual evidence embedded in PRs and docs.
 *
 *   node --import tsx scripts/demo-ui.ts live   # collapsed live board
 *   node --import tsx scripts/demo-ui.ts fleet  # F8 fleet panel overlay
 *   node --import tsx scripts/demo-ui.ts card   # durable flow card entry
 */
import { Theme } from "@earendil-works/pi-coding-agent";
import { FleetPanel } from "../extensions/pi-flows/fleet-panel.ts";
import { FlowRegistry } from "../extensions/pi-flows/inspector.ts";
import { renderFlowResultRow, type RowTickerState } from "../extensions/pi-flows/ui-live-row.ts";
import { flowCardLines, type FlowRunEntryData } from "../extensions/pi-flows/ui-flow-card.ts";

// A real Theme instance (the same class pi hands to renderers). The
// constructor precomputes ANSI for every color key, so fill the full record
// with a base tone and override the colors the flow renderers actually use.
const FG_KEYS = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder",
	"mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
	"syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
	"syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh",
	"thinkingXhigh", "thinkingMax", "bashMode",
];
const fgColors = Object.fromEntries(FG_KEYS.map((key) => [key, "#c0caf5"]));
Object.assign(fgColors, {
	accent: "#7aa2f7", border: "#3b4261", success: "#9ece6a", error: "#f7768e",
	warning: "#e0af68", muted: "#787c99", dim: "#565f89", toolTitle: "#7dcfff", toolOutput: "#a9b1d6",
});
const theme = new Theme(
	fgColors as any,
	{ selectedBg: "#292e42", userMessageBg: "#1f2335", customMessageBg: "#1f2335", toolPendingBg: "#1f2335", toolSuccessBg: "#1f2335", toolErrorBg: "#2d202a" } as any,
	"truecolor",
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clear = () => process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

function usage(input: number, output: number, cost: number, turns = 1) {
	return { input, output, cacheRead: 0, cacheWrite: 0, cost, contextTokens: input + output, turns };
}

const assistant = (parts: unknown[]) => ({ role: "assistant", content: parts });
const tool = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", name, arguments: args });
const say = (text: string) => ({ type: "text", text });

/**
 * One frame of a fictional five-agent parallel run. `t` is the frame index;
 * agents start staggered, stream activity, and settle — strategist fails so
 * the failure treatment is visible too.
 */
function timeline(t: number): any {
	const agents = [
		{
			agent: "recon", start: 0, end: 14, fail: false,
			steps: [tool("read", { path: "src/auth/session.ts" }), tool("grep", { pattern: "refreshSession" }), say("Mapped 6 call sites for the session-refresh path.")],
			finalUsage: usage(12400, 1800, 0.06),
		},
		{
			agent: "analyst", start: 2, end: 17, fail: false,
			steps: [tool("grep", { pattern: "refreshToken" }), tool("read", { path: "src/services/token-cache.ts" }), say("Token cache is the only consumer outside src/auth.")],
			finalUsage: usage(9100, 1400, 0.05),
		},
		{
			agent: "operator", start: 4, end: 30, fail: false,
			steps: [tool("read", { path: "src/auth/session.ts" }), tool("edit", { path: "src/auth/session.ts" }), tool("bash", { command: "npm test -- --filter auth" }), say("Two expiry fixtures assumed the old refresh window — updating."), tool("bash", { command: "npm test -- --filter auth" }), say("47 passing. Refactor holds under the auth suite.")],
			finalUsage: usage(41000, 8600, 0.31),
		},
		{
			agent: "redteam", start: 6, end: 33, fail: false,
			steps: [tool("read", { path: "src/auth/tokens.ts" }), tool("grep", { pattern: "clockSkew" }), say("Checked rotation edge cases; no regression found.")],
			finalUsage: usage(15200, 2900, 0.11),
		},
		{
			agent: "strategist", start: 8, end: 12, fail: true,
			steps: [say("Drafting the rollout sequence…")],
			finalUsage: usage(2100, 300, 0.02),
		},
	];

	const results = agents.map(({ agent, start, end, fail, steps, finalUsage }) => {
		if (t < start) return { agent, agentSource: "unknown", task: "queued", exitCode: -1, messages: [], stderr: "", usage: usage(0, 0, 0, 0) };
		const done = t >= end;
		const progress = Math.min(1, (t - start) / (end - start));
		const visibleSteps = steps.slice(0, Math.max(1, Math.ceil(progress * steps.length)));
		return {
			agent,
			agentSource: "package",
			task: `${agent} demo task`,
			exitCode: done ? (fail ? 1 : 0) : -1,
			messages: [assistant(visibleSteps)],
			stderr: "",
			usage: usage(Math.round(finalUsage.input * progress), Math.round(finalUsage.output * progress), finalUsage.cost * progress),
			durationMs: done ? (end - start) * 700 : undefined,
			...(done && fail ? { error: { code: "CHILD_EXIT", message: "demo failure" }, stopReason: "error" } : {}),
		};
	});

	return { mode: "parallel", version: "demo", agentScope: "user", config: { redactSecretsDefault: true }, agentsDir: {}, results };
}

const LAST_FRAME = 35;

async function liveDemo(): Promise<void> {
	const state: RowTickerState = {};
	const context = { invalidate: () => {}, state, lastComponent: undefined as unknown };
	for (let t = 0; t <= LAST_FRAME; t++) {
		const details = timeline(t);
		const partial = t < LAST_FRAME;
		const component = renderFlowResultRow(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: partial },
			theme,
			context as any,
			() => "",
		);
		(context as any).lastComponent = component;
		clear();
		process.stdout.write(component.render(94).join("\n") + "\n");
		await sleep(partial ? 260 : 0);
	}
	await sleep(2500);
}

async function fleetDemo(): Promise<void> {
	const registry = new FlowRegistry();
	const snapshot = { maxCostUsd: 1.0, spentCost: 0, spentTokens: 0, spentGeneratedTokens: 0 };
	// Budget-shaped: the panel reads burn-down through snapshot(), never the fields.
	const budget = { snapshot: () => ({ ...snapshot }) } as any;
	registry.start("demo-flow", "parallel", timeline(0), true, budget);
	const panel = new FleetPanel({ requestRender: () => {} } as any, theme, { matches: () => false, getKeys: () => ["esc"] } as any, registry, () => {});
	for (let t = 0; t <= LAST_FRAME; t++) {
		const details = timeline(t);
		snapshot.spentCost = details.results.reduce((sum: number, result: any) => sum + (result.usage.cost || 0), 0);
		registry.update("demo-flow", details);
		clear();
		process.stdout.write(panel.render(74).join("\n") + "\n");
		await sleep(t < LAST_FRAME ? 260 : 0);
	}
	await sleep(2500);
	panel.dispose();
}

async function cardDemo(): Promise<void> {
	const final = timeline(LAST_FRAME);
	const data: FlowRunEntryData = {
		version: "demo",
		mode: "parallel",
		status: "partial",
		results: final.results.map((result: any) => ({
			agent: result.agent,
			agentSource: result.agentSource,
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorCode: result.error?.code,
			durationMs: result.durationMs,
			usage: result.usage,
		})),
		trace: { traceFile: "flow-trace.jsonl", health: "complete" },
	};
	clear();
	process.stdout.write(theme.fg("muted", "collapsed flow card entry (persisted in the session):") + "\n\n");
	process.stdout.write(flowCardLines(data, theme, false).join("\n") + "\n");
	await sleep(3000);
	process.stdout.write("\n" + theme.fg("muted", "expanded (ctrl+o):") + "\n\n");
	process.stdout.write(flowCardLines(data, theme, true).join("\n") + "\n");
	await sleep(4000);
}

/** Write the settled card's Gantt PNG (the docs/PR asset) from the same fictional timeline. */
async function ganttDemo(): Promise<void> {
	const { flowGanttPng } = await import("../extensions/pi-flows/ui-gantt.ts");
	const { writeFileSync } = await import("node:fs");
	const final = timeline(LAST_FRAME);
	const image = flowGanttPng(
		final.results.map((result: any, index: number) => ({
			agent: result.agent,
			exitCode: result.exitCode,
			errorCode: result.error?.code,
			durationMs: result.durationMs,
			startedAtMs: [0, 1400, 2800, 4200, 5600][index],
		})),
		theme,
	)!;
	const out = process.argv[3] ?? "docs/images/flow-gantt.png";
	writeFileSync(out, Buffer.from(image.base64, "base64"));
	process.stdout.write(`wrote ${out} (${image.dimensions.widthPx}x${image.dimensions.heightPx})\n`);
}

const mode = process.argv[2];
process.stdout.write("\x1b[?25l");
const run = mode === "fleet" ? fleetDemo : mode === "card" ? cardDemo : mode === "gantt" ? ganttDemo : liveDemo;
run().finally(() => process.stdout.write("\x1b[?25h"));
