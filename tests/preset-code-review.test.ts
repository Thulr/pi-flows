import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { delegationContractId, prepareIntegrationHandoff, ResolvedDelegationContract } from "../extensions/pi-flows/delegation.ts";
import { Run } from "../extensions/pi-flows/run.ts";
import { attachPresetTraceAttributes } from "../extensions/pi-flows/preset-catalog.ts";
import { formatPresetResult, loadPresetsFromDir, packagePresetsDir, preparePresetRun, resolveFlowPreset } from "../extensions/pi-flows/presets.ts";
import { emptyUsage, type FlowPreset, type FlowRunResult } from "../extensions/pi-flows/types.ts";
import { appendFlowSessionEntry, flowProgressText } from "../extensions/pi-flows/ui.ts";
import { runFlow } from "./stub-harness.ts";

function reviewRun(
	role: "standards" | "spec",
	range: { base: string; head: string },
	findings: any[] = [],
	coverage = [{ path: "src/a.ts", status: "reviewed", evidence: "src/a.ts:1" }],
	unresolvedQuestions: string[] = [],
): FlowRunResult {
	return {
		agent: "overwatch",
		role,
		agentSource: "package",
		task: "review",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		envelope: {
			schemaVersion: "pi-flows.return-envelope.v1",
			status: "completed",
			summary: `${role} complete`,
			evidence: [],
			artifactReferences: [],
			digests: [],
			changedState: [],
			unresolvedQuestions,
			retry: { retryable: false },
			data: { axis: role, base: range.base, head: range.head, coverage, findings },
		},
	};
}

const reviewPreset: FlowPreset = {
	name: "code-review",
	description: "test",
	source: "package",
	filePath: "presets/code-review.md",
	overrides: [],
	result: "code-review-v1",
	template: {},
};

test("code-review formatter derives CLEAN, FINDINGS, and PARTIAL from Git-verified typed envelopes", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-review-manifest-"));
	await mkdir(path.join(repo, "src"), { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	await writeFile(path.join(repo, "src", "a.ts"), "before\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repo });
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	await writeFile(path.join(repo, "src", "a.ts"), "after\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head"], { cwd: repo });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const range = { base, head };
	const policy = { recordContent: true, redactSecrets: true };
	const makeOutput = (results: FlowRunResult[]) => ({
		content: [{ type: "text" as const, text: "raw" }],
		details: { mode: "parallel" as const, version: "test", agentScope: "user" as const, config: {} as any, agentsDir: {} as any, results },
	});
	const clean = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range)]), policy, repo, range);
	assert.equal(clean.details.presetOutcome, "CLEAN");
	assert.equal(clean.content[0].text, "Code review: CLEAN");

	const finding = { path: "src/a.ts", startLine: 7, endLine: 7, severity: "high", claim: "Broken invariant", evidence: "src/a.ts:7", suggestion: "Restore it" };
	const found = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range, [finding]), reviewRun("spec", range)]), policy, repo, range);
	assert.equal(found.details.presetOutcome, "FINDINGS");
	assert.match(found.content[0].text, /HIGH src\/a\.ts:7/);

	const partial = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], [{ path: "src/b.ts", status: "reviewed", evidence: "src/b.ts:1" }])]), policy, repo, range);
	assert.equal(partial.details.presetOutcome, "PARTIAL");
	assert.match(partial.content[0].text, /could not be proven complete/);

	const unresolved = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], undefined, ["Issue context unavailable"])]), policy, repo, range);
	assert.equal(unresolved.details.presetOutcome, "PARTIAL");
	assert.match(unresolved.content[0].text, /unresolved: Issue context unavailable/, "the caller needs to know what to supply");

	const skippedPath = [{ path: "src/a.ts", status: "skipped", evidence: "unreadable" }];
	const skipped = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], skippedPath)]), policy, repo, range);
	assert.equal(skipped.details.presetOutcome, "PARTIAL");
	assert.match(skipped.content[0].text, /skipped coverage: src\/a\.ts \(skipped\)/);
	const touchedRun = reviewRun("spec", range);
	touchedRun.envelope!.changedState = ["wrote /tmp/scratch-notes.md"];
	const touched = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), touchedRun]), policy, repo, range);
	assert.equal(touched.details.presetOutcome, "PARTIAL");
	assert.match(touched.content[0].text, /changed state: wrote \/tmp\/scratch-notes\.md/, "a read-only reviewer that touched state must say so");

	const quiet = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), reviewRun("spec", range, [], skippedPath)]), { recordContent: false, redactSecrets: true }, repo, range);
	assert.doesNotMatch(quiet.content[0].text, /src\/a\.ts/, "gap detail is child content and follows the capture policy");

	await writeFile(path.join(repo, "src", "b.ts"), "new\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second head"], { cwd: repo });
	const secondHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const omitted = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", { base, head: secondHead }), reviewRun("spec", { base, head: secondHead })]),
		policy,
		repo,
		{ base, head: secondHead },
	);
	assert.equal(omitted.details.presetOutcome, "PARTIAL");

	const wrongRange = { base: head, head: secondHead };
	const wrongCoverage = [{ path: "src/b.ts", status: "reviewed", evidence: "src/b.ts:1" }];
	const mismatched = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", wrongRange, [], wrongCoverage), reviewRun("spec", wrongRange, [], wrongCoverage)]),
		policy,
		repo,
		range,
	);
	assert.equal(mismatched.details.presetOutcome, "PARTIAL", "reviewer agreement on a different valid range must not produce CLEAN");

	const anchored = { id: "salvaged", path: "src/a.ts", startLine: 1, endLine: 1, severity: "high", category: "correctness", claim: "partial-envelope-claim", evidence: "src/a.ts:1" };
	const partialRun = reviewRun("spec", range, [anchored]);
	partialRun.envelope!.status = "partial";
	const salvaged = formatPresetResult(reviewPreset, makeOutput([reviewRun("standards", range), partialRun]), policy, repo, range);
	assert.equal(salvaged.details.presetOutcome, "PARTIAL", "an unproven axis cannot settle the verdict");
	assert.match(salvaged.content[0].text, /partial-envelope-claim/, "a finding anchored by a partial reviewer must still be reported");
});

