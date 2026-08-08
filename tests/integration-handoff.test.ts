import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	canonicalHandoff,
	delegationContractId,
	prepareIntegrationHandoff,
	ResolvedDelegationContract,
} from "../extensions/pi-flows/delegation.ts";
import { FlowParams } from "../extensions/pi-flows/schema.ts";
import { emptyUsage, type DelegationContract, type FlowRunResult } from "../extensions/pi-flows/types.ts";
import { workerRecoveryDetails } from "../extensions/pi-flows/modes/worktree.ts";
import { freshDir, runFlow } from "./stub-harness.ts";

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

function result(text: string): FlowRunResult {
	return {
		agent: "recon",
		agentSource: "package",
		task: "find the answer",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
		stderr: "",
		usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01, turns: 1 },
		step: 2,
	};
}

// The transition path accepts only a resolved contract; raw data stays for identity assertions.
const resolved = ResolvedDelegationContract.resolve(contract).resolved!;

function typedEnvelopeFor(envelopeContract: DelegationContract, data: unknown, overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(envelopeContract),
		status: "completed",
		summary: "Found it.",
		evidence: [{ claim: "The answer is 42.", source: "answer.txt:1" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data,
		...overrides,
	});
}

function typedEnvelope(overrides: Record<string, unknown> = {}) {
	return typedEnvelopeFor(contract, { answer: 42 }, overrides);
}

