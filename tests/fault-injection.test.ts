// Deterministic coordination fault injection.
//
// The suite runs offline through the child-run seam with no model and no
// subprocess, so a coordination fault that a live run reproduces once a month is
// reproduced here on every `npm test`. Each scenario is checked on all four
// families it declares — outcome, process, policy, residual state — because a
// run that returns the right refusal while having already merged the bad work is
// not contained, and a run that refuses a clean input is not safe either.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
	FAULT_KINDS,
	FAULT_SUITE,
	faultPortfolioReport,
	faultScenarios,
	formatFaultPortfolioReport,
	runTraceSuppression,
} from "./fault-scenarios.ts";
import { makeFaultAdapter } from "./fault-adapter.ts";

const scenarios = faultScenarios();

for (const scenario of scenarios) {
	test(`fault scenario: ${scenario.id} — ${scenario.description}`, async () => {
		const actual = await scenario.run();
		assert.deepEqual(actual.outcome, scenario.expected.outcome, "outcome check");
		assert.deepEqual(actual.process, scenario.expected.process, "process check");
		assert.deepEqual(actual.policy, scenario.expected.policy, "policy check");
		assert.deepEqual(actual.residualState, scenario.expected.residualState, "residual-state check");
	});
}

test("every scenario is classified and carries explicit opportunity denominators", () => {
	const ids = new Set<string>();
	for (const scenario of scenarios) {
		assert.equal(scenario.suite, FAULT_SUITE, `${scenario.id} must declare the fault-injection suite`);
		assert.ok(!ids.has(scenario.id), `${scenario.id} is duplicated`);
		ids.add(scenario.id);
		assert.match(scenario.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${scenario.id} must be a stable kebab-case id`);
		assert.ok(scenario.description.trim().length > 0, `${scenario.id} must describe what it injects`);
		// A case with neither denominator measures nothing: it can neither prove
		// containment nor prove that a clean run survived.
		assert.ok(
			scenario.attackOpportunities + scenario.benignOpportunities > 0,
			`${scenario.id} must declare at least one attack or benign opportunity`,
		);
		if (scenario.portfolio === "adversarial") assert.ok(scenario.attackOpportunities > 0, `${scenario.id} is adversarial but injects nothing`);
		if (scenario.portfolio === "control") assert.equal(scenario.attackOpportunities, 0, `${scenario.id} is a control and must not inject a fault`);
	}
});

test("benign controls run through the same harness so false containment stays measurable", () => {
	const report = faultPortfolioReport(scenarios);
	assert.ok(report.controls >= 3, `expected benign controls in the suite, saw ${report.controls}`);
	assert.ok(report.controlOpportunities > 0, "controls must contribute a false-containment denominator");
	assert.ok(report.benignOpportunities > report.controlOpportunities, "adversarial cases also carry clean deliveries alongside their faults");
	// The suite's headline claim: no clean delivery is expected to be blocked.
	assert.equal(report.falselyBlocked, 0, "a control that is expected to be blocked is a false-containment bug, not a passing test");
	assert.ok(report.contained > 0 && report.contained < report.attackOpportunities, "containment must be reported as a rate, not assumed total");
	const formatted = formatFaultPortfolioReport(report);
	assert.match(formatted, /containment: \d+\/\d+ attack opportunities/);
	assert.match(formatted, /false containment: \d+\/\d+ control deliveries/);
	// Print the denominators so a run reports what the suite measured, not just
	// that its assertions held.
	console.log(formatted);
});

test("every injectable fault kind is actually injected by at least one scenario", () => {
	// Checked against the rules the scenarios inject, not against their labels: a
	// label-only check passes forever the moment a case stops injecting anything.
	const injected = new Set(scenarios.flatMap((scenario) => scenario.faults.map((fault) => fault.kind)));
	const missing = FAULT_KINDS.filter((kind) => !injected.has(kind));
	assert.deepEqual(missing, [], `fault kinds the adapter can inject but no scenario injects: ${missing.join(", ")}`);

	// And the label has to agree with the rules, so classification cannot drift
	// from what the case does.
	for (const scenario of scenarios) {
		const kinds = new Set(scenario.faults.map((fault) => fault.kind));
		if (scenario.faultKind === "none") {
			assert.equal(scenario.faults.length, 0, `${scenario.id} is labelled "none" but injects ${[...kinds].join(", ")}`);
		} else {
			assert.ok(kinds.has(scenario.faultKind), `${scenario.id} is labelled ${scenario.faultKind} but injects ${[...kinds].join(", ") || "nothing"}`);
		}
	}
});

test("trace suppression is visible as trace health, not as an agent failure", async () => {
	const suppressed = await runTraceSuppression();
	// The coordination itself is untouched: both children ran and the run stands.
	assert.equal(suppressed.coordinationError, null, "a suppressed export must not fail an otherwise healthy run");
	assert.equal(suppressed.childrenSucceeded, 2);
	// What is lost is the evidence, and that is what strict mode refuses on.
	assert.ok(suppressed.spansAttempted > 0, "the run still tried to export spans");
	assert.equal(suppressed.health, "missing");
	assert.match(String(suppressed.strictIssue), /is missing/);
});

test("the adapter delivers each fault kind deterministically and records it", async () => {
	const options = (agent: string, step: number) => ({
		defaultCwd: "/tmp",
		agents: [],
		agentName: agent,
		task: `task ${step}`,
		step,
		makeDetails: (() => ({})) as any,
	});

	const lost = makeFaultAdapter({ replies: { recon: "fresh" }, faults: [{ kind: "loss", agent: "recon" }] });
	const lostResult = await lost.runChild(options("recon", 1) as any);
	assert.equal(lostResult.error?.code, "CHILD_TIMEOUT");
	assert.equal(lost.ledger.dispatches[0].delivery, "lost");

	const duplicated = makeFaultAdapter({ replies: { recon: ["one", "two"] }, faults: [{ kind: "duplicate", agent: "recon", occurrence: 2 }] });
	const first = await duplicated.runChild(options("recon", 1) as any);
	const second = await duplicated.runChild(options("recon", 2) as any);
	assert.equal(second.messages[0].content[0].text, first.messages[0].content[0].text, "a duplicate delivers the earlier reply verbatim");
	assert.equal(duplicated.ledger.countDelivered("replayed"), 1);

	const reordered = makeFaultAdapter({ replies: { recon: ["one", "two"] }, faults: [{ kind: "reorder", agent: "recon" }] });
	const swappedFirst = await reordered.runChild(options("recon", 1) as any);
	const swappedSecond = await reordered.runChild(options("recon", 2) as any);
	assert.equal(swappedFirst.messages[0].content[0].text, "two");
	assert.equal(swappedSecond.messages[0].content[0].text, "one");
	assert.equal(reordered.ledger.countDelivered("swapped"), 2);

	const failed = makeFaultAdapter({ replies: { redteam: "VERDICT: PASS" }, faults: [{ kind: "failure", agent: "redteam", errorCode: "CHILD_PROVIDER_ERROR" }] });
	const failedResult = await failed.runChild(options("redteam", 1) as any);
	assert.equal(failedResult.error?.code, "CHILD_PROVIDER_ERROR");
	assert.equal(failed.ledger.dispatches[0].delivery, "failed");

	const stale = makeFaultAdapter({ replies: { recon: "current" }, faults: [{ kind: "stale", agent: "recon", replay: "from an earlier revision" }] });
	const staleResult = await stale.runChild(options("recon", 1) as any);
	assert.equal(staleResult.messages[0].content[0].text, "from an earlier revision");
	assert.equal(stale.ledger.dispatches[0].delivery, "replayed");

	// Latency is virtual: a 90s child costs the suite nothing and still hits the ceiling.
	const delayed = makeFaultAdapter({ replies: { recon: "slow" }, faults: [{ kind: "delay", agent: "recon", delayMs: 90_000 }] });
	const startedAt = Date.now();
	const delayedResult = await delayed.runChild({ ...options("recon", 1), timeoutMs: 1_000 } as any);
	assert.equal(delayedResult.error?.code, "CHILD_TIMEOUT");
	assert.equal(delayed.ledger.dispatches[0].durationMs, 90_000);
	assert.ok(Date.now() - startedAt < 1_000, "an injected delay must not actually sleep");
});

test("the same scenario produces the same coordination result on every run", async () => {
	// Determinism is the property the whole suite rests on: a fault case that
	// varies run to run measures scheduling noise, not containment.
	const target = scenarios.find((scenario) => scenario.id === "reordered-responses")!;
	const first = await target.run();
	const second = await target.run();
	assert.deepEqual(first, second);
});
