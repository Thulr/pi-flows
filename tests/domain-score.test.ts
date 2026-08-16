// The domain-score judgment half (#145): fixed row identity, per-row review
// provenance (surface digests), and the verified/carried split. Each test runs
// the real script against a scratch git repo shaped like this one.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/domain-score.mjs", import.meta.url));
const ROWS = ["small-aggregates", "behavior-rich", "domain-events", "depth-rich-core", "depth-invariants-in-aggregates", "depth-language-consistency"];

const ARCHITECTURE = `# Architecture

## Subdomain split

**Core — the differentiator.**
_Modules_: \`flow.ts\`

**Supporting — recombinations.**
_Modules_: \`board.ts\`

**Generic — plumbing.**
_Modules_: \`png.ts\`

**Shared kernel.**
_Modules_: \`types.ts\`

**Composition root.**
_Modules_: \`index.ts\`

## Import direction

- **Core** → Core, Generic, Shared kernel
- **Shared kernel** → Core, Shared kernel
`;

/** An unstamped ledger: every row present, no review provenance yet. */
function ledger() {
	const judgment: Record<string, object> = {};
	const surfaces: Record<string, string[]> = {
		"small-aggregates": ["extensions/pi-flows/flow.ts"],
		"behavior-rich": ["extensions/pi-flows/types.ts"],
		"domain-events": ["extensions/pi-flows/board.ts"],
		"depth-rich-core": ["subdomain:Core"],
		"depth-invariants-in-aggregates": ["extensions/pi-flows/flow.ts", "tests/flow.test.ts"],
		"depth-language-consistency": ["CONTEXT.md", "subdomain:Core"],
	};
	for (const row of ROWS) judgment[row] = { label: `Judgment: ${row}`, verdict: "pass", note: `Recorded evidence for ${row}.`, surfaces: surfaces[row] };
	return { judgment, foreignImports: { adapters: [], debt: [] } };
}

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function makeFixture(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "domain-score-"));
	mkdirSync(path.join(dir, "extensions/pi-flows"), { recursive: true });
	mkdirSync(path.join(dir, "docs/reference"), { recursive: true });
	mkdirSync(path.join(dir, "tests"), { recursive: true });
	writeFileSync(path.join(dir, "extensions/pi-flows/flow.ts"), "export const flowGate = 1;\n");
	writeFileSync(path.join(dir, "extensions/pi-flows/board.ts"), "export const boardView = 1;\n");
	writeFileSync(path.join(dir, "extensions/pi-flows/png.ts"), "export const pngRaster = 1;\n");
	writeFileSync(path.join(dir, "extensions/pi-flows/types.ts"), "export const vocabulary = 1;\n");
	writeFileSync(path.join(dir, "extensions/pi-flows/index.ts"), "export const composition = 1;\n");
	writeFileSync(path.join(dir, "docs/reference/architecture.md"), ARCHITECTURE);
	writeFileSync(path.join(dir, "docs/domain-review.json"), JSON.stringify(ledger(), null, 2) + "\n");
	writeFileSync(path.join(dir, "CONTEXT.md"), "# Glossary\n\nFlow: one bounded delegation.\n");
	writeFileSync(path.join(dir, "tests/flow.test.ts"), "// names the admission invariant\n");
	git(dir, "init", "-b", "main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	return dir;
}

async function score(dir: string, ...flags: string[]) {
	try {
		const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...flags], { cwd: dir, env: { ...process.env, DOMAIN_SCORE_BASE: "main" } });
		return { code: 0, stdout, stderr };
	} catch (error: any) {
		return { code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string };
	}
}

async function scoreJson(dir: string) {
	const { stdout } = await score(dir, "--json");
	return JSON.parse(stdout);
}

const readLedger = (dir: string) => JSON.parse(readFileSync(path.join(dir, "docs/domain-review.json"), "utf8"));
const writeLedger = (dir: string, value: object) => writeFileSync(path.join(dir, "docs/domain-review.json"), JSON.stringify(value, null, 2) + "\n");
const byRow = (report: any, row: string) => report.judgment.find((entry: any) => entry.row === row);

/** Stamp every row against the current tree and commit the result. */
async function stampedFixture(): Promise<string> {
	const dir = makeFixture();
	const record = await score(dir, "--record=all");
	assert.equal(record.code, 0, `--record=all must succeed: ${record.stderr}`);
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "reviewed tree");
	return dir;
}

test("a stamped ledger on an unchanged tree verifies every row", async () => {
	const dir = await stampedFixture();
	const gate = await score(dir);
	assert.equal(gate.code, 0, gate.stderr);
	assert.match(gate.stdout, /^domain model: 11\/11 verified/m, "the default output leads with the verified score");
	const report = await scoreJson(dir);
	assert.equal(report.verified, 11);
	assert.equal(report.carried, 0);
	assert.equal(report.total, 11);
	for (const row of ROWS) assert.equal(byRow(report, row).stale, false, `${row} must be fresh`);
	rmSync(dir, { recursive: true, force: true });
});