test("code-review retains validated metadata privately when returned content is omitted", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-private-review-"));
	await writeFile(path.join(repo, "a.ts"), "before\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: repo });
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	await writeFile(path.join(repo, "a.ts"), "after\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "head"], { cwd: repo });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const codeReview = loaded.presets.find((preset) => preset.name === "code-review")!;
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: "code-review", task: `Review ${base}..${head}.`, recordContent: false }, discovery);
	assert.ok(!("error" in resolved));
	const tasks = resolved.params.tasks as any[];
	const finding = { id: "hidden", path: "a.ts", startLine: 1, endLine: 1, severity: "high", category: "correctness", claim: "private-review-claim", evidence: "a.ts:1", suggestion: "fix it" };
	const envelope = (index: number, axis: "standards" | "spec", findings: any[] = []) => JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(tasks[index].contract),
		status: "completed",
		summary: `${axis} complete`,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { axis, base, head, coverage: [{ path: "a.ts", status: "reviewed", evidence: "a.ts:1" }], findings },
	});
	const traceFile = path.join(repo, "review.jsonl");
	const { result } = await runFlow(
		{ preset: codeReview.name, task: `Review ${base}..${head}.`, recordContent: false, traceFile },
		// Bound by task text, not call order: the preset runs both axes concurrently.
		{ overwatch: [{ whenTaskIncludes: "Standards review", reply: envelope(0, "standards", [finding]) }, { whenTaskIncludes: "Spec review", reply: envelope(1, "spec") }] },
		{ cwd: repo },
	);
	assert.equal(result.details.presetOutcome, "FINDINGS");
	assert.equal(result.content[0].text, "Code review: FINDINGS");
	assert.doesNotMatch(JSON.stringify(result), /private-review-claim/);
	assert.equal((result.details.results[0].envelope?.data as any).axis, "[content omitted: recordContent=false]");
	const trace = await readFile(traceFile, "utf8");
	const root = trace.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((span) => span.parent_span_id === null);
	assert.equal(root.attributes["flow.outcome_verified"], true);
	assert.equal(root.attributes["flow.outcome_success"], false);
	assert.doesNotMatch(trace, /private-review-claim/);
});

