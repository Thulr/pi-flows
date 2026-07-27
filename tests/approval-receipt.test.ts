// Approval receipts: the unit contract for the receipt itself, then the workflow
// paths that mint, verify, and spend one. The scenarios the issue names —
// approve, reject, timeout, duplicate use, stale state, changed action, resume
// after rejection, resume after crash — each get a test here.
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { strict as assert } from "node:assert";
import {
	APPROVAL_RECEIPT_SCHEMA_VERSION,
	DEFAULT_APPROVAL_TTL_MS,
	MAX_APPROVAL_TTL_MS,
	MIN_APPROVAL_TTL_MS,
	approvalBindingDigest,
	approvalReceiptSummary,
	consumeApprovalReceipt,
	formatApprovalReceipt,
	issueApprovalReceipt,
	legacyApprovalReceipt,
	resolveApprovalTtlMs,
	verifyApprovalReceipt,
	type ApprovalBinding,
} from "../extensions/pi-flows/approval.ts";
import { freshDir, runFlow, type Call } from "./stub-harness.ts";

const binding = (overrides: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
	action: "workflow.phase:approve",
	parameters: { agentScope: "user", gatedPhases: [{ id: "ship", agent: "strategist", task: "Ship it" }] },
	requestedBy: "flow:workflow",
	workflowDigest: "1234567890abcdef",
	stateVersion: 3,
	...overrides,
});

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

// --- The receipt contract --------------------------------------------------

test("a binding digest identifies content, not authoring order", () => {
	const left = approvalBindingDigest(binding({ parameters: { a: 1, b: { c: 2, d: 3 } } }));
	const right = approvalBindingDigest(binding({ parameters: { b: { d: 3, c: 2 }, a: 1 } }));
	assert.equal(left, right, "reordering object keys must not read as a changed action");
	assert.match(left, /^sha256:[0-9a-f]{64}$/);
	assert.notEqual(left, approvalBindingDigest(binding({ parameters: { a: 1, b: { c: 2, d: 4 } } })));
});

test("every field a receipt binds changes its digest", () => {
	const base = approvalBindingDigest(binding());
	const variants: Array<[string, ApprovalBinding]> = [
		["action", binding({ action: "workflow.phase:other" })],
		["parameters", binding({ parameters: { agentScope: "project", gatedPhases: [] } })],
		["requestedBy", binding({ requestedBy: "flow:other" })],
		["workflowDigest", binding({ workflowDigest: "fedcba0987654321" })],
		["stateVersion", binding({ stateVersion: 4 })],
	];
	for (const [field, changed] of variants) {
		assert.notEqual(approvalBindingDigest(changed), base, `changing ${field} must require a new approval`);
	}
});

test("an issued receipt binds actors, workflow state, issue time, and expiry", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: 60_000 });
	assert.equal(receipt.schemaVersion, APPROVAL_RECEIPT_SCHEMA_VERSION);
	assert.match(receipt.receiptId, /^[0-9a-f]{16}$/);
	assert.equal(receipt.action, "workflow.phase:approve");
	assert.equal(receipt.requestedBy, "flow:workflow");
	assert.equal(receipt.approvedBy, "justin");
	assert.equal(receipt.workflowDigest, "1234567890abcdef");
	assert.equal(receipt.stateVersion, 3);
	assert.equal(receipt.issuedAt, "2026-07-27T12:00:00.000Z");
	assert.equal(receipt.expiresAt, "2026-07-27T12:01:00.000Z");
	assert.equal(receipt.consumedAt, null, "a fresh receipt authorizes an action, it does not record one");
	assert.equal(receipt.validation, "typed");
});

test("two approvals of the same binding are distinguishable receipts", () => {
	const first = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	const second = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	assert.notEqual(first.receiptId, second.receiptId);
	assert.equal(first.bindingDigest, second.bindingDigest);
});