test("worktree recovery details redact home paths while preserving usable locations", () => {
	const homeWorktree = path.join(homedir(), "AppData", "Local", "Temp", "pi-flow-worker");
	const details = workerRecoveryDetails([
		{ branch: "pi-flow/run/a", cwd: homeWorktree },
	], policy);
	assert.doesNotMatch(details, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(details, /`pi-flow\/run\/a` at `~[\\/]AppData[\\/]Local[\\/]Temp[\\/]pi-flow-worker`/);
});

test("contracted prompts carry a stable delegation-contract identity", () => {
	const id = delegationContractId(contract);
	assert.equal(id, delegationContractId(structuredClone(contract)));
	assert.match(id, /^sha256:[a-f0-9]{64}$/);
	assert.match(resolved.renderTask(undefined), new RegExp(id));
	assert.equal(resolved.id, id, "the resolved identity is the canonical digest");
});

test("integration handoffs reject missing and stale contract identities", () => {
	const missing = prepareIntegrationHandoff(result(typedEnvelope({ contractId: undefined })), {
		contract: resolved,
		cwd: "/tmp",
		policy,
	});
	assert.equal(missing.error?.code, "RETURN_CONTRACT_MISMATCH");

	const stale = prepareIntegrationHandoff(result(typedEnvelope({ contractId: "sha256:".concat("0".repeat(64)) })), {
		contract: resolved,
		cwd: "/tmp",
		policy,
	});
	assert.equal(stale.error?.code, "RETURN_CONTRACT_MISMATCH");
});

test("callers cannot forge a prior-validation receipt", () => {
	const forged = prepareIntegrationHandoff(result("ordinary prose"), {
		contract: resolved,
		cwd: "/tmp",
		policy,
		validation: {},
	});

	assert.equal(forged.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.equal(forged.handoff, undefined);
});

test("validation receipts retain an immutable private snapshot", () => {
	const child = result(typedEnvelope());
	const validated = prepareIntegrationHandoff(child, {
		contract: resolved,
		cwd: "/tmp",
		policy,
		enforceCompletion: false,
	});
	assert.ok(validated.validation);
	// The token exposes no properties at all (ECMAScript-private fields), so a
	// caller retaining it has nothing to tamper with and re-present.
	assert.deepEqual(Object.keys(validated.validation!), []);
	validated.handoff!.status = "failed";
	child.envelope!.status = "failed";

	const reused = prepareIntegrationHandoff(child, {
		contract: resolved,
		cwd: "/tmp",
		policy,
		validation: validated.validation,
	});

	assert.equal(reused.error, undefined);
	assert.equal(reused.handoff?.status, "completed");
});

test("validation receipts cannot carry permissive content into a stricter capture policy", () => {
	const secret = "secret=private-value";
	const child = result(typedEnvelope({ summary: secret }));
	const permissive = prepareIntegrationHandoff(child, {
		contract: resolved,
		cwd: "/tmp",
		policy: { recordContent: true, redactSecrets: false },
	});
	assert.ok(permissive.validation);
	assert.match(permissive.handoff?.summary ?? "", /private-value/);

	const restrictive = prepareIntegrationHandoff(child, {
		contract: resolved,
		cwd: "/tmp",
		policy: { recordContent: false, redactSecrets: true },
		validation: permissive.validation,
	});

	assert.equal(restrictive.error, undefined);
	assert.doesNotMatch(canonicalHandoff(restrictive.handoff!), /private-value/);
	assert.equal(restrictive.handoff?.summary, "[content omitted: recordContent=false]");
});

test("integration handoffs reject digest-mismatched artifacts", async () => {
	const cwd = await freshDir();
	await writeFile(`${cwd}/artifact.txt`, "actual content\n");
	const mismatched = prepareIntegrationHandoff(result(typedEnvelope({
		artifactReferences: [{ path: "artifact.txt" }],
		digests: [{ artifact: "artifact.txt", algorithm: "sha256", value: "0".repeat(64) }],
	})), {
		contract: resolved,
		cwd,
		policy,
	});
	assert.equal(mismatched.error?.code, "RETURN_DIGEST_MISMATCH");
});

test("partial and blocked typed handoffs fail closed unless inclusion is explicit", () => {
	for (const status of ["partial", "blocked"] as const) {
		const rejectedResult = result(typedEnvelope({ status }));
		const rejected = prepareIntegrationHandoff(rejectedResult, {
			contract: resolved,
			cwd: "/tmp",
			policy,
		});
		assert.equal(rejected.error?.code, "RETURN_ENVELOPE_INCOMPLETE");
		assert.equal(rejectedResult.handoff, undefined);

		const included = prepareIntegrationHandoff(result(typedEnvelope({ status })), {
			contract: resolved,
			cwd: "/tmp",
			policy,
			incompletePolicy: "include",
		});
		assert.equal(included.error, undefined);
		assert.equal(included.handoff?.status, status);
		assert.match(canonicalHandoff(included.handoff!), new RegExp(`"status":"${status}"`));
	}
});

test("failed typed handoffs remain terminal when incomplete inclusion is explicit", () => {
	const failed = prepareIntegrationHandoff(result(typedEnvelope({ status: "failed" })), {
		contract: resolved,
		cwd: "/tmp",
		policy,
		incompletePolicy: "include",
	});
	assert.equal(failed.error?.code, "RETURN_ENVELOPE_INCOMPLETE");
	assert.match(failed.error?.fix ?? "", /Failed handoffs remain terminal/);
});

test("legacy prose is preserved through a provenance-bearing compatibility envelope", () => {
	const legacy = result("ordinary prose with evidence at README.md:1");
	const prepared = prepareIntegrationHandoff(legacy, { cwd: "/tmp", policy });
	assert.equal(prepared.error, undefined);
	assert.equal(prepared.handoff?.compatibility, "legacy-prose");
	assert.equal(prepared.handoff?.contractId, null);
	assert.equal(prepared.handoff?.provenance.agent, "recon");
	assert.equal(prepared.handoff?.provenance.step, 2);
	assert.match(canonicalHandoff(prepared.handoff!), /ordinary prose/);
});

test("public integration-mode schemas accept role-specific contracts and an explicit incomplete policy", () => {
	assert.ok(FlowParams.properties.incompleteHandoffPolicy);
	assert.ok(FlowParams.properties.tasks.items.properties.contract);
	assert.ok(FlowParams.properties.graph.properties.nodes.items.properties.contract);
	assert.ok(FlowParams.properties.workflow.properties.phases.items.properties.contract);
	assert.ok(FlowParams.properties.worktree.properties.tasks.items.properties.contract);
	assert.ok(FlowParams.properties.vote.properties.voters.items.properties.contract);
	assert.ok(FlowParams.properties.debate.properties.participants.items.properties.contract);
	assert.ok(FlowParams.properties.dossier.properties.sections.items.properties.contract);
});

test("parallel validates typed returns and exposes compatibility provenance for legacy returns", async () => {
	const { result: output, calls } = await runFlow(
		{
			tasks: [
				{ agent: "recon", task: "typed", contract },
				{ agent: "analyst", task: "legacy" },
			],
		},
		{
			recon: typedEnvelope(),
			analyst: "legacy finding",
		},
	);
	assert.equal(output.details.error, undefined);
	assert.equal(calls.length, 2);
	assert.equal(output.details.results[0].handoff?.contractId, delegationContractId(contract));
	assert.equal(output.details.results[1].handoff?.compatibility, "legacy-prose");
	assert.match(output.content[0].text, /"data":\{"answer":42\}/, "terminal parallel output preserves the contracted data, not only its summary");
	assert.match(output.content[0].text, /legacy finding/);
});

test("graph rejects a stale node envelope before a dependent node is dispatched", async () => {
	const { result: output, calls } = await runFlow(
		{
			graph: {
				nodes: [
					{ id: "source", agent: "recon", task: "typed source", contract },
					{ id: "consumer", agent: "analyst", task: "consume {node.source}", dependsOn: ["source"] },
				],
			},
		},
		{
			recon: typedEnvelope({ contractId: `sha256:${"0".repeat(64)}` }),
			analyst: "must not run",
		},
	);
	assert.equal(output.details.error?.code, "RETURN_CONTRACT_MISMATCH");
	assert.deepEqual(calls.map((call) => call.agent), ["recon"]);
});

test("vote requires an explicit policy before aggregating partial typed ballots", async () => {
	const params = {
		task: "Return the answer.",
		contract,
		vote: { agent: "recon", count: 2 },
	};
	const plan = { recon: [typedEnvelope({ status: "partial" }), typedEnvelope({ status: "partial" })] };
	const rejected = await runFlow(params, plan);
	assert.equal(rejected.result.details.error?.code, "RETURN_ENVELOPE_INCOMPLETE");

	const included = await runFlow({ ...params, incompleteHandoffPolicy: "include" }, plan);
	assert.equal(included.result.details.error, undefined);
	assert.match(included.text, /Included incomplete handoffs by explicit policy/);
});

test("orchestrate rejects an invalid typed worker before synthesis", async () => {
	const { result: output, calls } = await runFlow(
		{
			task: "Answer from two findings.",
			orchestrate: {
				commander: { agent: "commander" },
				recon: { agent: "recon", contract },
				debrief: { agent: "debrief" },
				maxSubtasks: 2,
			},
		},
		{
			commander: '["first", "second"]',
			recon: [typedEnvelope(), typedEnvelope({ data: { wrong: true } })],
			debrief: "must not synthesize",
		},
	);
	assert.equal(output.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.deepEqual(calls.map((call) => call.agent).sort(), ["commander", "recon", "recon"].sort());
});

test("orchestrate reads typed verifier verdicts from handoff data", async () => {
	const verifierContract: DelegationContract = {
		...contract,
		objective: "Judge the synthesized answer.",
		acceptanceChecks: ["Return a pass or revise verdict."],
		returnSchema: {
			type: "object",
			required: ["verdict"],
			properties: { verdict: { type: "string", enum: ["pass", "revise"] } },
			additionalProperties: false,
		},
	};
	const { result: output, calls, text } = await runFlow(
		{
			task: "Answer from one finding.",
			orchestrate: {
				recon: { agent: "recon" },
				verify: { agent: "overwatch", contract: verifierContract },
				verifyPolicy: "fail",
				maxSubtasks: 1,
			},
		},
		{
			commander: '["find the answer"]',
			recon: "WORKER_FINDING",
			debrief: "COMPLETE_ANSWER",
			overwatch: typedEnvelopeFor(verifierContract, { verdict: "pass" }, { summary: "Verified." }),
		},
	);
	assert.equal(output.details.error, undefined);
	assert.deepEqual(calls.map((call) => call.agent), ["commander", "recon", "debrief", "overwatch"]);
	assert.match(text, /Verification PASS/);
});

test("dossier rejects invalid typed evidence before debrief", async () => {
	const { result: output, calls } = await runFlow(
		{
			task: "Build a dossier.",
			dossier: {
				sections: [
					{ agent: "recon", task: "source one", contract },
					{ agent: "analyst", task: "source two", contract },
				],
				debrief: { agent: "debrief" },
			},
		},
		{
			recon: typedEnvelope(),
			analyst: typedEnvelope({ data: null }),
			debrief: "must not synthesize",
		},
	);
	assert.equal(output.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.equal(calls.some((call) => call.agent === "debrief"), false);
});

test("workflow persists a validated typed phase handoff", async () => {
	const cwd = await freshDir();
	const { result: output } = await runFlow(
		{
			task: "Run one phase.",
			workflow: {
				stateFile: "workflow.json",
				phases: [{ id: "inspect", agent: "recon", task: "return 42", contract }],
			},
		},
		{ recon: typedEnvelope() },
		{ cwd },
	);
	assert.equal(output.details.error, undefined);
	assert.equal(output.details.results[0].handoff?.compatibility, "typed");
	assert.equal(output.details.results[0].handoff?.contractId, delegationContractId(contract));
});

test("workflow resume revalidates stale and schema-invalid persisted handoffs", async (t) => {
	for (const scenario of ["stale", "invalid"] as const) {
		await t.test(scenario, async () => {
			const cwd = await freshDir();
			const params = {
				task: "Run one phase.",
				workflow: {
					stateFile: "workflow.json",
					phases: [{ id: "inspect", agent: "recon", task: "return 42", contract }],
				},
			};
			const initial = await runFlow(params, { recon: typedEnvelope() }, { cwd });
			assert.equal(initial.result.details.error, undefined);
			const stateFile = `${cwd}/workflow.json`;
			const state = JSON.parse(await readFile(stateFile, "utf8"));
			if (scenario === "stale") state.handoffs.inspect.contractId = `sha256:${"0".repeat(64)}`;
			else state.handoffs.inspect.data = { wrong: true };
			await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);

			const resumed = await runFlow(
				{ ...params, workflow: { ...params.workflow, resume: true } },
				{ recon: "MUST_NOT_RERUN" },
				{ cwd },
			);
			assert.equal(
				resumed.result.details.error?.code,
				scenario === "stale" ? "RETURN_CONTRACT_MISMATCH" : "RETURN_ENVELOPE_INVALID",
			);
			assert.equal(resumed.calls.filter((call) => call.agent === "recon").length, 1);
		});
	}
});

test("workflow resume uses validation attestations when stored content is omitted or redacted", async () => {
	const cwd = await freshDir();
	const artifact = "artifact-secret=resume-private-value.txt";
	const artifactContent = "verified artifact\n";
	const attestedContract: DelegationContract = {
		...contract,
		returnSchema: {
			type: "object",
			required: ["code"],
			properties: { code: { const: "secret=resume-private-value" } },
			additionalProperties: false,
		},
	};
	const reply = JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(attestedContract),
		status: "completed",
		summary: "Verified secret=resume-private-value.",
		evidence: [],
		artifactReferences: [{ path: artifact }],
		digests: [{
			artifact,
			algorithm: "sha256",
			value: createHash("sha256").update(artifactContent).digest("hex"),
		}],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { code: "secret=resume-private-value" },
	});
	const params = {
		task: "Run one private phase.",
		recordContent: false,
		workflow: {
			stateFile: "workflow.json",
			phases: [{ id: "inspect", agent: "recon", task: "return private result", contract: attestedContract }],
		},
	};
	const initial = await runFlow(params, {
		recon: { reply, writes: { [artifact]: artifactContent } },
	}, { cwd });
	assert.equal(initial.result.details.error, undefined);
	const state = JSON.parse(await readFile(`${cwd}/workflow.json`, "utf8"));
	assert.equal(state.version, 3);
	assert.equal(state.attestations.inspect.validation, "typed");
	assert.doesNotMatch(JSON.stringify(state), /resume-private-value/);

	const resumed = await runFlow(
		{ ...params, workflow: { ...params.workflow, resume: true } },
		{ recon: "MUST_NOT_RERUN" },
		{ cwd },
	);
	assert.equal(resumed.result.details.error, undefined);
	assert.equal(resumed.calls.filter((call) => call.agent === "recon").length, 1);
});

test("workflow resume preserves included incomplete handoffs in the final summary", async () => {
	const cwd = await freshDir();
	const params = {
		task: "Review an incomplete finding.",
		incompleteHandoffPolicy: "include",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "inspect", agent: "recon", task: "Inspect the finding", contract },
				{ id: "approve", approval: { message: "Accept the incomplete finding" } },
			],
		},
	};
	const paused = await runFlow(params, {
		recon: typedEnvelope({
			status: "partial",
			summary: "Partial finding.",
			unresolvedQuestions: ["Need one more source."],
			retry: { retryable: true, reason: "Source unavailable." },
		}),
	}, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");

	const resumed = await runFlow(
		{ ...params, workflow: { ...params.workflow, resume: true } },
		{},
		{ cwd, hasUI: true },
	);
	assert.equal(resumed.result.details.error, undefined);
	assert.match(resumed.text, /Included incomplete handoffs by explicit policy: recon:partial/);
	assert.match(resumed.text, /APPROVED/);
});

