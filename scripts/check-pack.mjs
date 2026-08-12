import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

// npm <= 11 emits an array of pack reports; npm >= 12 emits an object keyed by
// package name. The publish workflow installs npm@latest, so handle both.
const parsed = JSON.parse(result.stdout);
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
assert.ok(pack?.files, `unrecognized npm pack --json output shape: ${result.stdout.slice(0, 200)}`);
const files = pack.files.map((file) => file.path);
const forbidden = [/^audit-artifacts\//, /^docs\/audits\//, /^docs\/research\//, /^node_modules\//, /^tests\//, /^scripts\//, /\.log$/];
for (const file of files) {
  for (const pattern of forbidden) assert.ok(!pattern.test(file), `pack includes forbidden file: ${file}`);
}

for (const required of ["extensions/pi-flows/index.ts", "presets/code-review.md", "presets/map-codebase.md", "presets/scout.md", "README.md", "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md", "docs/README.md", "docs/tutorials/quickstart.md", "docs/how-to/troubleshooting.md", "docs/reference/flow-reference.md", "docs/explanation/patterns.md"]) {
  assert.ok(files.includes(required), `pack missing required file: ${required}`);
}

// A packed source file that imports a relative module which is not itself
// packed ships a package that fails to load at runtime — the `files` globs are
// extension-suffix based, so a new file with an uncovered suffix slips through
// silently. Resolve every relative import in packed extension sources and
// require the target to be packed too.
const packedSet = new Set(files);
const relativeImportRe = /from\s+"(\.{1,2}\/[^"]+)"/g;
for (const file of files.filter((name) => name.startsWith("extensions/") && /\.(ts|mjs)$/.test(name))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(relativeImportRe)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    assert.ok(packedSet.has(resolved), `pack missing ${resolved}, imported by ${file} — add it to package.json "files"`);
  }
}

