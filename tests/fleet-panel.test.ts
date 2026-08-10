import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FleetPanel, budgetLine, createFleetPanelController, fleetFlowLines, spendSparkLine } from "../extensions/pi-flows/fleet-panel.ts";
import { FlowRegistry } from "../extensions/pi-flows/inspector.ts";
import { Budget } from "../extensions/pi-flows/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

/** A flow budget already burned down to `spentCost`, for views that render a partly spent ceiling. */
function spentBudget(ceilings: { maxCostUsd?: number; maxTokens?: number }, spentCost: number) {
	const budget = Budget.forFlow(ceilings)!;
	budget.charge({ ...usage, cost: spentCost, turns: 1 });
	return budget;
}

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

test("registry exposes live flows, budget references, and the last settled flow", () => {
	const registry = new FlowRegistry();
	const budget = Budget.forFlow({ maxCostUsd: 2 })!;
	registry.start("flow-1", "parallel", details([result()]), true, budget);
	assert.equal(registry.activeFlows().length, 1);
	assert.equal(registry.activeFlows()[0]?.budget, budget, "budget must be the live reference, not a copy");

	const final = details([result({ exitCode: 0 })]);
	registry.settle("flow-1", final);
	assert.equal(registry.activeFlows().length, 0);
	assert.equal(registry.lastSettledFlow()?.details, final, "the panel needs the final state after the last child exits");
});

test("budgetLine renders burn-down only when a cost ceiling exists", () => {
	assert.equal(budgetLine(undefined, theme), undefined);
	assert.equal(budgetLine(Budget.forFlow({ maxTokens: 100 })!.snapshot(), theme), undefined, "a token-only ceiling has no cost bar to draw");
	const quarterSpent = Budget.forFlow({ maxCostUsd: 2 })!;
	quarterSpent.charge({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextTokens: 0, turns: 1 });
	const line = budgetLine(quarterSpent.snapshot(), theme)!;
	assert.match(line, /█{3}░{9}/, "a quarter spent fills a quarter of the bar");
	assert.match(line, /\$0\.5000 \/ \$2\.00 budget/);

	// A $0 ceiling refuses every run, so it is the one a viewer most needs shown.
	// A falsy check would hide exactly that case.
	const zero = budgetLine(Budget.forFlow({ maxCostUsd: 0 })!.snapshot(), theme)!;
	assert.match(zero, /█{12}/, "a zero ceiling reads as fully spent, not as absent");
	assert.match(zero, /\$0\.0000 \/ \$0\.00 budget/);
});

test("the registry samples the spend curve on update traffic, resampled onto a uniform time grid", () => {
	let clock = 0;
	const registry = new FlowRegistry(1000, () => clock);
	registry.start("flow-1", "parallel", details([result({ usage: { ...usage, cost: 0.1 } })]));
	const flow = registry.activeFlows()[0]!;
	clock = 1000;
	registry.update("flow-1", details([result({ usage: { ...usage, cost: 0.3 } })]));
	clock = 2000;
	registry.settle("flow-1", details([result({ exitCode: 0, usage: { ...usage, cost: 0.5 } })]));

	const series = registry.spendHistory(flow)!;
	assert.equal(series.length, 24, "readers get a fixed-width series where equal spacing means equal time");
	assert.equal(series[0], 0.1);
	assert.equal(series[series.length - 1]!, 0.5, "the curve ends on the true settle total");
	assert.ok(series.includes(0.3), "intermediate samples appear at their place on the time grid");
	assert.equal(registry.lastSettledFlow(), flow, "the curve survives into the last-settled view");
});

test("spend sampling decimates inside the interval and holds quiet time flat on the grid", () => {
	let clock = 0;
	const registry = new FlowRegistry(60_000, () => clock);
	registry.start("flow-1", "parallel", details([result({ usage: { ...usage, cost: 0.1 } })]));
	const flow = registry.activeFlows()[0]!;
	clock = 1000;
	registry.update("flow-1", details([result({ usage: { ...usage, cost: 0.2 } })]));
	clock = 2000;
	registry.update("flow-1", details([result({ usage: { ...usage, cost: 0.3 } })]));
	assert.deepEqual(registry.spendHistory(flow), [0.1], "updates inside the interval are decimated");
	clock = 3000;
	registry.settle("flow-1", details([result({ exitCode: 0, usage: { ...usage, cost: 0.4 } })]));
	const series = registry.spendHistory(flow)!;
	assert.equal(series[0], 0.1);
	assert.equal(series[series.length - 1]!, 0.4, "settle skips decimation so the curve ends on the true total");
	assert.ok(!series.includes(0.2) && !series.includes(0.3), "decimated samples never reach a reader");
});

