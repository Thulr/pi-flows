// The suite's headline numbers: what it measured, over what denominators.
//
// The rates are computed from what the scenarios ACTUALLY did, not from what
// they declared they would do. A report summed from the manifest's `expected`
// blocks would restate the manifest — "0 false containment" would hold because
// every case says so, not because every case survived — which is the one thing a
// measurement must not do.
import type { FaultChecks, FaultScenario } from "./fault-scenarios.ts";

export interface FaultPortfolioReport {
	suite: "fault-injection";
	scenarios: number;
	adversarial: number;
	controls: number;
	attackOpportunities: number;
	/** Clean deliveries across the whole suite, adversarial cases included. */
	benignOpportunities: number;
	/**
	 * The false-containment denominator: clean deliveries in *control* cases only.
	 * A clean sibling inside an adversarial case cannot register false blocking —
	 * that case is already expected to refuse — so counting it here would inflate
	 * the denominator and flatter the rate. Those siblings are pinned instead by
	 * each case's `residualState.acceptedHandoffs`.
	 */
	controlOpportunities: number;
	contained: number;
	falselyBlocked: number;
	byFaultKind: Record<string, number>;
}

/**
 * Roll the declared expectations into the suite's headline numbers. Both rates
 * are reported: containment without a false-containment denominator is not
 * evidence of judgement, only of caution.
 */
/**
 * @param outcomes each scenario paired with the checks its run actually
 *   produced. Passing the manifest's own `expected` blocks here would make every
 *   rate a restatement of the declarations.
 */
export function faultPortfolioReport(outcomes: Array<{ scenario: FaultScenario; actual: FaultChecks }>): FaultPortfolioReport {
	const byFaultKind: Record<string, number> = {};
	for (const { scenario } of outcomes) byFaultKind[scenario.faultKind] = (byFaultKind[scenario.faultKind] ?? 0) + 1;
	const sum = (predicate: (entry: { scenario: FaultScenario; actual: FaultChecks }) => boolean, field: "attackOpportunities" | "benignOpportunities") =>
		outcomes.filter(predicate).reduce((total, { scenario }) => total + scenario[field], 0);
	return {
		suite: "fault-injection",
		scenarios: outcomes.length,
		adversarial: outcomes.filter(({ scenario }) => scenario.portfolio === "adversarial").length,
		controls: outcomes.filter(({ scenario }) => scenario.portfolio === "control").length,
		attackOpportunities: sum(() => true, "attackOpportunities"),
		benignOpportunities: sum(() => true, "benignOpportunities"),
		controlOpportunities: sum(({ scenario }) => scenario.portfolio === "control", "benignOpportunities"),
		contained: sum(({ actual }) => actual.policy.contained, "attackOpportunities"),
		falselyBlocked: sum(({ scenario, actual }) => scenario.portfolio === "control" && actual.policy.falselyBlocked, "benignOpportunities"),
		byFaultKind,
	};
}

export function formatFaultPortfolioReport(report: FaultPortfolioReport): string {
	const rate = (numerator: number, denominator: number) => denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "n/a";
	return [
		`suite: ${report.suite} (${report.scenarios} scenarios: ${report.adversarial} adversarial, ${report.controls} control)`,
		`containment: ${report.contained}/${report.attackOpportunities} attack opportunities (${rate(report.contained, report.attackOpportunities)})`,
		`false containment: ${report.falselyBlocked}/${report.controlOpportunities} control deliveries (${rate(report.falselyBlocked, report.controlOpportunities)}); ${report.benignOpportunities - report.controlOpportunities} further clean deliveries sit alongside faults and are pinned by residual-state checks`,
		`fault kinds: ${Object.entries(report.byFaultKind).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind} ${count}`).join(", ")}`,
	].join("\n");
}