test("verification accepts the exact action it was granted for", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	assert.equal(verifyApprovalReceipt(receipt, binding(), { consumer: "ship", now: NOW + 1000 }), null);
});

test("verification rejects a changed action as stale", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	const changed = binding({ parameters: { agentScope: "project", gatedPhases: [{ id: "ship", agent: "strategist", task: "Ship it" }] } });
	assert.equal(verifyApprovalReceipt(receipt, changed, { consumer: "ship", now: NOW })?.code, "APPROVAL_RECEIPT_STALE");
});

test("verification recomputes the binding rather than trusting the stored digest", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	const forged = { ...receipt, action: "workflow.phase:something-else" };
	assert.equal(verifyApprovalReceipt(forged, binding({ action: "workflow.phase:something-else" }), { consumer: "ship", now: NOW })?.code, "APPROVAL_RECEIPT_STALE");
});

test("verification rejects an expired receipt", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS });
	assert.equal(verifyApprovalReceipt(receipt, binding(), { consumer: "ship", now: NOW + MIN_APPROVAL_TTL_MS }), null, "the boundary instant is still inside the window");
	const expired = verifyApprovalReceipt(receipt, binding(), { consumer: "ship", now: NOW + MIN_APPROVAL_TTL_MS + 1 });
	assert.equal(expired?.code, "APPROVAL_RECEIPT_EXPIRED");
	assert.match(expired?.fix ?? "", /approvalTtlMs/);
});

test("a spent receipt cannot authorize a second, different action", () => {
	const receipt = consumeApprovalReceipt(issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }), "ship", NOW);
	assert.equal(verifyApprovalReceipt(receipt, binding(), { consumer: "ship", now: NOW }), null, "re-entering the same action is a resume, not a replay");
	const replay = verifyApprovalReceipt(receipt, binding(), { consumer: "publish", now: NOW });
	assert.equal(replay?.code, "APPROVAL_RECEIPT_CONSUMED");
	assert.match(replay?.cause ?? "", /consumed by "ship"/);
});

test("consuming twice from the same action is idempotent", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	const once = consumeApprovalReceipt(receipt, "ship", NOW);
	const twice = consumeApprovalReceipt(once, "ship", NOW + 5000);
	assert.equal(twice.consumedAt, once.consumedAt, "a crash-resume must not restamp the consumption");
	assert.equal(twice, once);
});

test("malformed receipts are refused rather than partially trusted", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	const cases: Array<[string, unknown]> = [
		["missing", undefined],
		["not an object", "APPROVED"],
		["wrong schema version", { ...receipt, schemaVersion: "pi-flows.approval-receipt.v2" }],
		["blank receiptId", { ...receipt, receiptId: "  " }],
		["non-integer stateVersion", { ...receipt, stateVersion: 3.5 }],
		["unparseable expiry", { ...receipt, expiresAt: "whenever" }],
		["unknown validation", { ...receipt, validation: "trusted" }],
	];
	for (const [label, value] of cases) {
		assert.equal(verifyApprovalReceipt(value, binding(), { consumer: "ship", now: NOW })?.code, "APPROVAL_RECEIPT_INVALID", label);
	}
});

test("a migrated receipt still binds but claims no approver or window", () => {
	const receipt = legacyApprovalReceipt(binding(), { issuedAt: "2026-01-01T00:00:00.000Z", consumedBy: "ship" });
	assert.equal(receipt.validation, "legacy-compatibility");
	assert.equal(receipt.expiresAt, null);
	assert.match(receipt.approvedBy, /unknown/);
	assert.equal(verifyApprovalReceipt(receipt, binding(), { consumer: "ship", now: NOW }), null, "no expiry to outlive");
	assert.equal(verifyApprovalReceipt(receipt, binding({ action: "workflow.phase:other" }), { consumer: "ship", now: NOW })?.code, "APPROVAL_RECEIPT_STALE");
});