test("workflow resume migrates legacy version-1 state to compatibility handoffs", async () => {
	const cwd = await freshDir();
	const params = {
		task: "prepare the release",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "analyze", agent: "recon", task: "Analyze the release" },
				{ id: "approve", approval: { message: "Approve the analysis" } },
				{ id: "plan", agent: "strategist", task: "Plan from {phase.analyze}" },
			],
		},
	};
	const paused = await runFlow(params, { recon: "NEW_FORMAT_ANALYSIS" }, { cwd });
	assert.equal(paused.result.details.error?.code, "WORKFLOW_APPROVAL_REQUIRED");
	const stateFile = `${cwd}/workflow.json`;
	const legacy = JSON.parse(await readFile(stateFile, "utf8"));
	legacy.version = 1;
	legacy.outputs.analyze = "LEGACY_ANALYSIS";
	delete legacy.handoffs;
	delete legacy.attestations;
	await writeFile(stateFile, `${JSON.stringify(legacy, null, 2)}\n`);

	const resumed = await runFlow(
		{ ...params, workflow: { ...params.workflow, resume: true } },
		{ strategist: "RELEASE_PLAN" },
		{ cwd, hasUI: true },
	);
	assert.equal(resumed.result.details.error, undefined);
	assert.match(resumed.calls.at(-1)?.task ?? "", /LEGACY_ANALYSIS/);
	const migrated = JSON.parse(await readFile(stateFile, "utf8"));
	assert.equal(migrated.version, 3);
	assert.equal(migrated.handoffs.analyze.compatibility, "legacy-prose");
	assert.equal(migrated.attestations.analyze.validation, "legacy-compatibility");
});

