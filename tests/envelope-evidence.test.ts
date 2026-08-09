// Terminal envelope evidence: a mode's FINAL contracted output is consumed by
// the parent, not by another role — no handoff exists — but CONTEXT.md promises
// that what the spend produced stays in the trace. Every contracted consumption
// must therefore leave exactly one validation event (and one artifact event per
// declared artifact) whether it validates or is rejected, named under the
// validation vocabulary rather than `handoff.*`, while integrate-path event
// names stay byte-identical. This is the per-mode evidence matrix.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import { ResolvedDelegationContract, delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { createHandoffConsumer } from "../extensions/pi-flows/handoff-consumption.ts";
import { handleGraph } from "../extensions/pi-flows/modes/graph.ts";
import { handleParallel } from "../extensions/pi-flows/modes/parallel.ts";
import { handleSingle } from "../extensions/pi-flows/modes/single.ts";
import { makeTraceSink } from "../extensions/pi-flows/trace-sink.ts";
import { parseTraceJsonl, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";
import {
	emptyUsage,
	type DelegationContract,
	type FlowDiscovery,
	type FlowMode,
	type FlowRunResult,
	type ModeDeps,
	type ModeOutput,
	type RunChildOptions,
} from "../extensions/pi-flows/types.ts";
import { freshDir } from "./stub-harness.ts";

const TRACE = "trace.jsonl";

const contract: DelegationContract = {
	objective: "Write the note and report it.",
	constraints: ["Cite the artifact."],
	nonGoals: [],
	dependencies: [],
	authority: { may: ["Write note files."], mustNot: [], requiresApproval: [] },
	sideEffectClass: "reversible",
	budget: {},
	acceptanceChecks: ["Return the artifact digest."],
	returnSchema: {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "string" } },
		additionalProperties: false,
	},
	owner: "parent",
};

const discovery: FlowDiscovery = {
	agents: [
		{ name: "recon", description: "read-only scout", tools: ["read"], systemPrompt: "recon prompt", source: "package", filePath: "/pkg/recon.md" },
		{ name: "debrief", description: "synthesizer", tools: ["read"], systemPrompt: "debrief prompt", source: "package", filePath: "/pkg/debrief.md" },
	],
	projectAgentsDir: null,
	userAgentsDir: "/tmp/user-agents",
	packageAgentsDir: "/tmp/package-agents",
	issues: [],
};

function envelope(artifact: string, digest: string): string {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract),
		status: "completed",
		summary: `Wrote ${artifact}.`,
		evidence: [{ claim: "The note exists.", source: `${artifact}:1` }],
		artifactReferences: [{ path: artifact }],
		digests: [{ artifact, algorithm: "sha256", value: digest }],
		changedState: [artifact],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { answer: artifact },
	});
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const MISMATCH = "0".repeat(64);

function fakeResult(options: RunChildOptions, text: string): FlowRunResult {
	return {
		agent: options.agentName,
		agentSource: "package",
		task: options.task,
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text }] } as any],
		stderr: "",
		usage: { ...emptyUsage(), input: 10, output: 5, cost: 0.01, turns: 1 },
		step: options.step,
		durationMs: 5,
	};
}

/**
 * ModeDeps over a fake runChild and a REAL trace sink, so the handlers run
 * in-process while the evidence lands in an actual JSONL trace — the
 * composition fault-scenarios uses for its poisoned-sink run. `cwd` is
 * pre-seeded by the caller so envelopes can reference artifacts that exist
 * before the flow runs.
 */
