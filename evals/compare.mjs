// Flows-vs-plain A/B: does pi-flows actually beat plain pi on the same task?
//
// For each case it runs TWO arms on the SAME subject model and grades BOTH with the
// same objective scorer + the same cross-model judge:
//   flows : the case's flow params — pi-flows' specialist agents + orchestration
//   plain : one headless `pi --no-extensions` call with the raw task — no flows
// Then reports per-case and aggregate deltas.
//
//   npm run eval:compare                       # all cases, both arms, on your pi default
//   npm run eval:compare -- --pairwise          # add order-controlled pairwise judging (the sensitive metric)
//   npm run eval:compare -- --filter=vote       # scope to keep cost down
//   npm run eval:compare -- --model=openai-codex/gpt-5.5 --judge-model=anthropic/claude-sonnet-4-6
//   npm run eval:compare -- --write=evals/compare.json
//   npm run eval:compare -- --dry-run           # wiring smoke (canned results, no model)
//
// Set PI_FLOWS_TRACE_FILE=<path> to also capture per-child OpenInference spans for
// the flows arm (diagnose WHY an arm scored as it did) — the flow tool honors that
// env var, no flag needed.
//
// Absolute judge scores cluster and can't resolve small gaps; --pairwise shows the
// judge both answers and asks which is better (positions swapped to cancel order
// bias), which is the sensitive, fair head-to-head. Some objective checks are
// pi-flows-only by construction (route dispatch, the same-model vote warning) and
// plain pi cannot satisfy them — that gap IS the point for those cases.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPlainPi } from "./baseline-pi.mjs";
import { CASES } from "./cases.mjs";
import { judgePairwise } from "./judge.mjs";
import { answerText, caseCwd, flowTool, scoreArm, DEFAULT_EVAL_MODEL } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";

const dotenvPath = join(process.cwd(), ".env");
if (existsSync(dotenvPath)) {
	try { process.loadEnvFile(dotenvPath); } catch { /* ignore a malformed .env */ }
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};

const cliModel = flag("model", null);
const model = cliModel ?? DEFAULT_EVAL_MODEL;
const useAgentModels = ["agent", "default", ""].includes(model);
const subjectModel = useAgentModels ? undefined : model;
const judgeModel = flag("judge-model", null) ?? process.env.PI_FLOWS_JUDGE_MODEL ?? "anthropic/claude-haiku-4-5";
const capUsd = Number(flag("cap", "1.00"));
const dryRun = args.includes("--dry-run");
const pairwise = args.includes("--pairwise");
const filter = flag("filter", "");
const writeArtifact = flag("write", "");

function preflight() {
	if (dryRun) return true;
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		console.error("✗ `pi` was not found on PATH.\n  Install: npm i -g @earendil-works/pi-coding-agent  ·  or smoke-test offline with --dry-run");
		return false;
	}
}

const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "n/a");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fixed = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);

async function runArm(kind, testCase, flow, signal) {
	const cwd = caseCwd(testCase, { dryRun });
	const flowCtx = { cwd, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
	const ctx = { flow, model: subjectModel, dryRun, flowCtx };
	const judgeCtx = { flow, model: judgeModel, dryRun, flowCtx, maxCostUsd: capUsd };
	const startedAt = Date.now();

	let result;
	let thrown;
	if (dryRun) {
		result = testCase.mock;
	} else if (kind === "flows") {
		const params = { ...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params, model)), traceLabel: testCase.name, maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: testCase.params.timeoutMs ?? 120000 };
		try {
			result = await flow.execute(`cmp:flows:${testCase.name}`, params, signal, undefined, flowCtx);
		} catch (error) {
			thrown = error;
		}
	} else {
		// Plain arm: the raw task a user would type to pi with no flows installed.
		const task = testCase.baselinePrompt ?? testCase.params.task;
		try {
			result = await runPlainPi({ task, cwd, model: subjectModel, timeoutMs: 120000, signal });
		} catch (error) {
			thrown = error;
		}
	}

	const arm = await scoreArm({ result, thrown, testCase, ctx, judgeCtx });
	return { ...arm, durationMs: Date.now() - startedAt, answer: answerText(result) };
}

