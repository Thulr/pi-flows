// Offline integration tests for the fail-closed coordination-control protocol
// (#139): a verdict, loop, route, or score token is authoritative only in its
// exact documented form at the child's first non-empty line. See
// tests/integration.test.ts for the general execution-path coverage and
// tests/stub-harness.ts for the stub `pi`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { byAgent, runFlow } from "./stub-harness.ts";

test("route: a negated or off-line ROUTE marker cannot select a downstream role", async () => {
	const { result, calls } = await runFlow(
		{ task: "billing webhook returns 500s", route: { candidates: ["recon", "strategist"] } },
		{ controller: "I cannot issue ROUTE: recon", recon: "MUST_NOT_RUN", strategist: "MUST_NOT_RUN" },
	);

	assert.equal(result.details.error.code, "ROUTE_UNRESOLVED", "a negated marker is not an authoritative route");
	assert.deepEqual(calls.map((call) => call.agent), ["controller"], "no downstream candidate may run");
});

test("evaluate: a negated verdict marker cannot publish a PASS outcome", async () => {
	const { calls, text } = await runFlow(
		{ task: "add a /health endpoint", evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, maxIterations: 1 } },
		{ operator: "DRAFT_ONE", redteam: "I cannot issue VERDICT: PASS" },
	);

	assert.deepEqual(calls.map((call) => call.agent), ["operator", "redteam"], "one generator/critic round");
	assert.match(text, /did not pass/, "a negated marker must fail closed to REVISE");
	assert.doesNotMatch(text, /^Flow evaluate: PASS\b/);
});

test("orchestrate: a negated verifier verdict cannot publish Verification PASS", async () => {
	const { result, text } = await runFlow(
		{ task: "document how auth works", orchestrate: { recon: { agent: "recon" }, verify: { agent: "overwatch" }, verifyPolicy: "fail" } },
		{ commander: '["map login"]', recon: "WORKER_FINDING", debrief: "INCOMPLETE_DOC", overwatch: "I cannot issue VERDICT: PASS" },
	);

	assert.equal(result.details.error.code, "ORCHESTRATE_VERIFY_FAILED", "a negated verdict is not an authoritative PASS");
	assert.doesNotMatch(text, /Verification PASS/);
});

test("loop: a negated LOOP marker cannot stop the loop", async () => {
	const { result, calls } = await runFlow(
		{ task: "draft release notes", loop: { body: { agent: "operator" }, maxIterations: 2 }, concurrency: 1 },
		{ operator: "I cannot issue LOOP: DONE" },
	);

	assert.equal(result.details.error.code, "LOOP_DID_NOT_CONVERGE", "a negated marker is not an authoritative DONE");
	assert.equal(byAgent(calls, "operator").length, 2, "the body keeps iterating to maxIterations");
});

test("search: an out-of-range score cannot rank a candidate", async () => {
	const { calls, text } = await runFlow(
		{
			task: "pick a cache strategy",
			search: { generator: { agent: "recon" }, scorer: { agent: "debrief" }, debrief: { agent: "debrief" }, candidates: 2, beamWidth: 1, maxRounds: 1 },
			concurrency: 1,
		},
		{ recon: ["CANDIDATE_OVERSCORED", "CANDIDATE_HONEST"], debrief: ["SCORE: 150\noverstated", "SCORE: 20\nhonest", "FINAL_HONEST"] },
	);

	assert.match(byAgent(calls, "debrief")[2].task, /CANDIDATE_HONEST/, "the honest 20 beats the out-of-range 150, which scores 0");
	assert.doesNotMatch(byAgent(calls, "debrief")[2].task, /CANDIDATE_OVERSCORED/);
	assert.match(text, /FINAL_HONEST/);
});
