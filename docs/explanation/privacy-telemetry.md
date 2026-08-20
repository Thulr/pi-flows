# Privacy & telemetry

pi-flows starts child `pi` processes. It does not add a separate analytics SDK, but child pi processes can use the same provider/network/telemetry behavior as pi itself.

## Data flow

| Data | Default | Notes |
|---|---|---|
| User task text | Written to a temporary `0600` file | The raw task is not placed in child process argv. |
| Child assistant text | Returned after redaction/capping | Set `recordContent:false` to omit child message content. |
| Child tool results | Stored in details after redaction/capping | Secret-shaped values and home paths are redacted by default. |
| Usage/cost/tokens | Stored structurally | Kept even when content capture is disabled. |
| stderr/stdout samples | Captured with caps and redaction | Used for recovery diagnostics. |
| Agent paths | Home path redacted to `~` | Project-relative context can still appear in task/output content. |
| Workflow state and approval receipts | Owner-only (`0600`) state file | Persists redacted phase artifacts plus receipt identity/status. A binding digest represents the approval conditions. The selected Agent prompt contributes a SHA-256 identity, never raw prompt text. |
| Inter-agent handoffs | Stripped of invisible/bidi chars + scanned | A bounded flow-scoped history also detects injection assembled across several boundaries. `warn` preserves flagged text with a notice, `quarantine` withholds it, and `fail` refuses the recipient before spawn. |
| Trace spans (`traceFile`) | **Off by default**; written only when set | OpenInference-shaped JSON spans appended to the file: one per child run, one per stage (wave/round/phase), one per coordination event (approval, state, retry, budget, validation, handoff, artifact), plus a root span. Subject to the same redaction/cap policy; `input.value`/`output.value` are omitted when `recordContent:false`. Coordination-event spans carry shapes, sizes, digests, and identifiers — never handoff summaries, envelope `data`, approved parameters, or constraint text. Constraint identifiers are content digests, so preservation is checkable without recording the constraint. With `recordContent:true`, child spans also record the delegation reason and a contract's authority lists, and artifact coordination events record artifact paths. Structural identity attributes (unit keys, phase ids, labels, approval actors, `traceLabel`) are recorded regardless of `recordContent`, after redaction and capping. The file is written with default permissions and is **not** auto-redacted at rest. Treat it with the same care as any trace export. |
| Eval reliability report (`--reliability-out`) | Written by `npm run eval`; defaults under ignored `.thulr/runs/` | Retains each subject trial's answer, objective/judge outcome, costs, tokens, duration, exclusion, and infrastructure failure so reliability statistics remain auditable. This is a local raw eval artifact. Review its contents before you commit or share it. |
| Flow UI/session entry | UI only | During a flow run, interactive pi sessions get one transient inline tool-row summary. The duplicate footer status and above-editor widget are cleared. When the run completes, pi-flows appends a `pi-flows.run` session entry with mode, status, usage, model, duration, and error codes — not full child content. |
| `evaluate.checkCommand` | **Not set by default** | When set, runs the given shell command in the operator's `cwd` each round. It executes with the parent process environment. Its stdout/stderr are redacted and capped before they become critique. Only pass commands that you trust. |

## Controls

- `redactSecrets:true` (default): redacts secret-shaped strings, emails, and home paths.
- `recordContent:true` (default): returns child content after redaction. Set `false` for structural-only details (also omits trace `input.value`/`output.value`).
- `handoffPolicy:"warn" | "quarantine" | "fail"`: call-level handling for
  injection-shaped handoffs. `modeHandoffPolicy` can require a stricter minimum
  for named modes. The stricter value wins.
- `timeoutMs`: bounds child runtime.
- `maxCostUsd` / `maxGeneratedTokens`: bound cumulative spend by stopping the
  active child at completed model-response accounting boundaries.
- `maxTokens`: preserves the completed response and blocks subsequent child
  spawns after the cumulative total-token ceiling is reached. A delegation
  contract's own total-token ceiling is stricter: it stops the live child.
- `traceFile` / `PI_FLOWS_TRACE_FILE`: opt-in trace export. Unset = no trace file is written.
- `traceStrict` / `PI_FLOWS_TRACE_STRICT`: opt-in gate that fails a call whose trace evidence is incomplete. It reads the finished export back and appends one validation-event row with the verdict (plus a revocation row when the read-back disagrees). It records nothing else beyond a non-strict run.
- `/flows report [trace-file]` and `npm run trace:report -- <trace-file>`: local summaries of trace JSONL. They read the file that you point at. They do not upload it.
- `confirmProjectAgents:true` (default): prompts in UI and fails closed in headless contexts.
- `allowSharedWriteCwd:false` (default): blocks concurrent write-capable agents from sharing a working directory.

## pi environment controls

Consult pi documentation for provider/session behavior. Useful environment controls visible in `pi --help` include:

- `PI_TELEMETRY=0` to disable pi install telemetry where supported.
- `PI_OFFLINE=1` to disable startup network operations where supported.
- `PI_FLOWS_CHILD_NO_EXTENSIONS=1` to make pi-flows spawn child agents with
  `--no-extensions` when you need to isolate installed user extensions. This
  only suppresses *discovered* extensions. `bash-ro` children still load the
  allowlist enforcer through an explicit `-e`, which pi keeps under
  `--no-extensions`. So they remain enforced, and this setting alone does not
  refuse them.
- `PI_FLOWS_BASH_READONLY` is an internal marker pi-flows sets on every child
  it spawns (`1` for a `bash-ro` toolset, empty otherwise, so a parent's value
  never leaks into grandchildren). If you set it by hand in your own shell,
  the bash of that pi session becomes allowlist-restricted too.
- `PI_FLOWS_BASH_RO_NO_SANDBOX=1` opts `bash-ro` children out of the OS
  read-only-checkout sandbox (macOS `sandbox-exec`). If the sandbox
  interferes with a toolchain, use it.
- `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX=1` makes `bash-ro` refuse
  (`BASH_READONLY_UNENFORCEABLE`) where the OS sandbox is unavailable, instead
  of a fallback to the command allowlist. By default, the allowlist fallback
  runs. Set this when you need a kernel-enforced guarantee, because the
  allowlist is best-effort and cannot be exhaustive.

## Retention

Child sessions run with `--no-session`. Parent sessions can still store the flow tool result, including redacted content/details. Resumable workflow state remains on disk until you remove it. Its receipt omits raw Agent prompt text, but the source Agent file still contains that prompt. Do not paste secrets into tasks. Use references or local files where possible.

## Regression policy

If secret-shaped content appears in returned content, details, updates, or process arguments, tests must fail.