// Order-bias-controlled pairwise verdict: judge twice with the answers swapped, and
// only call a winner when BOTH orderings agree — otherwise it's a tie (a flip means
// the judge is keying on position, not content).
async function pairwiseVerdict(judgeCtx, { criteria, flowsAnswer, plainAnswer }) {
	const c1 = await judgePairwise(judgeCtx, { criteria, answerA: flowsAnswer, answerB: plainAnswer });
	const c2 = await judgePairwise(judgeCtx, { criteria, answerA: plainAnswer, answerB: flowsAnswer });
	const cost = (c1.cost ?? 0) + (c2.cost ?? 0);
	const infra = c1.infra ?? c2.infra ?? null;
	if (infra) return { winner: "error", v1: "error", v2: "error", cost, infra };
	const v1 = c1.winner === "TIE" ? "tie" : c1.winner === "A" ? "flows" : "plain"; // flows was A
	const v2 = c2.winner === "TIE" ? "tie" : c2.winner === "A" ? "plain" : "flows"; // flows was B
	const winner = v1 === "flows" && v2 === "flows" ? "flows" : v1 === "plain" && v2 === "plain" ? "plain" : "tie";
	return { winner, v1, v2, cost, infra: null };
}

function armLine(label, arm) {
	const warn = arm.reachedModel ? `  ⚠ ${arm.reachedModel}` : "";
	return `   ${label}  judge ${(arm.judged.score ?? 0).toFixed(2)}${arm.judged.pass ? "" : "✗"}  obj ${(arm.objective.score ?? 0).toFixed(2)}${arm.objective.pass ? "" : "✗"}  $${arm.cost.toFixed(4)}  ${(arm.durationMs / 1000).toFixed(1)}s${warn}`;
}

const pickArm = (a) => ({ judgePass: a.judged.pass, judgeScore: a.judged.score, objPass: a.objective.pass, objScore: a.objective.score, cost: a.cost, durationMs: a.durationMs, infra: a.reachedModel ?? null, answer: (a.answer ?? "").slice(0, 1000) });

