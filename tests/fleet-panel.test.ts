import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FleetPanel, budgetLine, createFleetPanelController, fleetRunLines } from "../extensions/pi-flows/fleet-panel.ts";
import { FlowRunRegistry } from "../extensions/pi-flows/inspector.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function result(overrides: Record<string, unknown> = {}): any {
	return { agent: "recon", agentSource: "package", task: "inspect auth", exitCode: -1, messages: [], stderr: "", usage, ...overrides };
}

function details(results: any[]): any {
	return { mode: "parallel", version: "test", agentScope: "user", config: {}, agentsDir: {}, results };
}

const keybindings = {
	matches: (data: string, binding: string) => binding === "tui.select.cancel" && data === "x",
	getKeys: (binding: string) => (binding === "tui.select.cancel" ? ["x"] : []),
} as any;

test("registry exposes active runs, budget references, and the last settled run", () => {
	const registry = new FlowRunRegistry();
	const budget = { maxCostUsd: 2, spentCost: 0.5, spentTokens: 0, spentGeneratedTokens: 0 };
	registry.start("flow-1", "parallel", details([result()]), true, budget);
	assert.equal(registry.activeRuns().length, 1);
	assert.equal(registry.activeRuns()[0]?.budget, budget, "budget must be the live reference, not a copy");

	const final = details([result({ exitCode: 0 })]);
	registry.finish("flow-1", final);
	assert.equal(registry.activeRuns().length, 0);
	assert.equal(registry.lastFinishedRun()?.details, final, "the panel needs the final state after the last child exits");
});

test("budgetLine renders burn-down only when a cost ceiling exists", () => {
	assert.equal(budgetLine(undefined, theme), undefined);
	assert.equal(budgetLine({ spentCost: 1, spentTokens: 0, spentGeneratedTokens: 0 }, theme), undefined, "no ceiling, no line");
	const line = budgetLine({ maxCostUsd: 2, spentCost: 0.5, spentTokens: 0, spentGeneratedTokens: 0 }, theme)!;
	assert.match(line, /▰{3}▱{9}/, "a quarter spent fills a quarter of the bar");
	assert.match(line, /\$0\.5000 \/ \$2\.00 budget/);
});

test("fleetRunLines shows every agent with state, activity, and failures", () => {
	const run = {
		mode: "parallel" as const,
		redactSecrets: true,
		budget: { maxCostUsd: 2, spentCost: 0.2, spentTokens: 0, spentGeneratedTokens: 0 },
		details: details([
			result({ exitCode: 0, durationMs: 4000, usage: { ...usage, cost: 0.02 } }),
			result({
				agent: "operator",
				messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] }],
			}),
			result({ agent: "redteam", exitCode: 1, error: { code: "CHILD_EXIT" } }),
		]),
	};
	const lines = fleetRunLines(run as any, theme, 0);
	const text = lines.join("\n");
	assert.match(lines[0]!, /flow parallel 2\/3/);
	assert.match(text, /\$2\.00 budget/);
	assert.match(text, /recon\s+completed/);
	assert.match(text, /operator\s+running/);
	assert.match(text, /└ → \$ npm test/);
	assert.match(text, /redteam\s+failed/);
	assert.match(text, /└ CHILD_EXIT/);
});

test("FleetPanel renders a bounded bordered box and closes on the cancel key", () => {
	const registry = new FlowRunRegistry();
	registry.start("flow-1", "parallel", details([result()]));
	let renders = 0;
	let closed = false;
	const panel = new FleetPanel({ requestRender: () => renders++ } as any, theme, keybindings, registry, () => { closed = true; });

	const lines = panel.render(60);
	assert.ok(lines.length >= 4);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	assert.match(lines.join("\n"), /F8 or x close/);

	registry.update("flow-1", details([result({ exitCode: 0 })]));
	assert.ok(renders > 0, "registry updates must repaint the panel");

	panel.handleInput("x");
	assert.equal(closed, true);
	panel.dispose();
});

test("fleetRunLines drops the settled/total counter for single-child runs", () => {
	const run = { mode: "single" as const, redactSecrets: true, details: details([result()]) };
	const lines = fleetRunLines(run as any, theme, 0);
	assert.doesNotMatch(lines[0]!, /0\/1/);
	assert.match(lines[0]!, /flow single/);
});

test("FleetPanel falls back to the last settled run when nothing is active", () => {
	const registry = new FlowRunRegistry();
	registry.start("flow-1", "single", details([result()]));
	registry.finish("flow-1", details([result({ exitCode: 0 })]));
	const panel = new FleetPanel({ requestRender: () => {} } as any, theme, keybindings, registry, () => {});
	assert.match(panel.render(60).join("\n"), /no active flow runs · last run:/);
	panel.dispose();

	const empty = new FleetPanel({ requestRender: () => {} } as any, theme, keybindings, new FlowRunRegistry(), () => {});
	assert.match(empty.render(60).join("\n"), /no active flow runs/);
	empty.dispose();
});

test("controller toggles open/closed and declines headless or empty sessions quietly", async () => {
	const registry = new FlowRunRegistry();
	const controller = createFleetPanelController(registry);

	await controller.toggle({ hasUI: false, ui: {} } as any);
	assert.equal(controller.isOpen(), false, "headless contexts must not open a panel");

	const emptyNotices: string[] = [];
	await controller.toggle({ hasUI: true, mode: "tui", ui: { notify: (message: string) => emptyNotices.push(message) } } as any, true);
	assert.equal(controller.isOpen(), false, "an empty session gets a notice, not an empty panel");
	assert.match(emptyNotices.join("\n"), /No flow runs yet/);

	registry.start("flow-1", "parallel", details([result()]));

	let opened = 0;
	let panelDone: (() => void) | undefined;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: () => {},
			custom: (factory: any) => new Promise<void>((resolve) => {
				opened++;
				const component = factory({ requestRender: () => {} }, theme, keybindings, () => { component.dispose(); resolve(); });
				panelDone = () => component.handleInput("x");
			}),
		},
	} as any;

	const open = controller.toggle(ctx, true);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(controller.isOpen(), true);
	await controller.toggle(ctx, true);
	await open;
	assert.equal(controller.isOpen(), false, "a second F8 closes instead of stacking panels");
	assert.equal(opened, 1);
	assert.equal(panelDone !== undefined, true);
});
