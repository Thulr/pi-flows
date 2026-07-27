import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { FlowContractTask, FlowParams, FlowReturnEnvelope, FlowTask } from "../extensions/pi-flows/schema.ts";
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

test("public schemas expose typed contracts and runtime-enriched envelopes", () => {
	assert.ok(FlowParams.properties.contract);
	assert.ok(FlowContractTask.properties.contract);
	assert.equal("contract" in FlowTask.properties, false);
	assert.ok(FlowReturnEnvelope.properties.usage);
});

test("single accepts a typed contract as the task and retains a validated return envelope", async () => {
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

test("typed contracts fail before dispatch when required fields are malformed", async () => {
	const { result, calls, text } = await runFlow(
		{ agent: "recon", contract: { ...contract, owner: "" } },
		{ recon: envelope() },
	);

	assert.equal(calls.length, 0);
	assert.equal(result.details.error?.code, "INVALID_DELEGATION_CONTRACT");
	assert.match(text, /owner/);
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

test("chain validates each envelope before passing canonical data downstream", async () => {
	const { result, calls } = await runFlow(
		{
			chain: [
				{ agent: "recon", task: "Find the identifier.", contract },
				{ agent: "strategist", task: "Use this validated handoff:\n{previous}", contract: { ...contract, objective: "Explain the validated identifier." } },
			],
		},
		{ recon: envelope(), strategist: envelope({ summary: "Explained it." }) },
	);

	assert.equal(result.details.error, undefined);
	assert.equal(calls.length, 2);
	assert.match(calls[1].task, /"schemaVersion":"pi-flows\.return-envelope\.v1"/);
	assert.match(calls[1].task, /"answer":"xyzzy-42"/);
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

test("evaluate.operator contract overrides the top-level contract", async () => {
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
		{ operator: envelope({ data: { value: "operator-wins" } }), redteam: "VERDICT: PASS" },
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
