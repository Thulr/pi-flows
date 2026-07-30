import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { FlowContractTask, FlowParams, FlowReturnEnvelope, FlowTask } from "../extensions/pi-flows/schema.ts";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { freshDir, runFlow } from "./stub-harness.ts";

const returnSchema = {
	type: "object",
	required: ["answer"],
	properties: { answer: { type: "string" } },
	additionalProperties: false,
};

const contract = {
	objective: "Find the configured sample identifier.",
	constraints: ["Read only."],
	nonGoals: ["Do not edit configuration."],
	dependencies: ["settings.txt"],
	authority: {
		may: ["Read repository files."],
		mustNot: ["Write repository files."],
		requiresApproval: [],
	},
	sideEffectClass: "read-only",
	budget: { timeoutMs: 30_000, maxGeneratedTokens: 2_000 },
	acceptanceChecks: ["Return the exact identifier with its source path."],
	returnSchema,
	owner: "parent",
};

function envelope(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract),
		status: "completed",
		summary: "Found the identifier.",
		evidence: [{ claim: "The identifier is xyzzy-42.", source: "settings.txt:1" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { answer: "xyzzy-42" },
		...overrides,
	});
}

test("public schemas expose delegation contracts and runtime-enriched envelopes", () => {
	assert.ok(FlowParams.properties.contract);
	assert.ok(FlowContractTask.properties.contract);
	assert.ok(FlowTask.properties.contract);
	assert.ok(FlowReturnEnvelope.properties.contractId);
	assert.ok(FlowReturnEnvelope.properties.usage);
});

test("single accepts a delegation contract as the task and retains a validated return envelope", async () => {
	const { result, calls, text } = await runFlow(
		{ agent: "recon", contract },
		{ recon: envelope() },
	);

	assert.equal(calls.length, 1);
	assert.match(calls[0].task, /Find the configured sample identifier/);
	assert.match(calls[0].task, /pi-flows\.return-envelope\.v1/);
	assert.equal(result.details.error, undefined);
	assert.equal(result.details.results[0].envelope?.data.answer, "xyzzy-42");
	assert.ok(result.details.results[0].envelope?.usage, "runtime usage is attached when available");
	assert.match(text, /xyzzy-42/);
});

test("single preserves valid partial and failed typed terminal reports", async () => {
	for (const status of ["partial", "failed"] as const) {
		const { result, calls, text } = await runFlow(
			{ agent: "recon", contract },
			{ recon: envelope({ status }) },
		);

		assert.equal(calls.length, 1, status);
		assert.equal(result.details.error, undefined, status);
		assert.equal(result.details.results[0].envelope?.status, status);
		assert.match(text, new RegExp(`"status":"${status}"`));
	}
});

test("delegation contracts fail before dispatch when required fields are malformed", async () => {
	const { result, calls, text } = await runFlow(
		{ agent: "recon", contract: { ...contract, owner: "" } },
		{ recon: envelope() },
	);

	assert.equal(calls.length, 0);
	assert.equal(result.details.error?.code, "INVALID_DELEGATION_CONTRACT");
	assert.match(text, /owner/);
});

test("pre-dispatch contract errors obey redaction and content-omission policy", async () => {
	const invalid = { ...contract, returnSchema: { type: "string", pattern: "secret=private-value[" } };
	for (const recordContent of [true, false]) {
		const { result, calls, text } = await runFlow(
			{ agent: "recon", contract: invalid, recordContent },
			{ recon: envelope() },
		);
		assert.equal(calls.length, 0);
		assert.equal(result.details.error?.code, "INVALID_DELEGATION_CONTRACT");
		assert.doesNotMatch(`${text}\n${JSON.stringify(result.details)}`, /private-value/);
	}
});

test("single rejects return data that does not satisfy the contract schema", async () => {
	const { result, calls, text } = await runFlow(
		{ agent: "recon", contract },
		{ recon: envelope({ data: { value: "xyzzy-42" } }) },
	);

	assert.equal(calls.length, 1);
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.match(text, /returnSchema/);
});

