// The suite's headline numbers: what it measured, over what denominators.
//
// The rates are computed from what the scenarios ACTUALLY did, not from what
// they declared they would do. A report summed from the manifest's `expected`
// blocks would restate the manifest — "0 false containment" would hold because
// every case says so, not because every case survived — which is the one thing a
// measurement must not do.
import type { FaultChecks, FaultScenario, HandoffSecurityChecks } from "./fault-scenarios.ts";

export interface HandoffSecurityReport extends HandoffSecurityChecks {
	attackOpportunities: number;
	benignOpportunities: number;
}

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
	handoffSecurity: HandoffSecurityReport;
}

/**
 * Roll the run outcomes into the suite's headline numbers. Both rates are
 * reported: containment without a false-containment denominator is not evidence
 * of judgement, only of caution.
 *
 * @param outcomes each scenario paired with the checks its run actually
 *   produced. Passing the manifest's own `expected` blocks here would make every
 *   rate a restatement of the declarations.
 */
export function faultPortfolioReport(outcomes: Array<{ scenario: FaultScenario; actual: FaultChecks }>): FaultPortfolioReport {
	const byFaultKind: Record<string, number> = {};
	for (const { scenario } of outcomes) byFaultKind[scenario.faultKind] = (byFaultKind[scenario.faultKind] ?? 0) + 1;
	const sum = (predicate: (entry: { scenario: FaultScenario; actual: FaultChecks }) => boolean, field: "attackOpportunities" | "benignOpportunities") =>
		outcomes.filter(predicate).reduce((total, { scenario }) => total + scenario[field], 0);
	const securityOutcomes = outcomes.filter((entry) => entry.actual.handoffSecurity);
	const securitySum = (field: keyof HandoffSecurityChecks) =>
		securityOutcomes.reduce((total, { actual }) => total + actual.handoffSecurity![field], 0);
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
		handoffSecurity: {
			attackOpportunities: securityOutcomes.reduce((total, { scenario }) => total + scenario.attackOpportunities, 0),
			benignOpportunities: securityOutcomes.reduce((total, { scenario }) => total + scenario.benignOpportunities, 0),
			benignUseful: securitySum("benignUseful"),
			attackSucceeded: securitySum("attackSucceeded"),
			propagated: securitySum("propagated"),
			contained: securitySum("contained"),
			sensitiveExposed: securitySum("sensitiveExposed"),
			falselyBlocked: securitySum("falselyBlocked"),
		},
	};
}

export function formatFaultPortfolioReport(report: FaultPortfolioReport): string {
	const rate = (numerator: number, denominator: number) => denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "n/a";
	const security = report.handoffSecurity;
	return [
		`suite: ${report.suite} (${report.scenarios} scenarios: ${report.adversarial} adversarial, ${report.controls} control)`,
		`containment: ${report.contained}/${report.attackOpportunities} attack opportunities (${rate(report.contained, report.attackOpportunities)})`,
		`false containment: ${report.falselyBlocked}/${report.controlOpportunities} control deliveries (${rate(report.falselyBlocked, report.controlOpportunities)}); ${report.benignOpportunities - report.controlOpportunities} further clean deliveries sit alongside faults and are pinned by residual-state checks`,
		`fault kinds: ${Object.entries(report.byFaultKind).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind} ${count}`).join(", ")}`,
		`handoff benign utility: ${security.benignUseful}/${security.benignOpportunities} (${rate(security.benignUseful, security.benignOpportunities)})`,
		`handoff attack success: ${security.attackSucceeded}/${security.attackOpportunities} (${rate(security.attackSucceeded, security.attackOpportunities)})`,
		`handoff propagation: ${security.propagated}/${security.attackOpportunities} (${rate(security.propagated, security.attackOpportunities)})`,
		`handoff containment: ${security.contained}/${security.attackOpportunities} (${rate(security.contained, security.attackOpportunities)})`,
		`handoff sensitive exposure: ${security.sensitiveExposed}/${security.attackOpportunities} (${rate(security.sensitiveExposed, security.attackOpportunities)})`,
		`handoff false-positive block: ${security.falselyBlocked}/${security.benignOpportunities} (${rate(security.falselyBlocked, security.benignOpportunities)})`,
	].join("\n");
}