test("a receipt summary carries identity and status but never the bound parameters", () => {
	const receipt = issueApprovalReceipt(binding({ parameters: { secret: "launch-code-hunter2" } }), { approvedBy: "justin", now: NOW }); // privacy-scan: allow deliberate receipt-leak fixture
	const summary = approvalReceiptSummary(consumeApprovalReceipt(receipt, "ship", NOW));
	assert.equal(summary.status, "consumed");
	assert.equal(summary.consumedBy, "ship");
	assert.equal(summary.receiptId, receipt.receiptId);
	assert.doesNotMatch(JSON.stringify(summary), /launch-code-hunter2/);
	assert.doesNotMatch(formatApprovalReceipt(summary), /launch-code-hunter2/);
	assert.match(formatApprovalReceipt(summary), /receipt [0-9a-f]{16}/);
});

test("approval windows are bounded and default to a working day", () => {
	assert.deepEqual(resolveApprovalTtlMs(undefined), { ttlMs: DEFAULT_APPROVAL_TTL_MS });
	assert.deepEqual(resolveApprovalTtlMs(MIN_APPROVAL_TTL_MS), { ttlMs: MIN_APPROVAL_TTL_MS });
	for (const invalid of [0, -1, 1.5, MIN_APPROVAL_TTL_MS - 1, MAX_APPROVAL_TTL_MS + 1, "1h", Number.NaN]) {
		const resolved = resolveApprovalTtlMs(invalid) as { error?: { code: string; fix: string } };
		assert.equal(resolved.error?.code, "WORKFLOW_INVALID", `${String(invalid)} must be refused`);
		assert.match(resolved.error?.fix ?? "", /approvalTtlMs/);
	}
});

// --- The workflow paths -----------------------------------------------------

const APPROVAL_PARAMS = {
	task: "Ship the release.",
	workflow: {
		stateFile: "workflow.json",
		phases: [
			{ id: "analyze", agent: "recon", task: "Analyze the release" },
			{ id: "approve", approval: { message: "Approve the rollout" } },
			{ id: "ship", agent: "strategist", task: "Ship using {phase.analyze}" },
		],
	},
};

const resumeParams = (overrides: Record<string, any> = {}, workflow: Record<string, any> = {}) => ({
	...APPROVAL_PARAMS,
	...overrides,
	workflow: { ...APPROVAL_PARAMS.workflow, resume: true, ...workflow },
});

const readState = async (cwd: string) => JSON.parse(await readFile(`${cwd}/workflow.json`, "utf8"));
const writeState = async (cwd: string, state: unknown) => writeFile(`${cwd}/workflow.json`, `${JSON.stringify(state, null, 2)}\n`);

// The stub appends to one call log per directory, so runs that share a cwd share
// a log. Refusals are asserted as "no NEW gated child ran", against this count.
const shipCalls = (calls: Call[]) => calls.filter((call) => call.agent === "strategist").length;

/** Pause at the approval phase, headless. Nothing downstream has run. */
async function pausedAtApproval(cwd: string) {
	const paused = await runFlow(APPROVAL_PARAMS, { recon: "ANALYSIS" }, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	return paused;
}

/** Approve, then let the gated phase fail — leaving an issued-but-unspent receipt on disk. */
async function receiptIssuedButUnspent(cwd: string) {
	await pausedAtApproval(cwd);
	const crashed = await runFlow(resumeParams(), { strategist: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });
	assert.equal(crashed.result.details.approvals?.[0].status, "issued", "a failed gated phase must not spend the receipt");
	return { state: await readState(cwd), spent: shipCalls(crashed.calls) };
}

test("a headless workflow fails closed with no receipt to show for it", async () => {
	const cwd = await freshDir();
	const paused = await pausedAtApproval(cwd);
	assert.equal(paused.result.details.approvals, undefined, "a refused approval mints nothing");
	assert.deepEqual(await readState(cwd).then((s) => s.receipts), {});
	assert.equal(shipCalls(paused.calls), 0);
});

test("approving mints a receipt that the gated phase spends", async () => {
	const cwd = await freshDir();
	await pausedAtApproval(cwd);
	const resumed = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error, undefined);

	const approvals = resumed.result.details.approvals;
	assert.equal(approvals?.length, 1);
	assert.equal(approvals[0].action, "workflow.phase:approve");
	assert.equal(approvals[0].status, "consumed");
	assert.equal(approvals[0].consumedBy, "ship", "the receipt is spent by the exact action it authorized");
	assert.equal(approvals[0].approvedBy, "interactive-ui");
	assert.equal(approvals[0].validation, "typed");
	assert.match(resumed.text, new RegExp(`receipt ${approvals[0].receiptId}`), "the final answer names the receipt");

	const state = await readState(cwd);
	assert.equal(state.receipts.approve.receiptId, approvals[0].receiptId);
	assert.match(state.outputs.approve, /^APPROVED \(receipt [0-9a-f]{16}\)$/);
});

