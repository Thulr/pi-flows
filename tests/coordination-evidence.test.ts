// Minted events (#128): the seams that PERFORM a coordination action record its
// evidence themselves, the way runner.ts records every child span — so a mode
// cannot run a deterministic gate, or turn consent into a durable receipt,
// without the trace fact existing. Each test names one side of that contract:
// the caller owns the attribution (name, placement, its own facts), the seam
// owns the outcome, and a caller without a sink states the absence instead of
// forgetting the evidence.
import test from "node:test";
import { strict as assert } from "node:assert";
import { runCheckCommand } from "../extensions/pi-flows/commands.ts";
import { issueApprovalReceipt, type ApprovalBinding } from "../extensions/pi-flows/approval.ts";
import type { CapturePolicy, CoordinationEvent } from "../extensions/pi-flows/types.ts";

const POLICY: CapturePolicy = { recordContent: true, redactSecrets: true };
const NOW = Date.parse("2026-08-13T12:00:00.000Z");

const binding = (overrides: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
	action: "workflow.phase:ship",
	parameters: { agentScope: "user", marker: "bound-parameter-hunter2" }, // privacy-scan: allow deliberate receipt-leak fixture
	requestedBy: "flow:workflow",
	workflowDigest: "1234567890abcdef",
	stateVersion: 3,
	...overrides,
});

const recorder = () => {
	const events: CoordinationEvent[] = [];
	return { events, record: (event: CoordinationEvent) => events.push(event) };
};

// --- The gate seam ----------------------------------------------------------

test("running a check command IS recording its validation event", async () => {
	const { events, record } = recorder();
	const scope = { key: "phase-build.gate", dependsOn: ["phase-build.work"] };
	const result = await runCheckCommand("exit 0", process.cwd(), 5_000, POLICY, {
		record,
		name: "workflow.gate",
		scope,
		attributes: { "flow.workflow.phase_id": "build" },
	});
	assert.equal(result.ok, true);
	assert.equal(events.length, 1, "the gate ran once, so exactly one event exists");
	const [event] = events;
	assert.equal(event.kind, "validation");
	assert.equal(event.name, "workflow.gate");
	assert.equal(event.ok, true);
	assert.deepEqual(event.scope, scope, "placement is the caller's attribution, carried unchanged");
	assert.equal(event.attributes?.["flow.workflow.phase_id"], "build", "the caller's own facts ride along");
	assert.equal(event.attributes?.["flow.check.passed"], true, "the outcome is the seam's statement");
	assert.equal(event.attributes?.["flow.check.spawn_failed"], undefined, "a gate that ran claims no spawn failure");
});

test("a failing gate records ok:false, and attribution cannot override the outcome", async () => {
	const { events, record } = recorder();
	const result = await runCheckCommand("exit 3", process.cwd(), 5_000, POLICY, {
		record,
		name: "evaluate.check_command",
		// A caller claiming the gate passed is exactly the drift seam minting
		// exists to end: the seam's facts are merged after the attribution.
		attributes: { "flow.check.passed": true },
	});
	assert.equal(result.ok, false);
	const [event] = events;
	assert.equal(event.ok, false);
	assert.equal(event.attributes?.["flow.check.passed"], false, "what happened is the seam's, not the caller's");
});

test("a gate that could not start still leaves evidence of the attempt", async () => {
	const { events, record } = recorder();
	const result = await runCheckCommand("exit 0", "/nonexistent-pi-flows-cwd", 5_000, POLICY, {
		record,
		name: "worktree.integration_check",
	});
	assert.equal(result.spawnFailed, true);
	const [event] = events;
	assert.equal(event.ok, false);
	assert.equal(event.attributes?.["flow.check.spawn_failed"], true, "could-not-run is distinguishable from ran-and-failed");
});

test("a gate with no sink runs with the absence stated, not forgotten", async () => {
	const result = await runCheckCommand("exit 0", process.cwd(), 5_000, POLICY, { record: undefined, name: "workflow.gate" });
	assert.equal(result.ok, true, "record: undefined is the declared no-sink answer and never throws");
});

// --- The receipt seam -------------------------------------------------------

test("issuing an approval receipt IS recording its approval event", () => {
	const { events, record } = recorder();
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, {
		record,
		name: "workflow.approval.issued",
		scope: { key: "phase-gate.approval" },
		attributes: { "flow.approval.reopened": false },
	});
	assert.equal(events.length, 1, "one consent, one event");
	const [event] = events;
	assert.equal(event.kind, "approval");
	assert.equal(event.name, "workflow.approval.issued");
	assert.equal(event.scope?.key, "phase-gate.approval");
	assert.equal(event.attributes?.["flow.approval.reopened"], false, "the caller's own facts ride along");
	// Receipt identity is the seam's statement — the same fields the receipt binds.
	assert.equal(event.attributes?.["flow.approval.receipt_id"], receipt.receiptId);
	assert.equal(event.attributes?.["flow.approval.action"], "workflow.phase:ship");
	assert.equal(event.attributes?.["flow.approval.approved_by"], "justin");
	assert.equal(event.attributes?.["flow.approval.expires_at"], receipt.expiresAt);
	assert.equal(event.attributes?.["flow.approval.validation"], "typed");
	// Identity and status only: what was approved stays inside the binding digest.
	assert.doesNotMatch(JSON.stringify(event), /bound-parameter-hunter2/, "the approved parameters never reach the trace");
});

test("receipt attribution cannot override the identity the seam records", () => {
	const { events, record } = recorder();
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, {
		record,
		name: "workflow.approval.issued",
		// A caller claiming a different approver is the same drift the gate-seam
		// test pins: the seam's facts merge after the attribution.
		attributes: { "flow.approval.approved_by": "someone-else" },
	});
	const [event] = events;
	assert.equal(event.attributes?.["flow.approval.approved_by"], "justin", "receipt identity is the seam's, not the caller's");
	assert.equal(event.attributes?.["flow.approval.receipt_id"], receipt.receiptId);
});

test("a receipt issued with no sink still mints, with the absence stated", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, { record: undefined, name: "workflow.approval.issued" });
	assert.equal(receipt.validation, "typed", "evidence destination is required; the sink itself is not");
});