async function evidenceRunAt(
	cwd: string,
	mode: FlowMode,
	handler: (deps: ModeDeps) => Promise<ModeOutput>,
	params: Record<string, unknown>,
	replies: Record<string, string | string[]>,
): Promise<{ output: ModeOutput; spans: TraceSpanRecord[]; cwd: string }> {
	const sink = makeTraceSink(path.join(cwd, TRACE), mode, { recordContent: true, redactSecrets: true });
	const catalog = createAgentCatalog(discovery, "user");
	const served = new Map<string, number>();
	const deps: ModeDeps = {
		params,
		discovery,
		policy: { recordContent: true, redactSecrets: true },
		handoffs: createHandoffConsumer({
			params,
			mode,
			policy: { recordContent: true, redactSecrets: true },
			defaultCwd: cwd,
			recordEvent: sink.event,
		}),
		agentScope: "user",
		defaultCwd: cwd,
		makeDetails: catalog.makeDetails,
		runChild: async (options) => {
			const reply = replies[options.agentName];
			const index = served.get(options.agentName) ?? 0;
			served.set(options.agentName, index + 1);
			const text = Array.isArray(reply) ? reply[Math.min(index, reply.length - 1)] ?? "" : reply ?? "";
			const result = fakeResult(options, text);
			options.recordSpan?.(result, { scope: options.scope });
			return result;
		},
		recordSpan: sink.record,
		recordEvent: sink.event,
		concurrency: 2,
	};
	const output = await handler(deps);
	await sink.finalize({ ok: !output.details.error });
	const { spans, parseErrors } = parseTraceJsonl(await readFile(path.join(cwd, TRACE), "utf8"));
	assert.equal(parseErrors, 0);
	return { output, spans, cwd };
}

async function evidenceRun(
	mode: FlowMode,
	handler: (deps: ModeDeps) => Promise<ModeOutput>,
	params: Record<string, unknown>,
	replies: Record<string, string | string[]>,
): Promise<{ output: ModeOutput; spans: TraceSpanRecord[]; cwd: string }> {
	return evidenceRunAt(await freshDir(), mode, handler, params, replies);
}

const attr = (span: TraceSpanRecord | undefined, key: string) => span?.attributes?.[key];
const events = (spans: TraceSpanRecord[], kind: string) => spans.filter((span) => attr(span, "flow.event_kind") === kind);
const names = (spans: TraceSpanRecord[]) => spans.map((span) => attr(span, "flow.event_name"));

test("single: a validated terminal envelope leaves one validation event and its artifact evidence", async () => {
	const cwd = await freshDir();
	const note = "note.txt";
	await writeFile(path.join(cwd, note), "verified\n");
	const { output, spans } = await evidenceRunAt(cwd, "single", handleSingle, { agent: "recon", task: "write the note", contract }, { recon: envelope(note, sha256("verified\n")) });
	assert.equal(output.details.error, undefined);

	const validations = events(spans, "validation");
	assert.deepEqual(names(validations), ["envelope.validated"]);
	assert.equal(validations[0]?.status?.code, "OK");
	assert.equal(attr(validations[0], "flow.handoff.contract_id"), delegationContractId(contract));
	assert.equal(attr(validations[0], "flow.handoff.status"), "completed");
	assert.equal(attr(validations[0], "flow.handoff.from_agent"), "recon");
	assert.equal(attr(validations[0], "flow.handoff.artifact_count"), 1);

	const artifacts = events(spans, "artifact");
	assert.deepEqual(names(artifacts), ["artifact.referenced"]);
	assert.equal(attr(artifacts[0], "flow.artifact.verified"), true);
	assert.equal(attr(artifacts[0], "flow.artifact.path"), note);

	// A terminal report is not a handoff: nothing here may claim one happened.
	assert.equal(events(spans, "handoff").length, 0);

	// The evidence is attributable: the attestation links to the child that
	// produced the envelope, and the artifact links to the attestation.
	assert.equal(attr(validations[0], "flow.unit_key"), "single.handoff");
	assert.equal(attr(validations[0], "flow.depends_on"), "single");
	assert.equal(attr(artifacts[0], "flow.depends_on"), "single.handoff");
});