test("debate preserves typed advocate and adjudicator provenance", async () => {
	const { result: output } = await runFlow(
		{
			task: "Choose the answer.",
			contract,
			debate: {
				participants: [{ agent: "recon" }, { agent: "analyst" }],
				adjudicator: { agent: "debrief" },
				rounds: 1,
			},
		},
		{
			recon: typedEnvelope({ summary: "Advocate one." }),
			analyst: typedEnvelope({ summary: "Advocate two." }),
			debrief: typedEnvelope({ summary: "Decision." }),
		},
	);
	assert.equal(output.details.error, undefined);
	assert.equal(output.details.results.length, 3);
	assert.ok(output.details.results.every((run) => run.handoff?.compatibility === "typed"));
	assert.deepEqual(output.details.results.map((run) => run.handoff?.provenance.agent), ["recon", "analyst", "debrief"]);
});

test("worktree validates typed worker envelopes before integration", async () => {
	const cwd = await freshDir();
	await writeFile(`${cwd}/a.txt`, "old a\n");
	await writeFile(`${cwd}/b.txt`, "old b\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd });

	const { result: output } = await runFlow(
		{
			task: "Update both files.",
			worktree: {
				tasks: [
					{ id: "a", agent: "operator", task: "update a.txt", contract },
					{ id: "b", agent: "operator", task: "update b.txt", contract },
				],
				integrator: { agent: "debrief" },
			},
		},
		{
			operator: [
				{ whenTaskIncludes: "assignment (a)", reply: typedEnvelope(), writes: { "a.txt": "new a\n" } },
				{ whenTaskIncludes: "assignment (b)", reply: typedEnvelope(), writes: { "b.txt": "new b\n" } },
			],
			debrief: "integration reviewed",
		},
		{ cwd },
	);
	assert.equal(output.details.error, undefined);
	const workers = output.details.results.filter((run) => run.agent === "operator");
	assert.equal(workers.length, 2);
	assert.ok(workers.every((run) => run.handoff?.contractId === delegationContractId(contract)));
});

test("worktree exposes retained recovery paths after typed handoff rejection", async () => {
	const cwd = await freshDir();
	await writeFile(`${cwd}/a.txt`, "old a\n");
	await writeFile(`${cwd}/b.txt`, "old b\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "seed"], { cwd });

	const { result: output, text } = await runFlow(
		{
			task: "Update both files.",
			worktree: {
				tasks: [
					{ id: "a", agent: "operator", task: "update a.txt", contract },
					{ id: "b", agent: "operator", task: "update b.txt", contract },
				],
			},
		},
		{
			operator: [
				{ whenTaskIncludes: "assignment (a)", reply: typedEnvelope({ data: { wrong: true } }), writes: { "a.txt": "new a\n" } },
				{ whenTaskIncludes: "assignment (b)", reply: typedEnvelope(), writes: { "b.txt": "new b\n" } },
			],
		},
		{ cwd },
	);
	assert.equal(output.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.match(text, /Worker state retained for recovery/);
	const retained = [...text.matchAll(/- `([^`]+)` at `([^`]+)`/g)];
	assert.equal(retained.length, 2, text);
	assert.equal(await readFile(`${retained[0][2]}/a.txt`, "utf8"), "new a\n");
	assert.match(execFileSync("git", ["branch", "--list", retained[0][1]], { cwd, encoding: "utf8" }), new RegExp(retained[0][1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

	for (const [, , worktree] of retained) execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd });
	for (const branch of execFileSync("git", ["branch", "--list", "pi-flow/*"], { cwd, encoding: "utf8" }).split("\n").map((line) => line.trim()).filter(Boolean)) {
		execFileSync("git", ["branch", "-D", branch], { cwd });
	}
	await rm(path.dirname(retained[0][2]), { recursive: true, force: true });
});
