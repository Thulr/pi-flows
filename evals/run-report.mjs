// Console layout for the single-arm eval gate (evals/run.mjs) — the sibling of
// compare-report.mjs, which does the same job for the A/B harness.
//
// Every export is a pure string builder: the run loop decides WHAT happened, this
// decides how it reads. Keeping them apart means the wording is unit-testable and
// run.mjs's main() stays a pipeline instead of a print statement with a loop in it.
import { formatDuration } from "./compare-report.mjs";

/**
 * The one-line run banner: subject model and where it came from, judge model and
 * sampling, per-case cap, timeout policy, and the mode the run is in.
 */
export function headerLine({ subject, modelSource, subjectTrials = 1, judgeModel, samples, judgeBin, capUsd, timeoutMs, armTimeoutMs, efficiencyGuardrails, dryRun, traceOnly }) {
	const judged = !dryRun && !traceOnly;
	const judgeLabel = judged ? (samples > 1 ? `${judgeModel} ×${samples} samples (judge noise)` : `${judgeModel} ×1 sample (judge noise)`) : "(skipped)";
	const judgeBinLabel = judged && judgeBin ? ` via ${judgeBin}` : "";
	const efficiencyLabel = efficiencyGuardrails.length ? `  ·  efficiency ${efficiencyGuardrails.join(",")}` : "";
	const timeoutLabel = armTimeoutMs !== null
		? `arm-timeout ${formatDuration(armTimeoutMs)} DEBUG/SMOKE`
		: `timeout ${formatDuration(timeoutMs)}/agent default; per-case budgets honored`;
	const mode = dryRun ? "  ·  DRY RUN" : traceOnly ? "  ·  TRACE ONLY" : "";
	return `pi-flows evals  ·  subject ${subject} (${modelSource}) · ${subjectTrials} subject trial${subjectTrials === 1 ? "" : "s"}  ·  judge ${judgeLabel}${judgeBinLabel}  ·  cap $${capUsd.toFixed(2)}/case/trial  ·  ${timeoutLabel}${efficiencyLabel}${mode}\n`;
}

/**
 * The status glyph for one case. Infra exclusions (⚠) and debug-budget runs (⚑)
 * are inconclusive, not failures; hard cases (◐) are score-tracked rather than
 * pass/fail, so a partial objective score is the expected outcome.
 */
export const statusGlyph = ({ excludedReason, debugBudget, hard, pass }) =>
	excludedReason === "infra" ? "⚠" : debugBudget ? "⚑" : hard ? "◐" : pass ? "✓" : "✗";

/** The two lines one measured case prints: the scoreboard row and its note. */
export function caseLines({ name, objective, excludedReason, timeoutPlan, reachedModel, cost, durationMs, hard }) {
	const status = statusGlyph({ excludedReason, debugBudget: timeoutPlan.debugBudget, hard, pass: objective.pass });
	const seconds = (durationMs / 1000).toFixed(1);
	const debugNote = timeoutPlan.debugBudget
		? `debug budget: arm-timeout ${formatDuration(timeoutPlan.effectiveTimeoutMs)} overrides case budget ${formatDuration(timeoutPlan.caseTimeoutMs)}; excluded from quality verdict`
		: null;
	return [
		`${status} ${name.padEnd(34)} obj ${excludedReason ? "n/a" : (objective.score ?? 0).toFixed(2)}  $${cost.toFixed(4)}  ${seconds}s`,
		`    ↳ ${reachedModel ?? debugNote ?? objective.notes ?? ""}`,
	];
}

/** The two lines one calibration canary prints — fixed answer, no model, no spend. */
export const calibrationLines = ({ name, objective }) => [
	`· ${name.padEnd(34)} canary ${(objective.score ?? 0).toFixed(2)}  $0.0000  0.0s`,
	`    ↳ ${objective.notes ?? ""}`,
];

const excludedSuffix = (excluded) => (excluded ? `  ·  ${excluded} inconclusive/excluded` : "");
const calibrationSuffix = (calibration) => (calibration ? `  ·  ${calibration} calibration canar${calibration === 1 ? "y" : "ies"}` : "");

export const portfolioExcludedCaseIds = (summaries) =>
	[...new Set(summaries.filter((summary) => summary.excludedReason).map((summary) => summary.caseId ?? summary.name))];

/** Phase-1 scoreboard: the objective axis alone, before the judge has spoken. */
export const behaviourCountsLine = ({ passed, measured, excluded, hard, calibration, totalCost, dryRun }) =>
	`\n${passed}/${measured} behaviour checks passed${excludedSuffix(excluded)}${hard ? `  ·  ${hard} hard case${hard === 1 ? "" : "s"} score-tracked` : ""}${calibrationSuffix(calibration)}  ·  total $${totalCost.toFixed(4)}${dryRun ? "  (dry-run, no model)" : ""}`;

/** Final scoreboard: the two-axis verdict plus the gate's answer. */
export const finalCountsLine = ({ passed, measured, excluded, hard, calibration, gateBlocks = null }) =>
	`\n${passed}/${measured} behaviour cases passed${excludedSuffix(excluded)}${hard ? `  ·  ${hard} hard score-tracked` : ""}${calibrationSuffix(calibration)}${gateBlocks === null ? "" : `  ·  gate ${gateBlocks ? "FAIL" : "ok"}`}`;

/** The judge-phase banner, naming the model, the sampling, and the case count. */
export const judgeHeaderLine = ({ judgeModel, samples, judgedCount }) =>
	`\nthulr judge (${judgeModel}${samples > 1 ? ` ×${samples} samples` : ""})  ·  ${judgedCount} case${judgedCount === 1 ? "" : "s"}`;

/**
 * One case's judged verdict: every dimension's score (with `!` marking a failed
 * verdict), the case's role, and the criterion verdict that gates it.
 */
export function verdictLine({ name, calibration, hard }, dims) {
	const criterion = dims.criterion ?? {};
	const role = calibration ? "canary" : hard ? "hard" : "behaviour";
	const verdict = criterion.verdict === false ? "fail" : criterion.verdict === true ? "pass" : "unknown";
	const dimScores = Object.entries(dims)
		.map(([dimension, result]) => `${dimension} ${(result.score ?? 0).toFixed(2)}${result.verdict === false ? "!" : ""}`)
		.join("  ");
	return `${name.padEnd(34)} ${dimScores || "criterion n/a"}  ${role} ${verdict}`;
}

export const INFRA_WARNING = "\n⚠ Some cases could not complete (auth, credits, network, or timeout) — inconclusive infra, not an answer-quality failure.";

export const debugBudgetWarning = (count) =>
	`\n⚑ ${count} case${count === 1 ? " used" : "s used"} an --arm-timeout smoke/debug override and ${count === 1 ? "was" : "were"} excluded from quality verdicts.`;
