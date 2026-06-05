# Flow reference

## Modes

Exactly one mode is valid per call.

| Mode | Shape | Runs a child pi process? |
|---|---|---:|
| List | `{ "list": true }` | No |
| Config | `{ "showConfig": true }` | No |
| Single | `{ "agent": "recon", "task": "..." }` | Yes |
| Parallel | `{ "tasks": [{ "agent": "recon", "task": "..." }] }` | Yes |
| Chain | `{ "task": "...", "chain": [{ "agent": "recon", "task": "..." }] }` | Yes |
| Evaluate | `{ "task": "...", "evaluate": { "maxIterations": 3 } }` | Yes |
| Vote | `{ "task": "...", "vote": { "voters": [{ "agent": "recon" }, { "agent": "overwatch" }] } }` | Yes |
| Route | `{ "task": "...", "route": { "candidates": ["recon","strategist"] } }` | Yes |
| Orchestrate | `{ "task": "...", "orchestrate": {} }` | Yes |

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| `agentScope` | `user` | `user` = package + user agents; `project` = package + project; `all` = package + user + project. |
| `confirmProjectAgents` | `true` | Interactive sessions prompt. Headless sessions refuse project agents unless this is explicitly `false`. |
| `concurrency` | `4` | Parallel only. Integer `1..8`. |
| `timeoutMs` | `600000` | Per child process timeout. |
| `recordContent` | `true` | Return/store child message content after redaction. Set `false` to retain structural status/usage only. |
| `redactSecrets` | `true` | Redacts secret-shaped strings, emails, and home paths from content/details. |
| `maxCostUsd` | (none) | Cumulative USD cost ceiling across every child in the flow tree. Once reached, no further child spawns (`BUDGET_EXCEEDED`). Omit to run uncapped. |
| `maxTokens` | (none) | Cumulative input+output token ceiling across the flow tree. Once reached, no further child spawns (`BUDGET_EXCEEDED`). Omit to run uncapped. |
| `traceFile` | (none) | Append an OpenInference-shaped JSON span per child (plus a root span) to this JSONL file — trace data any OpenTelemetry pipeline (or a coding agent via `jq`/SQL) can read. Also settable via `PI_FLOWS_TRACE_FILE`. Relative paths resolve against `cwd`. Values are redacted/capped first. |
| `model` | agent/default | Optional model override. |
| `tools` | agent/default | Comma-separated tools, `none`, or `default`. |
| `cwd` | parent cwd | Child process working directory. |

The fan-out ceiling `maxParallelTasks` (`8`) is a fixed internal cap on `tasks`, voters, and subtasks — not a per-call input. It is enforced by the runtime and surfaced read-only in `details.config`.

`maxCostUsd` / `maxTokens` close the **cost** dimension of bounded execution: the iteration, fan-out, and time caps bound how *many* children run and how *long* each runs, but not total spend. The ceiling is best-effort — children already in flight finish — but once it trips, queued and subsequent children are refused, so an evaluate loop or large fan-out cannot run away on cost.

### Trace export (observability)

Set `traceFile` (or `PI_FLOWS_TRACE_FILE`) to write one append-only JSON span per delegated child, plus a root span for the whole flow call. Spans carry OpenInference-style attributes — `flow.mode`, `flow.agent`, `llm.model_name`, `llm.token_count.*`, `flow.cost_usd`, `flow.duration_ms`, status, and (when `recordContent` is on) redacted `input.value` / `output.value`. The format is plain JSONL: ingest it into any OpenTelemetry/OpenInference backend, or let a coding agent query it directly with `jq`/SQL to self-diagnose a flow. Export is best-effort and never fails a flow.

## Evaluate mode (generator-evaluator loop)

The `operator` builds an artifact against the top-level `task`; a separate `redteam` judges that artifact against the goal and returns a verdict. On `REVISE` the operator is re-shown **its previous artifact plus the critique** and revises it in place (rather than rebuilding from scratch); the loop stops on `PASS` or when `maxIterations` is reached, returning the last attempt either way.

