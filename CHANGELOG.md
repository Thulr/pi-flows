# Changelog

All notable changes to pi-flows are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version surfaces
that must agree are `package.json`, `PI_FLOWS_VERSION` in
`extensions/pi-flows/index.ts`, this file, and the release tag.

## Unreleased

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
