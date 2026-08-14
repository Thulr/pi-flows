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
	ApprovalAuthorization,
	approvalReceiptSummary,
	formatApprovalReceipt,
	issueApprovalReceipt,
	legacyApprovalReceipt,
	resolveApprovalTtlMs,
	type ApprovalBinding,
} from "../extensions/pi-flows/approval.ts";
import { approvalProfileRefusal, normalizeGatedPhase } from "../extensions/pi-flows/modes/workflow-approval.ts";
import { freshDir, runFlow, STUB_REGISTRY, UNRECORDED, type Call } from "./stub-harness.ts";

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

/** Verify-then-consume in one step — the only consumption path the API offers: `consume` exists solely on a verified authorization. */
const consumeVia = (receipt: unknown, consumer: string, now: number, b: ApprovalBinding = binding()) =>
	ApprovalAuthorization.verify(receipt, b, { consumer, now }).authorization!.consume(now);

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
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: 60_000 }, UNRECORDED);
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
	const first = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	const second = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	assert.notEqual(first.receiptId, second.receiptId);
	assert.equal(first.bindingDigest, second.bindingDigest);
});

test("verification accepts the exact action it was granted for", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	assert.equal(ApprovalAuthorization.verify(receipt, binding(), { consumer: "ship", now: NOW + 1000 }).error, undefined);
});

test("verification rejects a changed action as stale", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	const changed = binding({ parameters: { agentScope: "project", gatedPhases: [{ id: "ship", agent: "strategist", task: "Ship it" }] } });
	assert.equal(ApprovalAuthorization.verify(receipt, changed, { consumer: "ship", now: NOW }).error?.code, "APPROVAL_RECEIPT_STALE");
});

test("verification recomputes the binding rather than trusting the stored digest", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	const forged = reseal({ ...receipt, action: "workflow.phase:something-else" });
	assert.equal(ApprovalAuthorization.verify(forged, binding({ action: "workflow.phase:something-else" }), { consumer: "ship", now: NOW }).error?.code, "APPROVAL_RECEIPT_STALE");
});

test("editing a recorded approval fact without re-sealing is caught", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS }, UNRECORDED);
	for (const [field, value] of [["expiresAt", "2099-01-01T00:00:00.000Z"], ["approvedBy", "someone-else"], ["issuedAt", "2000-01-01T00:00:00.000Z"], ["consumedBy", "another-action"]] as const) {
		const edited = { ...receipt, [field]: value };
		const error = ApprovalAuthorization.verify(edited, binding(), { consumer: "workflow.phase:approve", now: NOW }).error;
		assert.equal(error?.code, "APPROVAL_RECEIPT_INVALID", `editing ${field} must not be honoured`);
		assert.match(error?.cause ?? "", /receiptDigest does not match/);
	}
});

test("verification rejects an expired receipt", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS }, UNRECORDED);
	assert.equal(ApprovalAuthorization.verify(receipt, binding(), { consumer: "ship", now: NOW + MIN_APPROVAL_TTL_MS }).error, undefined, "the boundary instant is still inside the window");
	const expired = ApprovalAuthorization.verify(receipt, binding(), { consumer: "ship", now: NOW + MIN_APPROVAL_TTL_MS + 1 }).error;
	assert.equal(expired?.code, "APPROVAL_RECEIPT_EXPIRED");
	assert.match(expired?.fix ?? "", /approvalTtlMs/);
});

test("a spent receipt cannot authorize a second, different action", () => {
	const receipt = consumeVia(issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED), "ship", NOW);
	assert.equal(ApprovalAuthorization.verify(receipt, binding(), { consumer: "ship", now: NOW }).error, undefined, "re-entering the same action is a resume, not a replay");
	const replay = ApprovalAuthorization.verify(receipt, binding(), { consumer: "publish", now: NOW }).error;
	assert.equal(replay?.code, "APPROVAL_RECEIPT_CONSUMED");
	assert.match(replay?.cause ?? "", /consumed by "ship"/);
});

test("consuming twice from the same action is idempotent", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	const once = consumeVia(receipt, "ship", NOW);
	const twice = consumeVia(once, "ship", NOW + 5000);
	assert.equal(twice.consumedAt, once.consumedAt, "a crash-resume must not restamp the consumption");
	assert.deepEqual(twice, once, "an identical record, not the same object: verify snapshots its receipt");
});

