// The behavior-rich Core objects: transitions live on constructed objects, not
// as free functions a caller can invoke out of order. Each test names the
// invariant the object enforces by construction.
import test from "node:test";
import { strict as assert } from "node:assert";
import { ApprovalAuthorization, issueApprovalReceipt, type ApprovalBinding } from "../extensions/pi-flows/approval.ts";
import { ResolvedDelegationContract, delegationContractId } from "../extensions/pi-flows/delegation.ts";
import type { DelegationContract } from "../extensions/pi-flows/types.ts";

/** The stated absence of a trace sink (`record: undefined`): these receipts exist outside any flow, and issuance requires the statement rather than letting evidence be forgotten (#128). */
const UNRECORDED = { record: undefined, name: "workflow.approval.issued" };

const contract: DelegationContract = {
	objective: "Return the exact answer.",
	constraints: [],
	nonGoals: [],
	dependencies: [],
	authority: { may: ["Read files."], mustNot: [], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget: { timeoutMs: 5_000, maxCostUsd: 1 },
	acceptanceChecks: ["Return answer 42."],
	returnSchema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
	owner: "tests",
};

test("a contract that fails admissibility never becomes an object the transitions accept", () => {
	const bad = ResolvedDelegationContract.resolve({ ...contract, objective: "" });
	assert.equal(bad.resolved, undefined, "no object exists to render tasks or budgets from");
	assert.equal(bad.error?.code, "INVALID_DELEGATION_CONTRACT");

	const uncompilable = ResolvedDelegationContract.resolve({ ...contract, returnSchema: { type: "string", pattern: "(" } });
	assert.equal(uncompilable.resolved, undefined, "an uncompilable returnSchema is refused at the door, not at first use");
	assert.equal(uncompilable.error?.code, "INVALID_DELEGATION_CONTRACT");
});

test("a resolved contract carries one identity and one compiled schema for every transition", () => {
	const resolved = ResolvedDelegationContract.resolve(contract).resolved!;
	assert.equal(resolved.id, delegationContractId(contract), "the identity is the canonical digest, computed once");
	assert.match(resolved.renderTask("Do it"), new RegExp(resolved.id), "the rendered protocol names the same identity");
	const reviewContext = resolved.reviewContext("Judge it");
	assert.match(reviewContext, /Return answer 42/, "review context carries the admitted acceptance terms");
	assert.doesNotMatch(reviewContext, /Required return protocol|contractId/, "review context cannot instruct another Role to return under this identity");
	assert.equal(resolved.timeoutMs, 5_000, "the dispatch bound reads the same admitted data");
	assert.equal(resolved.budget()?.snapshot().authority, "contract");
	assert.equal(resolved.checkReturnData({ answer: 42 }), true);
	assert.equal(resolved.checkReturnData({ answer: "42" }), false, "return validation uses the schema compiled at construction");
});

test("neither wrapper can be constructed directly at runtime", () => {
	// TS `private constructor` is erased in emitted JavaScript; the runtime
	// construction key is what actually keeps the factory the only way in.
	type Newable = new (...args: unknown[]) => unknown;
	assert.throws(() => {
		new (ResolvedDelegationContract as unknown as Newable)(contract, "sha256:forged", () => true);
	}, TypeError, "a resolved contract cannot exist without passing admissibility");
	assert.throws(() => {
		new (ApprovalAuthorization as unknown as Newable)(issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED), "workflow.phase:ship");
	}, TypeError, "an authorization cannot exist without verify having passed");
});

test("the resolved wrapper's dispatch can be neither shadowed nor replaced", () => {
	const resolvedContract = ResolvedDelegationContract.resolve(contract).resolved!;
	assert.throws(() => {
		(resolvedContract as { checkReturnData: unknown }).checkReturnData = () => true;
	}, TypeError, "instances are frozen at construction, so an own always-true validator cannot be attached");
	assert.throws(() => {
		(ResolvedDelegationContract.prototype as { checkReturnData: unknown }).checkReturnData = () => true;
	}, TypeError, "the prototype is frozen, so the shared method cannot be swapped either");
	assert.equal(resolvedContract.checkReturnData({ answer: "not-a-number" }), false, "validation still answers from the compiled schema");
});

test("mutating the input contract after resolve changes nothing the object already admitted", () => {
	const input = structuredClone(contract);
	const resolvedFromInput = ResolvedDelegationContract.resolve(input).resolved!;
	input.objective = "Something else entirely";
	(input.budget as { timeoutMs?: number }).timeoutMs = 1;
	assert.equal(resolvedFromInput.id, delegationContractId(contract), "identity keeps describing the admitted contract");
	assert.equal(resolvedFromInput.timeoutMs, 5_000, "the dispatch bound reads the admitted snapshot");
	assert.match(resolvedFromInput.renderTask(undefined), /Return the exact answer/, "so does the rendered protocol");
	assert.throws(() => {
		(resolvedFromInput.contract as { objective: string }).objective = "drift";
	}, TypeError, "the admitted snapshot is frozen, so it cannot drift from its own identity");
});

const binding = (overrides: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
	action: "workflow.phase:ship",
	parameters: { agentScope: "user" },
	requestedBy: "flow:workflow",
	workflowDigest: "1234567890abcdef",
	stateVersion: 3,
	...overrides,
});

const NOW = Date.parse("2026-08-08T12:00:00.000Z");

test("consumption exists only on a verified authorization, bound to the verified consumer", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	const verified = ApprovalAuthorization.verify(receipt, binding(), { consumer: "workflow.phase:ship", now: NOW });
	assert.equal(verified.error, undefined);

	const spent = verified.authorization!.consume(NOW);
	assert.equal(spent.consumedBy, "workflow.phase:ship", "the consumer was fixed at verification; consume takes no consumer argument to disagree with");
	assert.equal(spent.consumedAt, new Date(NOW).toISOString());

	const replay = ApprovalAuthorization.verify(spent, binding(), { consumer: "workflow.phase:other", now: NOW });
	assert.equal(replay.error?.code, "APPROVAL_RECEIPT_CONSUMED", "a failed verification yields no authorization at all");
	assert.equal(replay.authorization, undefined);
});

test("consumption seals the receipt verification covered, not later mutations", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	const authorization = ApprovalAuthorization.verify(receipt, binding(), { consumer: "workflow.phase:ship", now: NOW }).authorization!;
	(receipt as { approvedBy: string }).approvedBy = "someone-else";
	const spent = authorization.consume(NOW);
	assert.equal(spent.approvedBy, "justin", "the authorization holds a frozen snapshot from verification time, so the audit record cannot drift");
});

test("consuming one authorization twice returns the identical receipt, not a re-stamped one", () => {
	const receipt = issueApprovalReceipt(binding(), { approvedBy: "justin", now: NOW }, UNRECORDED);
	const authorization = ApprovalAuthorization.verify(receipt, binding(), { consumer: "workflow.phase:ship", now: NOW }).authorization!;
	const first = authorization.consume(NOW);
	const second = authorization.consume(NOW + 5_000);
	assert.equal(second, first, "the first consumption is latched; a duplicate call is a resume");
	assert.equal(second.consumedAt, first.consumedAt, "the consumption time and digest are never rewritten");
});
