# Changelog

All notable changes to pi-flows are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version surfaces
that must agree are `package.json`, `PI_FLOWS_VERSION` in
`extensions/pi-flows/types.ts`, this file, and the release tag.

## Unreleased

### Added

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
  restating it, reports the version it found alongside the one it needs, and
  treats a prerelease as below the release it precedes. A `pi --version` banner
  with no readable version warns rather than fails, since pi answering at all
  is not evidence of an unsupported host.
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
  [`docs/custom-agents.md`](./docs/custom-agents.md) covers the agent markdown
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
