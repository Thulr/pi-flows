// The spelled-once ledger, enforced by scripts/domain-score.mjs (the
// spelled-once structural row). Each entry is a concept a shipped
// consolidation reduced to one home (the PR that did it is named on the
// entry), the source shape that would betray a second derivation growing back,
// and exactly where — and how many times — the tree may spell it. The count is
// part of the allowance because "once" is usually the entire point: a second
// occurrence inside the allowed module is the same regression as one outside
// it.
//
// A new match is the old defect returning, so the remedy is fixing the code.
// Widening an allowance is a deliberate edit to this table for a reviewer to
// see, never a data file a change can quietly grow — the same posture as the
// foreign-import ledger, enforced at the point the escape hatch would
// otherwise be.
//
// Every pattern must carry /g: matchAll throws on a non-global regex, so an
// entry authored without it crashes the gate loudly instead of under-counting.
//
// Matching is raw source text, comments included — the same posture as the
// score's import matchers, and for the same reason: a comment parser correct
// about strings, templates, and regexes is a riskier resident of a required
// gate than the false positive it prevents. Instead, every pattern requires
// code-shaped text (operators, call syntax, escaped delimiters), which prose
// does not reproduce by accident. Each pattern is a tripwire, not a proof: it
// catches the honest regression, and each entry's comment names what evades it.
export const SPELLED_ONCE = [
  {
    concept: "run liveness sentinel, read",
    home: "runSettled (run.ts)",
    // #125: reading exit code -1 as "no child has exited yet" is runSettled's
    // one job — ten comparison sites collapsed to one. Constructing a result
    // with the sentinel is a write and stays free; comparing against it
    // anywhere else is a second liveness derivation. Identifier-bounded on
    // both sides: a distinct field like gitExitCode, or a different literal
    // like -12, is not this concept.
    pattern: /(?<![\w$])exitCode\s*[!=]==?\s*-1(?![\d.])/g,
    allowed: { "run.ts": 1 },
  },
  {
    concept: "refusal cap-and-slice assembly",
    home: "Settle.refuse (settle.ts)",
    // #130: refuse owns the model-visible cap over a refusal. Capping the
    // assembled message and slicing the formatted prefix back off is the trick
    // two modes independently reinvented before the cap moved into refuse.
    // The .slice( is anchored to the cap call's own balanced close (nesting
    // inside the argument handled two parens deep, which covers the historical
    // orchestrate shape), so a nearby slice of something else — even in the
    // same statement — stays silent, and the slice must carry the defect's
    // signature: removing a just-measured prefix (.slice(x.length)). An
    // argument nested three parens deep or a precomputed bare-variable length
    // evades this — a tripwire catches the honest regression, not an
    // adversary. Semicolons stay excluded so backtracking is confined to one
    // statement.
    pattern: /capModelVisibleText\((?:[^();]|\((?:[^();]|\([^();]*\))*\))*\)\.slice\(\w+\.length(?![\w$])/g,
    allowed: {},
  },
  {
    concept: "minted-event assembly",
    home: "mintEvent (trace-scope.ts)",
    // #128: a minted event merges the seam's facts after the caller's
    // attribution, spelled once in mintEvent so a later seam cannot reverse
    // the spread and let attribution override the outcome. Inlining
    // `attribution.record?.(` is a second assembly of that merge; the
    // hand-placed `deps.recordEvent?.(` sites are a different concept (no
    // attribution to merge) and stay silent, as does a seam that renames its
    // parameter — the tripwire limit the entries above accept. The one
    // allowance is mintEvent's own body.
    pattern: /attribution\.record\?\.\(/g,
    allowed: { "trace-scope.ts": 1 },
  },
  {
    concept: "integration-branch recovery pointer",
    home: "the settle.decorateFooter registration (modes/worktree.ts)",
    // #130: worktree registers the pointer once, after creating the branch. A
    // second literal is a refusal site deciding again what every refusal
    // already carries — the shape that shipped two refusals pointing at a
    // retained branch they never named. The escaped backtick after the colon
    // is the pointer's code shape (the branch name is always quoted), so the
    // phrase in a comment or prompt heading stays silent; a copy that skips
    // quoting the branch evades — the tripwire limit again.
    pattern: /Integration branch: \\`/g,
    allowed: { "modes/worktree.ts": 1 },
  },
  {
    concept: "subtask outcome construction",
    home: "OrchestrateBoard (modes/orchestrate-board.ts)",
    // #169: how a subtask settled is recorded only by the board, so a state can
    // never be set without the evidence that belongs to it. Before the board,
    // the handler and the replanner each constructed outcomes into a shared
    // Map — the shape that let a stranding carry neither a blocker nor a
    // reason. The brace anchor keeps this to object-literal construction: the
    // discriminated union's own arms are written `{ readonly state: "..." }`
    // and stay silent, as do the `stateOf(id) === "succeeded"` comparisons
    // every surface makes. A construction spread across a variable, or one
    // that names the field before a comment, evades — a tripwire catches the
    // honest regression, not an adversary.
    pattern: /\{\s*state:\s*"(?:succeeded|failed|stranded)"/g,
    allowed: { "modes/orchestrate-board.ts": 5 },
  },
];
