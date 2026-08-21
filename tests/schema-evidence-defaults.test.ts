// What the published schema advertises about requireEvidence, held to what the
// handlers actually do (issue #172).
//
// The compiled schema is only ever asked for Errors(), never to apply defaults,
// so a TypeBox `default` here is advertisement: it is what the parent model
// reads when it writes a flow call. The enforced value is the `?? …` in each
// handler. Nothing compiles against the pair, so they drifted once already —
// dossier sections asked for evidence while the schema said they did not.
// These tests pin the advertisement against the behavior, per mode.
import assert from "node:assert/strict";
import test from "node:test";

import { FlowParams } from "../extensions/pi-flows/schema.ts";
import { RETURN_EVIDENCE_REQUIREMENT } from "../extensions/pi-flows/validate.ts";
import { runFlow } from "./stub-harness.ts";

const advertisedEvidenceDefault = (schema: any): unknown => schema.properties.requireEvidence.default;

test("the shared task shape advertises evidence off, and a plain task gets none", async () => {
	assert.equal(advertisedEvidenceDefault(FlowParams.properties.tasks.items), false);

	const { calls } = await runFlow(
		{ tier: "capable", tasks: [{ agent: "recon", task: "one" }, { agent: "analyst", task: "two" }] },
		{ recon: "finding one", analyst: "finding two" },
	);
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.ok(!call.task.includes(RETURN_EVIDENCE_REQUIREMENT), `${call.agent} asked for evidence the schema says is off by default`);
	}
});

test("a dossier section advertises evidence on, and gets it without asking", async () => {
	assert.equal(advertisedEvidenceDefault(FlowParams.properties.dossier.properties.sections.items), true);

	const { calls } = await runFlow(
		{
			task: "Reconcile the incident evidence.",
			dossier: {
				sections: [
					{ agent: "recon", task: "source one" },
					{ agent: "analyst", task: "source two" },
				],
				debrief: { agent: "debrief" },
			},
		},
		{ recon: "claim one", analyst: "claim two", debrief: "reconciled" },
	);
	const sections = calls.filter((call) => call.agent !== "debrief");
	assert.equal(sections.length, 2);
	for (const call of sections) {
		assert.ok(call.task.includes(RETURN_EVIDENCE_REQUIREMENT), `dossier section ${call.agent} lost the evidence requirement the schema advertises`);
	}
});

test("a dossier section that opts out is obeyed, so the default stays a default", async () => {
	const { calls } = await runFlow(
		{
			task: "Reconcile the incident evidence.",
			dossier: {
				sections: [
					{ agent: "recon", task: "source one", requireEvidence: false },
					{ agent: "analyst", task: "source two" },
				],
				debrief: { agent: "debrief" },
			},
		},
		{ recon: "claim one", analyst: "claim two", debrief: "reconciled" },
	);
	const opted = calls.find((call) => call.agent === "recon");
	const defaulted = calls.find((call) => call.agent === "analyst");
	assert.ok(opted && !opted.task.includes(RETURN_EVIDENCE_REQUIREMENT), "an explicit false must beat the default");
	assert.ok(defaulted?.task.includes(RETURN_EVIDENCE_REQUIREMENT), "the sibling section keeps the default");
});

test("a worktree worker advertises evidence on, matching its handler", () => {
	// Worktree's writers are the other place a handler defaults evidence on
	// (modes/worktree.ts). Its own task schema already said so; assert it here
	// so both overrides of the shared default are covered by one rule.
	assert.equal(advertisedEvidenceDefault(FlowParams.properties.worktree.properties.tasks.items), true);
});
