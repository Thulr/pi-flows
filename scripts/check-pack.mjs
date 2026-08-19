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

for (const required of ["extensions/pi-flows/index.ts", "presets/code-review.md", "presets/map-codebase.md", "presets/scout.md", "README.md", "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md", "docs/README.md", "docs/how-to/troubleshooting.md", "docs/reference/flow-reference.md", "docs/explanation/patterns.md"]) {
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
// Raised to 1_169_900 for the strict-trace structural gate: trace-scope gains
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
// measured 1_169_428, matching the previous raise.
// Raised to 1_174_755 for the refusal-footer change: settle.ts gains the
// decorateFooter extension point, refuse's ownership of the model-visible
// cap, and (from the pre-PR and PR review rounds) the registered footer's
// own small byte allowance plus the per-field bounds (message/cause/fix)
// that keep the Retryable/Fix/Code suffix inside the cap, plus the
// CONTEXT.md Settle entry naming both decorators and the changelog entries
// for the two worktree refusals that lost their recovery pointer.
// worktree.ts shrinks (eight hand-written footers deleted), so this is
// interface and prose, not new machinery. Same verification: the file set is
// unchanged at 108 and none from tests/, scripts/, or evals/ (the new
// coverage is tests/settle-footer.test.ts, which is not packaged). Headroom
// is ~469 B over the measured 1_174_286, matching the previous raises.
// Raised to 1_185_330 for the invocation-scoped read-back (#127): trace-sink
// mints and stamps flow.invocation_id, trace-verify scopes its reading to it,
// trace-report splits a shared stable trace id into per-invocation runs, and
// FlowTraceLink gains invocationId — plus the CONTEXT.md Invocation id entry
// (with its carve-out from the Run Avoid list), the changelog's Fixed entry,
// the flow-reference/troubleshooting wording the sync rule requires, and the
// AGENTS.md trace-test map. The review round added the shared declaresOwnRoot
// predicate both gates decide a stampless remainder through, its live-gate
// mirror, and the release validator's invocation-aware keys. The
// discriminator rides the existing append path and the existing validator, so
// this is interface and prose, not new machinery. Same verification: the file
// set is unchanged at 108 and none from tests/, scripts/, or evals/ (the new
// coverage is tests/trace-invocation-scope.test.ts, not packaged; the
// domain-review re-record is not packaged either). Headroom is ~454 B over
// the measured 1_185_406, matching the previous raises.
// Raised to 1_192_370 for minted events (#128): trace-scope gains the
// EventAttribution vocabulary and the one mintEvent assembly home (the review
// round's extraction, so the merge order is spelled once and Generic invokes
// the Core rule rather than authoring it), runCheckCommand mints the
// deterministic gate's validation event on the one path every check command
// runs through, and issueApprovalReceipt mints the approval event carrying
// receipt identity — plus the CONTEXT.md Minted event entry and the
// changelog. The three mode call sites (workflow, evaluate, worktree) hand
// their attribution to the seam and delete their hand-placed events, so the
// mode files shrink; the growth is the seams' JSDoc and the prose, not new
// machinery. Same verification: the file set is unchanged at 108 and none
// from tests/, scripts/, or evals/ (the new coverage is
// tests/coordination-evidence.test.ts, not packaged; the domain-review
// re-record is not packaged either). Headroom is ~403 B over the measured
// 1_191_967, matching the previous raises.
// Raised to 1_200_350 for the record extent (#129): trace-sink captures where
// the file had grown to at the sink's birth, trace-verify gains the one
// bounded reader (readExtent) both readings go through and the boundary's
// rationale, and the stored-attribute discipline (storedLabel /
// storedStructural / storedAttributes and their caps) moves to
// trace-attributes.ts — the module whose charter it is — because trace-sink
// crossed the 500-line cap, which is not a thing to raise. Plus the
// CONTEXT.md Record extent entry, the changelog's disclosed deltas, and the
// flow-reference / troubleshooting / AGENTS.md wording the sync rule and the
// review round required. The reading reuses the existing markers and
// validator over fewer bytes, so this is interface and prose, not new
// machinery. Same verification: the file set is unchanged at 108 and none
// from tests/, scripts/, or evals/ (the new coverage is
// tests/trace-extent.test.ts, not packaged; the domain-review re-record is
// not packaged either). The PR review round added the torn-boundary rule in
// readExtent and its changelog sentence. Headroom is ~479 B over the
// measured 1_199_871,
// matching the previous raises.
// Raised to 1_217_350 for the owed event kinds declaration (#133): the mode
// table gains the required owedEventKinds member and its resolver, every
// non-mode record site states minted: true so the read-back can tell the
// seams' statements from the mode's own hand, the sink stamps the declaration
// on the root and the certification rows, trace-structure counts undeclared
// unminted event kinds, trace-verify refuses them and a rewritten
// declaration, the report carries the counter to its health line, and the
// four controller-parsed verdicts loop/debate/vote/search never recorded now
// are (protocol.ts gains the one parsedVerdict derivation the fallback flag
// reads). Plus the CONTEXT.md Owed event kinds entry, the changelog entry,
// and the flow-reference / troubleshooting wording the sync rule requires.
// Declarations and stamps over the existing event path, not new machinery.
// Same verification: the file set is unchanged at 108 and none from tests/,
// scripts/, or evals/ (the new coverage is tests/trace-owed-events.test.ts,
// not packaged). The PR review round added the owedEventKinds member to
// AGENTS.md's add-a-mode recipe and compile-error list, which is packaged,
// and then answered the review's P1 by making minting a capability rather
// than a field: trace-scope.ts gains MintedCoordinationEvent and
// RecordMintedEvent, so a mode's recorder cannot claim the seams' provenance
// and a seam cannot forget it, and the sink exposes both doors over one
// implementation while stating every structural fact after the caller's
// attributes, so a caller cannot forge the kind, the stamp, or the placement
// the read-back gates on. Types and merge order over the existing event
// path, not new machinery, plus the CONTEXT.md and changelog sentences that
// round required. Headroom is ~461 B over the measured 1_220_339, matching
// the previous raises.
// Raised to 1_228_200 for #137's review rounds: wave dispatch requires Return
// consumption before exposing results; admitted plans keep their state behind
// a flow/Result-bound unforgeable capability; validated controls cannot fall
// back to legacy prose; contract identities share spend; and prompts, schema,
// and role tables document those semantics. The file set remains 108 with no
// tests/, scripts/, or evals/; headroom is ~489 B over measured 1_227_711.
// Raised to 1_230_600 after #137's final review made admitted plans single-use,
// kept trusted wave-consumption fields outside policy output, ignored
// quarantined route control, and aligned the bundled control-agent prompts and
// public orchestrate documentation. The file set remains 108; headroom is
// ~590 B over measured 1_230_010.
// Raised to 1_231_300 after the closure review made structured control ranges
// exact and split a contract-bound Return envelope from its unbound rejected
// candidate. The file set remains 108; headroom is ~541 B over measured
// 1_230_759.
// Raised to 1_231_900 after the prompt-boundary review added contract review
// context without a competing Return protocol and documented empty contracted
// subtask refusal. The file set remains 108; headroom is ~432 B over measured
// 1_231_468.
// Raised to 1_251_150 for effective Agent-profile approval binding (#138): one
// new Core module resolves source, prompt identity, tools, cwd, model, and
// Thinking once for approval and dispatch; workflow state gains the v3 -> v4
// migration; and the public reference, troubleshooting, privacy, glossary, and
// schema help state the exact consent contract. Review rounds added canonical
// receipt validation, non-stranding migration, durable debrief consumption, and
// completed-state audit validation, then required an exact current roster model
// so Pi cannot fuzzy-retarget a vanished pin. The file set grows to 109 only for
// agent-profile.ts; tests and fault scenarios remain unpackaged. Headroom is
// ~497 B over the measured 1_250_653.
// Raised to 1_253_600 after #138's third review: historical v3 verification
// now tries a bounded set of Thinking clamps when a pinned model's old metadata
// has left the roster. The scorer parity fix and all new coverage live under
// evals/ and tests/, so the packaged file set remains 109. Headroom is ~500 B
// over the measured size, matching previous raises.
// Raised to 1_254_650 after #138's fourth review: cwd resolution now retains
// the canonical filesystem target across approval, dispatch, containment, and
// shared-write checks, with the public consent docs naming that identity. The
// metadata-change regressions remain unpackaged; the file set stays 109 and
// headroom is 281 B over the measured 1_254_369.
// Raised to 1_265_050 after #138's sixth review: v3 migration now searches
// coherent per-model clamp histories, recognizes the next approval as part of
// the authorized action, and accepts only digest-proven historical Thinking
// witnesses beyond its work bound. Partial v2 actions and unused witnesses fail
// closed, with migration diagnostics following the capture policy. The file set
// stays 109 and headroom is 491 B over the measured 1_264_559.
// Raised to 1_273_900 after #138's seventh review: binding resolution retains
// the canonical cwd path and filesystem identity it hashed, carries that binding
// through the opaque Integration plan and child-run seam, and the production
// adapter rechecks both immediately before spawn after its asynchronous setup.
// Missing, non-directory, unreadable, or unsearchable targets are unbound before
// consent. The regressions are unpackaged; the file set stays 109 and headroom
// is 522 B over measured 1_273_378.
// Raised to 1_277_550 for #142 (Handoffs exist only at a crossed role boundary):
// the handoff consumer now attaches a Handoff after the injection guard accepts
// it (never off the payload representation), the workflow rebuilds a terminal
// phase's durable handoff from its validated Return envelope, and the incomplete
// summary reads terminal envelopes. Tests and fault scenarios remain unpackaged;
// the file set stays 109 and headroom is ~500 B over measured 1_277_048.
// Raised to 1_283_000 for #139 (parse coordination-control markers fail-closed):
// protocol.ts gains the shared protocol vocabulary and the anchored first-line
// marker reader that both the instructions and the parsers render from, and the
// public reference/patterns/changelog name the authoritative position, exact
// values, and fallback behavior. The file set stays 109 and none from tests/,
// scripts/, or evals/; headroom is ~500 B over measured 1_282_485.
// Raised to 1_284_300 for #141 (mutually exclusive admission outcomes): the
// CONTEXT.md Flow and Admission entries and the Flow aggregate docblock now
// state the canonical admission graph (Described | Refused | Admitted, then
// Admitted -> Dispatched -> Settled) instead of implying refusal precedes
// admission. The file set stays 109 and none from tests/, scripts/, or evals/;
// headroom is ~515 B over measured 1_283_785.
// Raised to 1_290_000 for #140 (separate the domain glossary from architecture
// classification): CONTEXT.md shrinks into a pure glossary, and its subdomain
// split, import direction, and review policy move into a new packaged
// docs/reference/architecture.md ledger, with the rationale in a new packaged
// docs/explanation/domain-model.md. The glossary shrinks but the ledger and
// explanation ship as new public reference/explanation surfaces, so this is net
// growth in already-packaged docs, not an inclusion. The file set grows to 111
// for those two docs and none from tests/, scripts/, or evals/.
// Raised to 1_300_000 for #143 (distinguish Return candidates from validated
// Return envelopes): the taxonomy adds the packaged Core concept module
// return-types.ts (the candidate/envelope vocabulary types.ts re-exports), the
// public FlowReturnCandidate schema beside FlowReturnEnvelope, the glossary's
// Return candidate / Rejected Return candidate entries, the reference and
// troubleshooting taxonomy wording, and the breaking-change migration entry in
// CHANGELOG.md. The file set grows to 111 for return-types.ts (on the #155
// docs reorg base) and none from tests/, scripts/, or evals/; measured
// 1_295_899.
// Raised to 1_315_000 for #144 (canonicalize persisted workflow identity):
// the canonical/legacy digest pair, the v4 -> v5 state migration and receipt
// rebinding in workflow-state.ts and approval.ts, the legacy state-file
// lookup, and the reference/troubleshooting/CHANGELOG wording for the
// transition. No new file: the set stays 111, none from tests/, scripts/, or
// evals/; measured 1_306_148.
// Raised to 1_320_000 for #145 (verified vs carried judgment rows): the
// review-policy wording in architecture.md, domain-model.md, AGENTS.md, and
// CONTRIBUTING.md now describes fixed row identity, declared surfaces, and
// digest-stamped provenance, and the CHANGELOG documents the change. No new
// file: the set stays 111, none from tests/, scripts/, or evals/; measured
// 1_317_407.
// Raised to 1_350_500 for #148 (dependency-aware Decomposition): the packaged
// Core concept module decomposition.ts (the Decomposition type, the parser over
// both emission paths, the published FlowDecompositionReturn schema, and the
// deterministic validator), orchestrate's wave scheduling and not-completed
// manifest, the commander protocol instruction naming both shapes, and the
// reference/troubleshooting/CHANGELOG wording for the new codes and the raised
// maxSubtasks ceiling. The file set grows to 112 for decomposition.ts and none
// from tests/, scripts/, or evals/; measured 1_349_923.
// Raised again to 1_366_000 for the #148 user docs: the flow-reference
// Decomposition sections (both commander shapes, the subtask field table, the
// validation rules, wave scheduling, and the stranding manifest), the new
// docs/explanation/decomposition.md page with its index entry, and the
// dependency-aware orchestrate example. The file set grows to 113 for the new
// explanation page and none from tests/, scripts/, or evals/; measured
// 1_365_138.
// Raised again to 1_374_000 for the #148 review fixes: the subtask-id charset
// and its refusal, the prose fields the published return schema now accepts in
// either form, the prefixed worker span keys, and the reference, troubleshooting
// and explanation wording for all three. The file set stays at 113 and none from
// tests/, scripts/, or evals/; measured 1_371_721.
// Raised to 1_395_000 for #160 (review a Decomposition before dispatch): the
// packaged Supporting module owns the bounded review and revision loop. The
// prompt includes all Return requirements. The schema, orchestrate mode,
// glossary, changelog, and user documents expose the contract.
// The file set grows to 114 for decomposition-review.ts. No file from tests/,
// scripts/, or evals/ ships. The measured size is 1_394_429.
// Raised to 1_425_000 for #164 (the budget headroom gate): effortWeight joins
// the subtask type, parser, validator, published return schema, reviewer JSON,
// and commander prompt; Budget gains the headroom projection and its refusal;
// orchestrate gains the pre-dispatch gate, the replan-smaller route, and the
// per-wave budget stranding. The file set grows to 116 for the two size splits
// (decomposition-graph.ts, modes/orchestrate-outcomes.ts). No file from
// tests/, scripts/, or evals/ ships. The measured size is 1_415_957.
assert.ok(pack.unpackedSize < 1_425_000, `package unpacked size too large: ${pack.unpackedSize}`);
console.log(`pack ok: ${files.length} files, ${pack.unpackedSize} bytes unpacked`);
