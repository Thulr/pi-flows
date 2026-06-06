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
| Inter-agent handoffs | Stripped of invisible/bidi chars + scanned | Child output reused as another child's prompt is checked for injection markers before reuse; a warning is surfaced, content is not silently trusted. |
| Trace spans (`traceFile`) | **Off by default**; written only when set | One OpenInference-shaped JSON span per child plus a root span, appended to the file. Subject to the same redaction/cap policy; `input.value`/`output.value` are omitted when `recordContent:false`. `traceLabel` is copied into span attributes. The file is **not** auto-redacted at rest — treat it as you would any trace export. |
| Flow UI status/session entry | UI only | During a flow run, interactive pi sessions get a transient `pi-flows` status/widget summary. When the run completes, pi-flows appends a `pi-flows.run` session entry with mode, status, usage, model, duration, and error codes — not full child content. |
| `evaluate.checkCommand` | **Not set by default** | When set, runs the given shell command in the operator's `cwd` each round. It executes with the parent process environment; its stdout/stderr are redacted and capped before becoming critique. Only pass commands you trust. |

## Controls

- `redactSecrets:true` (default): redacts secret-shaped strings, emails, and home paths.
- `recordContent:true` (default): returns child content after redaction. Set `false` for structural-only details (also omits trace `input.value`/`output.value`).
- `timeoutMs`: bounds child runtime.
- `maxCostUsd` / `maxTokens`: bound cumulative spend across the flow tree.
- `traceFile` / `PI_FLOWS_TRACE_FILE`: opt-in trace export. Unset = no trace file is written.
- `/flows report [trace-file]` and `npm run trace:report -- <trace-file>`: local summaries of trace JSONL. They read the file you point at; they do not upload it.
- `confirmProjectAgents:true` (default): prompts in UI and fails closed in headless contexts.
- `allowSharedWriteCwd:false` (default): blocks concurrent write-capable agents from sharing a working directory.

## pi environment controls

Consult pi documentation for provider/session behavior. Useful environment controls visible in `pi --help` include:

- `PI_TELEMETRY=0` to disable pi install telemetry where supported.
- `PI_OFFLINE=1` to disable startup network operations where supported.

## Retention

Child sessions run with `--no-session`. Parent sessions may still store the flow tool result, including redacted content/details. Do not paste secrets into tasks; use references or local files where possible.

## Regression policy

Tests should fail if secret-shaped content appears in returned content, details, updates, or process arguments.