async function main() {
	if (!preflight()) process.exit(2);

	const selected = CASES.filter((c) => !filter || c.name.includes(filter));
	if (selected.length === 0) {
		console.error(`No cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	const signal = new AbortController().signal;
	const trace = process.env.PI_FLOWS_TRACE_FILE ? `  ·  trace ${process.env.PI_FLOWS_TRACE_FILE}` : "";
	console.log(`pi-flows A/B (flows vs plain pi)  ·  subject ${useAgentModels ? "(agent frontmatter)" : model}  ·  judge ${dryRun ? "(skipped)" : judgeModel}${pairwise ? " +pairwise" : ""}  ·  cap $${capUsd.toFixed(2)}/case${trace}${dryRun ? "  ·  DRY RUN" : ""}\n`);

	const rows = [];
	let pairwiseCost = 0;
	for (const testCase of selected) {
		const flows = await runArm("flows", testCase, flow, signal);
		const plain = await runArm("plain", testCase, flow, signal);

		let pv = null;
		if (pairwise && !flows.reachedModel && !plain.reachedModel && testCase.criterion) {
			const judgeCtx = { flow, model: judgeModel, dryRun, flowCtx: { cwd: process.cwd(), hasUI: false, ui: { confirm: async () => true, notify: () => undefined } }, maxCostUsd: capUsd };
			pv = await pairwiseVerdict(judgeCtx, { criteria: testCase.criterion, flowsAnswer: flows.answer, plainAnswer: plain.answer });
			pairwiseCost += pv.cost ?? 0;
		}
		rows.push({ name: testCase.name, flows, plain, pv });

		const dj = (flows.judged.score ?? 0) - (plain.judged.score ?? 0);
		const arrow = dj > 0.001 ? "▲ flows" : dj < -0.001 ? "▼ plain" : "= tie";
		console.log(testCase.name);
		console.log(armLine("flows", flows));
		console.log(armLine("plain", plain));
		console.log(`   judge Δ ${fixed(dj)}  ${arrow}`);
		if (pv) {
			const label = pv.winner === "flows" ? "▲ flows" : pv.winner === "plain" ? "▼ plain" : pv.winner === "error" ? `⚠ ${pv.infra}` : "= tie";
			console.log(`   pairwise ${label}  (swap: ${pv.v1}, ${pv.v2})`);
		}
		console.log("");
	}

	const fJudge = mean(rows.map((r) => r.flows.judged.score ?? 0));
	const pJudge = mean(rows.map((r) => r.plain.judged.score ?? 0));
	const fCrit = rows.filter((r) => r.flows.judged.pass).length;
	const pCrit = rows.filter((r) => r.plain.judged.pass).length;
	const fCost = rows.reduce((a, r) => a + r.flows.cost, 0);
	const pCost = rows.reduce((a, r) => a + r.plain.cost, 0);
	const fSec = rows.reduce((a, r) => a + r.flows.durationMs, 0) / 1000;
	const pSec = rows.reduce((a, r) => a + r.plain.durationMs, 0) / 1000;
	const wins = rows.filter((r) => (r.flows.judged.score ?? 0) - (r.plain.judged.score ?? 0) > 0.001).length;
	const losses = rows.filter((r) => (r.plain.judged.score ?? 0) - (r.flows.judged.score ?? 0) > 0.001).length;

	console.log(`Summary over ${rows.length} case${rows.length === 1 ? "" : "s"}`);
	if (pairwise) {
		const pw = (w) => rows.filter((r) => r.pv?.winner === w).length;
		console.log(`  pairwise       flows wins ${pw("flows")} · plain wins ${pw("plain")} · ties ${pw("tie")}${pw("error") ? ` · errors ${pw("error")}` : ""}   (order-controlled — the sensitive metric)`);
	}
	console.log(`  abs judge pass flows ${fCrit}/${rows.length} (${pct(fCrit, rows.length)})    plain ${pCrit}/${rows.length} (${pct(pCrit, rows.length)})`);
	console.log(`  abs mean judge flows ${fJudge.toFixed(2)}    plain ${pJudge.toFixed(2)}    lift ${fixed(fJudge - pJudge)}  (low resolution — read pairwise instead)`);
	console.log(`  abs per-case   flows wins ${wins} · plain wins ${losses} · ties ${rows.length - wins - losses}`);
	console.log(`  cost           flows $${fCost.toFixed(4)}    plain $${pCost.toFixed(4)}    (${pCost > 0 ? `${(fCost / pCost).toFixed(1)}× more` : "n/a"})${pairwise ? `  ·  pairwise judging $${pairwiseCost.toFixed(4)}` : ""}`);
	console.log(`  wall-clock     flows ${fSec.toFixed(0)}s    plain ${pSec.toFixed(0)}s`);
	console.log("\nNote: pairwise (same criterion, cross-model judge, told not to reward length) is the fair head-to-head. Some objective checks are pi-flows-only (route dispatch, same-model vote warning); plain pi cannot satisfy them by design, so read those as capabilities flows adds, not plain losses.");

	if (writeArtifact && !dryRun) {
		const out = resolve(process.cwd(), writeArtifact);
		writeFileSync(out, `${JSON.stringify({ model: useAgentModels ? "agent" : model, judgeModel, capUsd, pairwise, rows: rows.map((r) => ({ name: r.name, pairwise: r.pv?.winner ?? null, pairwiseSwap: r.pv ? [r.pv.v1, r.pv.v2] : null, flows: pickArm(r.flows), plain: pickArm(r.plain) })) }, null, 2)}\n`, "utf8");
		console.log(`\nWrote comparison: ${out}`);
	}

	const anyInfra = rows.some((r) => r.flows.reachedModel || r.plain.reachedModel);
	if (anyInfra) {
		console.log("\n⚠ Some arms could not reach a model (auth, credits, network, or timeout) — environment, not a result. Check `pi` /login for both the subject and judge providers.");
	}
}

main().catch((error) => {
	console.error(`compare failed: ${error?.stack ?? error}`);
	process.exit(1);
});