test("malformed receipts are refused rather than partially trusted", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
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
		assert.equal(ApprovalAuthorization.verify(value, binding(), { consumer: "ship", now: NOW }).error?.code, "APPROVAL_RECEIPT_INVALID", label);
	}
});

test("a migrated receipt still binds but claims no approver or window", () => {
	const receipt = legacyApprovalReceipt(binding(), { issuedAt: "2026-01-01T00:00:00.000Z", consumedBy: "ship" });
	assert.equal(receipt.validation, "legacy-compatibility");
	assert.equal(receipt.expiresAt, null);
	assert.match(receipt.approvedBy, /unknown/);
	assert.equal(ApprovalAuthorization.verify(receipt, binding(), { consumer: "ship", now: NOW }).error, undefined, "no expiry to outlive");
	assert.equal(ApprovalAuthorization.verify(receipt, binding({ action: "workflow.phase:other" }), { consumer: "ship", now: NOW }).error?.code, "APPROVAL_RECEIPT_STALE");
});

test("the expiry window gates starting the action, not finishing one already under way", () => {
	// A gated run that outlives its window must not abort halfway: the action was
	// authorized and begun, the binding still matches, and stopping mid-run leaves
	// the workflow worse off than finishing it.
	const started = consumeVia(issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS }, UNRECORDED), "workflow.phase:approve", NOW);
	const wayLater = NOW + MIN_APPROVAL_TTL_MS * 100;
	assert.equal(ApprovalAuthorization.verify(started, binding(), { consumer: "workflow.phase:approve", now: wayLater }).error, undefined);

	// An unspent receipt past its window is still refused — that is the case the
	// window exists for.
	const unspent = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW, ttlMs: MIN_APPROVAL_TTL_MS }, UNRECORDED);
	assert.equal(ApprovalAuthorization.verify(unspent, binding(), { consumer: "workflow.phase:approve", now: wayLater }).error?.code, "APPROVAL_RECEIPT_EXPIRED");
});

test("a receipt no path re-verified is reported as unverified, not repeated as fact", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	assert.equal(approvalReceiptSummary(receipt).validation, "typed");
	const tampered = { ...receipt, approvedBy: "someone-else" } as typeof receipt;
	const summary = approvalReceiptSummary(tampered);
	assert.equal(summary.validation, "unverified", "the audit line must not launder an edited record");
	const line = formatApprovalReceipt(summary);
	assert.match(line, /^UNVERIFIED \(receipt invalid\)/, "the caveat leads, so a reader who stops early is not misled");
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
	const receipt = issueApprovalReceipt(binding({ parameters: { secret: "launch-code-hunter2" } }), { approvedBy: "justin", now: NOW }, UNRECORDED); // privacy-scan: allow deliberate receipt-leak fixture
	const summary = approvalReceiptSummary(consumeVia(receipt, "ship", NOW, binding({ parameters: { secret: "launch-code-hunter2" } }))); // privacy-scan: allow deliberate receipt-leak fixture
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

	// `ship` already ran under the approved parameters, so this is a part-executed
	// gated run. Reopening here would mint one receipt claiming to authorize both
	// halves under parameters only the second half saw, so it is refused outright
	// even in an interactive session — the operator decides, not a retry.
	const widened = await runFlow(resumeTwoStep({ agentScope: "all", confirmProjectAgents: false }), { recon: "VERIFIED" }, { cwd, hasUI: true });
	assert.equal(widened.result.details.error?.code, "APPROVAL_RECEIPT_STALE", "the second gated phase must be checked too");
	assert.match(widened.result.details.error?.cause ?? "", /Phases ship already ran under the conditions that were approved/);
	assert.match(widened.result.details.error?.fix ?? "", /start a fresh run/);
	assert.equal(verifyCalls(widened.calls), verifyCalls(crashed.calls));

	// Restoring the approved parameters lets the remaining phase run on the
	// original, still-valid receipt — no re-approval needed, nothing re-run.
	const resumed = await runFlow(resumeTwoStep(), { recon: "VERIFIED" }, { cwd });
	assert.equal(resumed.result.details.error, undefined);
	assert.ok(verifyCalls(resumed.calls) > verifyCalls(widened.calls), "the second gated phase runs on the receipt that authorized it");
});

