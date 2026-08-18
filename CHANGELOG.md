# Changelog

All notable changes to pi-flows are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version surfaces
that must agree are `package.json`, `PI_FLOWS_VERSION` in
`extensions/pi-flows/types.ts`, this file, and the release tag.

## Unreleased

### Added

- Orchestrate can now review a Decomposition before worker dispatch (#160).
  The optional review role judges the normalized Decomposition against a fixed
  quality rubric and caller criteria. A bounded REVISE loop asks the commander
  for a complete replacement. Each replacement passes structural admission.
  Failed or exhausted reviews return `DECOMPOSITION_REVIEW_FAILED` before any
  worker starts. The new `npm run eval:decomposition-quality` command measures
  verdict accuracy and paired quality without rewarding extra subtasks.

- Orchestrate's commander can now return a dependency-aware Decomposition
  (#148): a JSON array of subtask objects carrying `id`, `objective`, and
  optional `dependsOn`, `scope`, `nonGoals`, `inputs`, `expectedReturn`, and
  `acceptanceEvidence`, beside the flat subtask-string array, which is unchanged.
  A new packaged Core module, `decomposition.ts`, holds the Decomposition type,
  the parser over both emission paths, the published `FlowDecompositionReturn`
  schema for contracted commanders, and the deterministic validator that runs
  after the commander settles and before any worker spawns. The validator
  refuses missing, duplicate, or unusable ids — an id must be one plain token,
  because the flow writes it into the worker prompt headings and the trace span
  keys — unknown `dependsOn` references, a subtask
  that names its own agent, a structured decomposition above the ceiling
  (`DECOMPOSITION_INVALID`), any dependency cycle (`DECOMPOSITION_CYCLE`), and a
  shared-write topology no wave schedule could ever admit (`SHARED_WRITE_CWD`).
  Dependent subtasks run wave by wave, receive each dependency's validated
  handoff as labeled untrusted data, and link it in the trace; a failed subtask
  strands its transitive dependents, and the debrief prompt and flow header name
  every unit that did not complete. `orchestrate.maxSubtasks` now accepts 1..16
  (default 8): a flat list is still cut to the cap, while a decomposition with
  edges is refused above it rather than cut. `npm run eval:decomposition` is the
  structural eval over that gate: 35 seeded, model-free fixtures report the
  admission rate for well-formed decompositions, dependency-edge correctness,
  refusal correctness per expected code, and the false-refusal rate on
  defect-free controls. It scores the shipped predicates themselves, spends no
  tokens, and makes no claim about decomposition quality.

- Workflow approval receipts now bind every gated Role and gated debrief to the
  effective Agent profile (#138): selected package/user/project source, a
  non-disclosing prompt digest, post-override tools, canonical cwd target and
  filesystem identity, concrete model, and Thinking level. Verification carries
  that exact cwd binding into gated Role and debrief dispatch, where the production
  runner rechecks it immediately before spawn. Profile drift reopens unspent consent; unbindable
  defaults refuse before prompting; malformed/replayed receipts remain hard
  failures; and version-3 states reopen unspent consent, preserve same-action
  retries across model-metadata drift, or retain completed approvals as
  audit-only compatibility evidence. Historical clamps are reconstructed per
  model, with digest-checked Thinking witnesses for searches beyond the bound;
  unused or incoherent witnesses and partially spent v2 actions fail closed.

- Every agent-reference `contract` now resolves before its Child can spawn
  (#137), binding Task, budget/timeout, Return validation, and trace authority
  for evaluator, controller, loop, search, and monitor roles. Unforgeable,
  flow/Result-bound single-use plan capabilities and trusted wave consumption close bypasses;
  Integration control distinguishes exact validated fields from legacy prose even
  when content is not recorded, contract spend is shared by identity, and rejected waves
  retain every spent Run and rejection event. Budget disclosure and opener
  admissibility derive from the same role rule.

- Every mode now declares its **owed event kinds** — the coordination-event
  kinds its own handler records by hand (state transitions, retries,
  controller-parsed verdicts) — once beside its handler on the mode table,
  like `plan`, `criticalPath`, and `preSpawnRefusal`; a mode without one is a
  compile error, and `noOwedEvents` is the declared answer for a mode that
  records none (#133). The sink stamps the declaration on the root span as
  `flow.trace.owed_event_kinds`, and every seam-minted event now carries
  `flow.event_minted` — a capability the seams hold rather than a field any
  caller may set, and one the sink states itself after the caller's own
  attributes, so neither the mark nor the event kind nor the placement the
  read-back gates on can be forged from a mode — so the strict read-back and
  `npm run trace:report -- --strict` can hold the hand-placed events to the
  mode's own statement: an unminted event of a kind the mode never declared is
  refused the same way forged surplus already is, counted separately as
  undeclared events. A declaration bounds kinds, not counts — whether a retry
  fires is runtime-dependent — so a healthy run that records nothing still
  passes, minted rows stay the seams' own statements, and traces written
  before the declaration existed stay exempt. Four verdicts that were parsed
  but never recorded now leave `validation` evidence: `loop.judge_verdict`,
  `debate.judge_verdict`, `vote.tally`, and `search.scores`.

- The Return assurance levels are now defined and exposed (#146). The glossary
  names three levels a child's output can carry: an **ordinary Result** (the
  Child's own account, no machine contract assurance), a **contract-bound
  Return** (a validated Return envelope proving contract attribution, declared
  artifact integrity, and return-schema conformance — never the truth of its
  claims or satisfaction of prose `acceptanceChecks`), and **Verified outcome
  success** (only when an independent verifier assessed the outcome). The
  trace report adds a `Return assurance` line counting child runs dispatched
  under a delegation contract against ordinary Results. The product value
  statement, README, reference docs, and TypeBox schema descriptions now state
  when a delegation contract is optional and exactly what supplying one
  proves; prompt-only return requirements are labeled as never machine-checked;
  and the code-review preset's rejected-envelope findings are labeled with the
  glossary's "Unvalidated claims from a rejected Return candidate".

### Changed

- The domain-model score now separates verified rows from carried ones (#145).
  Judgment-row identity and required fields are fixed in
  `scripts/domain-judgment.mjs`: a deleted, renamed, or invalid ledger row
  reads as a missing judgment and fails the score, and an explicitly failed
  verdict exits non-zero. Each row declares the code, mode, shared-kernel,
  documentation, and test surfaces that can invalidate it, and a recorded
  review stamps a content digest per surface plus a digest of the declared
  list itself — so a ledger edit alone, including trimming a changed surface,
  cannot mark a row fresh; only `node scripts/domain-score.mjs
  --record=<rows|all>` records provenance for the current tree. Staleness is
  content-based and needs no git history (dirty trees, divergent merges, and
  shallow clones all answer alike), stays advisory, and every output leads
  with the verified score while showing carried rows separately. The `acl`
  and `core-domain` labels now state only what their mechanical checks prove,
  and the score's `--json` shape changed accordingly (`carried` now counts
  stale passing rows only).

- Workflow identity is now canonical (#144): the state digest is the
  extension's canonical (recursively key-sorted) SHA-256 over the task, phases,
  and debrief, so reordering object keys at any nesting level no longer reads
  as different work, while task text, phase order, phase values, and debrief
  meaning still do. The state schema version moves to 5 — the version records
  which algorithm produced a persisted digest. On resume, versions 1–4 are
  still matched by their original order-sensitive digest and migrate forward:
  the state is restamped with the canonical digest, and every completed
  approval's receipt is revalidated against the v4 encoding of the live
  workflow before being rebound to the v5 encoding — a receipt that
  revalidates keeps its identity, actors, expiry, consumption record, and
  `typed` validation; a spent receipt that does not fails the migration with
  `APPROVAL_RECEIPT_STALE` and leaves the v4 state retryable; an unspent one
  reopens or fails closed through the normal receipt paths. The default
  `stateFile` lookup prefers the canonical-digest name and falls back to the
  legacy-digest file only when the canonical one does not exist — never a
  choice between two candidates — and a migrated legacy-named file is
  rewritten under the canonical name and removed once the new record is
  durable.

- **Breaking (public API):** the Return vocabulary now distinguishes a **Return
  candidate** (untrusted child output, structurally an envelope, identity
  optional and kept as parsed so a rejection stays diagnosable), a **rejected
  Return candidate** (retained as rejection evidence, never attached), and a
  validated **Return envelope** (#143). The public `FlowReturnEnvelope` schema
  validates only the validated form: `contractId` is required, so an unbound
  candidate no longer passes a validator named "Return envelope". Downstream
  validators of raw child output must migrate to the new public
  `FlowReturnCandidate` schema, which keeps `contractId` optional and matches
  the runtime shape check. The types `DelegationReturnCandidate`,
  `RejectedDelegationReturnCandidate`, and `DelegationReturnEnvelope` (identity
  required) are exported beside the schemas. At runtime, the validated envelope
  is stamped with the resolved contract identity itself, and attaching an
  envelope through the Run lifecycle is possible only via the validation seam —
  the attach transition is a single-claim capability held by validation, so
  nothing else can attach output that never passed the contract checks.
  (`FlowRunResult` itself stays the plain writable read projection it has
  always been; the seam guards the Run transition, not the projection.)
  Attribution,
  integrity, and conformance keep their order: only a schema-nonconforming
  candidate whose attribution and integrity held can surface Unvalidated
  claims.

- The domain documentation is split into three surfaces (#140): `CONTEXT.md` is
  now a pure glossary of canonical terms with concise, implementation-free
  definitions and Avoid lists, while module classification, import direction, and
  review policy move to a new `docs/reference/architecture.md` ledger and the
  rationale moves to `docs/explanation/domain-model.md`. `npm run score:domain`
  now reads classification and import direction from the architecture ledger
  rather than parsing the glossary, and contributor guidance points at the right
  surface for each purpose.

- Coordination-control markers are now authoritative only in their documented
  form (#139). A verdict, loop, route, or score token is accepted only when it
  occupies the child's first non-empty line and matches the exact grammar — a
  mention, quotation, negation, example, or a longer word that merely begins
  with an allowed token (e.g. `PASSPORT`, `APPROVED`, `LOOP: COMPLETE`, `SCORE: 150`,
  `I cannot issue VERDICT: PASS`) stays prose and fails closed to its safe
  fallback (revise, continue, unresolved route, or unscored candidate). The JSON
  fallback accepts only the documented field and value type. The instruction a
  mode sends its child and the grammar the parser accepts now derive from one
  protocol vocabulary, and the reference documents the authoritative position,
  exact values, and fallback behavior.

- The strict read-back no longer rereads the whole shared trace file on every
  finalize (#129). The sink records where the file had grown to the moment it
  was created — the file is append-only, so nothing before that byte can carry
  the invocation's just-minted random id — and both readings read only from
  there, keeping each finalize's I/O proportional to its own rows plus
  whatever co-tenants append while it runs — zero in the documented eval setup
  (every flow appending to one `PI_FLOWS_TRACE_FILE` in sequence), which
  previously paid for all its predecessors, quadratically across a run. Every
  in-extent verdict is unchanged: forged-identity surplus, stampless
  remainders, and co-tenant runs landing after the sink exists are judged
  exactly as before. One disclosed delta: rows under the same trace id already
  in the file *before* the flow call began are no longer read, so a stampless
  remainder there no longer refuses the live gate — it is a predecessor's
  record, judged by whole-file readers (`npm run trace:report -- --strict`
  still refuses the file), the same way rows appended after finalize were
  always beyond the live verdict. (A pre-extent row forging both of the run's
  ids likewise goes unread — a shape no honest writer can produce, since the
  invocation id does not exist until the sink is born.) The reading keeps the
  file's own line boundaries: when the pre-existing content ends in a torn row
  with no terminator, the sink's first append is physically part of that line,
  and the read-back refuses it as missing exactly as the whole-file report
  refuses the concatenated line as unparseable.

- The two coordination actions that already pass through framework seams now
  mint their own trace evidence instead of leaving it to handler discipline
  (#128). Running a deterministic gate (`runCheckCommand`) records the
  `validation` outcome event at the seam, and issuing an approval receipt
  (`issueApprovalReceipt`) records the `approval` event carrying the receipt's
  identity. Both take a required **event attribution** (the caller's event
  name, span placement, own facts, and the recorder or its stated absence), so
  a new mode cannot compile a gate or a receipt without stating where its
  evidence goes, and the seam's facts merge last — through the one `mintEvent`
  home — so attribution cannot override what happened. Event names,
  placements, and existing attributes are unchanged on the wire, with two
  disclosed deltas: `flow.check.spawn_failed` is a new attribute — a gate that
  could not start now leaves evidence on evaluate's refuse-first path, which
  previously recorded nothing for that spend — and the approval event now
  records at issuance rather than after the state persist that follows, so
  evidence of consent no longer depends on that write landing. A mode's own
  state transitions, retries, and controller-parsed verdicts have no shared
  seam performing them and stay hand-placed — the deliberate boundary named in
  `CONTEXT.md` (**Minted event**) and tracked in #133, now bounded by the
  owed-event-kinds declaration (see Added above).

- Raw `parallel` fan-out with two or more tasks now refuses before child spend
  when any task omits `tier`/`model` and the flow names no uniform fallback.
  Per-task sizing is explicit for mixed work; a flow-wide `tier` or `model`
  remains the explicit choice for intentional uniform sizing.
- Every mode now declares its **mode pre-spawn refusal** — what it refuses
  before its first child spawns — once beside its handler, and the handler
  reaches that same function instead of rebuilding the refusal inline. These
  rules previously existed twice, because Core may not import Supporting: once
  where the handler enforced them and once as a mirror in `validate.ts` for the
  selection eval to score, kept in agreement by hand. A new mode without one is
  a compile error, and the eval resolves the active mode's declaration through
  the table rather than importing and ordering five predicates.
- Every refusal keeps its code and its message. One **cause** is now more
  precise: a graph in which no node is dependency-free is refused before
  dispatch with "No graph node is dependency-free, so no first wave can ever
  become runnable", where it previously reported the wave loop's "No remaining
  graph node is runnable even though some nodes are incomplete". The wave loop
  keeps that cause for a cycle that strands only later nodes.
- A run with `traceStrict` now reads its own exported trace back before
  reporting the result as evidence-backed. **Trace health** is the writer's
  count — spans attempted against spans written — so it cannot see corruption
  that lands after a successful write, and a trace no reader can follow still
  passed the gate; the refusal text even directed readers to run
  `npm run trace:report -- --strict` by hand to find exactly this. The gate now
  performs that reading itself and refuses with `TRACE_INCOMPLETE` when the
  export is complete but is not a span tree. It reads only the rows carrying
  its own `trace_id` and `flow.invocation_id` (see the #127 fix below), so
  flows sharing one trace file — an eval setting `PI_FLOWS_TRACE_FILE` once
  for a whole run — do not judge each other.
  Ordinary best-effort flows read nothing back and are unaffected.

  This does **not** make trace health see un-emitted coordination events. A
  mode that records no state transition, retry or approval still writes a
  valid tree and still passes, because the expectation the reading measures
  against is what the sink attempted, not what the mode owed. Tracked as #128.
- A refusal's model-visible text is now capped by `refuse` itself, over the
  formatted error and footer together. `loop` and `orchestrate` had each
  hand-assembled the capped message and sliced the formatted prefix back off
  for `refuse` to re-prepend; their refusal text is byte-identical after this
  change (pinned by test). Other modes' refusals were previously uncapped, so
  a pathological error cause is now bounded like all other model-visible text.
  A recovery pointer a mode registers (see the worktree fix below) is appended
  after the cap, so truncation cannot swallow the one line that names where
  recovery lives — and is bounded by its own small allowance, so the refusal
  stays capped no matter what a mode registers. The variable-length error
  fields — message, cause, and fix (git stderr and failed-child reports reach
  the cause; unbounded params like a worktree `baseRef` reach interpolated
  messages) — are each bounded before formatting, with allowances that sum
  under the cap, so a refusal built over megabytes of stderr still shows its
  `Retryable`/`Fix`/`Code` lines instead of losing them to the truncation.
  Details and trace evidence keep the error object uncut.

### Fixed

- A Handoff now exists only when a downstream role actually consumes a result.
  Completion semantics are authoritative: a terminal (parent-facing) result keeps
  its validated return envelope and validation evidence but never attaches a
  Handoff, mints a handoff dependency key, aggregates handoff warnings, or records
  handoff evidence — whatever payload representation it was read as. Integration
  consumption still applies injection policy, aggregates warnings, mints a
  dependency key, records the boundary, and attaches exactly one Handoff, and a
  policy-refused handoff is recorded as evidence but never banked. Parallel and
  workflow terminal results no longer expose phantom Handoffs, workflow state
  rebuilds a terminal phase's durable handoff from its validated return envelope
  for resume, and the incomplete-handoff summary reads terminal envelopes. (#142)
- The strict read-back no longer falsely refuses a healthy run whose stable
  trace id is shared with an earlier call. `stableTraceIds` derives the id
  from the trace context and the mode so an eval row and its runtime trace
  correlate — which means a traced pre-spawn refusal (a project-preset
  refusal, for example) and the retry after it write two roots under one id
  into one file, and the retry's read-back reported the refusal's rows as its
  own duplicates and surplus, failing with `TRACE_INCOMPLETE` in exactly the
  strict eval/release population that shares `PI_FLOWS_TRACE_FILE`. Every row
  a sink writes now carries `flow.invocation_id`, a random per-call
  discriminator (returned as `details.trace.invocationId`), and both the
  runtime read-back and the trace report judge each invocation only on its
  own rows — so the shared file's report shows two whole runs instead of one
  corrupt one. The stable ids are untouched, so the eval linkage survives.
  Stamp-less rows under a discriminated trace id are decided by one shared
  predicate at every gate (the runtime read-back, the report, the release
  validator): a whole run that declares its own root — a writer predating the
  discriminator sharing the stable id — is judged as its own run, while a
  remainder no run claims counts against every invocation of the id, so the
  scoping cannot launder corruption past any gate, and a row that loses its
  stamp still counts as loss. One limit is accepted: two runs that *both*
  predate the discriminator and share a stable id have nothing to separate
  their rows, so the report still refuses that file — rerunning under the
  stamped version is the way out. (#127)
- Two worktree refusals — a failed commit of resolved integration conflicts,
  and a failed commit of integration review fixes — told users to inspect the
  retained integration branch without naming it. Both fire after the branch
  exists, so recovery was real but unfindable. The pointer is now registered
  once on the settle (`decorateFooter`, the parallel of the details decorator
  workflow uses) the moment the integration branch is created, so every
  refusal from then on carries ``Integration branch: `pi-flow/<run>/integration` ``
  — including refusals written later, which is how these two were lost, and
  including the planning refusals on the conflict/review path that previously
  carried no pointer at all. The eight hand-written copies of the footer are
  deleted. Refusals before the integration branch exists keep their
  worker-branch recovery footers unchanged.
- Provider failures now show sanitized cause, runtime/context facts, and safe
  recovery in collapsed views; expansion keeps detail. Generated-token budgets
  are labeled output-only. (#122)
- A child that reports a terminal stop reason without a diagnostic no longer
  renders three different ways. The live row, the flow card, and the timeline
  each derived **run state** separately and read different fields, so one run
  could show as failed in the live row, partial in the card header, and
  complete in that same card's row — and the timeline drew it as a clean rail.
  All three now render one derivation (`runState` in `run.ts`), which reads
  every failure signal under either name a run's shapes give it.

## 0.8.0 - 2026-08-10

### Added

- The settled flow card renders a **timeline** of the run as an inline image
  in terminals that speak the Kitty or iTerm2 graphics protocol (Ghostty,
  Kitty, iTerm2, WezTerm): one rail per child offset by real start times, a
  deterministic **per-agent identicon** beside each label (hashed sprite and
  hue, so repeated agents visibly share one mark), and failures hatched with
  an `X FAILED` label — never encoded by color alone. Every other terminal
  keeps the text card unchanged; the chart is rasterized dependency-free
  (`ui-gantt.ts` over `png.ts`) with the active theme's own colors on a
  transparent background. Child results now record `startedAtMs` so the chart
  shows which runs actually overlapped.
- The flow card's trace path is now an **OSC 8 `file://` hyperlink**
  (clickable in supporting terminals, plain text elsewhere).

### Changed

- The view surfaces (live tool row, flow card, inspector)
  now share one visual vocabulary (`ui-style.ts`): per-run state-cell progress
  bars that show *which* runs are out, smooth eighth-block budget meters with
  green/amber/red thresholds, inverse-video verdict badges, tree-guide
  connectors, and titled box frames.

- Every mode now declares its **plan** — its pre-spawn **waves** of agent refs —
  once, beside its handler, and the four surfaces that used to re-derive the
  topology by hand (requested agents, the shared-write admissibility mirror,
  budget disclosure, the critical-path resolver) read the declaration instead.
  A new mode without a plan or critical path is a compile error; the
  admissibility mirror moved out of Core onto the mode table.
- Mode handlers settle through a per-invocation **Settle** object and dispatch
  through `dispatchIntegrationPlan`/`dispatchIntegrationWave`. The shared-write gate is now
  enforced inside the fan-out itself (no hand-called guard to forget), a
  refusal structurally carries every run that already spent, and contracted
  dispatch derives its limits, cwd, and step in exactly one place. Refusal
  precedence between an invalid delegation contract and a shared-write
  collision flips accordingly (plans validate before the wave gate; both
  remain strictly pre-spawn).
- `list:true` and `showConfig:true` are decided inside the admission walk
  rather than by statement order in the composition root; their precedence
  (list over showConfig over run modes, before preset resolution) is now a
  stated, tested rule.

### Removed

- The **F8 fleet panel** (and its spend-sampling machinery, burn-rate
  sparkline, and shortcut) is gone: it overlaid the chat rather than sitting
  under it and did not earn its keep. The live tool row remains the primary
  progress surface and `/flows inspect` remains the per-child drill-down.

### Fixed

- The automatically derived model roster now honors pi's effective session
  scope (`/scoped-models`, `--models`): a non-empty `ctx.scopedModels`
  constrains the `fast`/`deep` candidates, so an automatically tiered child can
  no longer dispatch to a model the user disabled. An empty or absent scope
  (including older pi runtimes without the property) keeps the
  all-available-models behavior, `capable` still mirrors the session's active
  model even outside the cycling scope, and explicit model pins remain
  deliberate overrides. A non-empty scope that leaves the tiers nothing
  rankable fails closed down a ladder instead of falling through: anchor to
  the session model, else bind a decoded scoped reference directly, else
  refuse the automatic tier with the new `MODEL_SCOPE_UNSATISFIABLE` error —
  an unpinned child would load pi's configured default, which the scope may
  exclude. (#108)
- A child that reported a terminal provider error and then exited on its own
  was misclassified as `CHILD_EXIT_NONZERO`, replacing the provider's
  diagnostic with a generic exit message; it is now `CHILD_PROVIDER_ERROR` on
  both the prompt-exit and stalled-then-terminated paths, with a cause that
  says which of the two happened. A later healthy turn still clears the
  terminal-error state. (#110)
- A contracted child's budget wrap-up is no longer marked successful on notice
  delivery alone: a wrap-up response that fails envelope validation revokes the
  provisional `budget_wrap_up` success, so the run (and the live row and
  durable flow card) reports the validation error — naming the failing role —
  instead of rendering `✓`/`N ok` beside `RETURN_ENVELOPE_INVALID`. The
  contracted wrap-up notice now also states the exact `contractId` and
  return-envelope format the final message must carry. (#112)
- A flow whose router settled without naming a valid candidate
  (`ROUTE_UNRESOLVED`) reported no runs: the router child that had already
  spent tokens vanished from `details.results`, so the flow card read
  "0 agents" and reflexion skipped a flow that did spawn. The refusal now
  carries the router run.
- Terminal (parent-facing) contracted results now leave coordination
  evidence: `envelope.validated` / `envelope.rejected` validation events with
  their artifact events, in every mode. Previously a digest mismatch recorded
  five spans through `graph` and none through `single` or `parallel` — the
  mode the code-review preset runs. Injection-policy enforcement for terminal
  reports is unchanged; only the recording became unconditional.
- The trace writer no longer emits a shape its own reader refuses: a
  `dependsOn` key that resolves to no span is recorded as
  `flow.depends_on_unresolved` (a dangling link — a handler bug, reported
  separately) instead of being silently dropped and read back as corruption.
  A thrown handler now finalizes a closed, refusable trace instead of leaving
  child spans parented to stage ids that were never written.
- `npm run trace:report`, the command named in the `TRACE_INCOMPLETE` fix
  text, crashed under plain `node` on the first TypeScript parameter property;
  it now runs under the tsx loader and is smoke-tested.

- A **rejected envelope**'s claims are no longer surfaced as **unvalidated
  claims** when its artifacts were never verified. A return envelope's three
  contract checks now run attribution → integrity → conformance, where
  conformance previously short-circuited ahead of integrity: an envelope that
  missed `contract.returnSchema` was treated as surfaceable without its digests
  or artifact containment ever being checked, so an artifact reference escaping
  the child `cwd`, or one no longer matching its digest, could ride out on a
  schema miss. Only an envelope that is attributable to the dispatched contract,
  whose artifact references stay inside the child `cwd`, and whose declared
  digests match, may have its claims surfaced.
  Two consequences for reported errors, both only when an integrity failure and
  a schema miss arrive together: a digest mismatch is now reported as
  `RETURN_DIGEST_MISMATCH` rather than `RETURN_ENVELOPE_INVALID`, the more
  serious diagnosis and the one whose fix ("treat the handoff as untrusted")
  applies; and the other integrity failures — an artifact reference escaping the
  child `cwd`, a missing, unreadable, or non-regular artifact, a digest naming
  an undeclared artifact — keep `RETURN_ENVELOPE_INVALID` but now report the
  integrity failure as the cause instead of the schema miss.

## 0.7.1 - 2026-08-09

### Added

- A budget **wrap-up notice** (#104): at 80% of any ceiling that would stop the
  live run (cost, generated output, or a contract's total tokens), the runner
  delivers a steered message into the child — stop working and emit the return
  envelope now, marking unfinished work as skipped coverage and
  `unresolvedQuestions`. The channel is a per-child wrap-up file announced in
  the child's environment and watched by the pi-flows extension inside the
  child (`extensions/pi-flows/wrapup.ts`); the threshold transition belongs to
  the ceiling, so it steers every live child governed by a shared budget at
  the same moment, and a child spawned while a shared ceiling is already
  inside the window is steered at spawn. Requesting is not
  receiving: the runner treats the notice as delivered only when it is seen
  echoed back into the child session as a user message. A child that crosses
  the ceiling after a delivered notice is still terminated, but settles
  gracefully (`stopReason: "budget_wrap_up"`, exit 0) and its final envelope
  is validated normally, converting a breach from total loss into a valid
  partial envelope; an undelivered notice keeps the hard stop. The wrap-up
  request (`child.wrap_up`, with `flow.budget.wrapup_delivered`) and a
  graceful exhaustion (`flow.budget.graceful`) are recorded as budget events
  on the trace.

- A `bash-ro` tools token (`extensions/pi-flows/bash-readonly.ts`): bash under
  a read-only command allowlist — git inspection, file inspection, and repo
  verification (`npm test`, `npm run <script>`, `node --test`) — enforced by
  the pi-flows extension running inside the child via a blocking `tool_call`
  handler. A `bash-ro` toolset is not write-capable, so it passes the
  `SHARED_WRITE_CWD` guard; a toolset carrying both `bash` and `bash-ro`
  resolves to plain `bash`, and a `bash-ro` spawn no layer can enforce is
  refused with the new `BASH_READONLY_UNENFORCEABLE` error instead of granted
  an unrestricted shell. This is coordination safety against ad-hoc mutations
  of a shared checkout.
- A selection-eval case (`readonly-shell-fanout-bash-ro-recovery`) scoring the
  `bash-ro` recovery from `SHARED_WRITE_CWD`: a concurrent read-only shell
  fan-out in one checkout may spend one refusal, after which the retry must
  actually run: swapping `bash` for `bash-ro`, serializing, or a voter panel
  that keeps the shell. Recoveries that abandon the requested work do not
  count — dropping the shell entirely, or relocating roles out of the
  checkout — and `allowSharedWriteCwd:true` stays forbidden for work the
  request describes as read-only.

### Changed

- The bundled `code-review` preset's ceilings are resized as runaway backstops
  instead of governors inside the normal cost range (#104): per-axis contract
  `maxTokens` 100k → 300k and `maxGeneratedTokens` 8k → 12k, flow `maxTokens`
  200k → 750k and `maxGeneratedTokens` 16k → 30k. The observed normal spend of
  a read-heavy reviewer (~80–105k total tokens) sat astride the old 100k
  contract ceiling, so roughly half of routine runs forfeited their whole spend.
- `RETURN_ENVELOPE_INVALID`'s fix text now addresses the parent it is delivered
  to — do not automatically replay the flow; report to the user; retry only
  with changed return instructions or schema — with the child-facing envelope
  requirement quoted rather than issued as if the parent could perform it
  (#104). The code-review formatter also surfaces shape-valid envelopes that
  failed strict schema validation, labeled unvalidated, beside the findings a
  validated axis anchored, so a strict-schema miss no longer zeroes out the
  entire spend.

- `bash-ro` is now enforced at the OS level: on macOS a `bash-ro` child runs
  under `sandbox-exec` with a profile that denies writes anywhere under the
  reviewed `cwd` (`bash-readonly-sandbox.ts`), so a write into the shared
  checkout fails at the kernel regardless of the command — the in-child
  command allowlist becomes defense-in-depth plus the fallback where the
  sandbox is unavailable. Opt out with `PI_FLOWS_BASH_RO_NO_SANDBOX=1`. The
  fail-closed refusal (`BASH_READONLY_UNENFORCEABLE`) now fires only when
  neither layer is available; `PI_FLOWS_CHILD_NO_EXTENSIONS` alone no longer
  triggers it, because the enforcer loads through an explicit `-e` that
  survives `--no-extensions`. The child span records the enforcing layer as
  `flow.bash_ro.enforcement`. Because command parsing can never be an
  exhaustive boundary (option abbreviation yields endless bypasses), the
  allowlist is best-effort: off the sandbox it is the default fallback, and a
  caller who needs a kernel-enforced guarantee sets
  `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX=1` to refuse instead. Every
  bash-ro child also runs with the repository-configured git pager, a
  command-valued `fsmonitor`, and hooks neutralized via `GIT_CONFIG_*`.
  `diff.external`/textconv drivers are deliberately not forced off (an empty
  `diff.external` aborts every diff); their writes are denied on the sandbox
  path and are a documented residual on the allowlist fallback.
- The `code-review` preset's two reviewers now run with
  `read,grep,find,ls,bash-ro` at `concurrency: 2` — the two axes review
  concurrently in one checkout instead of serializing. The `scout` preset
  pins `concurrency: 1` explicitly.

- The flow lifecycle is now owned by a `Flow` aggregate root
  (`extensions/pi-flows/flow.ts`): admission walks every pre-spawn gate in the
  aggregate's declared order, returns a single-use capability that is the only
  way to dispatch, and dispatch returns the only thing that can settle — so
  running the lifecycle out of order is uncompilable, and a replayed
  transition is refused. A new `Run` object
  (`extensions/pi-flows/run.ts`) owns the child-result lifecycle: envelopes
  and handoffs attach to a result only through its transitions, replacing the
  former sanitize-side WeakMap side-channels. `index.ts` `execute()` is wiring
  only. The `flow` tool's external contract is unchanged; two flow-lifecycle
  coordination faults (`checkpoint-skipped-before-spawn`,
  `settle-without-dispatch`) join the fault-injection manifest (#97).

## 0.7.0 - 2026-08-08

### Added

- The README opens with a light/dark SVG banner, and the package manifest's
  new `pi.image` field points the [pi.dev gallery](https://pi.dev/packages)
  card at the durable flow-card demo GIF. Banner and GIFs are served from the
  repository, so the published tarball stays image-free.
- `docs/reference/package.md` documents the packaging surface for the first
  time: the `pi` manifest, what ships in the tarball and why, every install
  method, and the gallery metadata.
- Named workflow presets now sit above the raw mode/agent matrix. Bundled
  `scout`, `map-codebase`, and `code-review` definitions are discovered from
  package, user, and trust-gated project scopes; `/flows`, `flow list`, config
  details, traces, and durable UI retain preset provenance. Templates declare
  their permitted top-level overrides, and invalid or undeclared expansion
  fails before a child spawns. A template may tighten the capture policy but
  never loosen it; only the caller can turn redaction off.
- `code-review` runs exactly one bounded two-axis pass using sequential
  `overwatch` runs in separately visible `standards` and `spec` roles.
  Delegation contracts require typed per-file coverage and anchored findings;
  the harness pins the caller-requested Git range before dispatch and returns
  `CLEAN` only when both axes attest to those commits and cover its Git-derived
  manifest, otherwise `FINDINGS` or `PARTIAL`. A `base...head` request is pinned
  at its merge base, so the manifest stays the branch change set. An axis that
  could not finish is reported as `PARTIAL` carrying its anchored findings
  rather than as a handoff failure. Complete verdicts are published
  as verified trace outcomes even when child content capture is disabled. It
  never fixes, posts, delegates, or loops until clean.

### Changed

- User docs are reorganized around the [Diátaxis](https://diataxis.fr/)
  framework: `docs/{tutorials,how-to,reference,explanation}/` with a
  `docs/README.md` index. Packaged doc paths move accordingly (for example
  `docs/troubleshooting.md` → `docs/how-to/troubleshooting.md`); heading
  anchors are unchanged. The README is now a landing page — its former
  355-line `flow` quick reference lives in `docs/reference/flow-reference.md`,
  and the situations table and harness rationale in
  `docs/explanation/patterns.md` (#94).
- The selection-eval admissibility seam now scores the roster rule for
  `workflow` calls: a workflow whose first work phase names an unknown agent
  is refused (`UNKNOWN_AGENT`) instead of scoring as admissible, closing the
  parallel/workflow asymmetry #89 papered over with per-case
  `knownAgentsOnly` (#91). The refusal is derived from the tool's own
  first-spawn derivation (the first work phase — approval openers and
  resumes stay outside the rule) and, because `handleWorkflow` persists
  fresh state before the runner's roster check, the harness terminates the
  refusal rather than letting it play out. Workflow phase contracts remain
  deliberately unscored at this seam. Tool behavior is unchanged.
- Selection-eval scoring treats `minTasks` over a `workflow` call as a
  work-phase minimum, counted by the workflow handler's own imported
  work-phase predicate (agent AND task): approval-only phases carry no task,
  and an agentless task phase is a call the tool refuses
  (`WORKFLOW_INVALID`), so neither counts. The admissibility vocabulary now
  scores `WORKFLOW_INVALID` through the handler's own exported phase
  validation, so an invalid phase cannot lend its valid siblings to a case's
  topology, and the agents predicates read work phases only, so a stray
  agent field on an approval phase cannot fail a call the tool runs. A new
  `minApprovalPhases` shape predicate counts phases of the handler's
  approval kind, so a phase-gated case can require the gate itself. The
  `implicit-phase-gated-work-uses-workflow` case now requires at least two
  on-topic work phases naming bundled agents (`knownAgentsOnly`, which binds
  every named role — including phases past the first-work-phase roster rule
  above), closing the topology gap #87's headless-approval
  admissibility check left open — a workflow assigning one trivial work phase
  ahead of its approval while the top-level task recites the migration
  wording no longer passes (#88). Tool behavior is unchanged.
- Selection-eval scoring (`npm run eval:select`) now checks call admissibility:
  a spawning call whose `why` is missing or blank — one the tool would refuse
  with `WHY_REQUIRED` before any child spawns — no longer scores as a correct
  selection in any mode (#83). The gate predicate is imported from the
  extension, so the scored rule cannot drift from the enforced one; tool
  behavior is unchanged.
- The `SHARED_WRITE_CWD` refusal now attributes write-capability to each
  agent's effective toolset (rendering pi defaults explicitly) and states that
  the toolset, not the agent name, is what classifies a role — so a name-only
  retry is visibly futile. Its remediation, and the matching guidance in the
  tool prompt, README, and docs, now leads with `concurrency:1` and
  non-mutating toolsets and demotes `allowSharedWriteCwd:true` to a last
  resort for intentionally shared writes (#82). The guard's firing conditions
  are unchanged.

## 0.6.0 - 2026-08-01

### Added

- Tiers now resolve to real models with no configuration. `fast`, `capable`, and
  `deep` are matched against a **model roster** derived from pi's own model
  registry — the models this install has configured auth for, ranked by the
  provider's advertised pricing, context, and reasoning support. `fast` takes the
  cheapest usable model (preferring the parent's provider), `capable` the model
  this session is running — named explicitly, since a fresh child would otherwise
  load pi's *configured* default — and `deep` the most capable. Previously an unset `PI_FLOWS_FAST_MODEL` /
  `PI_FLOWS_DEEP_MODEL` meant every tier silently collapsed onto the parent's own
  model, so a correctly right-sized flow call did nothing. No vendor model id is
  hard-coded; the ranking comes from the registry, not from a list this repo
  maintains.
- `thinking` is a first-class dial on every surface that takes `tier` — flow
  calls, tasks, phases, graph nodes, worktree workers, agent refs, and agent
  frontmatter — passed to the child as `--thinking`. It is independent of `tier`,
  so effort can change while the model stays the same, and it is lowered
  automatically to what the resolved model supports whenever that model is
  known. A `capable` child with no level named inherits the
  parent session's current level, which previously never reached children at all.
  A model pin may also carry pi's `provider/id:level` shorthand.
- Child spans carry `flow.thinking_level` — the level passed to the child, after
  clamping — so two runs of an experiment that varies only effort no longer have
  indistinguishable span identities. `flow.thinking_level_verified` says whether
  that level was checked against the model it runs on, which is impossible for a
  child naming no model, since pi's configured default is not readable here.
- `/flows models` shows what each tier currently resolves to and why, and pins a
  tier interactively. Overrides persist to `~/.pi/agent/pi-flows.json`, or
  `.pi/pi-flows.json` for a trusted project — an untrusted project's file is
  ignored, since choosing the model also chooses which vendor sees the task.
  `flow showConfig:true` reports the same roster with its rationale.
  `PI_FLOWS_FAST_MODEL` / `PI_FLOWS_DEEP_MODEL` continue to work, outranked by
  the config file.
- A workflow approval is refused when the work it gates names no model, no tier,
  and runs an agent declaring neither. Such a step executes pi's configured
  default, which an extension cannot read and which can change before a resume —
  so the receipt would verify while authorizing work on a model the approver
  never saw. `WORKFLOW_INVALID` names the steps and the fix, in the same spirit
  as `BUDGET_UNOBSERVABLE`.
- A gated workflow phase's approval receipt now binds what that phase will
  actually *run as* — the concrete model and thinking level, resolved through the
  same path dispatch uses — for the gated phases and for a gated debrief.
  Previously only the phase's own `model`/`tier` were bound, so a workflow
  approved under one flow-level model could be resumed under another. Binding the
  tier *name* would not have been enough either: `deep` is a question, not an
  answer, so a roster override or a registry change between approval and resume
  could leave the same word selecting a different model, vendor, and effort while
  the receipt still verified. Changing any of it now invalidates the receipt.
- Bundled agents declare thinking levels where their effort profile is fixed:
  `recon` and `controller` at `low`, `strategist` at `high`, `redteam` at `max`.
  `analyst`, `operator`, `overwatch`, `commander`, and `debrief` inherit the
  parent session's level instead of pinning one.

- `npm run score:domain` scores the domain model, and CI posts it on every PR.
  The structural half — module classification, subdomain import direction, naming, and
  foreign-package containment — is re-derived from the tree on every run and is
  part of `npm run check`, so a regression fails the build. The half no check can
  settle (aggregate design, behavior-rich objects, language consistency) is
  carried from `docs/domain-review.json` and reported with the date it was
  taken; touching a Core module without re-recording the review marks those
  rows stale and drops them from the verified score rather than repeating them as
  fact. The subdomain table is parsed out of `CONTEXT.md` itself, so the classification
  a reader sees and the rule the build enforces cannot drift apart.

### Fixed

- A budget stop now reports the ceiling that actually caused it. Two problems,
  both in how the refusal was attributed after the fact. The decision to
  terminate was held as two flags plus a separate budget reference, and a model
  turn arriving between `terminate()` and the child exiting could rebind that
  reference while the flags stayed latched — so the refusal could be attributed
  to the wrong budget, or to none. Separately, the error was built only once the
  process had exited, from spend that kept accumulating in the meantime, so on a
  budget with several ceilings a limit crossed *after* the stop could out-rank
  the one that caused it and be named as the cause. The stop is now a single
  value carrying the error, frozen at the moment it was decided. Which ceilings
  bind is unchanged.
- The F8 fleet panel now renders a `$0` cost ceiling instead of hiding it. A
  falsy check read a zero ceiling as "no ceiling configured", so the one budget
  that refuses every run was also the one that showed no burn-down bar.
- Flow budget scope is now stated correctly. The `maxCostUsd` / `maxTokens` /
  `maxGeneratedTokens` tool descriptions, README, the flow reference, and the
  patterns guide said the ceiling covered "the whole flow tree"; it bounds one flow
  call. No budget state crosses the process boundary, so a nested flow a child
  starts is bounded only by the ceilings that call sets — and is uncapped when it
  sets none, which is the default. No enforcement behavior changed.

### Changed

- **Breaking (type surface).** A budget is now an object that owns its own rule.
  The removed names below were importable from `extensions/pi-flows/types.ts`,
  which ships in the package, so a downstream import of any of them must be
  updated; the commit carries `!`. `Budget.forFlow()` /
  `Budget.forContract()` replace the mutable `FlowBudget` / `ContractBudget` /
  `BudgetUsageState` records and the free functions over them (`chargeBudget`,
  `budgetExceeded`, `activeBudgetExceeded`, `budgetExceededError`,
  `budgetUnobservableError`, all removed from the `types.ts` re-export surface and
  from `__test`). Ceilings are fixed at construction, spend moves only through
  `charge()`, and views read `snapshot()` instead of the live record. **Budget
  authority** is carried by the budget rather than re-derived at six call sites by
  comparing object identity against the contract budget, so a contract-bound
  refusal cannot be reported as a flow-budget one; `budgetAttributes()` now takes
  its span prefix from the snapshot's authority instead of a caller-passed string.
  Which ceilings stop a live run (`stopsLiveRun()`) versus gate the next
  spawn (`refusesSpawn()`) is stated once, on the budget. No enforcement behavior
  changed: a flow's total-token ceiling remains a between-run spawn gate and a
  contract's still stops the live run.
- `CONTEXT.md` opens with a domain vision statement and a Core / Supporting /
  Generic split, so the modules that carry the guardrail invariants are named
  as the ones that earn deep modeling — and the plumbing is named as plumbing.
- Domain glossary alignment, continued: the live-flow registry keyed *flows* while
  naming them runs. `FlowRunRegistry`/`LiveFlowRun`/`activeRuns()`/
  `lastFinishedRun()`/`finish()` are now `FlowRegistry`/`LiveFlow`/`activeFlows()`/
  `lastSettledFlow()`/`settle()`, and the F8 fleet panel says "no live flows ·
  last flow:" and "No flows yet in this session". These names were not part of the
  package's public export surface; the persisted `pi-flows.run` entry name remains
  compatible.
- `CONTEXT.md` defines **Flow tree**, **Live**, **Replay**, **Budget ceiling**,
  **Budget authority**, **Capture policy**, **Handoff policy**, and **Compositional
  injection**. **Flow** now says what a flow owns beyond its runs, **Run** says a
  flow contains zero or more runs (a flow refused before spawning has none), and
  **Fleet** is keyed by flow rather than by executing run.

## 0.5.0 - 2026-07-31

### Changed

- Model-in-the-loop evals now standardize on Codex for both axes:
  `openai-codex/gpt-5.4-mini` as the subject and
  `openai-codex/gpt-5.5` as the independent judge. Release evals no longer
  depend on Anthropic OAuth.
- Release evidence now uses an explicit behavior/regression suite. Hard
  multi-part cases remain internal score tracks, matching the harness policy
  instead of requiring stochastic perfect scores in the strict manifest.
- Domain glossary alignment: the durable session entry is now the **Flow card**
  (it summarizes a flow, not a single run), monitoring language names runs
  rather than agents, and `CONTEXT.md` defines **Fleet**, **Settled**,
  **Delegation contract**, **Return requirements**, **Return envelope**,
  **Handoff**, **Handoff envelope**, **Execution success**,
  **Verified outcome success**, **Approval receipt**, **Flow budget**, and
  **Contract budget**. Runtime budget errors now identify whether the flow or
  delegation contract owns the exhausted ceiling. The existing `returnContract`
  JSON field remains compatible but now emits a **Return requirements** section,
  with `appendReturnContract` retained as an alias for
  `appendReturnRequirements`. Route traces use the canonical `selected` unit key
  instead of `specialist`. Other existing JSON fields and the persisted
  `pi-flows.run` entry name remain compatible.
- `CONTEXT.md` now ships in the package, because README and the flow reference
  point at its term definitions instead of restating them.

### Fixed

- Live evaluation cases now carry an eval-owned delegation justification, so
  the release gate reaches its subject model instead of being refused by the
  required `why` spawning boundary.
- The evidence-heavy regional-writes debate case now budgets enough time for
  both advocate rounds and adjudication instead of aborting the adjudicator at
  the former 600-second whole-case ceiling.
- Generated Flow and delegation-contract cost/token ceilings are now disclosed
  before work starts and retained in the collapsed live row, fleet panel, and
  durable Flow card. Each line names `flow` or `contract` as its authority;
  identical contract ceilings are collapsed, timeout-only contracts do not
  masquerade as cost/token caps, and omitted ceilings remain uncapped.
- Non-retryable failures now expose `Retryable unchanged: no` in the
  model-visible error text instead of keeping that fact only in structured
  details. `BUDGET_EXCEEDED` explicitly forbids automatic replay of the same
  Flow: the parent must preserve the configured ceiling unless the user
  explicitly approves changing it, then ask for direction or materially narrow
  the task or fan-out before starting another Flow.
- Live flows no longer repeat progress across the inline tool row, footer
  status, and above-editor widget. The inline row is now the single primary
  detailed view; the obsolete secondary surfaces are explicitly cleared so
  stale progress cannot linger.
- The live progress counter says what it counts. A fan-out header rendered a
  bare `settled/total`, so `0/2` read as "no runs started" and `2/2` read as
  "both runs succeeded" even when both failed with `BUDGET_EXCEEDED`. While any
  run is outstanding every surface now renders `0/2 settled`; once the flow has
  settled the ratio gives way to the verdict (`2 failed`, `2 ok`). The live tool
  row and fleet panel both take that text from one new exported helper,
  `flowProgressText(details, options)`, so they cannot drift apart again. A
  verdict now waits for the *flow* to settle rather than for the runs it has
  spawned so far: between the stages of a multi-stage mode — after `evaluate`'s
  generator returns, before its check command and critic panel — the header
  holds `2/2 settled` and its spinner instead of claiming `2 ok`. Single-run
  flows keep their bare board headers, and a flow-level error remains a separate
  signal on both boards.

## 0.4.2 - 2026-07-29

### Changed

- Single-child flow runs no longer render a `0/1` done/total counter, progress
  bar, or token rollup in the live tool-row and fleet-panel headers. With one
  agent those only restated the agent line below and `0/1` read as "stuck",
  not as progress; fan-outs (2+ children) keep the counter and bar.

## 0.4.1 - 2026-07-29

### Fixed

- The extension failed to load on a stock `pi` install (`Cannot find module
  '.../typebox/build/index.mjs/schema'`): pi's extension loader aliases only
  `typebox`, `typebox/compile`, and `typebox/value`, and rewrites any other
  subpath against the package main entry. `delegation.ts` now imports `Compile`
  from `typebox/compile` instead of `typebox/schema` (identical validation
  behavior), and a new test pins every packaged bare import to pi's alias
  table so unaliased subpaths cannot ship again.

## 0.4.0 - 2026-07-29

### Added

- The `flow` tool row is now a live dashboard while children run: per-agent
  state with an animated spinner, each running child's current tool call or
  latest message, a progress bar, and a token/cost rollup, updating in place
  until the run settles (`extensions/pi-flows/ui-live-row.ts`).
- `F8` now toggles a non-modal fleet panel overlay showing every live flow run
  at once — per-agent state and activity, failures, and budget burn-down when
  `maxCostUsd` is set — without taking keyboard focus from the editor
  (`extensions/pi-flows/fleet-panel.ts`). `/flows inspect` remains the focused
  single-child drill-down.
- Every settled run now renders a durable run-card from the persisted
  `pi-flows.run` session entry: status, per-agent duration bars, cost rollup,
  failure codes, and the trace pointer — re-rendered after session reloads
  (`extensions/pi-flows/ui-run-card.ts`). The entry additively gains a
  `trace: { traceFile, health }` field.

- Release decisions can now be emitted as deterministic
  `pi-flows.release-manifest.v1` records. The manifest pins the code commit,
  package/extension/lock versions, subject and judge model identifiers, prompt
  and tool-schema hashes, topology, budgets, environment, suite, harness,
  grader, calibration key, runtime trace, and source artifacts. It fails closed
  on dirty code, incomplete traces, incomplete or non-authoritative calibration,
  missing promoted regressions, and explicit hard blockers for unauthorized
  irreversible actions, approval bypass, secret or personal-data leakage,
  corrupted shared state, rollback failure, and trace loss.
- Validated production failures can be imported through a privacy-minimizing,
  allowlisted format into a `0600` hash-chained event ledger. Their minimized
  initial state and exact runtime-trace linkage become executable capability
  cases under `npm run eval -- --failure-ledger=...`; promotion to regression
  requires at least three distinct, passing, policy-compliant, fully traced
  held-out repetitions from one explicit run cohort and code revision, and every
  import, trial, denial, or approval is append-only. Older failed cohorts remain
  auditable without permanently poisoning a later fixed cohort. Import verifies
  the production trace digest and root identity; promotion accepts only a
  dedicated held-out run with independently resolved runtime roots. Release
  records bind operator attestations to evaluation-time models, topology,
  budgets, environment, and repository hashes, and reject empty or untyped
  hard-blocker references. Release evals isolate package-owned prompts, bind the
  actual grader version and calibration gate decision, and require the canonical
  failure ledger so promoted regressions cannot be omitted. Reliability binds
  its ledger head and imported cases, held-out trials retain the trace digest and
  reject duplicate identities, release traces pass structural read-back, and
  calibration keys are complete and self-verifying. Production traces now pass
  that structural gate too; promotion evidence is bound to its prior import,
  operator-authenticated reliability HMAC, judged-run artifact, calibration
  artifact, and one runtime-trace digest. Release recomputes calibration authority and
  gate issues, rejects duplicated trials/imports and skeletal calibration, and
  cross-checks validated artifact hashes.

- Inter-agent injection handling is now an enforceable, flow-scoped policy.
  `handoffPolicy` supports compatibility-preserving `warn`, payload-withholding
  `quarantine`, and `fail` before the recipient process spawns;
  `modeHandoffPolicy` declares non-downgradable per-mode minimums for
  high-consequence flows and workflow approval receipts bind the resolved
  policy. Bounded cross-handoff state detects conjunctive attacks assembled from
  individually benign fragments. The deterministic fault manifest now covers
  malicious child output, retrieved content, poisoned routing metadata,
  repeated poisoned consensus, and multi-boundary composition. Its
  ground-truth portfolio report keeps benign utility, attack success,
  propagation, containment, sensitive exposure, and false-positive block rates
  separate; runtime traces record enforcement facts without pretending scanner
  labels are outcome truth. New structured error:
  `HANDOFF_POLICY_VIOLATION`.

- A deterministic, model-free coordination fault-injection suite runs offline in
  `npm test`, so failures a live run reproduces once a month are reproduced on
  every check. A reusable adapter over the child-run seam (`ModeDeps.runChild`)
  injects delay, loss, duplication, reordering, failure, and staleness without
  spawning anything; latency is virtual, so a 90-second child costs the suite
  nothing and still hits its ceiling. Scenarios cover corrupted artifacts,
  persuasive-but-wrong children, stale and reordered responses, trace
  suppression, exhausted budgets, shared-writer races, and partial integration
  followed by a retry. Each declares four independent checks — outcome, process,
  policy, residual state — because a run that returns the right refusal after
  merging the bad work is not contained. Benign controls run through the same
  harness, so false containment stays measurable, and every case carries explicit
  attack-opportunity and benign-opportunity denominators: containment is reported
  as rates over what the scenarios actually did, including explicit attack and
  benign-control opportunities, instead of as a pile of passing assertions. The
  one uncontained case, a replayed untyped ballot that nothing in that path can
  distinguish from independent agreement, is kept in the suite rather than
  dropped from it.

- Coordination traces now capture the boundaries a delegated run actually
  crosses, instead of flattening every child under one root span. Spans declare a
  role (`root`, `stage`, `child`, `event`): children nest under the wave, round,
  iteration, fan-out group, or workflow phase that scheduled them, and
  dependencies are recorded as links (`flow.depends_on`,
  `flow.depends_on_span_ids`) rather than as invented parentage — a graph node
  that read another node's output was scheduled by its wave, not spawned by the
  node it read. Child spans identify the authority they ran under:
  `flow.agent_prompt_version` (a digest of the system prompt that actually ran),
  `flow.allowed_tools`, `flow.authority_may` / `_must_not` / `_requires_approval`,
  `flow.side_effect_class`, `flow.contract_id`, `flow.return_schema_digest`,
  `flow.constraint_ids`, `flow.delegation_reason`, and post-run budget state. The
  free-text halves of that identity (delegation reason, contract owner, authority
  prose, artifact paths) follow `recordContent`, so a content-free trace still
  tells two contracts apart by digest without recording what they said.
  Boundaries that are not child runs — approvals, workflow state transitions,
  retries and revision rounds, budget refusals, deterministic gates, validation
  results, handoffs, and artifact references — become their own attributable
  zero-duration event spans (`flow.event_kind`). Handoff events record filtering,
  raw-vs-carried size, injection warnings, preserved constraint identifiers,
  acceptance status, and artifact references, with the summary prose and envelope
  `data` deliberately left out; constraint identifiers are content digests, so
  preservation across hops is checkable without copying the constraint text.
  Event attributes carry operator- and repo-supplied strings (an approval actor,
  a phase id, a branch name), so they are redacted and capped like every other
  recorded value even though they are identity rather than content.
- Trace health is now reported as evidence in its own right. The root span
  accounts for the export (`flow.trace.expected_spans`, `.observed_spans`,
  `.dropped_spans`, `.redacted_spans`, `.failed_exports`, `.health`), the same
  counters return on `details.trace.spans`, and reading a trace back compares the
  declared expectation against the rows present — counted by unique span id, so a
  pipeline that loses one span and duplicates another cannot pass a row-count
  check, and a duplicate is itself reported as corruption. `/flows report` and
  `npm run trace:report` print observed-vs-expected spans, drops, redactions,
  failed exports, incomplete runs, and a stage/event topology line. Health is
  kept separate from execution success on purpose: a run whose spans were dropped
  is unauditable, not failed, and conflating the two would turn an exporter
  hiccup into a phantom agent regression.
- Strict tracing (`traceStrict`, `PI_FLOWS_TRACE_STRICT`) makes trace evidence a
  gate for evaluation and release runs: a missing trace file is refused before
  any child spawns, and an incomplete export fails the call with the new
  `TRACE_INCOMPLETE` error code. Default user flows are unchanged — tracing stays
  best-effort and never fails a flow. The eval harness gained the matching
  `npm run eval -- --strict-trace`, backed by a `traceHealth` rollup in the
  reliability artifact that is reported as its own score family, and
  `npm run trace:report -- --strict` exits non-zero on incomplete evidence. The
  gate applies on the `--trace-only` path too: judging is the driver's call
  there, but evidence is not.

- Workflow approvals are now durable, single-use receipts instead of a bare
  `APPROVED` marker in the resume state. A receipt binds the exact action it
  authorizes — the approval phase and the work phases it gates, at their
  effective parameters after flow-level fallbacks, plus `agentScope` and
  `incompleteHandoffPolicy` — along with the requesting and approving actors, the
  workflow digest, the state schema version, an issue time, and an expiry, plus
  the debrief's resolved parameters when the approval gates the workflow's tail
  (`workflow.approvalTtlMs`, 24h by default). Receipts are re-verified against the
  live spec immediately before the gated action runs and spent once it has run, so
  a crash-resume re-uses consent it already had while a different action is
  refused as a replay. Headless workflows still fail closed. New error codes:
  `APPROVAL_RECEIPT_INVALID`, `APPROVAL_RECEIPT_STALE`, `APPROVAL_RECEIPT_EXPIRED`,
  `APPROVAL_RECEIPT_CONSUMED`. Receipt identity and status reach
  `details.approvals`, the final answer, and the trace root span
  (`flow.approval_receipt_ids`, `flow.approval_receipt_count`,
  `flow.approval_consumed_count`, `flow.approval_blocked`) without exposing the
  approved parameters. Version-2 workflow state migrates to
  `legacy-compatibility` receipts that still bind the gated action. A completed
  approval whose receipt lapsed or was superseded reopens and asks again rather
  than stranding the state file; a consumed or malformed receipt, or a gated run
  that already part-executed, stays a hard refusal. Every recorded
  field is additionally covered by a `receiptDigest`, so a partial write or a tool
  that rewrites one field is caught rather than honoured.
- Judge calibration is now evidence a release decision can rest on. Every run
  writes a versioned `pi-flows.calibration.v1` report with per-dimension coverage,
  truth-class x decision confusion matrices, per-class precision/recall,
  false-positive and false-negative rates, and Wilson 95% bounds on each. A
  dimension is authoritative only with three independent *decided* failed labels
  plus passed and partial examples and an abstention rate under 25% — repeat
  trials of one case collapse to one observation (disagreeing trials collapse to
  an abstention), and an abstention never counts as coverage. Only the
  `calibration` and `held-out` splits count toward that authority, so cases the
  rubric was tuned against are reported but never gate, and the gate reads the
  95% upper bound on missed defects rather than the point estimate — zero misses
  out of four is not evidence of a zero miss rate.
  `criterion` is critical **by default** — gating a release on a judge whose
  accuracy nothing checks was the hole this closes — and a critical dimension
  that falls short blocks the release gate and refuses `--write-baseline`. The
  calibration canary set gains known-GOOD and additional known-bad fixtures so
  the default is satisfiable: it previously held no positive example at all, so a
  judge that failed everything scored perfectly on defect detection. Name other
  dimensions, or opt out, with `--critical-dimension` (`=none` to report without
  gating). Judge verdicts within
  `--abstention-band` of the decision boundary abstain and escalate to human review
  instead of voting. Cases are versioned in separately-digested
  `rubric-development`, `calibration`, and `held-out` splits, validated in
  preflight before any model runs. A calibration key over the judge, prompt,
  config, rubric text, thresholds, and trace-attribute shape invalidates a prior
  calibration automatically and names what changed.
- `npm run eval:review` records blinded independent labels, per-dimension
  verdicts, reviewer identity, and adjudications to an extended
  `pi-flows.review-set.v1` set alongside thulr's. Unanimous blinded reviewers
  resolve a case — two distinct blinded reviewers must agree, since a resolved
  human label overrides the deterministic objective — disagreements need an
  adjudicator, an unadjudicated disagreement stays unresolved rather than being
  settled by whoever labeled last, and two adjudicators who disagree leave the
  case unresolved rather than letting record order pick a winner. Named-dimension
  verdicts stay in the extended set, since thulr's review store is dimensionless.
  Inter-reviewer agreement is reported as observed/expected agreement and Fleiss
  kappa.
- Parallel, orchestrate, graph, workflow, worktree, vote, debate, and dossier
  now validate typed return envelopes before every dependent dispatch,
  synthesis, persistence, or merge. Stable contract identities reject missing
  and stale returns; partial/blocked statuses fail closed unless explicitly
  included, while failed handoffs remain terminal; provenance-bearing
  compatibility envelopes keep legacy prose callers working. Typed verifier
  verdicts are read from validated envelope data. Worktree conflict resolution
  receives the validated evidence/artifact provenance from both sides of the
  merge, and rejected worker handoffs return the retained branch/worktree
  recovery locations. Workflow resume verifies policy-safe handoff attestations
  before downstream reuse while retaining included incomplete provenance in
  its final header. Version-1 workflow state migrates to version-2 compatibility
  envelopes.
- Eval outputs now link stable run/case/trial/arm identities to the exact
  runtime trace and root span. Single-arm reliability and paired-comparison
  artifacts retain trace-health evidence plus separate execution,
  verified-outcome, and policy-compliance score families; missing trace
  telemetry no longer masquerades as an agent failure. Dry runs use separate
  runtime trace files so mock spans cannot truncate real-run diagnostics, and
  typed verifier verdicts remain consistent between results and root trace
  summaries. Trace context, paths, and write failures follow the same redaction
  and bounding policy as other returned details.
- `flow` now accepts a typed delegation `contract` in single, chain, and
  evaluate paths. Children return a validated, usage-enriched
  `pi-flows.return-envelope.v1`; JSON Schema, artifact path, and SHA-256 digest
  failures return structured fail-closed errors before downstream consumption.
  Existing prose `task`, `returnContract`, and `requireEvidence` calls are
  unchanged.
- `eval:compare -- --arms=<reference>,<candidate>` now selects named architecture
  controls and ablations for compute-matched self-review, deterministic
  workflow, no-communication ensembles, random/oracle routing, integrator and
  verifier removal, context scope, and sequential/parallel execution. Artifacts
  record topology/configuration identity, explicit inapplicability, component
  lift, and bounded per-case evidence.
- The single-arm eval runner now accepts `--trials=N` (maximum 50) to repeat the
  stochastic subject case in clean per-trial workspaces, independently of
  `--samples` judge-noise sampling. It writes an auditable raw reliability
  artifact with stable case/unique trial ids, per-trial outcomes and telemetry,
  pass@1/pass@k/pass^k, Wilson intervals, supported p50/p95 latency and cost, and
  an infrastructure-invalid-as-failure sensitivity view.
- `eval:compare` now runs paired repeated trials from one immutable workspace
  snapshot per case/trial and declares exactly one binding cost, generated-token,
  or deadline constraint. Its raw JSON artifact retains every arm outcome and
  suite/task-family slice, while the terminal and artifact report case-clustered
  paired deltas with 95% Student-t intervals, a case-clustered exact reliability
  sign test, separate cost/token/end-to-end/worker-time/invalid-run metrics, and
  predeclared improvement or non-inferiority promotion margins. Arm order is
  counterbalanced across case/trial pairs.
- Flow budgets now accept `maxGeneratedTokens` for an output-only ceiling.
  Cost and generated-token budgets stop children at completed model-response
  accounting boundaries, which lets paired evaluations apply the same active
  resource constraint to treatment and plain-Pi control arms. The existing
  total-token budget remains a between-child spawn gate. Cost ceilings fail
  closed with `BUDGET_UNOBSERVABLE` when a provider omits cost telemetry.

### Changed

- Flow root traces and `/flows report` now separate end-to-end elapsed time,
  accumulated worker time, and available critical-path latency. Reports call
  clean process completion execution success and only report verified outcome
  success/TPSO when a verifier supplied a verdict. Legacy
  `flow.duration_ms_total` traces remain readable and are labeled compatibility
  data.
- Contract identity is now checked at every contracted seam, not only the
  integration adapter. `chain`, `evaluate`, and `single` previously accepted a
  structurally valid envelope carrying a missing or stale `contractId`; such an
  envelope is now refused with `RETURN_CONTRACT_MISMATCH` rather than being
  passed downstream, judged by critics, or reported as a validated result for a
  contract it never claimed. The check is unconditional — it used to be an
  opt-in flag that three of its four call sites did not pass.

### Fixed

- Paired evaluation now excludes arms stopped at an exact cost or generated-token
  ceiling from quality judging, while retaining finite resource observations
  from constraint-invalid and infrastructure-invalid pairs in efficiency deltas.
- Paired infrastructure retries now restore the immutable arm workspace, remain
  inside one outer deadline, and include every attempt in latency/worker totals.
  Aggregate cost output also suppresses treatment or baseline values whose price
  telemetry is unknown.
- Eval, comparison, selection, and dry-run commands now reject malformed corpus
  metadata and stale source-backed expectations before model invocation. Every
  case declares a portfolio suite, task family, and task structure; reports show
  case counts and exclusions across both classifications. The package-version
  selection fixture now expects the current `0.3.0` package value.
- The trace gate no longer treats a corrupted attribute as an absent one. A
  rewritten `flow.trace.expected_spans` read as "not a modern trace" and
  exempted the whole file from the role, parent, dependency, and timing checks;
  a rewritten `flow.depends_on_count` read as "no count written" and let the
  fallback rebuild the number out of the very keys it was meant to check.
  Presence and readability are now separate questions, and a stated value
  nothing can read invalidates the trace.
- Author-supplied identifiers — graph node ids, workflow phase ids, worktree
  task ids — are escaped before becoming unit keys, so they cannot collide with
  the keys the framework derives. A node named `source.handoff` used to answer
  to the same key as node `source`'s handoff event, and a dependency on
  `source` resolved to whichever registered first.
- `parallel` validates its children's returns but no longer records handoff
  events for them. Its outputs go into the response the caller reads and it
  spawns nothing that consumes them, so there was no boundary to record — and
  the bytes were measured on a handoff envelope the response never carried.
  Validation still fails closed; only the evidence is withheld.
- `evaluate` records a handoff only where one was crossed. A failed check on the
  final iteration ends the run, so neither the artifact nor the check output
  reaches another agent; a critic REVISE on the final iteration returns to the
  caller, not to a generator. All three used to be recorded as accepted
  inter-agent handoffs with carried-byte accounting.
- An `evaluate` revision now links the artifact handoff it revises alongside the
  feedback that sent it back, since its prompt carries both.
- The trace gate no longer accepts a shortened dependency key list as capping.
  Capping is the only thing that legitimately shortens one, so the writer now
  marks it (`flow.depends_on_truncated`); an unmarked short list is erasure and
  invalidates the trace, and a whole list that claims truncation does too.
  Truncation now exempts only the final key, which the cap may have cut
  mid-key — every key it left intact is still matched to its span id. The flag
  describes the list as written, after redaction, so a secret-shaped author id
  that redaction shortens back under the cap is not reported as truncated.
- A failing `evaluate.checkCommand`'s output is now prepared like any other
  handoff before it reaches the next generator: capped, stripped of invisible
  characters, and injection-scanned, with the boundary recorded — and recorded
  only when another iteration will read it. Command output can carry whatever
  the command read, so pasting it into a prompt unchecked made the deterministic
  gate the one unscanned path into an agent.
- Fan-out handoff and artifact events are now attributable to the child that
  produced them. The merged span placement reached only the child dispatch, so
  acceptance — which runs after the fan-out returns and reads the item's own
  scope — placed those events without a stage, and for `parallel`, without a key
  or a producer link at all.
- An orchestrate revision now links every handoff its prompt carries: the worker
  findings and the prior answer alongside the verifier critique, rather than the
  critique alone.
- Workflow phases now link the handoff their consumers actually read, so a
  following phase and the debrief depend on the `<phase>.work.handoff` event
  rather than on the child span behind it, and the exported causal path runs
  through the validation and byte accounting the text went through.
- An orchestrate resynthesis now carries the accepted handoff of the prior
  answer instead of raw sanitized output, so the retry prompt matches the
  handoff evidence recorded for it and does not skip the injection scan.
- A typed envelope refused as `partial` or `blocked` now records the artifacts
  it claimed. The rejection previously dropped the envelope's artifact
  references and digests, so the trace showed the refusal without showing what
  state the child had already touched.
- A child that reports a terminal provider error (for example "input exceeds
  the context window of this model") and then stalls no longer hangs the flow
  until `timeoutMs` (default 10 hours): pi-flows now terminates the child after
  a short grace period (`PI_FLOWS_ERROR_GRACE_MS`, default 30s) and returns a
  structured `CHILD_PROVIDER_ERROR` with the provider message, retaining the
  usage already spent.

### Changed

- The supported pi host floor moved from `0.78.0` to `0.82.0`, in `engines.pi`,
  the four `@earendil-works/pi-*` peer ranges, `scripts/check-pi.mjs`, and the
  prerequisite lists in `README.md`, `docs/quickstart.md`, and
  `docs/troubleshooting.md`. The lockfile now resolves every pi package to a
  single `0.82.1`; previously `pi-coding-agent` resolved to `0.82.1` while
  `pi-agent-core`, `pi-ai`, and `pi-tui` stayed at `0.78.0` at the top level, so
  the build typechecked against two pi versions at once. Installs on a pi host
  older than `0.82.0` are no longer supported.
- `npm run preflight` now enforces the pi version floor instead of only checking
  that the binary exists. It reads the floor from `engines.pi` rather than
  restating it, names the executable and version it found alongside the one it
  needs, and treats a prerelease as below the release it precedes. A
  `pi --version` banner with no readable version warns rather than fails, since
  pi answering at all is not evidence of an unsupported host. The check resolves
  `pi` the way your shell would, skipping the `node_modules/.bin` directories npm
  injects while running a script — this checkout's and its ancestors', matched by
  canonical path, not by basename, so a `node_modules/.bin` you exported yourself
  still counts. In a clone npm's copy is the pi-coding-agent peer dependency, so
  validating it would green-light a host that the documented
  `pi -e ./extensions/pi-flows/index.ts` never runs.
- The Codex control arm reads model pricing through `getBuiltinModel` from
  `@earendil-works/pi-ai/providers/all`. pi-ai `0.82` removed `getModel` from
  the package root (it survives only as a deprecated alias on the `/compat`
  subpath), which broke `evals/baseline-codex.mjs` at import time.

## 0.3.0 - 2026-07-25

### Added

- Added an `F8` / `/flows inspect` TUI overlay for watching a running child agent.
- Added a `deep` capability tier (mapped via `PI_FLOWS_DEEP_MODEL`, falling back
  to the default pi model) alongside `fast` and `capable`, and a per-call `tier`
  parameter on tasks, phases, roles, and the flow level so the parent model can
  pick capability by task nature without hard-coding vendor model ids.
  Resolution order: flow-call `model` > flow-call `tier` > agent `model` pin >
  agent `tier` > pi default. Bundled `redteam` and `strategist` now declare
  `tier: deep`; `flow showConfig:true` surfaces the effective tier mappings.
- Added hard-negative selection eval cases (plausible-sounding tasks with no
  "do not delegate" hint) to `eval:select`, un-saturating the no-flow axis.

### Changed

- Increased the default per-child `timeoutMs` from 10 minutes to 10 hours.
  Explicit per-flow timeout values still override the default.
- Rewrote the `flow` tool's model-facing trigger surface (description, prompt
  snippet, and guidelines) around a positive decision rule — work directly by
  default; spawn only for explicit delegation requests, fan-out one context
  cannot hold, or author-independent verification — with the child-process cost
  stated up front and the mode catalog moved out of the description.
- Spawning `flow` calls now require a `why` parameter (one-sentence delegation
  justification). Calls without it are refused with the new `WHY_REQUIRED`
  error before any child spawns; `list`/`showConfig` are exempt. This is
  deliberate structural friction against reflexive delegation.
- `reflexion` now applies flow-wide at the dispatch core: recent lessons are
  appended to the top-level `task` for every mode, and a redacted lesson is
  recorded from the final output of any run that spawned at least one child.
  Previously only a subset of modes read or wrote lessons, inconsistently.
- `concurrency` is validated once at dispatch for every mode; an out-of-range
  value is refused (`INVALID_CONCURRENCY`) even in modes that run sequentially
  and previously ignored it.
- Internal seams deepened (no contract change): mode handlers spawn children
  through an injectable `ModeDeps.runChild` seam, the mode surface (handler
  table, detection, labels, tool prose) derives from the single table in
  `modes/contract.ts`, and one shared JSONL child-process protocol module backs
  both the extension runner and the eval baselines.

### Fixed

- `details.results` now retains every child run that completed before a
  mid-flow error, so the session ledger, trace `ok`, and inspector report real
  usage and cost instead of zero after failures such as `GRAPH_CYCLE` or
  `CHECK_COMMAND_FAILED`.
- `npm run pack:dry-run` now resolves every relative import reachable from the
  packaged extension sources and fails when an imported file is missing from
  the tarball (the new `.mjs` protocol module is packaged via an added `files`
  glob).

## 0.2.0 - 2026-07-17

### Added

- Five bounded flow modes: `workflow` for persisted phase gates and resumable
  approvals; `worktree` for isolated writers plus a durable verified integration
  branch; `debate` for bounded advocates and independent adjudication; `dossier`
  for source-specific evidence extraction and conflict-preserving synthesis; and
  `monitor` for bounded deterministic polling followed by one reactor agent.
- New-mode eval coverage: source-grounded train/holdout cases for all five modes,
  plus selection controls that keep tiny edits, one-shot commands, quick
  comparisons, and single-source lookups on the no-flow side of the activation
  threshold.

### Changed

- Evals: `eval:compare` now defaults to a direct Codex baseline, with
  `--baseline=pi` available for plain headless Pi. Pattern A/B cases use the same
  user task, subject model, timeout, and equivalent isolated workspace in both
  arms; model mismatches and one-sided infra/debug-budget runs are inconclusive,
  and only comparable pairs contribute to quality lift. `--duel` supplies an
  order-controlled signal when absolute rubric scores are saturated.
- Evals: emit thulr's richer trace metadata (`thulr.expected_behavior`,
  `thulr.failure_modes`, `thulr.config_version`, `thulr.task.input`, and
  zero-valued cost/token metrics), inspect traces before paid judging, feed
  `thulr label-failures` into calibration, and support `--eval-set`,
  `--redaction`, `--rate`, and repeatable `--efficiency-guardrail=<metric>` in
  the thulr-backed eval harness. The harness now lets thulr use its embedded
  judge runtime by default and only passes a judge wrapper when `--judge-bin` or
  `THULR_JUDGE_BIN` is explicit. The provider-error detector no longer treats
  ordinary security-review mentions of API keys, authentication gaps, or missing
  signature checks as provider auth failures. The `recon-retrieves-known-value`
  fixture now asks for
  `SAMPLE_IDENTIFIER=xyzzy-42` instead of token-shaped wording, and its judge
  criterion accepts the exact terse answer `xyzzy-42`, matching the task's
  "report exactly that value" instruction. The suite now appends fixed
  calibration canaries (wrong and partial answers) to every thulr trace so TNR
  has negative/mid-score signal; the full judged EvalRun keeps them for
  calibration while the release gate uses a filtered candidate. The terminal
  summary now prints thulr's numeric score, pass-rate, and efficiency deltas from
  `thulr gate --json` before the human gate report, and `--noise-band=<n>` makes
  guardrail tolerance explicit.
- Evals: adopt thulr 0.1.3. `npm run eval:compare -- --pairwise` now runs thulr's
  calibrated, position-swapped **`duel`** (relative win-rate judging, flips reported
  as judge position bias) over one self-contained trace per arm, replacing the
  harness's hand-rolled in-process pairwise judge. `npm run eval:review` records
  human SME verdicts and `npm run eval` folds them into calibration as a second
  ground-truth axis (`--reviews`; judge-vs-human TPR/TNR), auto-discovering
  `.thulr/reviews/<trace>.reviews.json`. `npm run eval:pareto` ranks failure modes
  across stored traces (which failure on which prompt/config version to fix first).
  Calibration also surfaces thulr 0.1.3's judge-trust gate: a judge blind in either
  direction downgrades a clean gate PASS to WARN.
- Vote/orchestrate quality: same-agent/model voters now receive complementary
  stances so ballots are not identical prompt replays, and orchestrate workers
  now see the overall goal/contract alongside their assigned subtask before
  synthesis.
- Recon quality: debugging and code-review delegations now tell `recon` not to
  stop at the first plausible issue and to check common production-correctness
  classes such as initialization/null guards, validation, auth/signature,
  idempotency/retry behavior, cleanup, error handling, and boundary cases.
- Runtime isolation: `PI_FLOWS_CHILD_NO_EXTENSIONS=1` makes spawned child agents
  pass `--no-extensions`, useful for eval runs or local setups where an installed
  user pi extension breaks child startup.
- Evals: `eval:compare` now prints per-arm child progress, and both eval CLIs
  support `--arm-timeout=<ms>` for smoke/debug loops. Runs that use a shorter
  clock than a case's declared budget are tagged as debug-budget/inconclusive
  and excluded from quality verdicts; real A/B measurement keeps both arms on
  the same subject model and lets per-case `timeoutMs` apply.
- Evals: A/B quality summaries now exclude timeout/infra arms and their paired
  counterpart from thulr traces instead of scoring timeout envelopes as failed
  answers. Artifacts retain the exclusion reason, spend, input/output/cache/total
  token usage, and wall-clock so infra can be debugged without polluting
  quality-lift reads. The direct Codex adapter normalizes cached input to Pi's
  usage contract and estimates cost from the same model-price table as the flows
  arm, making token and estimated-cost ratios comparable.
- Evals: simple answer-only quality cases are now marked as controls and excluded
  from default `eval` / `eval:compare` runs unless explicitly filtered or
  `--include-controls` is set.

## 0.1.1 - 2026-06-10

### Added

- Custom agents are now a documented public extension point:
  [`docs/how-to/custom-agents.md`](./docs/how-to/custom-agents.md) covers the agent markdown
  format (frontmatter contract + system prompt body), the
  package/user/project directories, shadowing precedence and its
  `AGENT_NAME_SHADOWED` diagnostic, `tier` vs `model` portability, and the
  project-agent trust gate. The loading behavior itself is unchanged — it was
  implemented but undocumented.
- `npm run lint:length` (part of `npm run check`): fails when a source file
  exceeds its line cap (500 for extension/script/eval code, 800 for tests) so
  the extension can't regrow into a single-file monolith.

- Evals: thulr 0.1.2 integration. `--samples=N` judges each case N times
  (majority verdict, mean score) and reports judge noise + flake warnings;
  `--junit=<path>` writes the gate verdict as a JUnit XML testsuite for CI test
  ingestion; `--trace-only` / `--trace-out=<path>` turn the harness into a
  command template for `thulr run-experiment` / `thulr optimize`
  (champion/challenger experiments over the eval suite, documented in
  `evals/README.md`). The emitted trace now carries the optional contract
  attributes — task text, per-case cost and tokens, and a
  `pi-flows@<version>` prompt-version stamp — and preflight runs
  `thulr doctor --json` instead of a bare version check.

### Changed

- Split the extension source: `extensions/pi-flows/index.ts` (3,547 lines) is
  now an entrypoint plus focused modules (`types`, `sanitize`, `validate`,
  `parse`, `agents`, `runner`, `trace`, `reflexion`, `ui`, `schema`) with one
  file per mode handler under `modes/`, registered in `modes/registry.ts`.
  No behavior change; the `flow` tool contract, `/flows` command, and public
  exports from `index.ts` are unchanged. `PI_FLOWS_VERSION` moved to
  `extensions/pi-flows/types.ts`.
- Evals: cheap models on both axes. The default subject is now
  `openai-codex/gpt-5.4-mini` — the cheapest model pi's codex provider exposes
  ($0.75/M in, $4.50/M out) and an exact model ID; the old default
  (`openai-codex/codex`) was a fuzzy pattern that pi resolved to
  `gpt-5.3-codex-spark` ($1.75/M in, $14/M out). The default judge (eval and
  A/B compare) is now `anthropic/claude-haiku-4-5` instead of
  `claude-sonnet-4-6` — still cross-vendor from the subject; escalate per-run
  with `--judge-model`. Re-seed the gate baseline after switching with
  `npm run eval -- --write-baseline`.
- Evals: `scripts/thulr-judge-pi.sh` — a `THULR_JUDGE_BIN` wrapper that
  re-enables pi extensions for the judge subprocess (thulr passes
  `--no-extensions`, which unloads extension-provided model providers such as
  pi-llama's `llama-cpp/...`) and keeps a printed verdict even if pi crashes
  during teardown. Opt-in, for judging on a local model when cloud quota is
  exhausted.

## 0.1.0 - 2026-06-06

### Added

- `returnContract` / `requireEvidence` prompts for preserving required output
  shape and concrete evidence through flow handoffs.
- `orchestrate.verifyPolicy` (`note` / `fail` / `revise`),
  `orchestrate.verifyMaxIterations`, and `orchestrate.workerReturnContract`.
  Verification can now be advisory, a hard gate, or a bounded revise-and-retry
  loop.
- `traceLabel`, `/flows report [trace-file]`, and `npm run trace:report` for
  grouped trace summaries (success rate, cost, TPSO, budget hits, and voting /
  routing warnings).
- Live flow status/widget updates and a compact `pi-flows.run` session entry.

### Security

- Concurrent write-capable fan-out now refuses shared working directories by
  default (`SHARED_WRITE_CWD`), with `allowSharedWriteCwd:true` as an explicit
  override.

### Changed

- Model-in-loop evals now support baseline writing/comparison and include cases
  for return-contract evidence preservation and same-model vote warnings.

## 0.0.2 - 2026-06-06

### Changed

- Bundled agents now declare a portable `tier` (`fast` / `capable`) instead of a
  hard-coded Claude model — no vendor model ids ship in the extension, so it does
  not go stale as providers release models. `capable` uses your pi default model;
  `fast` uses `PI_FLOWS_FAST_MODEL` if you set one (e.g. a cheaper model for your
  provider), otherwise your default too. So flows run on whatever model you have pi
  set up with rather than Anthropic specifically. Pin a `model:` (or pass a
  flow-call `model`) to override.

## 0.0.1 - 2026-06-05

Initial public release — a first-party pi extension that delegates work to
isolated sub-agents using proven multi-agent patterns, with safety, bounded
execution, and tracing built in.

### Added

- **`flow` tool** with delegation modes `single`, `parallel`, `chain`,
  `evaluate` (generator-evaluator), `vote`, `route`, and `orchestrate`, plus
  `list` and `showConfig` introspection. Exactly one mode runs per call.
- **Nine bundled agents** — `recon`, `analyst`, `strategist`, `operator`,
  `overwatch`, `redteam`, `controller`, `commander`, and `debrief`. User agents
  load from `~/.pi/agent/flow-agents/`; project agents from `.pi/flow-agents/`.
- **`/flows` command** to list agents and show help, status, and version.
- **Reliability levers** — `evaluate.checkCommand` (a deterministic gate that
  must exit `0`), `evaluate.redteam` critic panels, and an optional
  `orchestrate.verify` check on the synthesized answer.
- **Bounded execution** — hard caps on count, time (`timeoutMs`), nesting depth
  (`MAX_FLOW_DEPTH`), and cost (`maxCostUsd` / `maxTokens`) across the whole
  flow tree.
- **Trace export** — `traceFile` (or `PI_FLOWS_TRACE_FILE`) appends
  OpenInference-shaped JSONL spans per child plus a root span.
- A structured error contract (`code` / `message` / `cause` / `fix` /
  `retryable`) with a CI-verified catalog, an offline test suite, and bundled
  user documentation.

### Security

- Project-local agents fail closed in headless runs unless explicitly trusted
  with `confirmProjectAgents:false`.
- Secret-shaped strings and home paths are redacted from returned content,
  details, and trace spans by default.
- Inter-agent handoffs are stripped of invisible/bidi characters and scanned for
  instruction-override markers before one child's output becomes another's
  prompt.
- Read-only agents (`recon`, `analyst`) ship without a shell, so their
  read-only boundary is enforced by the toolset rather than by prompt text.
