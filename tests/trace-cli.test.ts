// The read-back CLI end to end, plus the dangling-link record it reports on.
//
// scripts/trace-report.mjs is the command the TRACE_INCOMPLETE refusal tells an
// operator to run, so it is spawned here exactly as the npm script runs it
// (`node --import tsx`): a crash-free report on a trace a real sink wrote, and a
// non-zero exit on corrupted evidence under --strict. The dangling-link cases
// pin the writer/reader agreement from the other side of trace-gate.test.ts:
// what the real sink writes for a dependsOn key that never resolved, and which
// rewrites of that record the reader still refuses as corruption.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeTraceSink, parseTraceJsonl, summarizeTraceSpans, traceReportIsComplete, type TraceSpanRecord } from "../extensions/pi-flows/trace.ts";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(repoRoot, "scripts", "trace-report.mjs");

/** Spawn the CLI as `npm run trace:report` does, capturing output either way. */
const runCli = (args: string[]) => exec(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repoRoot }).then(
	({ stdout, stderr }) => ({ code: 0, stdout: String(stdout), stderr: String(stderr) }),
	(error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: unknown }) =>
		({ code: typeof error.code === "number" ? error.code : 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }),
);

const freshDir = () => mkdtemp(path.join(tmpdir(), "trace-cli-"));

const child = {
	agent: "recon", agentSource: "package" as const, task: "task", exitCode: 0, messages: [], stderr: "",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 }, durationMs: 5,
};

/** A real sink's trace: alpha registered, beta depending on alpha plus any extra keys. */
async function writeTrace(betaDependsOn: string[]): Promise<{ traceFile: string; dir: string }> {
	const dir = await freshDir();
	const traceFile = path.join(dir, "flow-trace.jsonl");
	const sink = makeTraceSink(traceFile, "parallel", { recordContent: false, redactSecrets: true });
	sink.record(child, { scope: { key: "alpha" } });
	sink.record(child, { scope: { key: "beta", dependsOn: betaDependsOn } });
	await sink.finalize({ ok: true });
	return { traceFile, dir };
}

async function readTrace(traceFile: string): Promise<TraceSpanRecord[]> {
	return parseTraceJsonl(await readFile(traceFile, "utf8")).spans;
}

test("the CLI reads a real trace without crashing, dangling link included", async () => {
	const { traceFile } = await writeTrace(["alpha", "ghost"]);
	const report = await runCli([traceFile]);
	assert.equal(report.code, 0, report.stderr);
	assert.match(report.stdout, /Trace report/);
	assert.match(report.stdout, /1 dangling link/, "the handler bug must be visible in the operator's report");
	// The TRACE_INCOMPLETE refusal sends operators here with --strict; a dangling
	// link is an honest record, not lost evidence, so strict mode still exits 0.
	const strict = await runCli(["--strict", traceFile]);
	assert.equal(strict.code, 0, strict.stderr);
});