test("a trailing approval binds the debrief it gates, not just the phases", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Sign off, then synthesize.",
		requireEvidence: false,
		thinking: "low",
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
	assert.equal(changed.result.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.match(changed.result.details.error?.cause ?? "", /gated debrief began/);

	const unchanged = await runFlow(resume(), { debrief: "SUMMARY" }, { cwd });
	assert.equal(unchanged.result.details.error, undefined);
	assert.ok(debriefCalls(unchanged.calls) > debriefCalls(changed.calls), "the re-approved debrief runs");
});

test("a flow-level model or thinking change invalidates a receipt the phase inherited it under", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Ship the change.",
		// The phase names neither, so both resolve from the flow-level fallback at
		// dispatch. Binding only the phase's own values would leave a receipt that
		// survives changing what the child actually runs as.
		thinking: "low",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve the rollout" } },
				{ id: "ship", agent: "strategist", task: "Ship it" },
			],
		},
	};
	const resume = (o: Record<string, any> = {}) => ({ ...params, ...o, workflow: { ...params.workflow, resume: true } });
	const paused = await runFlow(params, {}, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	// Approve, then fail the gated phase so the receipt survives unspent.
	await runFlow(resume(), { strategist: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });

	const raised = await runFlow(resume({ thinking: "max" }), { strategist: "SHIPPED" }, { cwd });
	assert.equal(raised.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED", "raising effort after approval must not ride the old consent");
	assert.match(raised.result.details.error?.cause ?? "", /no longer holds/);

	// Same for the model: approving on one vendor's model and resuming on
	// another's is the same class of change.
	const revendored = await runFlow(resume({ model: "test-provider/session-model" }), { strategist: "SHIPPED" }, { cwd });
	assert.equal(revendored.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");

	const unchanged = await runFlow(resume(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(unchanged.result.details.error, undefined, "an unchanged resume still spends the receipt it was granted");
});

test("roster drift under a bound tier invalidates the receipt", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Ship the change.",
		// A tier is a question, not an answer: "deep" resolves through the
		// per-install roster, so the same word can select a different model,
		// vendor, and effort after a config change. Binding the word alone would
		// let the receipt verify while the child ran materially different work.
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve the rollout" } },
				{ id: "ship", agent: "strategist", task: "Ship it", tier: "deep" },
			],
		},
	};
	const resume = (o: Record<string, any> = {}) => ({ ...params, ...o, workflow: { ...params.workflow, resume: true } });
	const registry = (id: string) => ({
		getAvailable: () => [
			...STUB_REGISTRY.getAvailable(),
			{ id, provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 100, output: 100 } },
		],
	});
	await runFlow(params, {}, { cwd, registry: registry("deep-one") });
	await runFlow(resume(), { strategist: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true, registry: registry("deep-one") });

	// Same spec, same tier name — only what "deep" resolves to has moved.
	const drifted = await runFlow(resume(), { strategist: "SHIPPED" }, { cwd, registry: registry("deep-two") });
	assert.equal(drifted.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED", "the tier resolves elsewhere now, so the old consent does not cover it");
	assert.match(drifted.result.details.error?.cause ?? "", /no longer holds/);

	const restored = await runFlow(resume(), { strategist: "SHIPPED" }, { cwd, hasUI: true, registry: registry("deep-one") });
	assert.equal(restored.result.details.error, undefined, "restoring what was approved lets the original receipt stand");
});

