// The Return taxonomy (issue #143): untrusted child output is a Return
// candidate, a candidate that fails contract validation is a rejected Return
// candidate kept as evidence, and only the validation transition constructs or
// attaches a validated Return envelope. These tests compile the public schemas
// and pin that an unbound candidate is accepted only as a candidate — never as
// a validated Return envelope.
import { strict as assert } from "node:assert";
import test from "node:test";
import { Compile } from "typebox/compile";
import { FlowReturnCandidate, FlowReturnEnvelope } from "../extensions/pi-flows/index.ts";
import { delegationContractId, prepareIntegrationHandoff, ResolvedDelegationContract } from "../extensions/pi-flows/delegation.ts";
import { Run } from "../extensions/pi-flows/run.ts";
import { emptyUsage, type DelegationContract, type FlowRunResult } from "../extensions/pi-flows/types.ts";

const contract: DelegationContract = {
	objective: "Return the exact answer.",
	constraints: ["Read only."],
	nonGoals: [],
	dependencies: [],
	authority: { may: ["Read files."], mustNot: [], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget: {},
	acceptanceChecks: ["Return answer 42."],
	returnSchema: {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "number" } },
		additionalProperties: false,
	},
	owner: "parent",
};

const policy = { recordContent: true, redactSecrets: true };
const resolved = ResolvedDelegationContract.resolve(contract).resolved!;

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const value: Record<string, unknown> = {
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract),
		status: "completed",
		summary: "Found it.",
		evidence: [{ claim: "The answer is 42.", source: "answer.txt:1" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { answer: 42 },
		...overrides,
	};
	for (const [key, override] of Object.entries(overrides)) {
		if (override === undefined) delete value[key];
	}
	return value;
}

function result(text: string): FlowRunResult {
	return {
		agent: "recon",
		agentSource: "package",
		task: "find the answer",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
		stderr: "",
		usage: emptyUsage(),
	};
}

// The criterion is that downstream validators built from the public schemas
// agree with runtime behavior, so the schemas must compile, not merely exist.
const checkCandidate = Compile(FlowReturnCandidate);
const checkEnvelope = Compile(FlowReturnEnvelope);

test("an unbound candidate is accepted as a candidate and rejected as a validated Return envelope", () => {
	const unbound = candidate({ contractId: undefined });
	assert.ok(checkCandidate.Check(unbound), "missing identity is a diagnosable candidate");
	assert.ok(!checkEnvelope.Check(unbound), "a validated Return envelope requires contract identity");
});

test("a bound value satisfies both schemas; a malformed identity is not even a candidate", () => {
	const bound = candidate();
	assert.ok(checkCandidate.Check(bound));
	assert.ok(checkEnvelope.Check(bound));
	const malformed = candidate({ contractId: "not-a-digest" });
	assert.ok(!checkCandidate.Check(malformed));
	assert.ok(!checkEnvelope.Check(malformed));
});

test("a stale identity passes shape but is rejected by validation, with the stale identity kept as evidence", () => {
	// The schema cannot know the resolved identity — attribution is validation's
	// first check — so a stale candidate must survive shape and fail binding.
	const staleId = `sha256:${"0".repeat(64)}`;
	const stale = candidate({ contractId: staleId });
	assert.ok(checkCandidate.Check(stale));
	const child = result(JSON.stringify(stale));
	const rejected = prepareIntegrationHandoff(child, { contract: resolved, cwd: "/tmp", policy });
	assert.equal(rejected.error?.code, "RETURN_CONTRACT_MISMATCH");
	assert.equal(rejected.rejected?.contractId, staleId, "the rejected candidate keeps the stale identity as parsed");
	assert.equal(child.envelope, undefined, "a rejected candidate never becomes result.envelope");
	assert.equal(Run.of(child).takeRejectedReturnCandidate(), undefined, "a stale identity never leaves surfaceable claims");
});

test("a missing identity is rejected with the absence kept diagnosable", () => {
	const child = result(JSON.stringify(candidate({ contractId: undefined })));
	const rejected = prepareIntegrationHandoff(child, { contract: resolved, cwd: "/tmp", policy });
	assert.equal(rejected.error?.code, "RETURN_CONTRACT_MISMATCH");
	assert.match(rejected.error?.cause ?? "", /\(missing\)/);
	assert.ok(rejected.rejected, "the candidate's own claims stay available as rejection evidence");
	assert.equal(rejected.rejected?.contractId, undefined);
	assert.equal(child.envelope, undefined);
});

test("only validation constructs the Return envelope, stamped with the exact resolved identity", () => {
	const child = result(JSON.stringify(candidate()));
	const validated = prepareIntegrationHandoff(child, { contract: resolved, cwd: "/tmp", policy });
	assert.equal(validated.error, undefined);
	assert.equal(child.envelope?.contractId, resolved.id);
});

test("the attach transition is unreachable outside the validation seam", () => {
	// delegation.ts claimed the seam at module load; no second attach path exists.
	assert.throws(() => Run.claimReturnValidationSeam(), /already claimed/);
	assert.equal((Run.of(result("prose")) as unknown as Record<string, unknown>).acceptReturnEnvelope, undefined);
});
