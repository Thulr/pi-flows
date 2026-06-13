// Flows-vs-plain A/B: does pi-flows actually beat plain pi on the same task?
//
// For each case it runs TWO arms on the SAME subject model and grades BOTH with the
// same objective scorer + the same cross-model judge:
//   flows : the case's flow params — pi-flows' specialist agents + orchestration
//   plain : one headless `pi --no-extensions` call with the raw task — no flows
// Then reports per-case and aggregate deltas.
//
//   npm run eval:compare                       # all cases, both arms, on your pi default
//   npm run eval:compare -- --pairwise          # add thulr's relative duel (the sensitive metric)
//   npm run eval:compare -- --filter=vote,route # scope to a comma-separated set of name substrings
//   npm run eval:compare -- --timeout=300000    # per-agent ms cap (default 120000) for heavy review/evaluate cases
//   npm run eval:compare -- --model=openai-codex/gpt-5.5 --judge-model=anthropic/claude-sonnet-4-6
//   npm run eval:compare -- --write=evals/compare.json
//   npm run eval:compare -- --dry-run           # wiring smoke (canned results, no model)
//
// Set PI_FLOWS_TRACE_FILE=<path> to also capture per-child OpenInference spans for
// the flows arm (diagnose WHY an arm scored as it did) — the flow tool honors that
// env var, no flag needed.
//
// Absolute judge scores cluster and can't resolve small gaps. With --pairwise the
// harness emits one self-contained trace per arm and shells out to `thulr duel`,
// thulr's calibrated relative judge: it pairs the arms by case id, judges each case
// twice with the answers swapped to cancel order bias, and counts a win only when
// both orderings agree (a flip is reported as judge position bias, not a win). This
// replaces the old in-process pairwise judge. Some objective checks are pi-flows-only
// by construction (route dispatch, the same-model vote warning) and plain pi cannot
// satisfy them — that gap IS the point for those cases.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPlainPi } from "./baseline-pi.mjs";
import { CASES } from "./cases.mjs";
import { answerText, caseCwd, flowTool, scoreArm, DEFAULT_EVAL_MODEL } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import * as thulr from "./thulr.mjs";

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
// Per-agent timeout (ms) for BOTH the subject arms and the cross-model judge. Default
// 120s; raise it for the heavy review/evaluate cases whose arms (or the judge grading
// a long answer) legitimately run minutes — a too-low cap surfaces as ⚠ child timeout
// and drops the case from the duel. Override: --timeout=300000 or PI_FLOWS_TIMEOUT_MS.
const timeoutMs = Number(flag("timeout", process.env.PI_FLOWS_TIMEOUT_MS ?? "120000"));
const dryRun = args.includes("--dry-run");
const pairwise = args.includes("--pairwise");
// --filter is a comma-separated set of name substrings; a case matches if it contains ANY term.
const filter = flag("filter", "");
const filterTerms = filter.split(",").map((t) => t.trim()).filter(Boolean);
const writeArtifact = flag("write", "");
// Same judge-bin resolution as the main harness: the committed wrapper keeps
// extension-provided model providers available to thulr's judge (and duel) calls.
const defaultJudgeBin = "scripts/thulr-judge-pi.sh";
const configuredJudgeBin = flag("judge-bin", null) ?? process.env.THULR_JUDGE_BIN ?? null;
const judgeBin = configuredJudgeBin ?? (existsSync(resolve(process.cwd(), defaultJudgeBin)) ? defaultJudgeBin : null);