test("single verifies artifact digests and fails closed on mismatch", async () => {
	const cwd = await freshDir();
	await writeFile(`${cwd}/answer.txt`, "xyzzy-42\n", "utf8");
	const wrongDigest = createHash("sha256").update("wrong").digest("hex");
	const { result, text } = await runFlow(
		{ agent: "recon", cwd, contract },
		{
			recon: envelope({
				artifactReferences: [{ path: "answer.txt" }],
				digests: [{ artifact: "answer.txt", algorithm: "sha256", value: wrongDigest }],
			}),
		},
	);

	assert.equal(result.details.error?.code, "RETURN_DIGEST_MISMATCH");
	assert.match(text, /answer\.txt/);
});

test("single converts non-file digest targets into a structured envelope error", async () => {
	const cwd = await freshDir();
	const { result, text } = await runFlow(
		{ agent: "recon", cwd, contract },
		{
			recon: envelope({
				artifactReferences: [{ path: "." }],
				digests: [{ artifact: ".", algorithm: "sha256", value: "0".repeat(64) }],
			}),
		},
	);

	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.match(text, /not a regular file/);
});

test("artifact validation errors obey redaction and content-omission policy", async () => {
	const cwd = await freshDir();
	await writeFile(`${cwd}/answer.txt`, "actual\n", "utf8");
	const homePath = `${homedir()}/secret=private-value/answer.txt`;
	const escaping = await runFlow({ agent: "recon", cwd, contract }, {
		recon: envelope({ artifactReferences: [{ path: homePath }], digests: [] }),
	});
	assert.doesNotMatch(JSON.stringify(escaping.result), new RegExp(homedir()));
	const secretPath = "secret=private-value/missing.txt";
	const missing = await runFlow({ agent: "recon", cwd, contract }, {
		recon: envelope({ artifactReferences: [{ path: secretPath }], digests: [] }),
	});
	assert.doesNotMatch(JSON.stringify(missing.result), /private-value/);
	const wrongDigest = "a".repeat(64);
	const mismatch = await runFlow({ agent: "recon", cwd, contract, recordContent: false }, {
		recon: envelope({
			artifactReferences: [{ path: "answer.txt" }],
			digests: [{ artifact: "answer.txt", algorithm: "sha256", value: wrongDigest }],
		}),
	});
	assert.doesNotMatch(JSON.stringify(mismatch.result), new RegExp(wrongDigest));
});

const secondStepContract = { ...contract, objective: "Explain the validated identifier." };

test("chain validates each envelope before passing canonical data downstream", async () => {
	const { result, calls } = await runFlow(
		{
			chain: [
				{ agent: "recon", task: "Find the identifier.", contract },
				{ agent: "strategist", task: "Use this validated handoff:\n{previous}", contract: secondStepContract },
			],
		},
		// Each step's envelope must name the contract that step was dispatched
		// under: chain requires contract identity, as every other contracted path
		// does, so an envelope bound to the first step cannot satisfy the second.
		{ recon: envelope(), strategist: envelope({ contractId: delegationContractId(secondStepContract), summary: "Explained it." }) },
	);

	assert.equal(result.details.error, undefined);
	assert.equal(calls.length, 2);
	assert.match(calls[1].task, /"schemaVersion":"pi-flows\.return-envelope\.v1"/);
	assert.match(calls[1].task, /"answer":"xyzzy-42"/);
});

test("chain preserves incomplete terminal reports but refuses them before downstream consumption", async () => {
	const terminal = await runFlow(
		{ chain: [{ agent: "recon", task: "Find the identifier.", contract }] },
		{ recon: envelope({ status: "partial" }) },
	);
	assert.equal(terminal.result.details.error, undefined);
	assert.equal(terminal.result.details.results[0].envelope?.status, "partial");
	assert.equal(terminal.calls.length, 1);

	const consumed = await runFlow(
		{
			chain: [
				{ agent: "recon", task: "Find the identifier.", contract },
				{ agent: "strategist", task: "Use {previous}", contract: secondStepContract },
			],
		},
		{ recon: envelope({ status: "partial" }), strategist: envelope({ contractId: delegationContractId(secondStepContract) }) },
	);
	assert.equal(consumed.result.details.error?.code, "RETURN_ENVELOPE_INCOMPLETE");
	assert.equal(consumed.calls.length, 1);
});