test("a dirty change to a declared surface makes exactly the rows that declare it stale, and stays advisory", async () => {
	const dir = await stampedFixture();
	writeFileSync(path.join(dir, "extensions/pi-flows/flow.ts"), "export const flowGate = 2;\n");
	const gate = await score(dir);
	assert.equal(gate.code, 0, "staleness is advisory, not a gate failure");
	const report = await scoreJson(dir);
	// flow.ts is a surface of small-aggregates and depth-invariants directly, and
	// of the two subdomain:Core rows through the Core expansion.
	for (const row of ["small-aggregates", "depth-invariants-in-aggregates", "depth-rich-core", "depth-language-consistency"]) {
		assert.equal(byRow(report, row).stale, true, `${row} declares flow.ts and must be stale`);
	}
	for (const row of ["behavior-rich", "domain-events"]) assert.equal(byRow(report, row).stale, false, `${row} does not declare flow.ts`);
	assert.equal(report.verified, 5 + 2);
	assert.equal(report.carried, 4);
	assert.match(gate.stdout, /7\/11 verified/, "the lead score counts only verified rows");
	assert.ok(byRow(report, "small-aggregates").staleBecause.includes("extensions/pi-flows/flow.ts"), "the stale row names the changed surface");
	rmSync(dir, { recursive: true, force: true });
});

test("editing the ledger alone cannot mark a stale row fresh; --record for the row does", async () => {
	const dir = await stampedFixture();
	writeFileSync(path.join(dir, "extensions/pi-flows/flow.ts"), "export const flowGate = 3;\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "core change without re-review");
	const current = readLedger(dir);
	current.judgment["small-aggregates"].note = "Edited prose, no re-review.";
	writeLedger(dir, current);
	let report = await scoreJson(dir);
	assert.equal(byRow(report, "small-aggregates").stale, true, "a ledger edit is not review provenance for the current tree");
	const record = await score(dir, "--record=small-aggregates,depth-invariants-in-aggregates,depth-rich-core,depth-language-consistency");
	assert.equal(record.code, 0, record.stderr);
	report = await scoreJson(dir);
	assert.equal(report.verified, 11, "recording the named rows against this tree re-establishes them");
	rmSync(dir, { recursive: true, force: true });
});

test("deleting a judgment row fails the score instead of shrinking the denominator", async () => {
	const dir = await stampedFixture();
	const current = readLedger(dir);
	delete current.judgment["behavior-rich"];
	writeLedger(dir, current);
	const gate = await score(dir);
	assert.equal(gate.code, 1);
	assert.match(gate.stderr, /behavior-rich/, "the missing row is named");
	const report = await scoreJson(dir);
	assert.equal(report.total, 11, "the denominator does not shrink");
	assert.equal(byRow(report, "behavior-rich").pass, false, "a missing judgment is a failed row");
	rmSync(dir, { recursive: true, force: true });
});

test("an unknown judgment row and a missing required field both fail the gate", async () => {
	const dir = await stampedFixture();
	const current = readLedger(dir);
	current.judgment["invented-row"] = { label: "Invented", verdict: "pass", note: "n", surfaces: ["CONTEXT.md"] };
	writeLedger(dir, current);
	let gate = await score(dir);
	assert.equal(gate.code, 1);
	assert.match(gate.stderr, /invented-row/);

	const fixed = readLedger(dir);
	delete fixed.judgment["invented-row"];
	delete fixed.judgment["domain-events"].surfaces;
	writeLedger(dir, fixed);
	gate = await score(dir);
	assert.equal(gate.code, 1);
	assert.match(gate.stderr, /domain-events/);
	rmSync(dir, { recursive: true, force: true });
});

test("an explicitly failed judgment exits non-zero even when fresh", async () => {
	const dir = await stampedFixture();
	const current = readLedger(dir);
	current.judgment["domain-events"].verdict = "fail";
	current.judgment["domain-events"].note = "Events no longer carry provenance.";
	writeLedger(dir, current);
	const record = await score(dir, "--record=domain-events");
	assert.equal(record.code, 0, "recording a failed verdict is legitimate evidence");
	const gate = await score(dir);
	assert.equal(gate.code, 1, "a recorded failure is a failed score");
	const summary = await score(dir, "--summary");
	assert.equal(summary.code, 0, "--summary reports and never fails");
	rmSync(dir, { recursive: true, force: true });
});

test("module deletion stays visible to staleness even after the classification stops naming it", async () => {
	const dir = await stampedFixture();
	rmSync(path.join(dir, "extensions/pi-flows/board.ts"));
	const architecture = readFileSync(path.join(dir, "docs/reference/architecture.md"), "utf8");
	writeFileSync(path.join(dir, "docs/reference/architecture.md"), architecture.replace("_Modules_: `board.ts`", "_Modules_:"));
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "delete board and its classification");
	const gate = await score(dir);
	assert.equal(gate.code, 0, `structure stays clean: ${gate.stderr}`);
	const report = await scoreJson(dir);
	assert.equal(byRow(report, "domain-events").stale, true, "the row that declared the deleted module is stale");
	rmSync(dir, { recursive: true, force: true });
});