test("the strict CLI exits non-zero on corrupted evidence and still prints the report without it", async () => {
	const { traceFile, dir } = await writeTrace(["alpha"]);
	const rows = (await readFile(traceFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
	for (const row of rows) delete row.attributes?.["flow.depends_on_span_ids"];
	const corrupted = path.join(dir, "corrupted.jsonl");
	await writeFile(corrupted, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

	const strict = await runCli(["--strict", corrupted]);
	assert.notEqual(strict.code, 0, "erased resolution ids must fail the strict gate");
	assert.match(strict.stderr, /incomplete/i);
	const plain = await runCli([corrupted]);
	assert.equal(plain.code, 0, "without --strict the report still prints so the operator can see what broke");
	assert.match(plain.stdout, /structurally invalid/);
});

test("the writer records unresolved keys with the same encoding as the declared list", async () => {
	const { traceFile } = await writeTrace(["ghost,one", "alpha", "ghost-two"]);
	const spans = await readTrace(traceFile);
	const beta = spans.find((span) => span.attributes?.["flow.unit_key"] === "beta")!;
	// Same escaping as flow.depends_on: author-supplied keys may contain the
	// delimiter, and a reader must be able to match the two lists to each other.
	assert.equal(beta.attributes?.["flow.depends_on_unresolved"], "ghost%2Cone,ghost-two");
	assert.equal(beta.attributes?.["flow.depends_on_count"], 3);
	assert.equal(String(beta.attributes?.["flow.depends_on_span_ids"]).split(",").length, 1);
	assert.equal(beta.attributes?.["flow.depends_on_unresolved_truncated"], undefined, "a list that fits is not truncated");
	// Resolved plus unresolved account for the count, and the resolved key still
	// matches its id positionally with unresolved keys interleaved around it.
	const report = summarizeTraceSpans(spans, 0, "trace");
	assert.equal(report.danglingLinks, 2);
	assert.equal(report.structurallyInvalidTraces, 0);
	assert.equal(traceReportIsComplete(report), true);
});

test("an unresolved list past the structural cap is marked truncated and still passes", async () => {
	const ghosts = Array.from({ length: 12 }, (_unused, index) => `ghost-${index}-${"z".repeat(900)}`);
	const { traceFile } = await writeTrace(["alpha", ...ghosts]);
	const spans = await readTrace(traceFile);
	const beta = spans.find((span) => span.attributes?.["flow.unit_key"] === "beta")!;
	assert.equal(beta.attributes?.["flow.depends_on_unresolved_truncated"], true, "the writer must say the list was capped");
	assert.ok(String(beta.attributes?.["flow.depends_on_unresolved"]).split(",").length < ghosts.length, "the stored list must actually be shorter");
	const report = summarizeTraceSpans(spans, 0, "trace");
	assert.equal(report.structurallyInvalidTraces, 0);
	assert.equal(report.danglingLinks, ghosts.length, "the count survives the cap: it is arithmetic, not a list length");
	assert.equal(traceReportIsComplete(report), true);
});

test("the unresolved marker is checked, not merely trusted", async () => {
	const { traceFile } = await writeTrace(["alpha", "ghost"]);
	const spans = await readTrace(traceFile);
	const beta = spans.find((span) => span.attributes?.["flow.unit_key"] === "beta")!;
	const alpha = spans.find((span) => span.attributes?.["flow.unit_key"] === "alpha")!;
	const rewrite = (target: TraceSpanRecord, patch: Record<string, unknown>) =>
		spans.map((span) => (span === target ? { ...span, attributes: { ...span.attributes, ...patch } } : span)) as TraceSpanRecord[];
	const refused = (label: string, patched: TraceSpanRecord[]) =>
		assert.equal(traceReportIsComplete(summarizeTraceSpans(patched, 0, "trace")), false, label);

	// The arithmetic must hold in both directions: the marker cannot vanish while
	// the shortfall stays, cannot claim keys a resolved id already accounts for,
	// and cannot vouch for ids that were erased after the write.
	refused("marker erased", rewrite(beta, { "flow.depends_on_unresolved": undefined }));
	refused("forged extra unresolved key", rewrite(beta, { "flow.depends_on_unresolved": "ghost,ghost-two" }));
	refused("resolved ids erased behind the marker", rewrite(beta, { "flow.depends_on_span_ids": undefined }));
	// Truncation claims are impossible on a whole list, and a flag or marker with
	// nothing to describe proves metadata was removed, not never written.
	refused("truncation claimed on a whole list", rewrite(beta, { "flow.depends_on_unresolved_truncated": true }));
	refused("flag without a list", rewrite(alpha, { "flow.depends_on_unresolved_truncated": true }));
	refused("marker without a dependency list", rewrite(alpha, { "flow.depends_on_unresolved": "ghost" }));
	// Presence and readability are different questions: a marker rewritten into
	// something no accessor can read is corruption, not a row that never had one.
	refused("marker rewritten to a number", rewrite(beta, { "flow.depends_on_unresolved": 7 }));
	assert.equal(traceReportIsComplete(summarizeTraceSpans(spans, 0, "trace")), true, "the unrewritten trace passes");
});