test("chain stops before downstream consumption when an envelope is invalid", async () => {
	const { result, calls } = await runFlow(
		{
			chain: [
				{ agent: "recon", task: "Find the identifier.", contract },
				{ agent: "strategist", task: "Use {previous}", contract },
			],
		},
		{ recon: "ordinary prose", strategist: envelope() },
	);

	assert.equal(calls.length, 1);
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
});

test("evaluate validates the generator envelope before the critic consumes it", async () => {
	const { result, calls } = await runFlow(
		{ contract, evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 1 } },
		{ operator: envelope(), redteam: "VERDICT: PASS" },
	);

	assert.equal(result.details.error, undefined);
	assert.deepEqual(calls.map((call) => call.agent), ["operator", "redteam"]);
	assert.match(calls[1].task, /"schemaVersion":"pi-flows\.return-envelope\.v1"/);
});

test("evaluate reuses typed validation when stored child content is omitted", async () => {
	const { result, calls } = await runFlow(
		{
			contract,
			recordContent: false,
			evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 1 },
		},
		{ operator: envelope(), redteam: "VERDICT: PASS" },
	);

	assert.equal(result.details.error, undefined);
	assert.deepEqual(calls.map((call) => call.agent), ["operator", "redteam"]);
});

test("evaluate applies completion eligibility only when a critic consumes the report", async () => {
	const terminal = await runFlow(
		{
			contract,
			evaluate: {
				operator: { agent: "operator" },
				redteam: { agent: "redteam" },
				checkCommand: 'node -e "process.exit(1)"',
				maxIterations: 1,
			},
		},
		{ operator: envelope({ status: "partial" }), redteam: "VERDICT: PASS" },
	);
	assert.equal(terminal.result.details.error, undefined);
	assert.equal(terminal.result.details.results[0].envelope?.status, "partial");
	assert.deepEqual(terminal.calls.map((call) => call.agent), ["operator"]);

	const consumed = await runFlow(
		{ contract, evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 1 } },
		{ operator: envelope({ status: "partial" }), redteam: "VERDICT: PASS" },
	);
	assert.equal(consumed.result.details.error?.code, "RETURN_ENVELOPE_INCOMPLETE");
	assert.deepEqual(consumed.calls.map((call) => call.agent), ["operator"]);
});

test("evaluate.operator delegation contract overrides the top-level delegation contract", async () => {
	const operatorContract = {
		...contract,
		objective: "Return a value field.",
		returnSchema: {
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
			additionalProperties: false,
		},
	};
	const { result, calls } = await runFlow(
		{
			contract,
			evaluate: { operator: { agent: "operator", contract: operatorContract }, redteam: { agent: "redteam" }, maxIterations: 1 },
		},
		{ operator: envelope({ contractId: delegationContractId(operatorContract), data: { value: "operator-wins" } }), redteam: "VERDICT: PASS" },
	);

	assert.equal(result.details.error, undefined);
	assert.deepEqual(calls.map((call) => call.agent), ["operator", "redteam"]);
});

test("evaluate fails closed before critic dispatch when the generator envelope is invalid", async () => {
	const { result, calls } = await runFlow(
		{ contract, evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 1 } },
		{ operator: envelope({ data: null }), redteam: "VERDICT: PASS" },
	);

	assert.deepEqual(calls.map((call) => call.agent), ["operator"]);
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
});

test("chain refuses an envelope that is not bound to the contract it was dispatched under", async () => {
	// Structurally valid, and claiming no contract at all. Accepting it would let
	// the next step consume an unbound envelope while `typedHandoff` stamped the
	// dispatched contract's id onto the trace — a binding nothing verified.
	const { result, calls } = await runFlow(
		{
			chain: [
				{ agent: "recon", task: "Find the identifier.", contract },
				{ agent: "strategist", task: "Use {previous}", contract },
			],
		},
		{ recon: envelope({ contractId: undefined }), strategist: envelope() },
	);
	assert.equal(result.details.error?.code, "RETURN_CONTRACT_MISMATCH");
	assert.equal(calls.length, 1, "the unbound envelope must not reach the next step");
});

