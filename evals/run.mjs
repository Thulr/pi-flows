// Opt-in, model-in-the-loop eval harness for pi-flows.
//
// Unlike `npm test` (offline, deterministic, no model), this drives REAL `flow`
// delegations through REAL `pi` and scores agent/flow behaviour — so it needs the
// `pi` CLI on PATH and a configured model provider, and it spends tokens. It is
// intentionally NOT part of `npm run check`.
//
//   npm run eval                          # run all cases
//   npm run eval -- --filter=route        # only matching cases
//   npm run eval -- --model=claude-sonnet-4-6
//   npm run eval -- --cap=0.25            # per-case USD ceiling (default 0.10)
//   npm run eval -- --dry-run             # framework smoke (canned results, no model)
//
// Exit code is 0 when every selected case passes, 1 otherwise.
import { execFileSync } from "node:child_process";
import registerPiFlows from "../extensions/pi-flows/index.ts";
import { CASES } from "./cases.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const filter = flag("filter", "");
const model = flag("model", "claude-haiku-4-5");
const capUsd = Number(flag("cap", "0.10"));
const dryRun = args.includes("--dry-run");

// Resolve a real `pi` from PATH rather than re-running this script. getPiInvocation
// falls through to { command: "pi" } when argv[1] is not an existing script file.
process.argv[1] = "";

function flowTool() {
	const tools = new Map();
	registerPiFlows({ registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
	return tools.get("flow");
}

// Push the chosen (cheap) model into every agent reference the params expose, so a
// run does not silently use pricier per-agent defaults. maxCostUsd is the hard cap.
function injectModel(params) {
	const p = structuredClone(params);
	const ref = (r) => { if (r && typeof r === "object" && !r.model) r.model = model; };
	if (p.agent && !p.model) p.model = model;
	for (const t of p.tasks ?? []) ref(t);
	for (const s of p.chain ?? []) ref(s);
	if (p.evaluate) { ref(p.evaluate.operator); const critics = Array.isArray(p.evaluate.redteam) ? p.evaluate.redteam : [p.evaluate.redteam]; critics.forEach(ref); }
	if (p.vote) { (p.vote.voters ?? []).forEach(ref); ref(p.vote.debrief); }
	if (p.route) ref(p.route.controller);
	if (p.orchestrate) for (const k of ["commander", "recon", "debrief", "verify"]) ref(p.orchestrate[k]);
	return p;
}

const sumCost = (r) => (r?.details?.results ?? []).reduce((acc, x) => acc + (x?.usage?.cost ?? 0), 0);

function preflight() {
	if (dryRun) return true;
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		console.error("✗ `pi` was not found on PATH.\n  The eval harness needs the pi CLI and a configured model provider.\n  Install: npm i -g @earendil-works/pi-coding-agent\n  Or smoke-test the harness offline with: npm run eval -- --dry-run");
		return false;
	}
}

async function main() {
	if (!preflight()) process.exit(2);

	const selected = CASES.filter((c) => !filter || c.name.includes(filter));
	if (selected.length === 0) {
		console.error(`No eval cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	console.log(`pi-flows evals  ·  model ${model}  ·  cap $${capUsd.toFixed(2)}/case${dryRun ? "  ·  DRY RUN" : ""}\n`);

	let passed = 0;
	let totalCost = 0;
	for (const testCase of selected) {
		const flowCtx = { cwd: testCase.cwd ?? process.cwd(), hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
		const ctx = { flow, model, dryRun, flowCtx };
		const startedAt = Date.now();

		let result;
		let thrown;
		if (dryRun) {
			result = testCase.mock;
		} else {
			const params = { ...injectModel(testCase.params), maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: testCase.params.timeoutMs ?? 120000 };
			try {
				result = await flow.execute(`eval:${testCase.name}`, params, new AbortController().signal, undefined, flowCtx);
			} catch (error) {
				thrown = error;
			}
		}

		let scored;
		if (thrown) {
			scored = { pass: false, score: 0, notes: `flow threw: ${thrown.message}` };
		} else {
			try {
				scored = await testCase.score(result, ctx);
			} catch (error) {
				scored = { pass: false, score: 0, notes: `scorer threw: ${error.message}` };
			}
		}

		const cost = sumCost(result);
		totalCost += cost;
		if (scored.pass) passed++;
		const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`${scored.pass ? "✓" : "✗"} ${testCase.name.padEnd(34)} score ${scored.score.toFixed(2)}  $${cost.toFixed(4)}  ${seconds}s`);
		if (scored.notes) console.log(`    ↳ ${scored.notes}`);
	}

	console.log(`\n${passed}/${selected.length} passed  ·  total $${totalCost.toFixed(4)}${dryRun ? "  (dry-run, no model)" : ""}`);
	process.exit(passed === selected.length ? 0 : 1);
}

main().catch((error) => {
	console.error(`eval harness failed: ${error?.stack ?? error}`);
	process.exit(1);
});