test("a partial review axis returns PARTIAL carrying its findings, not a handoff error", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-partial-axis-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q");
	await writeFile(path.join(repo, "a.ts"), "before\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	await writeFile(path.join(repo, "a.ts"), "after\n");
	git("add", ".");
	git("commit", "-qm", "head");
	const head = git("rev-parse", "HEAD");
	const task = `Review ${base}..${head}.`;
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: "code-review", task }, discovery);
	assert.ok(!("error" in resolved));
	const tasks = resolved.params.tasks as any[];
	const finding = { id: "skipped-axis", path: "a.ts", startLine: 1, endLine: 1, severity: "high", category: "correctness", claim: "unproven-axis-claim", evidence: "a.ts:1", suggestion: "fix it" };
	const envelope = (index: number, axis: "standards" | "spec", status: string, findings: any[]) => JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(tasks[index].contract),
		status,
		summary: `${axis} ${status}`,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { axis, base, head, coverage: [{ path: "a.ts", status: "reviewed", evidence: "a.ts:1" }], findings },
	});
	const { result } = await runFlow(
		{ preset: "code-review", task },
		// Bound by task text, not call order: the preset runs both axes concurrently.
		{ overwatch: [{ whenTaskIncludes: "Standards review", reply: envelope(0, "standards", "completed", []) }, { whenTaskIncludes: "Spec review", reply: envelope(1, "spec", "partial", [finding]) }] },
		{ cwd: repo },
	);
	assert.equal(result.details.error, undefined, "an axis that could not finish is a PARTIAL verdict, not a flow failure");
	assert.equal(result.details.presetOutcome, "PARTIAL");
	assert.match(result.content[0].text, /unproven-axis-claim/);
	assert.match(result.content[0].text, /do not treat this result as clean/);
});

test("code-review reports why a review axis did not return", () => {
	const policy = { recordContent: true, redactSecrets: true };
	const failedRun: FlowRunResult = {
		agent: "overwatch",
		role: "spec",
		agentSource: "package",
		task: "review",
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		stopReason: "timeout",
	};
	const output = formatPresetResult(
		reviewPreset,
		{
			content: [{ type: "text" as const, text: "raw" }],
			details: { mode: "parallel" as const, version: "test", agentScope: "user" as const, config: {} as any, agentsDir: {} as any, results: [reviewRun("standards", { base: "a".repeat(40), head: "b".repeat(40) }), failedRun] },
		},
		policy,
	);
	assert.equal(output.details.presetOutcome, "PARTIAL");
	assert.match(output.content[0].text, /Review axes that did not return: spec \(timeout\)/);
});

test("code-review trace attributes publish complete verdicts as verified outcomes", () => {
	const base = { "flow.outcome_verified": false };
	const clean = attachPresetTraceAttributes({ ...base }, reviewPreset, { presetOutcome: "CLEAN" } as any);
	const findings = attachPresetTraceAttributes({ ...base }, reviewPreset, { presetOutcome: "FINDINGS" } as any);
	const partial = attachPresetTraceAttributes({ ...base, "flow.outcome_success": true }, reviewPreset, { presetOutcome: "PARTIAL" } as any);
	assert.equal(clean["flow.outcome_verified"], true);
	assert.equal(clean["flow.outcome_success"], true);
	assert.equal(findings["flow.outcome_verified"], true);
	assert.equal(findings["flow.outcome_success"], false);
	assert.equal(partial["flow.outcome_verified"], false);
	assert.equal(partial["flow.outcome_success"], undefined);

	const undeliverable = attachPresetTraceAttributes({ ...base }, reviewPreset, { presetOutcome: "CLEAN" } as any, false);
	assert.equal(undeliverable["flow.outcome_verified"], false, "a strict run with degraded evidence cannot claim a verified outcome");
	assert.equal(undeliverable["flow.outcome_success"], undefined);

	const refused = attachPresetTraceAttributes({ ...base }, reviewPreset, { presetOutcome: "CLEAN", error: { code: "CHECKPOINT_DENIED" } } as any);
	assert.equal(refused["flow.outcome_verified"], false, "a verdict the run never delivered is not a verified outcome");
	assert.equal(refused["flow.outcome_success"], undefined);
	assert.equal(refused["flow.preset_outcome"], "CLEAN");
});