test("no contracted mode accepts an envelope bound to a different contract", async () => {
	// One rule, checked at every contracted seam. `single` has no downstream
	// consumer, but validating an envelope's data against a contract it does not
	// claim is still reporting success for work performed under other terms.
	const other = delegationContractId({ ...contract, objective: "Something else entirely." } as never);

	const lone = await runFlow({ agent: "recon", task: "Find it.", contract }, { recon: envelope({ contractId: other }) });
	assert.equal(lone.result.details.error?.code, "RETURN_CONTRACT_MISMATCH");

	// evaluate: the critics would otherwise judge an unbound artifact while the
	// handoff event stamped the dispatched contract's id onto it.
	const evaluated = await runFlow(
		{ task: "Find it.", contract, evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 1 } },
		{ operator: envelope({ contractId: other }), redteam: "VERDICT: PASS" },
	);
	assert.equal(evaluated.result.details.error?.code, "RETURN_CONTRACT_MISMATCH");
	assert.equal(evaluated.calls.length, 1, "the unbound artifact must not reach the critics");
});

test("a resynthesis carries the accepted handoff, not the raw prior answer", async () => {
	// The retry prompt is an inter-agent boundary like any other: the prior answer
	// must reach the next synthesizer as the validated canonical handoff whose
	// bytes and warnings the trace recorded, not as raw output that skipped the
	// injection scan.
	const { calls } = await runFlow(
		{
			task: "map the system",
			concurrency: 1,
			contract,
			orchestrate: {
				commander: { agent: "commander" }, recon: { agent: "recon" }, debrief: { agent: "debrief" }, verify: { agent: "overwatch" },
				maxSubtasks: 1, verifyPolicy: "revise", verifyMaxIterations: 2,
			},
		},
		{
			commander: '["only"]',
			recon: envelope(),
			debrief: [envelope({ summary: "First pass." }), envelope({ summary: "Revised." })],
			// The verdict is read off the accepted handoff's `data`, not the summary.
			overwatch: [envelope({ data: { answer: "VERDICT: REVISE" } }), envelope({ data: { answer: "VERDICT: PASS" } })],
		},
	);
	const resynthesis = calls.filter((call) => call.agent === "debrief")[1];
	assert.ok(resynthesis, "the verifier's REVISE must drive a second synthesis");
	// Isolate the prior answer: the findings above it are handoffs already, so a
	// whole-prompt match would pass no matter what this section carried.
	const priorAnswer = resynthesis.task
		.split("## Previous synthesized answer (revise this in place)\n")[1]
		?.split("\n## ")[0] ?? "";
	assert.match(priorAnswer, /^\{"schemaVersion":"pi-flows\.handoff-envelope\.v1"/);
});

test("orchestrate reuses verifier validation before deferred resynthesis", async () => {
	const commanderContract = {
		...contract,
		objective: "Decompose the goal.",
		returnSchema: { type: "array", items: { type: "string" } },
	};
	const { result, calls } = await runFlow(
		{
			task: "map the system",
			concurrency: 1,
			contract,
			recordContent: false,
			orchestrate: {
				commander: { agent: "commander", contract: commanderContract },
				recon: { agent: "recon" },
				debrief: { agent: "debrief" },
				verify: { agent: "overwatch", contract },
				maxSubtasks: 1,
				verifyPolicy: "revise",
				verifyMaxIterations: 2,
			},
		},
		{
			commander: envelope({
				contractId: delegationContractId(commanderContract),
				data: ["only"],
			}),
			recon: envelope(),
			debrief: [envelope({ summary: "First pass." }), envelope({ summary: "Revised." })],
			overwatch: [
				envelope({ data: { answer: "VERDICT: REVISE" } }),
				envelope({ data: { answer: "VERDICT: PASS" } }),
			],
		},
	);

	// Content omission hides the verdict marker, so the verifier conservatively
	// remains REVISE. Reaching both resynthesis rounds proves deferred validation
	// reused the accepted envelope instead of reparsing the omitted message.
	assert.equal(result.details.error?.code, "ORCHESTRATE_VERIFY_FAILED");
	assert.notEqual(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.equal(calls.filter((call) => call.agent === "debrief").length, 2);
	assert.equal(calls.filter((call) => call.agent === "overwatch").length, 2);
});