test("reclassifying a module makes subdomain-scoped rows stale", async () => {
	const dir = await stampedFixture();
	const architecture = readFileSync(path.join(dir, "docs/reference/architecture.md"), "utf8");
	writeFileSync(
		path.join(dir, "docs/reference/architecture.md"),
		architecture.replace("_Modules_: `board.ts`", "_Modules_:").replace("_Modules_: `png.ts`", "_Modules_: `png.ts`, `board.ts`"),
	);
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "board.ts is Generic now");
	const report = await scoreJson(dir);
	assert.equal(byRow(report, "depth-rich-core").stale, true, "a subdomain surface covers the classification ledger itself");
	assert.equal(byRow(report, "small-aggregates").stale, false, "a row with only file surfaces is untouched");
	rmSync(dir, { recursive: true, force: true });
});

test("a merged tree holding a change the review never saw reads stale, even across divergent history", async () => {
	const dir = await stampedFixture();
	git(dir, "checkout", "-b", "review-branch");
	writeFileSync(path.join(dir, "extensions/pi-flows/flow.ts"), "export const flowGate = 4;\n");
	const record = await score(dir, "--record=all");
	assert.equal(record.code, 0, record.stderr);
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "core change, re-reviewed");
	git(dir, "checkout", "main");
	writeFileSync(path.join(dir, "CONTEXT.md"), "# Glossary\n\nFlow: one bounded delegation.\nHandoff: a checked transfer.\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "glossary change the review never saw");
	git(dir, "merge", "review-branch", "-m", "merge");
	const report = await scoreJson(dir);
	assert.equal(byRow(report, "depth-language-consistency").stale, true, "the merged tree differs from what the review stamped");
	assert.equal(byRow(report, "small-aggregates").stale, false, "rows whose surfaces match the stamped tree stay fresh");
	rmSync(dir, { recursive: true, force: true });
});

test("a shallow clone scores identically: provenance is content, not git history", async () => {
	const dir = await stampedFixture();
	writeFileSync(path.join(dir, "extensions/pi-flows/types.ts"), "export const vocabulary = 2;\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "kernel change without re-review");
	const clone = mkdtempSync(path.join(tmpdir(), "domain-score-shallow-"));
	execFileSync("git", ["clone", "--depth", "1", `file://${dir}`, "shallow"], { cwd: clone, encoding: "utf8" });
	const shallowDir = path.join(clone, "shallow");
	assert.equal(git(shallowDir, "rev-parse", "--is-shallow-repository"), "true");
	const report = await scoreJson(shallowDir);
	assert.equal(byRow(report, "behavior-rich").stale, true, "the un-reviewed kernel change reads stale in a shallow clone");
	assert.equal(byRow(report, "small-aggregates").stale, false, "fresh rows stay verified in a shallow clone");
	const gate = await score(shallowDir);
	assert.equal(gate.code, 0, gate.stderr);
	assert.doesNotMatch(gate.stdout, /shallow/i, "no shallow-history disclaimer remains");
	rmSync(dir, { recursive: true, force: true });
	rmSync(clone, { recursive: true, force: true });
});

test("trimming a changed surface out of a row's declaration cannot make it read fresh", async () => {
	const dir = await stampedFixture();
	writeFileSync(path.join(dir, "tests/flow.test.ts"), "// the invariant test changed\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "surface change without re-review");
	const current = readLedger(dir);
	const row = current.judgment["depth-invariants-in-aggregates"];
	row.surfaces = row.surfaces.filter((surface: string) => surface !== "tests/flow.test.ts");
	delete row.reviewed.surfaces["tests/flow.test.ts"];
	writeLedger(dir, current);
	const gate = await score(dir);
	assert.equal(gate.code, 1, "a trimmed declaration invalidates the stamp instead of reading fresh");
	assert.match(gate.stderr, /depth-invariants-in-aggregates/);
	assert.match(gate.stderr, /declared surfaces/);
	rmSync(dir, { recursive: true, force: true });
});

test("--record refuses a surface that matches no files", async () => {
	const dir = await stampedFixture();
	const current = readLedger(dir);
	current.judgment["behavior-rich"].surfaces = ["extensions/pi-flows/no-such-module.ts"];
	writeLedger(dir, current);
	const record = await score(dir, "--record=behavior-rich");
	assert.equal(record.code, 1);
	assert.match(record.stderr, /no-such-module/, "the empty surface is named instead of stamped as an empty digest");
	rmSync(dir, { recursive: true, force: true });
});

test("the summary leads with the verified score and lists carried rows separately", async () => {
	const dir = await stampedFixture();
	writeFileSync(path.join(dir, "extensions/pi-flows/flow.ts"), "export const flowGate = 5;\n");
	const summary = await score(dir, "--summary");
	assert.equal(summary.code, 0);
	const lead = summary.stdout.split("\n").find((line) => line.startsWith("**"));
	assert.match(lead ?? "", /^\*\*7\/11 verified\*\*/, "the bold lead is the verified score");
	assert.match(summary.stdout, /[Cc]arried/, "carried rows are described separately");
	rmSync(dir, { recursive: true, force: true });
});