test("a three-dot review request freezes at the merge base so the manifest is the branch change set", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-review-range-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();
	await mkdir(path.join(repo, "src"), { recursive: true });
	git("init", "-q");
	await writeFile(path.join(repo, "src", "a.ts"), "before\n");
	await writeFile(path.join(repo, "src", "b.ts"), "before\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const mergeBase = git("rev-parse", "HEAD");
	git("checkout", "-qb", "feature");
	await writeFile(path.join(repo, "src", "a.ts"), "after\n");
	git("add", ".");
	git("commit", "-qm", "feature");
	const featureHead = git("rev-parse", "HEAD");
	git("checkout", "-q", "-");
	// The base branch moves on independently: src/b.ts is not part of the branch's
	// change set, but it does differ between the two endpoints.
	await writeFile(path.join(repo, "src", "b.ts"), "moved on\n");
	git("add", ".");
	git("commit", "-qm", "base branch moves on");
	const baseHead = git("rev-parse", "HEAD");

	const runParams = { tasks: [{ task: "standards" }, { task: "spec" }] };
	for (const [phrase, expected] of [
		["Review HEAD~1..HEAD.", { base: mergeBase, head: baseHead }],
		["Review HEAD^..HEAD.", { base: mergeBase, head: baseHead }],
		// A suffix on the trailing ref must survive: pinning base=head here would
		// make an empty manifest that both reviewers could attest CLEAN against.
		["Review HEAD against HEAD^.", { base: mergeBase, head: baseHead }],
		["Review HEAD~1..HEAD^.", { base: mergeBase, head: mergeBase }],
	] as const) {
		assert.deepEqual(preparePresetRun(reviewPreset, runParams, phrase, repo).codeReviewRange, expected, `${phrase} must pin a range`);
	}
	const symmetric = preparePresetRun(reviewPreset, runParams, `Review ${baseHead}...${featureHead}.`, repo);
	assert.deepEqual(symmetric.codeReviewRange, { base: mergeBase, head: featureHead });
	assert.ok((symmetric.params.tasks as any[]).every((item) => item.task.includes(`base ${mergeBase}, head ${featureHead}`)));
	const twoDot = preparePresetRun(reviewPreset, runParams, `Review ${baseHead}..${featureHead}.`, repo);
	assert.deepEqual(twoDot.codeReviewRange, { base: baseHead, head: featureHead }, "a two-endpoint request must keep both endpoints");

	const policy = { recordContent: true, redactSecrets: true };
	const makeOutput = (results: FlowRunResult[]) => ({
		content: [{ type: "text" as const, text: "raw" }],
		details: { mode: "parallel" as const, version: "test", agentScope: "user" as const, config: {} as any, agentsDir: {} as any, results },
	});
	const range = symmetric.codeReviewRange!;
	const branchCoverage = [{ path: "src/a.ts", status: "reviewed", evidence: "src/a.ts:1" }];
	const reviewed = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", range, [], branchCoverage), reviewRun("spec", range, [], branchCoverage)]),
		policy,
		repo,
		range,
	);
	assert.equal(reviewed.details.presetOutcome, "CLEAN", "the branch change set is the whole manifest for a three-dot range");

	const endpointRange = twoDot.codeReviewRange!;
	const endpointReviewed = formatPresetResult(
		reviewPreset,
		makeOutput([reviewRun("standards", endpointRange, [], branchCoverage), reviewRun("spec", endpointRange, [], branchCoverage)]),
		policy,
		repo,
		endpointRange,
	);
	assert.equal(endpointReviewed.details.presetOutcome, "PARTIAL", "src/b.ts also differs between the endpoints, so that coverage is incomplete");
});