The two roles run in separate child processes with separate contexts, and the `redteam` is shown only the `operator`'s **output**, never its reasoning trace — so its judgment is independent (see the wiki's generator-evaluator-harness design rules).

Two reliability levers beyond the single LLM critic:

- **`checkCommand` — a deterministic gate (level-1 / code assertions).** A shell command run in the operator's `cwd` that must exit `0` each round. A non-zero exit is an automatic `REVISE` — the command output becomes the critique and the LLM critic is skipped that round (saving cost). `PASS` requires **both** the check (exit 0) **and** the critic(s). This is verification guaranteed by the harness, not merely requested in the prompt. A command that cannot even start (e.g. not found) fails with `CHECK_COMMAND_FAILED` rather than looping forever.
- **`redteam` as a panel (god-metric → decomposed evaluators).** Pass an array of critics — for example one per dimension (correctness, security, tests). They run in parallel; `PASS` requires **every** critic to pass, and the `REVISE` critiques are merged for the next round.

```json
{
  "task": "Add a /health endpoint that returns 200 and a JSON status, with a test",
  "evaluate": {
    "operator": { "agent": "operator" },
    "redteam": [
      { "agent": "redteam" },
      { "agent": "overwatch" }
    ],
    "checkCommand": "npm test",
    "maxIterations": 3,
    "passContract": "Test exists and passes; endpoint returns 200 with {status:'ok'}."
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `evaluate.operator` | `{ agent: "operator" }` | Builds the artifact. Accepts `agent`, `model`, `tools`, `cwd`. |
| `evaluate.redteam` | `{ agent: "redteam" }` | The critic: a single agent **or an array** of critics (a decomposed panel). With a panel, `PASS` needs every critic to pass. |
| `evaluate.checkCommand` | (none) | Deterministic gate: a shell command that must exit `0` each round. Non-zero → forced `REVISE`; non-runnable → `CHECK_COMMAND_FAILED`. |
| `evaluate.maxIterations` | `3` | Integer `1..8`. Hard cap on generate→evaluate rounds. |
| `evaluate.passContract` | (none) | Explicit acceptance criteria appended to the critic's rubric. Concrete criteria make the verdict reliable. |

The `redteam` signals its verdict with a `VERDICT: PASS` or `VERDICT: REVISE` line (a JSON `{ "verdict": "pass" }` block is also accepted). An unparseable verdict is treated as `REVISE`, so a misbehaving critic keeps iterating under the cap rather than falsely passing. `details.results` holds the full transcript: `operator` and `redteam` runs interleaved (with a panel, all critics for a round appear after that round's generator).

## Vote mode (parallelization / voting)

Runs the same `task` across two or more voters, then either aggregates the answers via a `debrief` agent or returns all of them. Independent voters suppress non-deterministic errors; **different models** (vendor-diverse voting) additionally break correlated blind spots.

```json
{
  "task": "Is this regex safe from catastrophic backtracking? /^(a+)+$/",
  "vote": {
    "voters": [{ "agent": "recon" }, { "agent": "recon", "model": "claude-haiku-4-5" }, { "agent": "overwatch" }],
    "debrief": { "agent": "debrief" }
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `vote.voters` | (none) | Explicit voter list (heterogeneous models recommended). Each runs the same `task`. |
| `vote.agent` + `vote.count` | count `3` | Same-agent voting: run one agent `count` times. `count` is `2..8`. |
| `vote.debrief` | (none) | Optional `debrief` agent that merges the voter answers. Without it, all voter answers are returned for the parent to judge. |

At least 2 voters are required (`TOO_FEW_VOTERS` otherwise) and at most `maxParallelTasks`. `concurrency` controls fan-out. Voter answers are free text, so consensus is decided by the `debrief` agent, not by programmatic majority.

## Route mode (classify → dispatch)

The `controller` reads the `task` plus the candidate descriptions and picks one specialist to run.

```json
{
  "task": "The billing webhook is returning 500s in production",
  "route": { "controller": { "agent": "controller" }, "candidates": ["recon", "strategist", "overwatch"], "fallback": "recon" }
}
```

| Field | Default | Notes |
|---|---|---|
| `route.controller` | `{ agent: "controller" }` | Classifier. Sees the task and each candidate's description. |
| `route.candidates` | (required) | Agent names the `controller` may choose from. |
| `route.fallback` | (none) | Agent to run if the `controller` names no valid candidate. Without it, an unresolved route returns `ROUTE_UNRESOLVED`. |

The `controller` signals its choice with a `ROUTE: <agent>` line (JSON `{ "route": "<agent>" }` and a whole-word mention are also accepted, validated against `candidates`). If no candidate genuinely fits, the `controller` emits `ROUTE: none`; this resolves to no valid candidate and triggers `route.fallback` (or `ROUTE_UNRESOLVED` when no fallback is set), so a poor-fit task falls back instead of being force-routed.

## Orchestrate mode (decompose → fan out → synthesize)

The `commander` decomposes the `task` into independent subtasks, `recon` workers run them in parallel, and the `debrief` agent merges the results — the deep-research / orchestrator-workers shape.

```json
{
  "task": "Document how authentication works across the codebase",
  "orchestrate": {
    "commander": { "agent": "commander" },
    "recon": { "agent": "recon" },
    "debrief": { "agent": "debrief" },
    "maxSubtasks": 5
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `orchestrate.commander` | `{ agent: "commander" }` | Returns a JSON array of subtask strings. |
| `orchestrate.recon` | `{ agent: "recon" }` | Runs one subtask each, in parallel. Use `analyst` for deeper per-subtask investigation. |
| `orchestrate.debrief` | `{ agent: "debrief" }` | Merges the subtask findings into one answer. |
| `orchestrate.verify` | (none) | Optional critic that checks the merged answer against the goal in one pass (orchestrator-workers composed with evaluator-optimizer). Appends a `VERDICT: PASS/REVISE` note so the synthesis is verified rather than trusted — without a separate flow call. |
| `orchestrate.maxSubtasks` | `maxParallelTasks` | Cap on subtasks (also bounded by `maxParallelTasks`). |

If the `commander` returns no usable subtask array, the call fails with `ORCHESTRATE_NO_SUBTASKS`. `concurrency` controls worker fan-out. `details.results` is ordered commander → workers → debrief → (optional) verify.

## Details object

`flow` returns content plus `details`:

- `version`: pi-flows version.
- `mode`: `list`, `config`, `single`, `parallel`, `chain`, `evaluate`, `vote`, `route`, or `orchestrate`.
- `agentScope`: effective scope.
- `config`: defaults and caps.
- `agentsDir`: package/user/project directories with home paths redacted to `~`.
- `agents`: discovered agent summaries.
- `discoveryIssues`: invalid frontmatter, unreadable files, or shadowed names.
- `results`: child run summaries with redacted task preview, usage, duration, stderr, and structured error when applicable.

## Error contract

Every error returned by the `flow` tool is a structured envelope:

- `code` — a stable identifier from a fixed set (see catalog below)
- `message` — what happened
- `cause` — why
- `fix` — the suggested next action
- `retryable` — whether retrying unchanged may succeed

The full list of `code` values, each with its cause and fix, lives in the
**[canonical error-code catalog](./troubleshooting.md#error-codes)** in
Troubleshooting. That catalog is the single source of truth and is verified in
CI to cover every code the tool can return, so it never drifts from the source.

## `/flows` command

```text
/flows
/flows user
/flows project
/flows all
/flows help
/flows version
/flows status
/flows status all
```

Invalid arguments return an error instead of silently falling back to another scope.
