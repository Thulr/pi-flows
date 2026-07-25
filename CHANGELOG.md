# Changelog

All notable changes to pi-flows are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version surfaces
that must agree are `package.json`, `PI_FLOWS_VERSION` in
`extensions/pi-flows/types.ts`, this file, and the release tag.

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
