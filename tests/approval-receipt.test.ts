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
	approvalReceiptDigest,
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

/** Re-stamp a hand-edited receipt so a test reaches the check it is actually about, not the integrity check in front of it. */
const reseal = (receipt: any) => ({ ...receipt, receiptDigest: approvalReceiptDigest(receipt) });

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
	const forged = reseal({ ...receipt, action: "workflow.phase:something-else" });
	assert.equal(verifyApprovalReceipt(forged, binding({ action: "workflow.phase:something-else" }), { consumer: "ship", now: NOW })?.code, "APPROVAL_RECEIPT_STALE");
});

test("editing a recorded approval fact without re-sealing is caught", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS });
	for (const [field, value] of [["expiresAt", "2099-01-01T00:00:00.000Z"], ["approvedBy", "someone-else"], ["issuedAt", "2000-01-01T00:00:00.000Z"], ["consumedBy", "another-action"]] as const) {
		const edited = { ...receipt, [field]: value };
		const error = verifyApprovalReceipt(edited, binding(), { consumer: "workflow.phase:approve", now: NOW });
		assert.equal(error?.code, "APPROVAL_RECEIPT_INVALID", `editing ${field} must not be honoured`);
		assert.match(error?.cause ?? "", /receiptDigest does not match/);
	}
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

test("the expiry window gates starting the action, not finishing one already under way", () => {
	// A gated run that outlives its window must not abort halfway: the action was
	// authorized and begun, the binding still matches, and stopping mid-run leaves
	// the workflow worse off than finishing it.
	const started = consumeApprovalReceipt(issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS }), "workflow.phase:approve", NOW);
	const wayLater = NOW + MIN_APPROVAL_TTL_MS * 100;
	assert.equal(verifyApprovalReceipt(started, binding(), { consumer: "workflow.phase:approve", now: wayLater }), null);

	// An unspent receipt past its window is still refused — that is the case the
	// window exists for.
	const unspent = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS });
	assert.equal(verifyApprovalReceipt(unspent, binding(), { consumer: "workflow.phase:approve", now: wayLater })?.code, "APPROVAL_RECEIPT_EXPIRED");
});

test("a receipt no path re-verified is reported as unverified, not repeated as fact", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW });
	assert.equal(approvalReceiptSummary(receipt).validation, "typed");
	const tampered = { ...receipt, approvedBy: "someone-else" } as typeof receipt;
	const summary = approvalReceiptSummary(tampered);
	assert.equal(summary.validation, "unverified", "the audit line must not launder an edited record");
	const line = formatApprovalReceipt(summary);
	assert.match(line, /^UNVERIFIED \(receipt digest mismatch\)/, "the caveat leads, so a reader who stops early is not misled");
	assert.match(line, /someone-else/, "the claimed value is still shown, just not vouched for");
});