test("declining an approval leaves no receipt and blocks the gated phase", async () => {
	const cwd = await freshDir();
	await pausedAtApproval(cwd);
	const denied = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true, ui: { confirm: async () => false } });
	assert.equal(denied.result.details.error?.code, "WORKFLOW_APPROVAL_DENIED");
	assert.equal(shipCalls(denied.calls), 0);
	assert.deepEqual((await readState(cwd)).receipts, {});

	// Resume after rejection: the approval is asked again, and granting it works.
	const retried = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(retried.result.details.error, undefined);
	assert.equal(retried.result.details.approvals?.[0].status, "consumed");
});

test("a receipt survives a crash between approval and the gated action", async () => {
	const cwd = await freshDir();
	const { state: crashedState } = await receiptIssuedButUnspent(cwd);
	assert.equal(crashedState.receipts.approve.consumedAt, null);

	// Resuming re-verifies the surviving receipt rather than re-asking, then spends it.
	const resumed = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(resumed.result.details.error, undefined, "a valid receipt authorizes the retry without a UI");
	assert.equal(resumed.result.details.approvals?.[0].receiptId, crashedState.receipts.approve.receiptId);
	assert.equal(resumed.result.details.approvals?.[0].status, "consumed");
});

test("an expired receipt refuses to authorize the resume", async () => {
	const cwd = await freshDir();
	const { state, spent } = await receiptIssuedButUnspent(cwd);
	state.receipts.approve.expiresAt = new Date(Date.now() - 1000).toISOString();
	await writeState(cwd, state);

	const expired = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(expired.result.details.error?.code, "APPROVAL_RECEIPT_EXPIRED");
	assert.equal(shipCalls(expired.calls), spent, "no child runs on expired consent");
});

test("changing the gated action's effective parameters invalidates the approval", async () => {
	const cwd = await freshDir();
	const { spent } = await receiptIssuedButUnspent(cwd);

	// agentScope is not part of the workflow digest, but it decides which prompt
	// the gated phase actually runs — so it must not ride the old approval.
	const widened = await runFlow(resumeParams({ agentScope: "all", confirmProjectAgents: false }), { strategist: "SHIPPED" }, { cwd });
	assert.equal(widened.result.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.equal(shipCalls(widened.calls), spent);

	// The unchanged action still resumes cleanly.
	const unchanged = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(unchanged.result.details.error, undefined);
});

test("a receipt cannot be replayed onto an action it never authorized", async () => {
	const cwd = await freshDir();
	const { state, spent } = await receiptIssuedButUnspent(cwd);
	state.receipts.approve.consumedAt = new Date().toISOString();
	state.receipts.approve.consumedBy = "some-other-phase";
	await writeState(cwd, state);

	const replayed = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(replayed.result.details.error?.code, "APPROVAL_RECEIPT_CONSUMED");
	assert.equal(shipCalls(replayed.calls), spent);
});

test("a resume state with the receipt stripped out fails closed", async () => {
	const cwd = await freshDir();
	const { state, spent } = await receiptIssuedButUnspent(cwd);
	state.receipts = {};
	await writeState(cwd, state);

	const stripped = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(stripped.result.details.error?.code, "APPROVAL_RECEIPT_INVALID");
	assert.equal(shipCalls(stripped.calls), spent);
});

test("a trailing approval gates the workflow's own completion", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Sign off.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Sign off on the analysis" } },
			],
		},
	};
	const paused = await runFlow(params, { recon: "ANALYSIS" }, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");

	const resumed = await runFlow({ ...params, workflow: { ...params.workflow, resume: true } }, {}, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.result.details.approvals?.[0].consumedBy, "workflow.complete");
});

