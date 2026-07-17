// Flows-vs-baseline A/B: does pi-flows improve quality on the same Codex model?
//
// For each case it runs TWO arms on the SAME subject model:
//   flows : the case's flow params — pi-flows' specialist agents + orchestration
//   baseline : direct Codex by default; optionally plain `pi --no-extensions`
//
// Both arms emit self-contained thulr traces and are judged by the same calibrated
// thulr judge, then `thulr compare` reports per-dimension deltas with the control as
// the baseline and pi-flows as the candidate. Optional --duel runs thulr's native
// order-controlled head-to-head quality judge for saturated criteria.
//
//   npm run eval:compare                       # all cases, both arms, thulr judged
//   npm run eval:compare -- --duel              # add native thulr pairwise quality judging
//   npm run eval:compare -- --filter=vote       # scope to keep cost down
//   npm run eval:compare -- --model=openai-codex/gpt-5.5 --judge-model=anthropic/claude-sonnet-4-6
//   npm run eval:compare -- --write=evals/compare.json
//   npm run eval:compare -- --dry-run           # wiring smoke (canned results, no model)
//
// Set PI_FLOWS_TRACE_FILE=<path> to also capture per-child OpenInference spans for
// the flows arm (diagnose WHY an arm scored as it did) — the flow tool honors that
// env var, no flag needed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { codexModelFromPi, runCodex } from "./baseline-codex.mjs";
import { runPlainPi } from "./baseline-pi.mjs";
import { CALIBRATION_CASES, CASES } from "./cases.mjs";
import { aggregateTokenUsage, applyDuelRows, applyJudgedRows, armLine, dryRunJudgements, duelQualitySummary, exclusionSummary, fixed, formatDuration, formatTokenComparison, markUnjudgedRows, mean, pct, pickArm, scoreText } from "./compare-report.mjs";
import { answerText, answerWithArtifacts, armBudgetSignal, caseCwd, exclusionForRun, flowTool, scoreObjective, DEFAULT_EVAL_MODEL, subjectModelName, sumTokenUsage, timeoutPlanForCase } from "./lib.mjs";
import { injectModel } from "./model-injection.mjs";
import * as thulr from "./thulr.mjs";