// Typed integration handoffs, runtime/eval trace linkage, durable approval
// receipts, and coordination-boundary tracing each add public runtime modules
// and their reference documentation. The tracing work alone added five —
// trace-scope, trace-sink, trace-attributes, trace-report, and dispatch — plus
// the flow-reference and troubleshooting sections users need to read a trace and
// act on TRACE_INCOMPLETE. Retain explicit headroom without excluding that
// material. Raise this deliberately when a public surface grows, never to make an
// accidental inclusion fit — the forbidden-path and relative-import checks above
// are what catch those, and they are the reason a bump here is safe to make.
// Raised to 690_000 for the pi version-floor guidance in troubleshooting and its
// changelog entries; the previous 680_000 left under 200 bytes of headroom, so
// the next release note alone would have tripped it.
// Raised to 725_000 for the subagent UI surface: three new public runtime
// modules (ui-live-row, ui-run-card, fleet-panel), their flow-reference
// monitoring section, and changelog entries.
// Raised to 745_000 for CONTEXT.md: README and flow-reference now point at the
// glossary's term definitions instead of restating them, so the glossary has to
// ship or those links dangle in the tarball.
// Raised to 760_000 for the Budget object (a documented public type replacing the
// exported budget records and their free functions) and CONTEXT.md's subdomain
// split, which tells a downstream reader which modules carry the guardrail
// invariants. The previous ceiling left 1_442 bytes, so one changelog entry for
// either change would have tripped it.
// Raised to 815_000 for the model roster: three new runtime modules
// (model-roster, roster-source, roster-types, ~26KB together) plus the README
// and flow-reference sections that document what a tier now resolves to and how
// to override it. The modules ship because tiers resolve at runtime from the
// user's own model registry, so the ranking has to be in the package, not in a
// build artifact. Verified against the packed file list rather than the delta
// alone: 81 files, none of them from tests/, scripts/, or evals/.
// Raised to 840_000 for the review rounds on that change: a fourth runtime
// module (roster-config, splitting config I/O out of the ranking policy once
// model-roster crossed its line cap) and the changelog entries describing the
// approval-receipt binding. The previous ceiling left ~1_300 bytes, which one
// more changelog paragraph would have tripped. Same verification: 82 files, none
// from tests/, scripts/, or evals/.
// Raised to 880_000 across the review rounds on that change: the approval
// binding now records what a gated phase resolves to, the roster tracks
// precedence per field, and workflow-state.ts split out of workflow.ts when it
// crossed its line cap — plus the changelog entries for each. Same verification
// as before: 83 files, none from tests/, scripts/, or evals/.
// Raised for the preset layer and three bundled workflow definitions, including
// the machine-checked code-review return schemas. Presets are runtime inputs,
// not examples, so all three are required above and intentionally packaged.
// Raised to 940_000 for the exported workflow work-phase predicate the
// selection eval imports (#88) and its changelog entry; the previous ceiling
// left ~500 bytes. Same verification: 90 files, none from tests/, scripts/,
// or evals/.
// Raised to 975_000 for the Flow aggregate root (flow.ts) and the Run object
// (run.ts) that took the execute() lifecycle and the child-result lifecycle
// out of index.ts (#97), plus their changelog entry. Same verification:
// 95 files, none from tests/, scripts/, or evals/.
// Raised to 990_000 for the bash-ro vocabulary module (bash-readonly.ts) and
// its reference/troubleshooting/changelog entries and the standalone
// enforcer entry (bash-readonly-extension.ts). Same verification:
// 97 files, none from tests/, scripts/, or evals/.
// Raised to 1_010_000 for the OS read-only-checkout sandbox module
// (bash-readonly-sandbox.ts) and its docs. Same verification:
// 98 files, none from tests/, scripts/, or evals/.
// Raised to 1_040_000 for the budget wrap-up channel (#104): three new public
// runtime modules — wrapup.ts (the parent/child file channel), runner-budget.ts
// (the budget half of the child-run seam, split when runner.ts crossed its
// line cap), and preset-review.ts (the code-review result unit, same split
// from presets.ts) — plus the budget wrap-up sections in flow-reference and
// troubleshooting and the changelog entries. Same verification: 101 files,
// none from tests/, scripts/, or evals/.
// Raised to 1_100_000 for the mode-seam deepening: unconditional terminal
// envelope-validation evidence (handoff-consumption.ts), unresolved
// dependency-link recording (trace-sink/structure/report), the describe gate
// in the admission walk (flow.ts), and the declared mode plans + settle
// object the mode table gained. Same verification: no files from tests/,
// scripts/, or evals/.
// Raised to 1_110_000 for the shared UI vocabulary (ui-style.ts): one new
// public runtime module holding the state icons/colors, meters, per-run
// state bars, badges, tree guides, and box frames the four view surfaces
// now share. Same verification: 105 files, none from tests/, scripts/, or
// evals/.
// Raised to 1_130_000 for the settled card's Gantt timeline: ui-gantt.ts
// (layout + bitmap-font rasterizer) over png.ts (dependency-free RGBA→PNG
// encoder), gated on terminal image capability with the text card as the
// fallback, plus the PR-review hardening round (expandSafePath, time-grid
// spend resampling). Same verification: 107 files, none from tests/,
// scripts/, or evals/.
// Lowered to 1_125_000: the timeline's editorial-rails redesign grew
// ui-gantt.ts (per-agent identicons, hatched failed-rail texture), but
// removing the F8 fleet panel and its spend-sampling machinery more than
// paid it back. Same verification: 106 files, none from tests/, scripts/,
// or evals/.
// Raised to 1_135_000 for the mode pre-spawn refusal declarations: thirteen of
// the fifteen modes now export what they refuse before their first child
// spawns, so entry rules that were unreachable inside handler bodies became
// public functions the mode table and the selection eval both read. That is a
// public surface growing, which is what a bump here is for. validate.ts lost 76
// lines of mirror in the same change. The remainder is prose this repo's own
// standards require — the Mode pre-spawn refusal glossary entry (CONTEXT.md),
// the added table member in the adding-a-mode recipe (AGENTS.md), and the
// Unreleased changelog entry — and it was trimmed twice before raising this.
// Same verification: 106 files, none from tests/, scripts/, or evals/.
// Raised to 1_145_000 for intentional parallel sizing (#121): the runtime
// refusal, model-facing schema/tool guidance, and the reference,
// troubleshooting, example, and changelog text that keep the public contract
// synchronized. The file set remains 106 files with no tests/, scripts/, or
// evals/; this is growth in already-packaged public surfaces, not an inclusion.
// Raised to 1_150_300 for the one run-state derivation: run.ts gains the
// exported RunState/RunStateFields vocabulary and runState/runSettled/runFailed,
// the flow card gains its third verdict glyph, and each carries the JSDoc this
// repo's standards require on a Core surface three views now render through. It
// is a net addition even after deleting the two duplicate predicates it replaces
// (entryResultFailed, flowAgentState) and collapsing ten exitCode === -1 sentinel
// sites into one. The prose was trimmed twice before raising, and the remaining
// rationale lives in CONTEXT.md and docs/domain-review.json, neither packaged.
// AGENTS.md is packaged and carries the module map, so naming run.ts's new
// member there counts too. Headroom is ~472 B over the measured 1_149_828,
// matching the previous raise's ~449 B rather than loosening the ratchet. Same
// verification: 107 files, none from tests/, scripts/, or evals/ — growth in an
// already-packaged public surface, not an inclusion. (The two comments above say
// 106; both were already 107 when written. This file is not packaged, so its own
// prose is free — state the measurement rather than round it.)
// Raised to 1_168_150 for the strict-trace structural gate: trace-scope gains
// the FlowTraceStructure verdict, trace-sink the read-back that produces it,
// and trace.ts the refusal that reports it — plus the CONTEXT.md Trace
// structure entry and the changelog. The read-back reuses parseTraceJsonl and
// traceStructure rather than adding a second validator, so this is interface
// and prose, not new machinery. Same verification: 107 files, none from
// tests/, scripts/, or evals/ — and the schema/flow-reference wording the sync
// rule requires, since traceStrict now refuses a case those two did not
// describe (one said the in-process gate could not catch it). Headroom is
// It also adds trace-verify.ts, one module: reading a finished export back is
// the reader's question, and keeping it in the writer put trace-sink.ts over
// the 500-line cap, which is not a thing to raise. Headroom is ~486 B over the
// measured 1_167_693, matching the previous raise.
assert.ok(pack.unpackedSize < 1_168_150, `package unpacked size too large: ${pack.unpackedSize}`);
console.log(`pack ok: ${files.length} files, ${pack.unpackedSize} bytes unpacked`);