test("a wall clock stepping backwards neither suppresses sampling nor disorders the series", () => {
	let clock = 10_000;
	const registry = new FlowRegistry(1000, () => clock);
	registry.start("flow-1", "parallel", details([result({ usage: { ...usage, cost: 0.1 } })]));
	const flow = registry.activeFlows()[0]!;
	clock = 0; // e.g. NTP correction
	registry.update("flow-1", details([result({ usage: { ...usage, cost: 0.2 } })]));
	clock = 500;
	registry.settle("flow-1", details([result({ exitCode: 0, usage: { ...usage, cost: 0.3 } })]));
	const series = registry.spendHistory(flow)!;
	assert.equal(series[series.length - 1]!, 0.3, "the curve still ends on the true total after a backwards step");
});

test("spend sparkline shows the burn curve, and carries the total only without a budget line", () => {
	assert.equal(spendSparkLine(undefined, false, theme), undefined);
	assert.equal(spendSparkLine([0.1], false, theme), undefined, "one sample has no curve to draw");
	assert.equal(spendSparkLine([0, 0, 0], false, theme), undefined, "no spend yet, no line");
	assert.match(spendSparkLine([0, 0.1, 0.3], false, theme)!, /▁.*█ \$0\.3000 spent/, "without a budget line this is the only spend surface");
	assert.match(spendSparkLine([0, 0.1, 0.3], true, theme)!, /spend$/, "the budget line already shows the amount");
});

test("fleetFlowLines renders the spend sparkline from sampled history", () => {
	const run = { mode: "parallel" as const, redactSecrets: true, details: details([result(), result({ agent: "analyst" })]) };
	const lines = fleetFlowLines(run as any, theme, 0, { spendHistory: [0, 0.05, 0.2] });
	assert.match(lines.join("\n"), /\$0\.2000 spent/);
});

test("fleetFlowLines shows every agent with state, activity, and failures", () => {
	const run = {
		mode: "parallel" as const,
		redactSecrets: true,
		budget: spentBudget({ maxCostUsd: 2 }, 0.2),
		details: details([
			result({ exitCode: 0, durationMs: 4000, usage: { ...usage, cost: 0.02 } }),
			result({
				agent: "operator",
				messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] }],
			}),
			result({ agent: "redteam", exitCode: 1, error: { code: "CHILD_EXIT" } }),
		]),
	};
	const lines = fleetFlowLines(run as any, theme, 0);
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
	const registry = new FlowRegistry();
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

test("fleetFlowLines drops the settled/total counter for single-child flows", () => {
	const run = { mode: "single" as const, redactSecrets: true, details: details([result()]) };
	const lines = fleetFlowLines(run as any, theme, 0);
	assert.doesNotMatch(lines[0]!, /0\/1/);
	assert.match(lines[0]!, /flow single/);
});

test("FleetPanel falls back to the last settled flow when no flow is live", () => {
	const registry = new FlowRegistry();
	registry.start("flow-1", "single", details([result()]));
	registry.settle("flow-1", details([result({ exitCode: 0 })]));
	const panel = new FleetPanel({ requestRender: () => {} } as any, theme, keybindings, registry, () => {});
	assert.match(panel.render(60).join("\n"), /no live flows · last flow:/);
	panel.dispose();

	const empty = new FleetPanel({ requestRender: () => {} } as any, theme, keybindings, new FlowRegistry(), () => {});
	assert.match(empty.render(60).join("\n"), /no live flows/);
	empty.dispose();
});

test("controller toggles open/closed and declines headless or empty sessions quietly", async () => {
	const registry = new FlowRegistry();
	const controller = createFleetPanelController(registry);

	await controller.toggle({ hasUI: false, ui: {} } as any);
	assert.equal(controller.isOpen(), false, "headless contexts must not open a panel");

	const emptyNotices: string[] = [];
	await controller.toggle({ hasUI: true, mode: "tui", ui: { notify: (message: string) => emptyNotices.push(message) } } as any, true);
	assert.equal(controller.isOpen(), false, "an empty session gets a notice, not an empty panel");
	assert.match(emptyNotices.join("\n"), /No flows yet/);

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