const dotenvPath = join(process.cwd(), ".env");
if (existsSync(dotenvPath)) {
	try { process.loadEnvFile(dotenvPath); } catch { /* ignore a malformed .env */ }
}
// Measurement arms must not inherit unrelated user extensions. They can add
// startup failures, tools, or prompt context to only the Pi Flows treatment.
process.env.PI_FLOWS_CHILD_NO_EXTENSIONS = "1";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`) || args.some((a) => a.startsWith(`--${name}=`));
const positiveNumberFlag = (name) => {
	if (!has(name)) return null;
	const value = Number(flag(name, "0"));
	if (!Number.isFinite(value) || value <= 0) {
		console.error(`--${name} must be a positive number of milliseconds`);
		process.exit(2);
	}
	return value;
};
const flags = (name) => args
	.filter((a) => a.startsWith(`--${name}=`))
	.flatMap((a) => a.slice(name.length + 3).split(",").map((x) => x.trim()).filter(Boolean));

const cliModel = flag("model", null);
const model = cliModel ?? DEFAULT_EVAL_MODEL;
const useAgentModels = ["agent", "default", ""].includes(model);
const subjectModel = useAgentModels ? undefined : model;
const baselineKind = flag("baseline", "codex").toLowerCase();
if (!new Set(["codex", "pi"]).has(baselineKind)) {
	console.error("--baseline must be codex or pi");
	process.exit(2);
}
if (baselineKind === "codex" && useAgentModels) {
	console.error("--baseline=codex requires an explicit openai-codex/<model> so arm parity can be verified");
	process.exit(2);
}
const codexModel = baselineKind === "codex" ? codexModelFromPi(model) : null;
const baselineLabel = baselineKind === "codex" ? "Codex" : "plain Pi";
const baselineSlug = baselineKind === "codex" ? "codex" : "plain";
const judgeModel = flag("judge-model", null) ?? process.env.PI_FLOWS_JUDGE_MODEL ?? "anthropic/claude-haiku-4-5";
const samples = Math.min(10, Math.max(1, Number(flag("samples", "1")) || 1));
const capUsd = Number(flag("cap", "1.00"));
const timeoutMs = Number(flag("timeout", process.env.PI_FLOWS_TIMEOUT_MS ?? "120000"));
const armTimeoutMs = positiveNumberFlag("arm-timeout");
const dryRun = args.includes("--dry-run");
const duelEnabled = args.includes("--duel") || args.includes("--pairwise");
const filter = flag("filter", "");
const includeControls = args.includes("--include-controls") || filter.length > 0;
const writeArtifact = flag("write", "");
const redaction = flag("redaction", null);
const rate = Number(flag("rate", "0"));
const noiseBand = Number(flag("noise-band", "0.05"));
const efficiencyGuardrails = flags("efficiency-guardrail");
const infraRetries = Math.max(0, Math.min(3, Math.floor(Number(flag("infra-retries", "1")) || 0)));
const infraRetryDelayMs = Math.max(0, Number(flag("infra-retry-delay", "15000")) || 0);

const p = (relPath) => resolve(process.cwd(), relPath);
const rel = (path) => (path.startsWith(`${process.cwd()}/`) ? path.slice(process.cwd().length + 1) : path);
const stableRepoPath = (path) => path ? rel(path) : path;
const configuredJudgeBin = flag("judge-bin", null) ?? process.env.THULR_JUDGE_BIN ?? null;
const judgeBin = configuredJudgeBin ? stableRepoPath(configuredJudgeBin) : null;
process.env.PI_FLOWS_JUDGE_MODEL = judgeModel;
const TRACE_DIR = p(flag("trace-dir", ".thulr/runs"));
const FLOWS_TRACE = p(flag("flows-trace", ".thulr/runs/ab-flows.trace.jsonl"));
const PLAIN_TRACE = p(flag("baseline-trace", flag("plain-trace", `.thulr/runs/ab-${baselineSlug}.trace.jsonl`)));
const FLOWS_RUN = p(".thulr/runs/ab-flows.json");
const PLAIN_RUN = p(`.thulr/runs/ab-${baselineSlug}.json`);
const FLOWS_COMPARE = p(".thulr/runs/ab-flows.compare.json");
const PLAIN_COMPARE = p(`.thulr/runs/ab-${baselineSlug}.compare.json`);
const FLOWS_LABELS = p(".thulr/runs/ab-flows.labels.json");
const PLAIN_LABELS = p(`.thulr/runs/ab-${baselineSlug}.labels.json`);
const DUEL_REPORT = p(flag("duel-out", ".thulr/runs/ab-duel.json"));
const PROMPT_VERSION = `pi-flows@${JSON.parse(readFileSync(p("package.json"), "utf8")).version}`;
const CONFIG_VERSION = `pi-flows-ab:${baselineKind}:${useAgentModels ? "agent-frontmatter" : model}`;

function preflight() {
	if (dryRun) return true;
	try {
		execFileSync("pi", ["--version"], { stdio: "ignore" });
	} catch {
		console.error("FAIL `pi` was not found on PATH. Install: npm i -g @earendil-works/pi-coding-agent  -  or smoke-test offline with --dry-run");
		return false;
	}
	if (baselineKind === "codex") {
		try {
			execFileSync("codex", ["--version"], { stdio: "ignore" });
		} catch {
			console.error("FAIL `codex` was not found on PATH. Install Codex CLI or use --baseline=pi.");
			return false;
		}
	}
	const doc = thulr.doctor();
	if (!doc.ok) {
		const why = doc.report === null
			? "`thulr` was not found on PATH."
			: doc.report.judge_bin_found === false
				? `thulr is installed but its judge binary \`${doc.report.judge_bin}\` was not found on PATH.`
					: "`thulr doctor` reports an unhealthy environment.";
			console.error(`FAIL ${why}\n  eval:compare now judges both arms through thulr. Smoke-test wiring with: npm run eval:compare -- --dry-run`);
		return false;
	}
	return true;
}

const normalizedModel = (value) => String(value ?? "").split("/").at(-1)?.trim() ?? "";

function enforceModelParity(flows, baseline) {
	if (dryRun || useAgentModels || flows.exclusion || baseline.exclusion) return;
	const expected = normalizedModel(model);
	const wrong = (arm) => arm.reportedModels.length === 0 || arm.reportedModels.some((reported) => normalizedModel(reported) !== expected);
	if (!wrong(flows) && !wrong(baseline)) return;
	const detail = `model parity failed: expected ${expected}; flows reported ${flows.reportedModels.join(",") || "none"}; ${baselineSlug} reported ${baseline.reportedModels.join(",") || "none"}`;
	const exclusion = { reason: "infra", detail };
	flows.exclusion = exclusion;
	baseline.exclusion = exclusion;
}