test("an unreadable receipt degrades to an unverified line instead of throwing", () => {
	// This runs on the paths that are REFUSING a malformed state file, so throwing
	// here would swallow the actionable error it accompanies.
	for (const broken of [null, undefined, "APPROVED", 42, []]) {
		const summary = approvalReceiptSummary(broken);
		assert.equal(summary.validation, "unverified", `${JSON.stringify(broken) ?? "undefined"} must not throw`);
		assert.match(formatApprovalReceipt(summary), /^UNVERIFIED/);
	}
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
	assert.equal(approvals[0].consumedBy, "workflow.phase:approve", "the receipt is spent by the exact action it authorized");
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
	state.receipts.approve = reseal({ ...state.receipts.approve, expiresAt: new Date(Date.now() - 1000).toISOString() });
	await writeState(cwd, state);

	// Headless: the approval reopens and fails closed, naming why it is being asked
	// again rather than stranding a state file nobody can ever re-approve.
	const expired = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(expired.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.match(expired.result.details.error?.cause ?? "", /no longer holds.*bounded window/s);
	assert.equal(shipCalls(expired.calls), spent, "no child runs on expired consent");

	// Interactive: consent can be granted afresh, and the run proceeds.
	const reapproved = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(reapproved.result.details.error, undefined);
	assert.equal(reapproved.result.details.approvals?.[0].status, "consumed");
	assert.ok(shipCalls(reapproved.calls) > spent, "the gated phase runs on the fresh approval");
});

test("changing the gated action's effective parameters invalidates the approval", async () => {
	const cwd = await freshDir();
	const { spent } = await receiptIssuedButUnspent(cwd);

	// agentScope is not part of the workflow digest, but it decides which prompt
	// the gated phase actually runs — so it must not ride the old approval.
	const widened = await runFlow(resumeParams({ agentScope: "all", confirmProjectAgents: false }), { strategist: "SHIPPED" }, { cwd });
	assert.equal(widened.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED", "consent is re-asked for the changed action, headless-closed");
	assert.match(widened.result.details.error?.cause ?? "", /no longer holds.*agent scope/s);
	assert.equal(shipCalls(widened.calls), spent);

	// Reopening discarded the consent that no longer held, so restoring the
	// parameters is not enough on its own — the operator has to approve again.
	const restoredHeadless = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(restoredHeadless.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	const unchanged = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(unchanged.result.details.error, undefined);
});

test("a receipt cannot be replayed onto an action it never authorized", async () => {
	const cwd = await freshDir();
	const { state, spent } = await receiptIssuedButUnspent(cwd);
	state.receipts.approve = reseal({ ...state.receipts.approve, consumedAt: new Date().toISOString(), consumedBy: "some-other-phase" });
	await writeState(cwd, state);

	// A spent receipt is evidence of tampering, not a lapsed window — re-prompting
	// past it would launder the tampering, so it stays a hard refusal.
	const replayed = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(replayed.result.details.error?.code, "APPROVAL_RECEIPT_CONSUMED");
	assert.equal(shipCalls(replayed.calls), spent);
});

test("a resume state with the receipt stripped out fails closed", async () => {
	const cwd = await freshDir();
	const { state, spent } = await receiptIssuedButUnspent(cwd);
	state.receipts = {};
	await writeState(cwd, state);

	// Likewise a missing receipt: it is not a lapse a re-prompt should paper over.
	const stripped = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(stripped.result.details.error?.code, "APPROVAL_RECEIPT_INVALID");
	assert.equal(shipCalls(stripped.calls), spent);
});

test("every phase an approval gates re-verifies, not just the first", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Ship in two steps.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve the two-step rollout" } },
				{ id: "ship", agent: "strategist", task: "Ship it" },
				{ id: "verify", agent: "recon", task: "Verify the rollout" },
			],
		},
	};
	const resumeTwoStep = (overrides: Record<string, any> = {}) => ({ ...params, ...overrides, workflow: { ...params.workflow, resume: true } });

	const paused = await runFlow(params, {}, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	// Approve, ship, then fail on the SECOND gated phase — the resume lands in the
	// middle of the gated run, past the phase that first presented the receipt.
	const crashed = await runFlow(resumeTwoStep(), { strategist: "SHIPPED", recon: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });
	assert.equal(crashed.result.details.approvals?.[0].status, "consumed");
	const verifyCalls = (calls: Call[]) => calls.filter((call) => call.agent === "recon").length;

	const widened = await runFlow(resumeTwoStep({ agentScope: "all", confirmProjectAgents: false }), { recon: "VERIFIED" }, { cwd });
	assert.equal(widened.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED", "the second gated phase must be checked too");
	assert.match(widened.result.details.error?.cause ?? "", /no longer holds/);
	assert.equal(verifyCalls(widened.calls), verifyCalls(crashed.calls));

	// The widened resume reopened the approval, so consent is granted afresh and
	// the remaining gated phase then runs.
	const resumed = await runFlow(resumeTwoStep(), { recon: "VERIFIED" }, { cwd, hasUI: true });
	assert.equal(resumed.result.details.error, undefined);
	assert.ok(verifyCalls(resumed.calls) > verifyCalls(widened.calls), "the second gated phase runs on the fresh approval");
});

test("a trailing approval binds the debrief it gates, not just the phases", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Sign off, then synthesize.",
		requireEvidence: false,
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Sign off on the analysis" } },
			],
			debrief: { agent: "debrief" },
		},
	};
	const resume = (overrides: Record<string, any> = {}) => ({ ...params, ...overrides, workflow: { ...params.workflow, resume: true } });

	const paused = await runFlow(params, { recon: "ANALYSIS" }, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	// Approve, then fail the debrief so the receipt survives unspent into a resume.
	await runFlow(resume(), { debrief: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });
	const debriefCalls = (calls: Call[]) => calls.filter((call) => call.agent === "debrief").length;

	// requireEvidence is not in the workflow digest, and the debrief resolves it
	// from the top-level params — so changing it after approval must not ride the
	// old consent.
	const changed = await runFlow(resume({ requireEvidence: true }), { debrief: "SUMMARY" }, { cwd });
	assert.equal(changed.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.match(changed.result.details.error?.cause ?? "", /no longer holds/);

	const unchanged = await runFlow(resume(), { debrief: "SUMMARY" }, { cwd, hasUI: true });
	assert.equal(unchanged.result.details.error, undefined);
	assert.ok(debriefCalls(unchanged.calls) > debriefCalls(changed.calls), "the re-approved debrief runs");
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
	assert.equal(resumed.result.details.approvals?.[0].consumedBy, "workflow.phase:signoff");
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
	assert.equal(migrated?.consumedBy, "workflow.phase:approve");
	assert.equal((await readState(cwd)).version, 3);

	// Migrated consent still binds. The approval gates the tail of this workflow as
	// well as the phase after it, so widening the scope is refused even once every
	// phase has completed — the receipt is not spent by the workflow finishing.
	const widened = await runFlow(resumeParams({ agentScope: "all", confirmProjectAgents: false }), { strategist: "SHIPPED" }, { cwd });
	assert.equal(widened.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	assert.match(widened.result.details.error?.cause ?? "", /no longer holds/);
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
