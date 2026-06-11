# Changelog

All notable changes to pi-flows are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version surfaces
that must agree are `package.json`, `PI_FLOWS_VERSION` in
`extensions/pi-flows/types.ts`, this file, and the release tag.

## Unreleased

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