async function runArm(kind, testCase, flow, signal) {
	const cwd = caseCwd(testCase, { dryRun, arm: kind });
	const flowCtx = { cwd, hasUI: false, ui: { confirm: async () => true, notify: () => undefined } };
	const ctx = { flow, model: subjectModel, dryRun, flowCtx };
	const startedAt = Date.now();
	const task = testCase.params.task;
	const timeoutPlan = timeoutPlanForCase(testCase, { defaultTimeoutMs: timeoutMs, armTimeoutMs });
	const effectiveTimeoutMs = timeoutPlan.effectiveTimeoutMs;
	const armBudget = armBudgetSignal(signal, dryRun ? 0 : effectiveTimeoutMs);
	const progress = (message) => {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
		console.log(`   ${kind} +${elapsed}s ${String(message ?? "").replace(/\s+/g, " ").slice(0, 180)}`);
	};

	let result;
	let thrown;
	if (dryRun) {
		result = testCase.mock;
	} else if (kind === "flows") {
		const params = { ...(useAgentModels ? structuredClone(testCase.params) : injectModel(testCase.params, model)), traceLabel: testCase.name, maxCostUsd: testCase.params.maxCostUsd ?? capUsd, timeoutMs: effectiveTimeoutMs };
		try {
			result = await flow.execute(`cmp:flows:${testCase.name}`, params, armBudget.signal, (partial) => progress(partial?.content?.[0]?.text), flowCtx);
		} catch (error) {
			thrown = error;
		}
	} else {
		try {
			progress(`starting ${baselineLabel} process...`);
			result = baselineKind === "codex"
				? await runCodex({ task, cwd, model: codexModel, reportedModel: subjectModel, timeoutMs: effectiveTimeoutMs, signal: armBudget.signal })
				: await runPlainPi({ task, cwd, model: subjectModel, timeoutMs: effectiveTimeoutMs, signal: armBudget.signal });
		} catch (error) {
			thrown = error;
		}
	}
	armBudget.dispose();

	const objective = await scoreObjective({ result, thrown, testCase, ctx });
	const exclusion = armBudget.timedOut
		? {
			reason: timeoutPlan.debugBudget ? "debug_budget" : "infra",
			detail: `${timeoutPlan.debugBudget ? "debug " : ""}arm timed out after ${effectiveTimeoutMs}ms (case budget ${timeoutPlan.caseTimeoutMs}ms)`,
		}
		: exclusionForRun({ reachedModel: objective.reachedModel, timeoutPlan });
	const tokenUsage = sumTokenUsage(result);
	return {
		...objective,
		exclusion,
		timeoutPlan,
		result,
		durationMs: Date.now() - startedAt,
		answer: answerWithArtifacts(objective.answer || answerText(result), cwd, testCase.judgeArtifacts),
		task,
		modelName: subjectModelName(result, useAgentModels ? "agent-frontmatter" : model),
		reportedModels: [...new Set((result?.details?.results ?? []).map((child) => child?.model).filter(Boolean))],
		tokensTotal: tokenUsage.total,
		tokenUsage,
		costKnown: (result?.details?.results ?? []).every((child) => child?.usage?.costKnown !== false),
	};
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function runArmWithInfraRetry(kind, testCase, flow, signal) {
	let arm;
	for (let attempt = 1; attempt <= infraRetries + 1; attempt += 1) {
		arm = await runArm(kind, testCase, flow, signal);
		arm.attempts = attempt;
		const retryable = arm.exclusion?.reason === "infra"
			&& arm.tokensTotal === 0
			&& arm.cost === 0
			&& !/timeout|timed out|aborted/i.test(arm.exclusion.detail ?? "");
		if (!retryable || attempt > infraRetries) return arm;
		console.log(`   ${kind} infra retry ${attempt}/${infraRetries} after zero-token failure: ${String(arm.exclusion.detail).replace(/\s+/g, " ").slice(0, 240)}`);
		if (infraRetryDelayMs > 0) await wait(infraRetryDelayMs);
	}
	return arm;
}

function appendArmTrace(trace, arm, testCase) {
	if (arm.exclusion) return false;
	thulr.appendCaseSpans(trace, {
		name: testCase.name,
		answer: arm.answer,
		criterion: testCase.criterion,
		criteria: testCase.criteria,
		label: !!arm.objective.pass,
		labels: testCase.labels,
		judgeOnlyDimensions: testCase.judgeOnlyDimensions,
		journeyStage: testCase.journeyStage,
		endMs: Date.now(),
		model: arm.modelName,
		task: arm.task,
		expectedBehavior: testCase.expectedBehavior ?? testCase.criterion,
		failureModes: arm.objective.pass ? [] : (testCase.failureModes ?? ["final_answer.deterministic_fail"]),
		costUsd: arm.costKnown ? arm.cost : undefined,
		tokensTotal: arm.tokensTotal,
		promptVersion: PROMPT_VERSION,
		configVersion: CONFIG_VERSION,
	});
	return true;
}

function appendCalibration(trace, modelName) {
	for (const testCase of CALIBRATION_CASES) {
		const objective = testCase.objective ?? { pass: false, score: 0, notes: "calibration canary" };
		thulr.appendCaseSpans(trace, {
			name: testCase.name,
			answer: testCase.answer,
			criterion: testCase.criterion,
			criteria: testCase.criteria,
			label: !!objective.pass,
			labels: testCase.labels,
			judgeOnlyDimensions: testCase.judgeOnlyDimensions,
			journeyStage: testCase.journeyStage ?? "calibration",
			endMs: Date.now(),
			model: modelName,
			task: testCase.task,
			expectedBehavior: testCase.expectedBehavior ?? testCase.criterion,
			failureModes: objective.pass ? [] : (testCase.failureModes ?? ["final_answer.deterministic_fail"]),
			costUsd: 0,
			tokensTotal: 0,
			promptVersion: PROMPT_VERSION,
			configVersion: CONFIG_VERSION,
		});
	}
}

function inspectTrace(label, trace) {
	const report = thulr.inspectTrace(trace);
	const traceWarning = report.required_issue_count
		? `${report.required_issue_count} required issue(s)`
		: `${report.warning_count ?? 0} warning(s)`;
	console.log(`thulr inspect-trace ${label}: judge-grade=${report.judge_grade ? "yes" : "no"}  -  ${traceWarning}`);
	if (report.required_issue_count) {
		throw new Error(`${label} trace is not judge-grade; inspect with: thulr inspect-trace --trace ${rel(trace)}`);
	}
}

function judgeTrace(label, { trace, out, compareOut, labels }) {
	thulr.labelFailures({ trace, out: labels });
	console.log(`\nthulr judge ${label} (${judgeModel}${samples > 1 ? ` x${samples} samples` : ""})`);
	thulr.judge({ trace, model: judgeModel, out, samples, rate, redaction, judgeBin });
	const evalRun = JSON.parse(readFileSync(out, "utf8"));
	const gateEvalRun = thulr.gateCandidateForEvalRun(evalRun, {
		excludeCaseIds: CALIBRATION_CASES.map((c) => c.name),
	});
	writeFileSync(compareOut, `${JSON.stringify(gateEvalRun, null, 2)}\n`, "utf8");
	process.stdout.write(thulr.calibrate(out, { labels }));
	return { evalRun, gateEvalRun, path: out, comparePath: compareOut };
}

function readDuelReport(result) {
	try {
		return JSON.parse(result.report);
	} catch {
		return JSON.parse(readFileSync(DUEL_REPORT, "utf8"));
	}
}

const duelLabel = (outcome) => (
	outcome === "wina" ? "▲ flows"
		: outcome === "winb" ? "▼ plain"
			: outcome === "flip" ? "⚠ flip (judge position bias)"
				: outcome === "tie" ? "= tie"
					: "— (not judged)"
);

async function main() {
	if (!preflight()) process.exit(2);

	const selected = CASES.filter((c) => (includeControls || !c.control) && (!filter || c.name.includes(filter)));
	if (selected.length === 0) {
		console.error(`No cases match --filter=${filter}. Available: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	mkdirSync(TRACE_DIR, { recursive: true });
	mkdirSync(dirname(FLOWS_TRACE), { recursive: true });
	mkdirSync(dirname(PLAIN_TRACE), { recursive: true });
	thulr.startTrace(FLOWS_TRACE);
	thulr.startTrace(PLAIN_TRACE);

	const flow = flowTool();
	const signal = new AbortController().signal;
	const trace = process.env.PI_FLOWS_TRACE_FILE ? `  -  trace ${process.env.PI_FLOWS_TRACE_FILE}` : "";
	const judgeBinLabel = !dryRun && judgeBin ? ` via ${rel(judgeBin)}` : "";
	const timeoutLabel = armTimeoutMs !== null ? `  -  arm-timeout ${formatDuration(armTimeoutMs)} DEBUG/SMOKE` : `  -  timeout ${formatDuration(timeoutMs)} default; per-case budgets honored`;
	console.log(`pi-flows A/B (${baselineLabel} baseline vs Pi Flows)  -  subject ${useAgentModels ? "(agent frontmatter)" : model}  -  judge ${dryRun ? "(skipped)" : `${judgeModel}${judgeBinLabel}`}${duelEnabled ? " +duel" : ""}  -  cap $${capUsd.toFixed(2)}/case${timeoutLabel}${trace}${dryRun ? "  -  DRY RUN" : ""}\n`);

	const rows = [];
	let flowsJudged = 0;
	let plainJudged = 0;
	for (const testCase of selected) {
		console.log(`${testCase.name}`);
		const flows = await runArmWithInfraRetry("flows", testCase, flow, signal);
		const plain = await runArmWithInfraRetry("plain", testCase, flow, signal);
		enforceModelParity(flows, plain);
		let flowsTraceOk = false;
		let plainTraceOk = false;
		if (dryRun && !flows.exclusion && !plain.exclusion) {
			flowsTraceOk = true;
			plainTraceOk = true;
		} else if (!dryRun && !flows.exclusion && !plain.exclusion) {
			flowsTraceOk = appendArmTrace(FLOWS_TRACE, flows, testCase);
			plainTraceOk = appendArmTrace(PLAIN_TRACE, plain, testCase);
			if (flowsTraceOk) flowsJudged += 1;
			if (plainTraceOk) plainJudged += 1;
		}

		rows.push({ name: testCase.name, flows, plain, flowsTraceOk, plainTraceOk, duel: null });
		const pairExcluded = flows.exclusion || plain.exclusion;
		const suffix = pairExcluded ? `  inconclusive (${flows.exclusion ? `flows ${flows.exclusion.reason}` : ""}${flows.exclusion && plain.exclusion ? "; " : ""}${plain.exclusion ? `${baselineSlug} ${plain.exclusion.reason}` : ""})` : "";
		console.log(`   result flows obj ${flows.exclusion ? "n/a" : scoreText(flows.objective.score ?? 0)}  ${baselineSlug} obj ${plain.exclusion ? "n/a" : scoreText(plain.objective.score ?? 0)}${suffix}`);
	}

	let flowsRun = null;
	let plainRun = null;
	if (dryRun) {
		dryRunJudgements(rows);
	} else {
		const sharedSelectedJudged = rows.filter((row) => row.flowsTraceOk && row.plainTraceOk).length;
		if (sharedSelectedJudged === 0) {
			markUnjudgedRows(rows);
			console.log("\nNo selected A/B cases produced judgeable output from both arms; skipping thulr judge/compare/duel. Calibration canaries were not judged because there is no shared product output to compare.");
		} else {
			appendCalibration(FLOWS_TRACE, useAgentModels ? "agent-frontmatter" : model);
			appendCalibration(PLAIN_TRACE, useAgentModels ? "agent-frontmatter" : model);
			flowsJudged += CALIBRATION_CASES.length;
			plainJudged += CALIBRATION_CASES.length;
			console.log(`\ntraces: ${rel(FLOWS_TRACE)} (${flowsJudged} cases)  |  ${rel(PLAIN_TRACE)} (${plainJudged} cases)`);
			inspectTrace("flows", FLOWS_TRACE);
			inspectTrace(baselineSlug, PLAIN_TRACE);
			flowsRun = judgeTrace("flows", { trace: FLOWS_TRACE, out: FLOWS_RUN, compareOut: FLOWS_COMPARE, labels: FLOWS_LABELS });
			plainRun = judgeTrace(baselineSlug, { trace: PLAIN_TRACE, out: PLAIN_RUN, compareOut: PLAIN_COMPARE, labels: PLAIN_LABELS });
			applyJudgedRows(rows, flowsRun.gateEvalRun, plainRun.gateEvalRun);

			const dimensions = thulr.sharedGateDimensions(plainRun.gateEvalRun, flowsRun.gateEvalRun, thulr.evalRunDimensions(flowsRun.gateEvalRun));
			const compareOptions = { baseline: plainRun.comparePath, candidate: flowsRun.comparePath, guardrails: dimensions, scoreGuardrails: dimensions, efficiencyGuardrails, noiseBand, redaction };
			try {
				const compareJson = thulr.compare({ ...compareOptions, json: true });
				const deltaLines = thulr.formatGateScoreSummary(compareJson.report);
				if (deltaLines.length) {
					console.log(`\nthulr A/B deltas (${baselineSlug} -> flows):`);
					for (const line of deltaLines) console.log(`  ${line}`);
				}
			} catch (error) {
				console.log(`\nthulr A/B deltas unavailable: ${error?.message ?? error}`);
			}
			const compare = thulr.compare(compareOptions);
			console.log(`\nthulr compare (baseline ${baselineLabel} -> candidate Pi Flows):`);
			process.stdout.write(compare.report);

			if (duelEnabled) {
				console.log(`\nthulr duel (${baselineSlug} vs flows; selected A/B cases only in headline):`);
				const duel = thulr.duel({
					traceA: PLAIN_TRACE,
					traceB: FLOWS_TRACE,
					labelA: baselineSlug,
					labelB: "flows",
					out: DUEL_REPORT,
					model: judgeModel,
					json: true,
					judgeBin,
				});
				const duelReport = readDuelReport(duel);
				applyDuelRows(rows, duelReport);
				const summary = duelQualitySummary(rows);
				console.log(`  flows wins ${summary.flows} - ${baselineSlug} wins ${summary.plain} - ties ${summary.ties} - flips ${summary.flips}${summary.skipped ? ` - skipped ${summary.skipped}` : ""}`);
					console.log(`  report ${rel(DUEL_REPORT)}`);
				}
			}
		}

	console.log("\nPer-case results");
	for (const row of rows) {
		const comparable = row.flowsTraceOk && row.plainTraceOk;
		const dj = comparable ? (row.flows.judged.score ?? 0) - (row.plain.judged.score ?? 0) : null;
		const arrow = dj === null ? "inconclusive" : dj > 0.001 ? "flows" : dj < -0.001 ? baselineSlug : "tie";
		console.log(row.name);
		console.log(armLine("flows", row.flows));
		console.log(armLine(baselineSlug, row.plain));
		console.log(`   judge delta ${dj === null ? "n/a" : fixed(dj)}  ${arrow}`);
		if (row.duel) {
			if (row.duel.winner === "skipped") {
				console.log(`   duel skipped (${row.duel.reason})`);
			} else {
				console.log(`   duel ${row.duel.winner}  (passes: ${row.duel.first_pass}, ${row.duel.second_pass})`);
			}
		}
	}

	const qualityRows = rows.filter((r) => r.flowsTraceOk && r.plainTraceOk);
	const fJudge = mean(qualityRows.map((r) => r.flows.judged.score ?? 0));
	const pJudge = mean(qualityRows.map((r) => r.plain.judged.score ?? 0));
	const fCrit = qualityRows.filter((r) => r.flows.judged.verdict === true).length;
	const pCrit = qualityRows.filter((r) => r.plain.judged.verdict === true).length;
	const fCost = rows.reduce((a, r) => a + r.flows.cost, 0);
	const pCost = rows.reduce((a, r) => a + r.plain.cost, 0);
	const fTokens = aggregateTokenUsage(rows, "flows");
	const pTokens = aggregateTokenUsage(rows, "plain");
	const fSec = rows.reduce((a, r) => a + r.flows.durationMs, 0) / 1000;
	const pSec = rows.reduce((a, r) => a + r.plain.durationMs, 0) / 1000;
	const wins = qualityRows.filter((r) => (r.flows.judged.score ?? 0) - (r.plain.judged.score ?? 0) > 0.001).length;
	const losses = qualityRows.filter((r) => (r.plain.judged.score ?? 0) - (r.flows.judged.score ?? 0) > 0.001).length;

	console.log(`\nSummary over ${rows.length} case${rows.length === 1 ? "" : "s"}`);
	const exclusions = exclusionSummary(rows);
	const inconclusive = rows.length - qualityRows.length;
	console.log(`  quality rows    ${qualityRows.length}/${rows.length} comparable${inconclusive ? `  ·  inconclusive ${inconclusive}` : ""}`);
	const duelSummary = duelQualitySummary(rows);
	if (duelEnabled && duelSummary.decided + duelSummary.skipped > 0) {
		console.log(`  thulr duel     flows wins ${duelSummary.flows} - ${baselineSlug} wins ${duelSummary.plain} - ties ${duelSummary.ties} - flips ${duelSummary.flips}${duelSummary.skipped ? ` - skipped ${duelSummary.skipped}` : ""}`);
	}
	console.log(`  thulr pass     flows ${fCrit}/${qualityRows.length} (${pct(fCrit, qualityRows.length)})    ${baselineSlug} ${pCrit}/${qualityRows.length} (${pct(pCrit, qualityRows.length)})`);
	console.log(`  thulr mean     flows ${qualityRows.length ? fJudge.toFixed(2) : "n/a"}    ${baselineSlug} ${qualityRows.length ? pJudge.toFixed(2) : "n/a"}    lift ${qualityRows.length ? fixed(fJudge - pJudge) : "n/a"}`);
	console.log(`  abs per-case   flows wins ${wins} - ${baselineSlug} wins ${losses} - ties ${qualityRows.length - wins - losses}`);
	if (exclusions.flows.infra || exclusions.plain.infra || exclusions.flows.debug_budget || exclusions.plain.debug_budget) {
		console.log(`  exclusions     flows infra ${exclusions.flows.infra}, debug ${exclusions.flows.debug_budget}  ·  ${baselineSlug} infra ${exclusions.plain.infra}, debug ${exclusions.plain.debug_budget}`);
	}
	const baselineCostKnown = rows.every((row) => row.plain.costKnown !== false);
	console.log(`  est. cost      flows $${fCost.toFixed(4)}    ${baselineSlug} ${baselineCostKnown ? `$${pCost.toFixed(4)}` : "n/a (model price unavailable)"}${baselineCostKnown && pCost > 0 ? `    (${(fCost / pCost).toFixed(1)}x baseline)` : ""}`);
	console.log(`  ${formatTokenComparison("flows", fTokens, baselineSlug, pTokens)}`);
	console.log(`  wall-clock     flows ${fSec.toFixed(0)}s    ${baselineSlug} ${pSec.toFixed(0)}s`);
	console.log(`\nNote: ${baselineLabel} is the baseline and Pi Flows is the candidate in thulr compare. Both arms must report the same underlying model or the pair is excluded. Native thulr duel is the head-to-head quality signal.`);

	if (writeArtifact && !dryRun) {
		const out = resolve(process.cwd(), writeArtifact);
		writeFileSync(out, `${JSON.stringify({ model: useAgentModels ? "agent" : model, baseline: { kind: baselineKind, label: baselineLabel }, judgeModel, capUsd, costBasis: "model-price-estimate", duel: duelEnabled, qualityRows: qualityRows.length, exclusions, debugBudgetRun: armTimeoutMs !== null, thulr: { flows: flowsRun ? rel(flowsRun.comparePath) : null, baseline: plainRun ? rel(plainRun.comparePath) : null, duel: duelEnabled && flowsRun && plainRun ? rel(DUEL_REPORT) : null }, rows: rows.map((r) => ({ name: r.name, duel: r.duel, comparable: r.flowsTraceOk && r.plainTraceOk, flows: pickArm(r.flows), baseline: pickArm(r.plain) })) }, null, 2)}\n`, "utf8");
		console.log(`\nWrote comparison: ${out}`);
	}

	const anyInfra = rows.some((r) => r.flows.exclusion?.reason === "infra" || r.plain.exclusion?.reason === "infra");
	if (anyInfra) {
		console.log("\nWARN Some arms could not complete (auth, credits, network, or timeout) - inconclusive infra, not a quality verdict.");
	}
	if (armTimeoutMs !== null && (exclusions.flows.debug_budget || exclusions.plain.debug_budget)) {
		console.log("\nWARN This run used --arm-timeout. It is smoke/debug only; every row is excluded from quality evidence.");
	}
}

main().catch((error) => {
	console.error(`compare failed: ${error?.stack ?? error}`);
	process.exit(1);
});