test("a capable-tier phase binds the session model, and moving it invalidates the receipt", () => {
	// Tested on the binding directly rather than through a resume: stating a model
	// on the resume would make the binding differ for that reason alone, which
	// passes whether or not the model is captured. What changes here is ONLY what
	// the tier resolves to.
	const roster = (sessionModel: string) => ({
		fast: { model: "p/cheap", thinking: "low", why: "t" },
		capable: { model: sessionModel, thinking: "medium", why: "t" },
		deep: { model: "p/strong", thinking: "max", why: "t" },
		available: [{ reference: sessionModel, provider: "p", id: sessionModel.slice(2), reasoning: true, thinkingLevels: ["medium"], contextWindow: 100_000 }],
		sessionModel,
		source: "derived" as const,
		issues: [],
	});
	const deps = (sessionModel: string) => ({ discovery: { agents: [] }, defaultCwd: "/workspace", roster: roster(sessionModel) } as any);
	const phase = { id: "ship", agent: "operator", task: "Ship it", tier: "capable" };

	const before = normalizeGatedPhase(phase, {}, deps("p/original"));
	const after = normalizeGatedPhase(phase, {}, deps("p/replacement"));
	assert.notDeepEqual(before, after, "the same phase binds differently once its tier resolves elsewhere");
	assert.equal(before.model, "p/original", "and it records the concrete model, not the tier name");

	// A phase naming no model, no tier, and using an agent that declares none
	// runs pi's configured default — which an extension cannot read, so the
	// receipt records null rather than a model the child will not run.
	const unpinned = { id: "ship", agent: "operator", task: "Ship it" };
	assert.equal(normalizeGatedPhase(unpinned, {}, deps("p/original")).model, null);
	assert.equal(normalizeGatedPhase(phase, {}, { discovery: { agents: [] }, defaultCwd: "/workspace" } as any).model, null, "an unresolvable roster binds null too");
});

test("a trailing approval binds the debrief's model and thinking, not just its contract", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Analyze, sign off, then synthesize.",
		thinking: "low",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Sign off on the analysis" } },
			],
			// The debrief ref names no level, so it inherits the top-level one at
			// dispatch — a fallback the workflow digest never sees.
			debrief: { agent: "debrief" },
		},
	};
	const resume = (o: Record<string, any> = {}) => ({ ...params, ...o, workflow: { ...params.workflow, resume: true } });
	await runFlow(params, { recon: "ANALYSIS" }, { cwd });
	await runFlow(resume(), { debrief: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });

	const raised = await runFlow(resume({ thinking: "max" }), { debrief: "SUMMARY" }, { cwd });
	assert.equal(raised.result.details.error?.code, "APPROVAL_RECEIPT_STALE", "the debrief would run at an effort the operator never approved");
	assert.match(raised.result.details.error?.cause ?? "", /gated debrief began/);

	const unchanged = await runFlow(resume(), { debrief: "SUMMARY" }, { cwd });
	assert.equal(unchanged.result.details.error, undefined);
});