// Regenerated duel artifacts (under the gitignored .thulr/ store): one trace per arm
// plus the persisted thulr.duel_report.v1.
const RUNS_DIR = resolve(process.cwd(), ".thulr/runs");
const FLOWS_TRACE = join(RUNS_DIR, "compare-flows.jsonl");
const PLAIN_TRACE = join(RUNS_DIR, "compare-plain.jsonl");
const DUEL_OUT = join(RUNS_DIR, "compare-duel.json");

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
	const judgeCtx = { flow, model: judgeModel, dryRun, flowCtx, maxCostUsd: capUsd, timeoutMs };
	const startedAt = Date.now();

	let result;
	let thrown;
	if (dryRun) {
		result = testCase.mock;
	} else if (kind === "flows") {
		const params = { ...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params, model)), traceLabel: testCase.name, maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: testCase.params.timeoutMs ?? timeoutMs };
		try {
			result = await flow.execute(`cmp:flows:${testCase.name}`, params, signal, undefined, flowCtx);
		} catch (error) {
			thrown = error;
		}
	} else {
		// Plain arm: the raw task a user would type to pi with no flows installed.
		const task = testCase.baselinePrompt ?? testCase.params.task;
		try {
			result = await runPlainPi({ task, cwd, model: subjectModel, timeoutMs, signal });
		} catch (error) {
			thrown = error;
		}
	}

	const arm = await scoreArm({ result, thrown, testCase, ctx, judgeCtx });
	return { ...arm, durationMs: Date.now() - startedAt, answer: answerText(result) };
}

// Emit a self-contained thulr trace for one arm: one case span per eligible row,
// carrying the same case id and criterion in both arms so `thulr duel` can pair
// them. `pick` selects the arm (flows/plain) whose answer this trace grades.
function emitArmTrace(file, eligibleRows, pick) {
	thulr.startTrace(file);
	for (const r of eligibleRows) {
		thulr.appendCaseSpans(file, {
			name: r.name,
			answer: pick(r).answer,
			criterion: r.criterion,
			task: r.task,
			model: subjectModel,
			endMs: Date.now(),
		});
	}
}

function armLine(label, arm) {
	const warn = arm.reachedModel ? `  ⚠ ${arm.reachedModel}` : "";
	return `   ${label}  judge ${(arm.judged.score ?? 0).toFixed(2)}${arm.judged.pass ? "" : "✗"}  obj ${(arm.objective.score ?? 0).toFixed(2)}${arm.objective.pass ? "" : "✗"}  $${arm.cost.toFixed(4)}  ${(arm.durationMs / 1000).toFixed(1)}s${warn}`;
}

const pickArm = (a) => ({ judgePass: a.judged.pass, judgeScore: a.judged.score, objPass: a.objective.pass, objScore: a.objective.score, cost: a.cost, durationMs: a.durationMs, infra: a.reachedModel ?? null, answer: (a.answer ?? "").slice(0, 1000) });

const duelLabel = (outcome) => (
	outcome === "wina" ? "▲ flows"
		: outcome === "winb" ? "▼ plain"
			: outcome === "flip" ? "⚠ flip (judge position bias)"
				: outcome === "tie" ? "= tie"
					: "— (not judged)"
);