test("single: a digest mismatch leaves the rejection and the artifact claim that proves the corruption", async () => {
	const cwd = await freshDir();
	const note = "note.txt";
	await writeFile(path.join(cwd, note), "actual\n");
	const { output, spans } = await evidenceRunAt(cwd, "single", handleSingle, { agent: "recon", task: "write the note", contract }, { recon: envelope(note, MISMATCH) });
	assert.equal(output.details.error?.code, "RETURN_DIGEST_MISMATCH");

	const validations = events(spans, "validation");
	assert.deepEqual(names(validations), ["envelope.rejected"]);
	assert.equal(validations[0]?.status?.code, "ERROR");
	assert.equal(attr(validations[0], "flow.error_code"), "RETURN_DIGEST_MISMATCH");
	assert.equal(attr(validations[0], "flow.handoff.artifact_count"), 1);

	const artifacts = events(spans, "artifact");
	assert.deepEqual(names(artifacts), ["artifact.rejected"]);
	assert.equal(attr(artifacts[0], "flow.artifact.verified"), false);
	assert.match(String(attr(artifacts[0], "flow.artifact.digest")), /^sha256:0{64}$/);
	assert.equal(events(spans, "handoff").length, 0);
});

test("parallel: every contracted task leaves exactly one validation event, accepted or rejected", async () => {
	const accepted = await (async () => {
		const cwd = await freshDir();
		await writeFile(path.join(cwd, "note-a.txt"), "a\n");
		await writeFile(path.join(cwd, "note-b.txt"), "b\n");
		return evidenceRunAt(cwd, "parallel", handleParallel, {
			task: "collect",
			tasks: [
				{ agent: "recon", task: "A", contract },
				{ agent: "recon", task: "B", contract },
			],
		}, { recon: [envelope("note-a.txt", sha256("a\n")), envelope("note-b.txt", sha256("b\n"))] });
	})();
	assert.equal(accepted.output.details.error, undefined);
	assert.deepEqual(names(events(accepted.spans, "validation")), ["envelope.validated", "envelope.validated"]);
	assert.deepEqual(names(events(accepted.spans, "artifact")), ["artifact.referenced", "artifact.referenced"]);
	assert.equal(events(accepted.spans, "handoff").length, 0);
	// Fan-out placement carries through: each attestation names its task's unit.
	assert.deepEqual(
		events(accepted.spans, "validation").map((span) => attr(span, "flow.unit_key")).sort(),
		["tasks.1.handoff", "tasks.2.handoff"],
	);

	const rejected = await (async () => {
		const cwd = await freshDir();
		await writeFile(path.join(cwd, "note-a.txt"), "a\n");
		return evidenceRunAt(cwd, "parallel", handleParallel, {
			task: "collect",
			tasks: [{ agent: "recon", task: "A", contract }],
		}, { recon: envelope("note-a.txt", MISMATCH) });
	})();
	assert.equal(rejected.output.details.error?.code, "RETURN_DIGEST_MISMATCH");
	assert.deepEqual(names(events(rejected.spans, "validation")), ["envelope.rejected"]);
	assert.deepEqual(names(events(rejected.spans, "artifact")), ["artifact.rejected"]);
	assert.equal(events(rejected.spans, "handoff").length, 0);
});