test("claims are surfaceable only when attribution and integrity both hold", async () => {
	// Attribution, then integrity, then conformance — and only the last failure
	// leaves surfaceable claims. A stale contractId is a wrong envelope; an artifact that
	// escaped the child cwd or no longer matches its digest is an untrustworthy
	// one. Neither becomes surfaceable because the schema happened to miss too,
	// which is exactly what checking conformance first would have allowed.
	const contract = {
		objective: "Review the change.",
		constraints: [],
		nonGoals: [],
		dependencies: [],
		authority: { may: [], mustNot: [], requiresApproval: [] },
		sideEffectClass: "read-only" as const,
		budget: {},
		acceptanceChecks: [],
		returnSchema: { type: "object", required: ["axis"], properties: { axis: { type: "string" } }, additionalProperties: false },
		owner: "spec",
	};
	const resolved = ResolvedDelegationContract.resolve(contract).resolved!;
	const policy = { recordContent: true, redactSecrets: true };
	const envelope = (contractId: string, data: unknown, artifacts: { artifactReferences?: unknown[]; digests?: unknown[] } = {}) => JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId,
		status: "completed",
		summary: "done",
		evidence: [],
		artifactReferences: artifacts.artifactReferences ?? [],
		digests: artifacts.digests ?? [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data,
	});
	const run = (text: string): FlowRunResult => ({
		agent: "overwatch",
		agentSource: "package",
		task: "review",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		stderr: "",
		usage: emptyUsage(),
	});

	const schemaMiss = run(envelope(resolved.id, { axis: "spec", findings: [{ claim: "surfaceable" }] }));
	const missed = prepareIntegrationHandoff(schemaMiss, { contract: resolved, cwd: process.cwd(), policy });
	assert.equal(missed.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.ok(Run.of(schemaMiss).takeRejectedReturnCandidate(), "a strict-schema miss under the right contract is retained, its claims surfaceable");

	const stale = run(envelope(`sha256:${"0".repeat(64)}`, { axis: "spec", findings: [{ claim: "stale" }] }));
	const mismatched = prepareIntegrationHandoff(stale, { contract: resolved, cwd: process.cwd(), policy });
	assert.equal(mismatched.error?.code, "RETURN_CONTRACT_MISMATCH");
	assert.ok(mismatched.rejected, "the stale envelope's claims stay available as trace evidence");
	assert.equal(Run.of(stale).takeRejectedReturnCandidate(), undefined, "but a stale identity must never have its claims surfaced");

	// Both of the following also miss the schema. Before integrity was checked
	// first, the schema miss short-circuited and carried them out as surfaceable.
	const escaped = run(envelope(resolved.id, { axis: "spec", findings: [{ claim: "escaped" }] }, { artifactReferences: [{ path: "../outside.txt" }] }));
	const uncontained = prepareIntegrationHandoff(escaped, { contract: resolved, cwd: process.cwd(), policy });
	assert.equal(uncontained.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.match(uncontained.error?.cause ?? "", /(escapes|resolves outside) the child cwd/, "containment is the reported diagnosis, not the schema miss it arrived with");
	assert.equal(Run.of(escaped).takeRejectedReturnCandidate(), undefined, "an artifact escaping the cwd never leaves surfaceable claims");

	const dir = await mkdtemp(path.join(tmpdir(), "pi-flow-surfaceable-"));
	await writeFile(path.join(dir, "report.txt"), "actual contents\n");
	const forged = run(envelope(resolved.id, { axis: "spec", findings: [{ claim: "forged" }] }, {
		artifactReferences: [{ path: "report.txt" }],
		digests: [{ artifact: "report.txt", algorithm: "sha256", value: "f".repeat(64) }],
	}));
	const untrusted = prepareIntegrationHandoff(forged, { contract: resolved, cwd: dir, policy });
	assert.equal(untrusted.error?.code, "RETURN_DIGEST_MISMATCH", "an integrity failure outranks the schema miss it arrived with");
	assert.equal(Run.of(forged).takeRejectedReturnCandidate(), undefined, "a digest mismatch never leaves surfaceable claims");

	// A digest whose target was never declared: guarded in validateDigests, and
	// reachable only now that integrity precedes conformance.
	const undeclared = run(envelope(resolved.id, { axis: "spec", findings: [{ claim: "undeclared" }] }, {
		digests: [{ artifact: "report.txt", algorithm: "sha256", value: "a".repeat(64) }],
	}));
	const unbacked = prepareIntegrationHandoff(undeclared, { contract: resolved, cwd: dir, policy });
	assert.equal(unbacked.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.match(unbacked.error?.cause ?? "", /not declared in artifactReferences/, "the undeclared digest target is the reported diagnosis");
	assert.equal(Run.of(undeclared).takeRejectedReturnCandidate(), undefined, "a digest with no declared artifact never leaves surfaceable claims");
});

test("a validated axis keeps its findings when the other axis fails validation", async () => {
	const repo = await mkdtemp(path.join(tmpdir(), "pi-flow-review-mixed-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q");
	await writeFile(path.join(repo, "a.ts"), "before\n");
	git("add", ".");
	git("commit", "-qm", "base");
	const base = git("rev-parse", "HEAD");
	await writeFile(path.join(repo, "a.ts"), "after\n");
	git("add", ".");
	git("commit", "-qm", "head");
	const head = git("rev-parse", "HEAD");
	const task = `Review ${base}..${head}.`;
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: "code-review", task }, discovery);
	assert.ok(!("error" in resolved));
	const tasks = resolved.params.tasks as any[];
	const finding = { id: "kept", path: "a.ts", startLine: 1, endLine: 1, severity: "high", category: "correctness", claim: "surviving-axis-claim", evidence: "a.ts:1", suggestion: "fix it" };
	const envelope = (index: number, axis: "standards" | "spec", data: unknown) => JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(tasks[index].contract),
		status: "completed",
		summary: `${axis} complete`,
		evidence: [],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data,
	});
	const rejectedFinding = { id: "rejected", path: "a.ts", startLine: 2, endLine: 2, severity: "medium", category: "correctness", claim: "schema-rejected-claim", evidence: "a.ts:2", suggestion: "fix it" };
	const good = envelope(0, "standards", { axis: "standards", base, head, coverage: [{ path: "a.ts", status: "reviewed", evidence: "a.ts:1" }], findings: [finding] });
	const malformed = envelope(1, "spec", { axis: "spec", base, head, coverage: "not-an-array", findings: [rejectedFinding] });
	// Bound by task text, not call order: the preset runs both axes concurrently.
	const { result } = await runFlow({ preset: "code-review", task }, { overwatch: [{ whenTaskIncludes: "Standards review", reply: good }, { whenTaskIncludes: "Spec review", reply: malformed }] }, { cwd: repo });
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.match(result.content[0].text, /surviving-axis-claim/, "the validated axis's finding must not be hidden by the other axis's error");
	// A strict-schema miss must not zero out the rejected axis's spend either:
	// its shape-valid envelope is surfaced, labeled as unvalidated.
	assert.match(result.content[0].text, /Unvalidated claims from a rejected Return candidate/, "the rejected candidate is surfaced under the glossary's assurance label");
	assert.match(result.content[0].text, /schema-rejected-claim/, "the rejected axis's own findings are still worth reading");
	// The fix line is delivered to the parent, so it must speak to the parent
	// first — the incident behind issue #104 was a parent replaying a
	// non-retryable flow because the fix text addressed the child.
	assert.match(result.content[0].text, /Do not automatically replay this flow/);
});