async function main() {
	if (!preflight()) process.exit(2);

	const selected = CASES.filter((c) => filterTerms.length === 0 || filterTerms.some((t) => c.name.includes(t)));
	if (selected.length === 0) {
		console.error(`No cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	const flow = flowTool();
	const signal = new AbortController().signal;
	const trace = process.env.PI_FLOWS_TRACE_FILE ? `  ·  trace ${process.env.PI_FLOWS_TRACE_FILE}` : "";
	console.log(`pi-flows A/B (flows vs plain pi)  ·  subject ${useAgentModels ? "(agent frontmatter)" : model}  ·  judge ${dryRun ? "(skipped)" : judgeModel}${pairwise ? " +duel" : ""}  ·  cap $${capUsd.toFixed(2)}/case  ·  timeout ${Math.round(timeoutMs / 1000)}s/agent${trace}${dryRun ? "  ·  DRY RUN" : ""}\n`);

	const rows = [];
	for (const testCase of selected) {
		const flows = await runArm("flows", testCase, flow, signal);
		const plain = await runArm("plain", testCase, flow, signal);

		// Eligible for the duel only when BOTH arms reached the model (an infra miss
		// has no real answer to compare) and the case states a criterion to judge.
		const duelEligible = !flows.reachedModel && !plain.reachedModel && Boolean(testCase.criterion);
		rows.push({ name: testCase.name, criterion: testCase.criterion, task: testCase.baselinePrompt ?? testCase.params.task, flows, plain, duelEligible, outcome: null });

		const dj = (flows.judged.score ?? 0) - (plain.judged.score ?? 0);
		const arrow = dj > 0.001 ? "▲ flows" : dj < -0.001 ? "▼ plain" : "= tie";
		console.log(testCase.name);
		console.log(armLine("flows", flows));
		console.log(armLine("plain", plain));
		console.log(`   judge Δ ${fixed(dj)}  ${arrow}`);
		console.log("");
	}

	// Relative head-to-head via thulr's calibrated, position-swapped duel. One
	// `thulr duel` over the two arm traces does every swap-controlled comparison at
	// once (paired by case id), replacing the harness's old in-process pairwise judge.
	let duelReport = null;
	if (pairwise && !dryRun) {
		const eligible = rows.filter((r) => r.duelEligible);
		if (!thulr.available()) {
			console.log("⚠ --pairwise needs the `thulr` CLI for the duel (relative judging); it was not found on PATH.\n  Install it (e.g. `cargo install thulr`) or drop --pairwise. The absolute deltas above still stand.\n");
		} else if (eligible.length === 0) {
			console.log("⚠ --pairwise: no case had both arms reach the model, so there is nothing to duel.\n");
		} else {
			mkdirSync(RUNS_DIR, { recursive: true });
			emitArmTrace(FLOWS_TRACE, eligible, (r) => r.flows);
			emitArmTrace(PLAIN_TRACE, eligible, (r) => r.plain);
			try {
				duelReport = thulr.duel({ traceA: FLOWS_TRACE, traceB: PLAIN_TRACE, labelA: "flows", labelB: "plain", model: judgeModel, out: DUEL_OUT, judgeBin, json: true });
				const outcomeByCase = new Map((duelReport.cases ?? []).map((c) => [c.case_id, c.outcome]));
				for (const r of rows) r.outcome = outcomeByCase.get(r.name) ?? null;
			} catch (error) {
				console.log(`⚠ thulr duel failed: ${error?.message ?? error}\n`);
			}
		}
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
	console.log(`  abs judge pass flows ${fCrit}/${rows.length} (${pct(fCrit, rows.length)})    plain ${pCrit}/${rows.length} (${pct(pCrit, rows.length)})`);
	console.log(`  abs mean judge flows ${fJudge.toFixed(2)}    plain ${pJudge.toFixed(2)}    lift ${fixed(fJudge - pJudge)}  (low resolution — read the duel instead)`);
	console.log(`  abs per-case   flows wins ${wins} · plain wins ${losses} · ties ${rows.length - wins - losses}`);
	console.log(`  cost           flows $${fCost.toFixed(4)}    plain $${pCost.toFixed(4)}    (${pCost > 0 ? `${(fCost / pCost).toFixed(1)}× more` : "n/a"})`);
	console.log(`  wall-clock     flows ${fSec.toFixed(0)}s    plain ${pSec.toFixed(0)}s`);

	if (pairwise && duelReport) {
		console.log("\nPairwise duel (thulr · order-controlled relative judging — the sensitive metric)");
		for (const r of rows) {
			if (!r.duelEligible) {
				console.log(`   ${r.name.padEnd(34)} — (skipped: an arm did not reach the model)`);
				continue;
			}
			console.log(`   ${r.name.padEnd(34)} ${duelLabel(r.outcome)}`);
		}
		for (const line of thulr.formatDuelSummary(duelReport)) console.log(`   ${line}`);
	}

	console.log("\nNote: the thulr duel (same criterion, cross-model judge, positions swapped, told not to reward length) is the fair head-to-head; a flip means the judge keyed on position, not content. Some objective checks are pi-flows-only (route dispatch, same-model vote warning); plain pi cannot satisfy them by design, so read those as capabilities flows adds, not plain losses.");

	if (writeArtifact && !dryRun) {
		const out = resolve(process.cwd(), writeArtifact);
		writeFileSync(out, `${JSON.stringify({ model: useAgentModels ? "agent" : model, judgeModel, capUsd, pairwise, duel: duelReport?.summary ?? null, rows: rows.map((r) => ({ name: r.name, duel: r.outcome, flows: pickArm(r.flows), plain: pickArm(r.plain) })) }, null, 2)}\n`, "utf8");
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