test("graph: a terminal node's contract validation is evidence; an integrated node keeps handoff names", async () => {
	// Terminal node, no debrief: previously ["child","root"] — no evidence at all.
	const terminal = await (async () => {
		const cwd = await freshDir();
		await writeFile(path.join(cwd, "note.txt"), "graph\n");
		return evidenceRunAt(cwd, "graph", handleGraph, {
			task: "map",
			graph: { nodes: [{ id: "answer", agent: "recon", task: "write the note", contract }] },
		}, { recon: envelope("note.txt", sha256("graph\n")) });
	})();
	assert.equal(terminal.output.details.error, undefined);
	assert.deepEqual(names(events(terminal.spans, "validation")), ["envelope.validated"]);
	assert.deepEqual(names(events(terminal.spans, "artifact")), ["artifact.referenced"]);
	assert.equal(events(terminal.spans, "handoff").length, 0);
	assert.equal(attr(events(terminal.spans, "validation")[0], "flow.unit_key"), "answer.handoff");

	const corrupted = await (async () => {
		const cwd = await freshDir();
		await writeFile(path.join(cwd, "note.txt"), "graph\n");
		return evidenceRunAt(cwd, "graph", handleGraph, {
			task: "map",
			graph: { nodes: [{ id: "answer", agent: "recon", task: "write the note", contract }] },
		}, { recon: envelope("note.txt", MISMATCH) });
	})();
	assert.equal(corrupted.output.details.error?.code, "RETURN_DIGEST_MISMATCH");
	assert.deepEqual(names(events(corrupted.spans, "validation")), ["envelope.rejected"]);
	assert.deepEqual(names(events(corrupted.spans, "artifact")), ["artifact.rejected"]);

	// A node another node consumes crosses a role boundary: the integrate path's
	// names and kinds stay byte-identical.
	const integrated = await (async () => {
		const cwd = await freshDir();
		await writeFile(path.join(cwd, "note.txt"), "graph\n");
		return evidenceRunAt(cwd, "graph", handleGraph, {
			task: "map",
			graph: {
				nodes: [
					{ id: "source", agent: "recon", task: "write the note", contract },
					{ id: "sink", agent: "debrief", task: "read {node.source}", dependsOn: ["source"] },
				],
			},
		}, { recon: envelope("note.txt", sha256("graph\n")), debrief: "synthesis" });
	})();
	assert.equal(integrated.output.details.error, undefined);
	assert.deepEqual(names(events(integrated.spans, "handoff")), ["handoff.accepted"]);
	assert.deepEqual(names(events(integrated.spans, "artifact")), ["artifact.referenced"]);
	// The sink node's own output is terminal and uncontracted: prose leaves no
	// envelope validation to attest, so nothing new is recorded for it.
	assert.equal(events(integrated.spans, "validation").length, 0);

	const integratedRejection = await (async () => {
		const cwd = await freshDir();
		await writeFile(path.join(cwd, "note.txt"), "graph\n");
		return evidenceRunAt(cwd, "graph", handleGraph, {
			task: "map",
			graph: {
				nodes: [
					{ id: "source", agent: "recon", task: "write the note", contract },
					{ id: "sink", agent: "debrief", task: "read {node.source}", dependsOn: ["source"] },
				],
			},
		}, { recon: envelope("note.txt", MISMATCH), debrief: "must not run" });
	})();
	assert.equal(integratedRejection.output.details.error?.code, "RETURN_DIGEST_MISMATCH");
	assert.deepEqual(names(events(integratedRejection.spans, "validation")), ["handoff.rejected"]);
	assert.deepEqual(names(events(integratedRejection.spans, "artifact")), ["artifact.rejected"]);
});

test("a terminal consumption mints no dependency key and aggregates no warnings", async () => {
	const cwd = await freshDir();
	await writeFile(path.join(cwd, "note.txt"), "verified\n");
	const handoffs = createHandoffConsumer({
		params: { handoffPolicy: "fail" },
		mode: "single",
		policy: { recordContent: true, redactSecrets: true },
		defaultCwd: cwd,
	});
	const result: FlowRunResult = {
		agent: "recon",
		agentSource: "package",
		task: "write the note",
		exitCode: 0,
		messages: [{ role: "assistant", content: [{ type: "text", text: envelope("note.txt", sha256("verified\n")) }] } as any],
		stderr: "",
		usage: emptyUsage(),
	};
	const resolved = ResolvedDelegationContract.resolve(contract).resolved!;
	const terminal = handoffs.consumeResult({
		result,
		contract: resolved,
		cwd,
		scope: { key: "single" },
		completion: "terminal",
		payload: "source",
	});
	assert.equal(terminal.error, undefined);
	assert.equal(terminal.dependencyKey, undefined, "a terminal report is not a unit another span may depend on");
	assert.equal(handoffs.warningSummary(), "", "terminal reports do not join handoff warning aggregation");
});

test("a terminal prose consumption without a contract records nothing", async () => {
	const { output, spans } = await evidenceRun("single", handleSingle, { agent: "recon", task: "inspect" }, { recon: "plain prose answer" });
	assert.equal(output.details.error, undefined);
	assert.equal(events(spans, "validation").length, 0);
	assert.equal(events(spans, "artifact").length, 0);
	assert.equal(events(spans, "handoff").length, 0);
});