// ---------------------------------------------------------------------------
// Budget wrap-up at the preset seam (#112): a contracted reviewer near its
// ceiling is steered to return a partial envelope. Delivery is not compliance —
// an axis that answers the notice with prose must fail, named, while an axis
// that honors it with a valid partial envelope stays graceful.
// ---------------------------------------------------------------------------

/** The code-review preset's real contracts, resolved exactly as runFlow resolves them for `task`. */
function reviewContracts(task: string): { standards: unknown; spec: unknown } {
	const loaded = loadPresetsFromDir(packagePresetsDir, "package");
	const discovery = { presets: loaded.presets, issues: [], packagePresetsDir, userPresetsDir: "", projectPresetsDir: null };
	const resolved = resolveFlowPreset({ preset: "code-review", task }, discovery);
	assert.ok(!("error" in resolved));
	const tasks = (resolved as any).params.tasks as any[];
	return { standards: tasks[0].contract, spec: tasks[1].contract };
}

/** One code-review run whose spec axis is steered to wrap up and answers with `specWrapUpReply`. */
async function runWrapUpReview(specWrapUpReply: (contracts: { standards: unknown; spec: unknown }) => string) {
	const task = "Review the pending change.";
	const contracts = reviewContracts(task);
	return runFlow(
		{ preset: "code-review", task, maxGeneratedTokens: 10, concurrency: 2, timeoutMs: 8_000 },
		{
			overwatch: [
				{ whenTaskIncludes: "Standards review", reply: reviewEnvelope(contracts.standards, "standards", "completed") },
				{ whenTaskIncludes: "Spec review", omitUsage: true, reply: "ack", wrapUpReply: specWrapUpReply(contracts), holdOpenMs: 6_000 },
			],
		},
	);
}

const reviewEnvelope = (contract: unknown, axis: "standards" | "spec", status: "completed" | "partial", overrides: Record<string, unknown> = {}) => JSON.stringify({
	schemaVersion: "pi-flows.return-envelope.v1",
	contractId: delegationContractId(contract as never),
	status,
	summary: `${axis} ${status}`,
	evidence: [],
	artifactReferences: [],
	digests: [],
	changedState: [],
	unresolvedQuestions: status === "partial" ? ["budget exhausted before full coverage"] : [],
	retry: { retryable: false },
	data: { axis, base: "a".repeat(40), head: "b".repeat(40), coverage: [], findings: [] },
	...overrides,
});

