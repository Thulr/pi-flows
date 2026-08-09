# Privacy & telemetry

pi-flows starts child `pi` processes. It does not add a separate analytics SDK, but child pi processes may use the same provider/network/telemetry behavior as pi itself.

## Data flow

| Data | Default | Notes |
|---|---|---|
| User task text | Written to a temporary `0600` file | The raw task is not placed in child process argv. |
| Child assistant text | Returned after redaction/capping | Set `recordContent:false` to omit child message content. |
| Child tool results | Stored in details after redaction/capping | Secret-shaped values and home paths are redacted by default. |
| Usage/cost/tokens | Stored structurally | Kept even when content capture is disabled. |
| stderr/stdout samples | Captured with caps and redaction | Used for recovery diagnostics. |
| Agent paths | Home path redacted to `~` | Project-relative context may still appear in task/output content. |
| Inter-agent handoffs | Stripped of invisible/bidi chars + scanned | A bounded flow-scoped history also detects injection assembled across several boundaries. `warn` preserves flagged text with a notice, `quarantine` withholds it, and `fail` refuses the recipient before spawn. |
| Trace spans (`traceFile`) | **Off by default**; written only when set | OpenInference-shaped JSON spans appended to the file: one per child run, one per stage (wave/round/phase), one per coordination event (approval, state, retry, budget, validation, handoff, artifact), plus a root span. Subject to the same redaction/cap policy; `input.value`/`output.value` are omitted when `recordContent:false`. Coordination-event spans carry shapes, sizes, digests, and identifiers — never handoff summaries, envelope `data`, approved parameters, or constraint text. Constraint identifiers are content digests, so preservation is checkable without recording the constraint. `traceLabel` is copied into span attributes. The file is **not** auto-redacted at rest — treat it as you would any trace export. |
| Eval reliability report (`--reliability-out`) | Written by `npm run eval`; defaults under ignored `.thulr/runs/` | Retains each subject trial's answer, objective/judge outcome, costs, tokens, duration, exclusion, and infrastructure failure so reliability statistics remain auditable. This is a local raw eval artifact; do not commit or share it without reviewing its contents. |
| Flow UI/session entry | UI only | During a flow run, interactive pi sessions get one transient inline tool-row summary; the duplicate footer status and above-editor widget are cleared. When the run completes, pi-flows appends a `pi-flows.run` session entry with mode, status, usage, model, duration, and error codes — not full child content. |
| `evaluate.checkCommand` | **Not set by default** | When set, runs the given shell command in the operator's `cwd` each round. It executes with the parent process environment; its stdout/stderr are redacted and capped before becoming critique. Only pass commands you trust. |

## Controls

- `redactSecrets:true` (default): redacts secret-shaped strings, emails, and home paths.
- `recordContent:true` (default): returns child content after redaction. Set `false` for structural-only details (also omits trace `input.value`/`output.value`).
- `handoffPolicy:"warn" | "quarantine" | "fail"`: call-level handling for
  injection-shaped handoffs. `modeHandoffPolicy` can require a stricter minimum
  for named modes; the stricter value wins.
- `timeoutMs`: bounds child runtime.
- `maxCostUsd` / `maxGeneratedTokens`: bound cumulative spend by stopping the
  active child at completed model-response accounting boundaries.
- `maxTokens`: preserves the completed response and blocks subsequent child
  spawns after the cumulative total-token ceiling is reached.
- `traceFile` / `PI_FLOWS_TRACE_FILE`: opt-in trace export. Unset = no trace file is written.
- `traceStrict` / `PI_FLOWS_TRACE_STRICT`: opt-in gate that fails a call whose trace evidence is incomplete. It changes nothing about what is recorded — only whether an incomplete export is tolerated.
- `/flows report [trace-file]` and `npm run trace:report -- <trace-file>`: local summaries of trace JSONL. They read the file you point at; they do not upload it.
- `confirmProjectAgents:true` (default): prompts in UI and fails closed in headless contexts.
- `allowSharedWriteCwd:false` (default): blocks concurrent write-capable agents from sharing a working directory.

## pi environment controls

Consult pi documentation for provider/session behavior. Useful environment controls visible in `pi --help` include:

- `PI_TELEMETRY=0` to disable pi install telemetry where supported.
- `PI_OFFLINE=1` to disable startup network operations where supported.
- `PI_FLOWS_CHILD_NO_EXTENSIONS=1` to make pi-flows spawn child agents with
  `--no-extensions` when you need to isolate installed user extensions. With it
  set, roles whose tools include `bash-ro` are refused
  (`BASH_READONLY_UNENFORCEABLE`) rather than spawned with an unrestricted
  shell, because the allowlist is enforced by the pi-flows extension inside the
  child.
- `PI_FLOWS_BASH_READONLY` is an internal marker pi-flows sets on every child
  it spawns (`1` for a `bash-ro` toolset, empty otherwise, so a parent's value
  never leaks into grandchildren). Setting it by hand in your own shell makes
  that pi session's bash allowlist-restricted too.
- `PI_FLOWS_BASH_RO_NO_SANDBOX=1` opts `bash-ro` children out of the OS
  read-only-checkout sandbox (macOS `sandbox-exec`). Use it if the sandbox
  interferes with a toolchain.
- `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX=1` makes `bash-ro` refuse
  (`BASH_READONLY_UNENFORCEABLE`) where the OS sandbox is unavailable, instead
  of falling back to the command allowlist. By default the allowlist fallback
  runs; set this when you need a kernel-enforced guarantee, since the allowlist
  cannot be exhaustive and is best-effort.

## Retention

Child sessions run with `--no-session`. Parent sessions may still store the flow tool result, including redacted content/details. Do not paste secrets into tasks; use references or local files where possible.

## Regression policy

Tests should fail if secret-shaped content appears in returned content, details, updates, or process arguments.
