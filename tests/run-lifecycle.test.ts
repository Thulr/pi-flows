// The Run object (run.ts): one child executing one task, owning its result's
// lifecycle. These tests name the ordering rules that used to live as WeakMap
// side-channels in sanitize.ts and external mutations in delegation.ts — state
// about a result now lives inside the Run, and the transitions that attach an
// envelope or a handoff to a result exist only there.
import { strict as assert } from "node:assert";
import test from "node:test";
import { Run } from "../extensions/pi-flows/run.ts";
import { MODEL_VISIBLE_OUTPUT_CAP, emptyUsage, type DelegationHandoffEnvelope, type DelegationReturnEnvelope, type FlowRunResult } from "../extensions/pi-flows/types.ts";

function childResult(): FlowRunResult {
	return {
		agent: "recon",
		agentSource: "package",
		task: "inspect",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};
}

function returnEnvelope(): DelegationReturnEnvelope {
	return {
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: `sha256:${"a".repeat(64)}`,
		status: "completed",
		summary: "Finding recorded.",
		evidence: [{ claim: "finding is in report.txt", source: "report.txt" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { answer: "report.txt" },
	};
}

function handoffEnvelope(): DelegationHandoffEnvelope {
	return {
		...returnEnvelope(),
		schemaVersion: "pi-flows.handoff-envelope.v1",
		contractId: `sha256:${"a".repeat(64)}`,
		compatibility: "typed",
		provenance: { agent: "recon" },
	};
}

test("one run per result: Run.of answers with the same run for the same result", () => {
	const result = childResult();
	assert.equal(Run.of(result), Run.of(result));
	assert.notEqual(Run.of(result), Run.of(childResult()));
});

test("a run retains one bounded envelope candidate and yields it exactly once", () => {
	const run = Run.of(childResult());
	run.captureEnvelopeCandidate({ role: "assistant", content: [{ type: "text", text: "the envelope body" }] });
	assert.equal(run.takeEnvelopeCandidate(), "the envelope body");
	// Consumed: the candidate cannot linger past validation or leak into details.
	assert.equal(run.takeEnvelopeCandidate(), undefined);
});

test("the retained candidate is capped at the model-visible bound", () => {
	const run = Run.of(childResult());
	run.captureEnvelopeCandidate({ role: "assistant", content: [{ type: "text", text: "x".repeat(MODEL_VISIBLE_OUTPUT_CAP + 4096) }] });
	const candidate = run.takeEnvelopeCandidate();
	assert.ok(candidate);
	// Capped to the bound plus the truncation notice that says so.
	assert.ok(Buffer.byteLength(candidate, "utf8") < MODEL_VISIBLE_OUTPUT_CAP + 256);
	assert.match(candidate, /\[Envelope candidate truncated: \d+ bytes omitted\.\]$/);
});

test("a later capture replaces the candidate; a message without text leaves it standing", () => {
	const run = Run.of(childResult());
	run.captureEnvelopeCandidate({ role: "assistant", content: [{ type: "text", text: "first" }] });
	run.captureEnvelopeCandidate({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] });
	run.captureEnvelopeCandidate({ role: "assistant", content: [{ type: "text", text: "final" }] });
	assert.equal(run.takeEnvelopeCandidate(), "final");
});

test("a failed run discards its envelope candidate", () => {
	const run = Run.of(childResult());
	run.captureEnvelopeCandidate({ role: "assistant", content: [{ type: "text", text: "confident but failed" }] });
	run.discardEnvelopeCandidate();
	assert.equal(run.takeEnvelopeCandidate(), undefined);
});

test("accepting a return envelope attaches the stored form and retains the validated content privately", () => {
	const result = childResult();
	const run = Run.of(result);
	const validated = { ...returnEnvelope(), usage: result.usage };
	const stored = returnEnvelope();
	run.acceptReturnEnvelope(validated, stored);
	// The stored (redacted) form is what the result carries outward.
	assert.equal(result.envelope, stored);
	// The validated content is retained beside it, not on it.
	assert.deepEqual(run.takeValidatedReturnEnvelope(), validated);
});

test("the validated return envelope is consumed once, as an isolated clone", () => {
	const result = childResult();
	const run = Run.of(result);
	const validated = returnEnvelope();
	run.acceptReturnEnvelope(validated, returnEnvelope());
	// Mutating the caller's copy after acceptance must not drift the retained one.
	validated.summary = "tampered";
	const taken = run.takeValidatedReturnEnvelope();
	assert.equal(taken?.summary, "Finding recorded.");
	// And mutating the taken clone touches nothing retained (already consumed).
	assert.equal(run.takeValidatedReturnEnvelope(), undefined);
});

test("accepting a handoff is the transition that attaches it to the result", () => {
	const result = childResult();
	const handoff = handoffEnvelope();
	Run.of(result).acceptHandoff(handoff);
	assert.equal(result.handoff, handoff);
});