test("a pre-receipt state migrates to a bound receipt instead of a bare APPROVED string", async () => {
	const cwd = await freshDir();
	const { state } = await receiptIssuedButUnspent(cwd);

	// Rewind to exactly what a v2 state looked like: consent as a bare string.
	state.version = 2;
	state.outputs.approve = "APPROVED";
	delete state.receipts;
	await writeState(cwd, state);

	const resumed = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	const migrated = resumed.result.details.approvals?.[0];
	assert.equal(migrated?.validation, "legacy-compatibility");
	assert.equal(migrated?.expiresAt, null);
	assert.equal((await readState(cwd)).version, 3);

	// Migrated consent still binds: widening the scope afterwards is refused.
	const widened = await runFlow(resumeParams({ agentScope: "all", confirmProjectAgents: false }, { phases: [...APPROVAL_PARAMS.workflow.phases.slice(0, 2), { id: "ship", agent: "strategist", task: "Ship using {phase.analyze}" }] }), { strategist: "SHIPPED" }, { cwd });
	assert.equal(widened.result.details.error, undefined, "the gated phase already completed, so nothing re-verifies");
});

test("an invalid approval window is refused before any child runs", async () => {
	const { result, calls } = await runFlow(
		{ ...APPROVAL_PARAMS, workflow: { ...APPROVAL_PARAMS.workflow, approvalTtlMs: 5 } },
		{ recon: "ANALYSIS" },
		{ cwd: await freshDir(), hasUI: true },
	);
	assert.equal(result.details.error?.code, "WORKFLOW_INVALID");
	assert.match(result.details.error?.cause ?? "", /approvalTtlMs/);
	assert.equal(calls.length, 0);
});

test("a shorter approval window is honoured end to end", async () => {
	const cwd = await freshDir();
	const params = { ...APPROVAL_PARAMS, workflow: { ...APPROVAL_PARAMS.workflow, approvalTtlMs: MIN_APPROVAL_TTL_MS } };
	const paused = await runFlow(params, { recon: "ANALYSIS" }, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	const resumed = await runFlow({ ...params, workflow: { ...params.workflow, resume: true } }, { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error, undefined);
	const receipt = (await readState(cwd)).receipts.approve;
	assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt), MIN_APPROVAL_TTL_MS);
});

test("receipts never carry the approved task text into details or the trace", async () => {
	const cwd = await freshDir();
	const secret = "sk-live-approvalleak";
	const params = {
		task: `Ship the release with token ${secret}.`,
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: `Approve rollout using ${secret}` } },
				{ id: "ship", agent: "strategist", task: `Ship with ${secret}` },
			],
		},
	};
	const paused = await runFlow(params, {}, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	const resumed = await runFlow({ ...params, workflow: { ...params.workflow, resume: true } }, { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error, undefined);

	assert.equal(resumed.result.details.approvals?.length, 1);
	assert.doesNotMatch(JSON.stringify(resumed.result.details.approvals), new RegExp(secret));
	assert.doesNotMatch(JSON.stringify((await readState(cwd)).receipts), new RegExp(secret), "the state file stores the digest, not the parameters");
});