test("a reopen is refused once part of the gated run has already executed", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Two-step rollout.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve the two-step rollout" } },
				{ id: "ship", agent: "strategist", task: "Ship it" },
				{ id: "verify", agent: "recon", task: "Verify" },
			],
		},
	};
	const resume = (o: Record<string, any> = {}) => ({ ...params, ...o, workflow: { ...params.workflow, resume: true } });
	await runFlow(params, {}, { cwd });
	await runFlow(resume(), { strategist: "SHIPPED", recon: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });

	// Nothing of the gated run has been invalidated and nothing is re-run: the
	// refusal names which phases already ran and what the operator can do.
	const changed = await runFlow(resume({ agentScope: "all", confirmProjectAgents: false }), { recon: "VERIFIED" }, { cwd, hasUI: true });
	assert.equal(changed.result.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.match(changed.result.details.error?.cause ?? "", /Phases ship already ran/);
	const state = JSON.parse(await readFile(`${cwd}/workflow.json`, "utf8"));
	assert.ok(state.completedPhaseIds.includes("approve"), "the approval is not silently reopened");
	assert.ok(state.receipts.approve, "the receipt that authorized the completed work is not erased");
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

test("a pre-receipt approval whose gated work never ran is re-asked, not reconstructed", async () => {
	// The binding would be computed from the roster that happens to exist at
	// resume time, so a tier now resolving elsewhere would be retroactively
	// blessed as what the operator consented to. Nobody approved that.
	const cwd = await freshDir();
	const { state, spent } = await receiptIssuedButUnspent(cwd);
	state.version = 2;
	state.outputs.approve = "APPROVED";
	delete state.receipts;
	await writeState(cwd, state);

	const headless = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd });
	assert.equal(headless.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED", "outstanding gated work means the consent is re-asked");
	// The stub log accumulates across runs in one workspace, so this compares
	// against what the setup already spent rather than against zero.
	assert.equal(shipCalls(headless.calls), spent, "and nothing new runs on the unreconstructed approval");

	// Answering it again produces a real receipt and lets the work proceed.
	const reapproved = await runFlow(resumeParams(), { strategist: "SHIPPED" }, { cwd, hasUI: true });
	assert.equal(reapproved.result.details.error, undefined);
	assert.equal(reapproved.result.details.approvals?.[0].validation, "typed", "the new consent is a real approval, not a legacy stand-in");
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

test("an approval is refused when the work it gates names no model to bind", () => {
	// A receipt claims to bind the conditions it authorizes. A gated ref that
	// names no model, no tier, on an agent declaring neither runs pi's configured
	// default — unknowable here, and free to change before a resume under consent
	// that still verifies. This codebase refuses in the analogous case rather than
	// pretend: BUDGET_UNOBSERVABLE stops a run when the cost telemetry a ceiling
	// depends on is missing.
	const roster = {
		fast: { model: "p/cheap", thinking: "low", why: "t" },
		capable: { model: "p/session", thinking: "medium", why: "t" },
		deep: { model: "p/strong", thinking: "max", why: "t" },
		available: ["p/cheap", "p/session", "p/strong", "p/explicit"].map((reference) => ({
			reference,
			provider: "p",
			id: reference.slice(2),
			reasoning: true,
			thinkingLevels: ["low", "medium", "max"],
			contextWindow: 100_000,
		})),
		sessionModel: "p/session",
		source: "derived" as const,
		issues: [],
	};
	const phases = [
		{ id: "approve", approval: { message: "Approve" } },
		{ id: "ship", agent: "operator", task: "Ship it" },
	];
	const agent = (overrides: Record<string, unknown> = {}) => ({ name: "operator", description: "Approval fixture.", tools: ["read"], thinking: "low", systemPrompt: "", source: "package", filePath: "/pkg/operator.md", ...overrides });
	const refusal = (target: any[], agents: any[], params: any = {}, selectedRoster: any = roster) => approvalProfileRefusal(target, 0, params, { agents, defaultCwd: "/workspace", roster: selectedRoster });

	// The agent declares no tier, and neither does the phase.
	assert.equal(refusal(phases, [agent()])?.code, "WORKFLOW_INVALID");

	// Any of the three ways of naming one closes it.
	assert.equal(refusal(phases, [agent({ tier: "capable" })]), null);
	assert.equal(refusal(phases, [agent()], { tier: "fast" }), null);
	const pinned = [phases[0], { ...phases[1], model: "p/explicit" }];
	assert.equal(refusal(pinned, [agent()]), null);

	// A broken registry does not make the risk smaller — it makes every tier
	// unresolvable, so more work runs on a model nobody recorded. The refusal has
	// to be loudest exactly there, and naming a model outright is the way through.
	const blind = { ...roster, fast: { why: "x" }, capable: { why: "x" }, deep: { why: "x" }, available: [], source: "unavailable" as const };
	assert.equal(refusal(phases, [agent({ tier: "capable" })], {}, blind)?.code, "WORKFLOW_INVALID", "a tier that cannot resolve is not a bound model");
	assert.equal(refusal(pinned, [agent()], {}, blind)?.code, "WORKFLOW_INVALID", "a model selector without a registry cannot prove its exact target");
});

test("a trailing legacy approval is re-asked while its debrief is still outstanding", async () => {
	// A trailing approval gates no phases, so judging it by phases alone calls it
	// spent — while the workflow completion and debrief it authorizes have not
	// run. Those would then execute on whatever the roster now resolves.
	const cwd = await freshDir();
	const params = {
		task: "Analyze, then sign off.",
		thinking: "low",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze" },
				{ id: "signoff", approval: { message: "Sign off" } },
			],
			debrief: { agent: "debrief" },
		},
	};
	const resume = (o: Record<string, any> = {}) => ({ ...params, ...o, workflow: { ...params.workflow, resume: true } });
	await runFlow(params, { recon: "ANALYSIS" }, { cwd });
	await runFlow(resume(), { debrief: { reply: "boom", exitCode: 1 } }, { cwd, hasUI: true });
	const state = await readState(cwd);
	assert.notEqual(state.status, "completed", "the debrief this approval gates has not run");
	state.version = 2;
	state.outputs.signoff = "APPROVED";
	delete state.receipts;
	await writeState(cwd, state);
	const headless = await runFlow(resume(), { debrief: "SUMMARY" }, { cwd });
	assert.equal(headless.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED", "consent that has not been spent is re-asked, not reconstructed");
});