test("code-review: a delivered wrap-up answered with prose fails the flow and names the axis", async () => {
	// The incident behind #112: both reviewers crossed the ceiling after the
	// notice, one returned an invalid response, and the UI still said `2 ok`
	// beside error:RETURN_ENVELOPE_INVALID.
	const { result } = await runWrapUpReview(() => "wrapped up in prose instead of the required envelope");
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.match(result.details.error?.cause ?? "", /spec/, "the error names the axis whose envelope failed validation");
	const spec = result.details.results.find((item: any) => item.role === "spec");
	const standards = result.details.results.find((item: any) => item.role === "standards");
	assert.ok(spec && standards);
	assert.equal(spec.wrapUpRequested, true, "the spec axis was steered");
	assert.notEqual(spec.exitCode, 0, "a delivered-but-invalid wrap-up must not render as a success");
	assert.equal(spec.error?.code, "RETURN_ENVELOPE_INVALID");
	assert.equal(standards.exitCode, 0, "the validated axis keeps its success");
	assert.equal(flowProgressText(result.details), "1 failed", "the compact row must never say `2 ok` beside RETURN_ENVELOPE_INVALID");

	// The durable flow card persists the same demoted state: status error, and
	// the failed axis's row carries the validation code rather than a success.
	const entries: any[] = [];
	appendFlowSessionEntry({ appendEntry: (_type: string, data: any) => entries.push(data) } as any, result.details);
	assert.equal(entries[0].status, "error");
	const cardSpec = entries[0].results.find((item: any) => item.role === "spec");
	assert.notEqual(cardSpec.exitCode, 0, "the persisted card row for the spec axis must not read as ✓");
	assert.equal(cardSpec.errorCode, "RETURN_ENVELOPE_INVALID");
});

test("code-review: a wrap-up honored with a valid partial envelope settles graceful and PARTIAL", async () => {
	const { result } = await runWrapUpReview((contracts) => reviewEnvelope(contracts.spec, "spec", "partial"));
	assert.equal(result.details.error, undefined, "an honored wrap-up is not a flow failure");
	const spec = result.details.results.find((item: any) => item.role === "spec");
	assert.equal(spec?.exitCode, 0);
	assert.equal(spec?.stopReason, "budget_wrap_up");
	assert.equal(spec?.envelope?.status, "partial");
	assert.equal(result.details.presetOutcome, "PARTIAL", "an accepted partial envelope is a PARTIAL verdict, not an error");
	assert.match(result.content[0].text, /Code review: PARTIAL/);
});

test("code-review: every dishonored wrap-up in the batch is demoted, not only the first", async () => {
	// The incident shape exactly: BOTH axes cross after the notice and neither
	// returns an envelope. Consumption must validate (and revoke) both before
	// surfacing the first error — a short-circuit left the second axis ✓.
	const task = "Review the pending change.";
	reviewContracts(task); // preset resolvable; contracts irrelevant, both axes return prose
	const { result } = await runFlow(
		{ preset: "code-review", task, maxGeneratedTokens: 10, concurrency: 2, timeoutMs: 8_000 },
		{
			overwatch: [
				// Standards' first turn is delayed so spec's zero-usage ack always
				// settles while the shared budget is untouched. Without the delay, a
				// slow runner can process the ack inside the past-ceiling window that
				// standards' own prose turn opens, hard-stopping spec before its
				// notice echo — BUDGET_EXCEEDED instead of the validation path this
				// test exists to pin.
				{ whenTaskIncludes: "Standards review", reply: "ack", delayBeforeReplyMs: 500, wrapUpReply: "standards wrapped up in prose", holdOpenMs: 6_000 },
				{ whenTaskIncludes: "Spec review", omitUsage: true, reply: "ack", wrapUpReply: "spec wrapped up in prose", holdOpenMs: 6_000 },
			],
		},
	);
	assert.equal(result.details.error?.code, "RETURN_ENVELOPE_INVALID");
	for (const axis of ["standards", "spec"]) {
		const run = result.details.results.find((item: any) => item.role === axis);
		assert.ok(run, `${axis} axis ran`);
		assert.notEqual(run.exitCode, 0, `${axis}: a dishonored wrap-up after the first error must still be demoted`);
		assert.equal(run.error?.code, "RETURN_ENVELOPE_INVALID", `${axis}: carries its own validation cause`);
	}
	assert.equal(flowProgressText(result.details), "2 failed", "no dishonored axis may count as ok");
});
