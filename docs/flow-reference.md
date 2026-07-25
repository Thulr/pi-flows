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
| Graph | `{ "task": "...", "graph": { "nodes": [{ "id": "a", "agent": "recon", "task": "..." }] } }` | Yes |
| Loop | `{ "task": "...", "loop": { "body": { "agent": "operator" } } }` | Yes |
| Search | `{ "task": "...", "search": { "candidates": 3 } }` | Yes |
| Workflow | `{ "task": "...", "workflow": { "phases": [{ "id": "a", "agent": "recon", "task": "..." }] } }` | For work phases |
| Worktree | `{ "task": "...", "worktree": { "tasks": [{ "id": "a", "agent": "operator", "task": "..." }, { "id": "b", "agent": "operator", "task": "..." }] } }` | Yes |
| Debate | `{ "task": "...", "debate": { "participants": [{ "agent": "analyst" }, { "agent": "strategist" }] } }` | Yes |
| Dossier | `{ "task": "...", "dossier": { "sections": [{ "agent": "recon", "task": "source A" }, { "agent": "analyst", "task": "source B" }] } }` | Yes |
| Monitor | `{ "task": "...", "monitor": { "command": "./probe" } }` | On trigger |

## Live TUI inspection

While a flow is running in interactive Pi, press `F8` or run `/flows inspect`.
Select a queued or running child to see its task, status, usage, and recent text/tool activity.
Use Up/Down to scroll, End to return to the latest activity, and Escape to close
the overlay without interrupting the child. The inspector uses existing in-memory
flow updates and creates no additional persisted data.

## Activation thresholds

Use the least coordination that materially improves correctness. Do not auto-use
any flow for a simple task or a **saturated** task, where direct parent execution
already meets the acceptance criteria reliably and leaves no useful quality
headroom. In that case, extra subprocesses are only cost and latency.

Every spawning call must pass `why` — one sentence naming the reason delegation
beats direct execution (an explicit user request, fan-out one context cannot
hold, or author-independent verification). Calls without it are refused with
`WHY_REQUIRED` before any child spawns. This is deliberate structural friction:
if no justification can be stated, the task belongs in the parent context.

| Mode | Activate when | Stay direct or use a simpler mode when |
|---|---|---|
| `workflow` | Named phases, persisted artifacts, deterministic gates, or a resumable human approval are part of correctness. | The work is one small edit or an ordinary linear handoff; use the parent, `single`, `chain`, or `evaluate`. |
| `worktree` | Isolation, ownership boundaries, or shared integration conflicts are part of correctness for multiple write-capable tasks, and a verified integration branch is required. | The parent can safely make the edits in one checkout, even when two files are involved; use direct execution, `single`/`evaluate`, or read-only `parallel`. |
| `debate` | The user explicitly requests independent advocates/rebuttal/adjudication for a consequential decision. | Debate is not an automatic route today: direct Codex matched its decision quality with lower latency/tokens in the paired baseline. Answer directly unless independent opposition is itself requested. |
| `dossier` | At least two sources or claim families must be cited and reconciled, including contradictions and gaps. | One source or lookup is enough; use `single` with `recon`/`analyst`. |
| `monitor` | A deterministic probe must be repeated under a hard bound, and a typed event should trigger one diagnosis/response. | One status check is enough, or the need is durable/background scheduling; run the command directly or use an external automation system. |

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| `why` | (required to spawn) | One sentence justifying delegation over direct parent execution. Required for every spawning mode; `list`/`showConfig` never need it. Missing/empty ⇒ `WHY_REQUIRED`. |
| `agentScope` | `user` | `user` = package + user agents; `project` = package + project; `all` = package + user + project. |
| `confirmProjectAgents` | `true` | Interactive sessions prompt. Headless sessions refuse project agents unless this is explicitly `false`. |
| `concurrency` | `4` | Concurrent fan-out, including parallel, vote, orchestrate, worktree, debate, and dossier. Integer `1..8`. |
| `timeoutMs` | `36000000` | Per child process timeout (10 hours). |
| `recordContent` | `true` | Return/store child message content after redaction. Set `false` to retain structural status/usage only. |
| `redactSecrets` | `true` | Redacts secret-shaped strings, emails, and home paths from content/details. |
| `maxCostUsd` | (none) | Cumulative USD cost ceiling across every child in the flow tree. Once reached, no further child spawns (`BUDGET_EXCEEDED`). Omit to run uncapped. |
| `maxTokens` | (none) | Cumulative input+output token ceiling across the flow tree. Once reached, no further child spawns (`BUDGET_EXCEEDED`). Omit to run uncapped. |
| `traceFile` | (none) | Append an OpenInference-shaped JSON span per child (plus a root span) to this JSONL file — trace data any OpenTelemetry pipeline (or a coding agent via `jq`/SQL) can read. Also settable via `PI_FLOWS_TRACE_FILE`. Relative paths resolve against `cwd`. Values are redacted/capped first. |
| `traceLabel` | (none) | Use-case label attached to trace spans so reports can group success rate, TPSO, cost, and warning counts by journey/release gate. |
| `returnContract` | (none) | Output contract appended to delegated worker/generator/synthesis prompts. Use it to require a shape, fields, max length, or evidence format. |
| `requireEvidence` | `false` | Appends an evidence requirement to delegated prompts: load-bearing claims need file:line refs, command output, citations, or explicit gaps. |
| `allowSharedWriteCwd` | `false` | By default, concurrent write-capable agents may not share one `cwd`. Set `true` only when shared writes are intentional. |
| `checkpoint` | (none) | Optional human approval gate. `checkpoint.before:"spawn"` asks before any child runs; `"finalize"` asks after child work before returning the final answer. Headless contexts fail closed. |
| `reflexion` | disabled | Optional local cross-run lessons. `reflexion.enabled:true` reads/appends recent lessons from `.pi/flow-reflections.jsonl` by default. |
| `model` | agent/default | Flow-wide exact-model fallback. A task, phase, participant, or role-level `model` overrides it. Prefer `tier` unless the user named a concrete model. |
| `tier` | agent/default | Flow-wide capability-tier fallback (`fast`, `capable`, `deep`), overridable per task/phase/role. Portable model selection: resolves through `PI_FLOWS_FAST_MODEL` / `PI_FLOWS_DEEP_MODEL` when the user mapped them, else the default pi model. Resolution order: call `model` > call `tier` > agent `model` pin > agent `tier` > pi default; a call-level `tier:"capable"` always resolves, forcing the default model even on a `fast`/`deep` agent, while an unmapped call-level `fast`/`deep` falls through. |
| `tools` | agent/default | Comma-separated tools, `none`, or `default`. |
| `cwd` | parent cwd | Child process working directory. |

The fan-out ceiling `maxParallelTasks` (`8`) is a fixed internal cap on `tasks`,
voters, subtasks, worktree writers, debate participants, and dossier sections --
not a per-call input. It is enforced by the runtime and surfaced read-only in
`details.config`.

`maxCostUsd` / `maxTokens` close the **cost** dimension of bounded execution: the iteration, fan-out, and time caps bound how *many* children run and how *long* each runs, but not total spend. The ceiling is best-effort — children already in flight finish — but once it trips, queued and subsequent children are refused, so an evaluate loop or large fan-out cannot run away on cost.

### Trace export (observability)

Set `traceFile` (or `PI_FLOWS_TRACE_FILE`) to write one append-only JSON span per delegated child, plus a root span for the whole flow call. Spans carry OpenInference-style attributes — `flow.mode`, `flow.agent`, `llm.model_name`, `llm.token_count.*`, `flow.cost_usd`, `flow.duration_ms`, status, and (when `recordContent` is on) redacted `input.value` / `output.value`. The format is plain JSONL: ingest it into any OpenTelemetry/OpenInference backend, or let a coding agent query it directly with `jq`/SQL to self-diagnose a flow. Export is best-effort and never fails a flow.

Summarize a trace file from inside pi:

```text
/flows report flow-trace.jsonl
```

Or from a checkout:

```bash
npm run trace:report -- flow-trace.jsonl
```

The report groups runs by `flow.mode` and `traceLabel`, with success rate, cost,
tokens-per-success (TPSO), budget hits, same-model vote warnings, and route
choices.

## Return contracts and write isolation

`returnContract` and `requireEvidence` exist to prevent summary loss at handoff
boundaries. They are appended to child prompts in `single`, `parallel`, `chain`,
`evaluate`, `vote`, `route`, and to `orchestrate` workers/synthesis. Workflow
phases, worktree tasks, and dossier sections accept task-level contracts; those
override the top-level contract. Dossier sections and worktree tasks require
evidence by default. `orchestrate.workerReturnContract` can set a worker-specific
contract while the top-level `returnContract` still applies to synthesis.

Parallel fan-out is read-optimized by default. If two write-capable agents would
run concurrently in the same `cwd`, pi-flows returns `SHARED_WRITE_CWD` before
spawning them. A role is write-capable when its effective tools are pi defaults,
or include `bash`, `edit`, or `write`. Give each writer a separate worktree/cwd,
use read-only agents, or set `allowSharedWriteCwd:true` after deciding the shared
checkout is intentional.

## Evaluate mode (generator-evaluator loop)

The `operator` builds an artifact against the top-level `task`; a separate `redteam` judges that artifact against the goal and returns a verdict. Top-level `task` is preferred, but `evaluate.operator.task` is accepted as the goal when the top-level field is omitted. On `REVISE` the operator is re-shown **its previous artifact plus the critique** and revises it in place (rather than rebuilding from scratch); the loop stops on `PASS` or when `maxIterations` is reached, returning the last attempt either way.

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
| `evaluate.operator` | `{ agent: "operator" }` | Builds the artifact. Accepts `agent`, `model`, `tools`, `cwd`, and optional `task` as the goal fallback when top-level `task` is omitted. |
| `evaluate.redteam` | `{ agent: "redteam" }` | The critic: a single agent **or an array** of critics (a decomposed panel). With a panel, `PASS` needs every critic to pass. |
| `evaluate.checkCommand` | (none) | Deterministic gate: a shell command that must exit `0` each round. Non-zero → forced `REVISE`; non-runnable → `CHECK_COMMAND_FAILED`. |
| `evaluate.maxIterations` | `3` | Integer `1..8`. Hard cap on generate→evaluate rounds. |
| `evaluate.passContract` | (none) | Explicit acceptance criteria appended to the critic's rubric. Concrete criteria make the verdict reliable. |

The `redteam` signals its verdict with a `VERDICT: PASS` or `VERDICT: REVISE` line (a JSON `{ "verdict": "pass" }` block is also accepted). An unparseable verdict is treated as `REVISE`, so a misbehaving critic keeps iterating under the cap rather than falsely passing. `details.results` holds the full transcript: `operator` and `redteam` runs interleaved (with a panel, all critics for a round appear after that round's generator).

## Vote mode (parallelization / voting)

Runs the same `task` across two or more voters, then either aggregates the answers via a `debrief` agent or returns all of them. Independent voters suppress non-deterministic errors; **different models** (vendor-diverse voting) additionally break correlated blind spots. When every voter has the same agent/model identity, pi-flows keeps the original task but adds complementary voter stances (solver, skeptic, evidence checker, etc.) so the ballots are not identical prompt replays.

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
| `vote.voters` | (none) | Explicit voter list (heterogeneous models recommended). Each runs the same goal; identical agent/model voters get complementary stances. |
| `vote.agent` + `vote.count` | count `3` | Same-agent voting: run one agent `count` times with complementary stances. `count` is `2..8`. |
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

The `commander` decomposes the `task` into independent subtasks, `recon` workers run them in parallel, and the `debrief` agent merges the results — the deep-research / orchestrator-workers shape. Top-level `task` is preferred; `orchestrate.task` is accepted as its fallback. Each worker sees both the overall goal/contract and its assigned subtask, so terse decomposition output does not detach findings from the final answer requirements.

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
| `orchestrate.task` | (none) | Goal fallback when top-level `task` is omitted. Prefer top-level `task` for new calls. |
| `orchestrate.commander` | `{ agent: "commander" }` | Returns a JSON array of subtask strings. |
| `orchestrate.recon` | `{ agent: "recon" }` | Runs one subtask each, in parallel, with the overall goal/contract included for context. Use `analyst` for deeper per-subtask investigation. |
| `orchestrate.debrief` | `{ agent: "debrief" }` | Merges the subtask findings into one answer. |
| `orchestrate.verify` | (none) | Optional critic that checks the merged answer against the goal/contract (orchestrator-workers composed with evaluator-optimizer). |
| `orchestrate.verifyPolicy` | `note` | `note` appends the verifier verdict; `fail` returns `ORCHESTRATE_VERIFY_FAILED` on `REVISE`; `revise` reruns `debrief` with the critique and re-verifies until pass or cap. |
| `orchestrate.verifyMaxIterations` | `2` | Integer `1..4`. Maximum synthesize→verify rounds when `verifyPolicy:"revise"`. |
| `orchestrate.workerReturnContract` | (none) | Contract appended to every worker subtask before fan-out. |
| `orchestrate.returnContract` | (none) | Alias for top-level `returnContract`; when top-level `task` is also omitted, this text may serve as the goal fallback for model-generated calls. |
| `orchestrate.maxSubtasks` | `maxParallelTasks` | Cap on subtasks (also bounded by `maxParallelTasks`). |

If the `commander` returns no usable subtask array, the call fails with `ORCHESTRATE_NO_SUBTASKS`. `concurrency` controls worker fan-out. `details.results` is ordered commander → workers → debrief → (optional) verify.

## Graph mode (static DAG)

`graph` runs a bounded static DAG. Nodes run once all `dependsOn` nodes have
completed, and ready nodes in the same dependency wave may run in parallel.

```json
{
  "task": "Map auth",
  "graph": {
    "nodes": [
      { "id": "frontend", "agent": "recon", "task": "Find frontend auth for {task}" },
      { "id": "backend", "agent": "recon", "task": "Find backend auth for {task}" },
      { "id": "summary", "agent": "strategist", "dependsOn": ["frontend", "backend"], "task": "Plan from:\n{node.frontend}\n{node.backend}" }
    ],
    "debrief": { "agent": "debrief" }
  }
}
```

Each node has `id`, `agent`, `task`, optional `dependsOn`, and the usual
`model`/`tools`/`cwd` overrides. Node tasks can use `{task}` and dependency
output placeholders like `{node.frontend}`. Graphs are capped at 16 nodes.

## Loop mode (generic bounded loop)

`loop` repeats a body agent until the body emits `LOOP: DONE`, or until an
optional judge emits `VERDICT: PASS`.

```json
{
  "task": "Draft release notes",
  "loop": {
    "body": { "agent": "operator" },
    "judge": { "agent": "redteam" },
    "maxIterations": 3
  }
}
```

If the loop reaches `maxIterations` without a stop signal, pi-flows returns
`LOOP_DID_NOT_CONVERGE` with the last output/critique.

## Search mode (bounded beam search)

`search` generates candidate paths, scores each candidate with `SCORE: 0..100`,
keeps the best beam, optionally refines for more rounds, then debriefs the
winning beam.

```json
{
  "task": "Pick a cache strategy",
  "search": {
    "generator": { "agent": "strategist" },
    "scorer": { "agent": "redteam", "tools": "none" },
    "debrief": { "agent": "debrief" },
    "candidates": 3,
    "beamWidth": 1,
    "maxRounds": 2
  }
}
```

Use `search` when several plausible plans or artifacts should be explored and
ranked before synthesis. It is intentionally bounded by candidate count, beam
width, rounds, concurrency, timeout, and cost/token ceilings.

If `scorer` is omitted, it defaults to `redteam` with `tools:"none"` so
parallel scoring cannot mutate the workspace.

## Workflow mode (gated, resumable phases)

`workflow` runs an ordered state machine of work phases and approval nodes. It
persists redacted outputs after every phase, so a headless approval pause or a
later retry does not discard completed work.

```json
{
  "task": "Ship the cache migration",
  "workflow": {
    "stateFile": ".pi/flow-workflows/cache-migration.json",
    "phases": [
      {
        "id": "plan",
        "agent": "strategist",
        "task": "Produce an evidence-backed rollout plan for {task}",
        "requireEvidence": true
      },
      {
        "id": "approve",
        "approval": { "message": "Approve the rollout plan?" }
      },
      {
        "id": "apply",
        "agent": "operator",
        "task": "Implement the approved plan:\n{phase.plan}",
        "checkCommand": "npm test"
      }
    ],
    "debrief": { "agent": "debrief" }
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `workflow.phases` | required | Ordered `1..12` phases with unique `id` values. Each phase is exactly one kind: `agent` + `task`, or `approval.message`. |
| `workflow.stateFile` | `.pi/flow-workflows/<digest>.json` | Audit/resume state. The digest covers the top-level task, phases, and debrief configuration. The file is written atomically with owner-only permissions. |
| `workflow.resume` | `false` | Load completed phases from `stateFile`. The task and workflow digest must match. |
| `workflow.debrief` | (none) | Optional final synthesizer over all persisted phase artifacts. |
| `phase.task` | required for work | Supports `{task}`, `{previous}`, and `{phase.<id>}` output placeholders. |
| `phase.checkCommand` | (none) | Deterministic gate run in the phase `cwd`; non-zero stops with `WORKFLOW_GATE_FAILED`. |
| `phase.cwd` / `model` / `tools` | inherited | Per-phase process and gate overrides. |
| `phase.returnContract` / `requireEvidence` | top-level values | Per-phase handoff requirements. |

Interactive approval nodes call the Pi confirmation UI. In headless contexts they
fail closed with `WORKFLOW_APPROVAL_REQUIRED` after persisting completed artifacts
and the next phase. Resume the same task/phases/state file in an interactive UI
with `workflow.resume:true`. A denied approval returns
`WORKFLOW_APPROVAL_DENIED`; it never silently advances.

## Worktree mode (isolated writers and integration)

`worktree` provisions one branch and temporary git worktree per writer, runs the
writers concurrently, commits each result, merges them into a separate integration
branch, asks an integrator to review/fix the combined result, and optionally runs
a deterministic integration check.

```json
{
  "task": "Fix frontend and backend auth, then verify the integrated result",
  "worktree": {
    "baseRef": "HEAD",
    "tasks": [
      { "id": "frontend", "agent": "operator", "task": "Fix frontend auth only" },
      { "id": "backend", "agent": "operator", "task": "Fix backend auth only" }
    ],
    "integrator": { "agent": "operator" },
    "checkCommand": "npm test",
    "checkTimeoutMs": 120000
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `worktree.tasks` | required | `2..8` independent write tasks. Each needs a unique `id`, `agent`, and concrete `task`. Evidence is required by default. |
| `worktree.baseRef` | `HEAD` | Existing commit, branch, or tag from which every worker and the integration branch starts. |
| `worktree.integrator` | `{ agent: "operator" }` | Resolves merge conflicts, reviews the integrated diff, and may make integration fixes. |
| `worktree.checkCommand` | (none) | Deterministic command run on the integration branch after integration review. |
| `worktree.checkTimeoutMs` | flow timeout | Timeout for the integration command; minimum 1000 ms. |
| `worktree.requireClean` | `true` | Refuses a dirty source checkout. `false` still branches from committed `baseRef`; uncommitted source changes are intentionally omitted. |

The source checkout is never switched or merged by the mode. On success,
temporary worktrees and worker branches are removed, while the durable
`pi-flow/<run>/integration` branch remains for explicit review/merge. Verification
failure returns the integration branch name instead of merging an unverified
result. Use this mode only when the tasks are genuinely independent; one writer
belongs in `single` or `evaluate`.

## Debate mode (advocates and adjudicator)

`debate` runs independent advocates on the same decision question, exposes the
prior round for rebuttal, then asks a separate adjudicator to choose against the
original constraints rather than majority or rhetoric.

```json
{
  "task": "Choose queue migration A or B against every constraint in decision.md",
  "debate": {
    "participants": [
      { "agent": "strategist" },
      { "agent": "analyst" }
    ],
    "adjudicator": { "agent": "overwatch" },
    "rounds": 2
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `debate.participants` | required | `2..8` advocates. Different agents/models reduce correlated reasoning. |
| `debate.adjudicator` | `{ agent: "analyst" }` | Independently checks source material and returns one decision, constraint matrix, tradeoffs, mitigations, and reversal conditions. |
| `debate.rounds` | `2` | Integer `1..3`. Round 1 opens independently; later rounds rebut and repair positions. |

At least two advocates must produce usable arguments in every round. Debate is
deliberately expensive; use it for high-consequence choices with real opposing
cases, not quick preferences or questions one fact already settles.

## Dossier mode (evidence map/reduce)

`dossier` assigns each source or claim family to an extractor, then synthesizes
the successful sections into a source-grounded answer without smoothing conflicts.

```json
{
  "task": "Explain the deployment incident and preserve source conflicts",
  "dossier": {
    "sections": [
      { "agent": "recon", "task": "Extract evidence from runbook.md only" },
      { "agent": "recon", "task": "Extract evidence from config.yaml only" },
      { "agent": "analyst", "task": "Extract evidence from incident.md only" }
    ],
    "debrief": { "agent": "debrief" }
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `dossier.sections` | required | `2..8` `FlowTask` entries, normally one per source or claim family. `requireEvidence` defaults to `true` for extraction. |
| `dossier.debrief` | `{ agent: "debrief" }` | Produces findings, cited claims, a conflict table, confidence by claim, unresolved gaps, and next evidence. |

At least two extractors must succeed or the mode returns
`DOSSIER_TOO_FEW_SECTIONS`; one surviving source cannot support cross-source
reconciliation. Prefer read-only `recon`/`analyst` extractors unless source
preparation genuinely requires writes.

## Monitor mode (bounded trigger and react)

`monitor` runs a deterministic shell probe under a hard check/time bound. It does
not spawn an agent until a typed trigger fires; the captured observation then
becomes untrusted evidence for one reactor agent.

```json
{
  "task": "Diagnose the first degraded health event",
  "monitor": {
    "command": "./health-check",
    "trigger": "match",
    "pattern": "DEGRADED",
    "intervalMs": 5000,
    "maxChecks": 6,
    "checkTimeoutMs": 30000,
    "reactor": { "agent": "analyst" }
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `monitor.command` | required | Shell probe run in the flow `cwd`. This is an observation source, not an agent task. |
| `monitor.trigger` | `success` | `success` for exit 0, `failure` for non-zero, or `match` for a case-insensitive JavaScript regex over capped output. |
| `monitor.pattern` | (none) | Required when `trigger:"match"`; invalid regexes return `MONITOR_INVALID`. |
| `monitor.intervalMs` | `5000` | Delay between probes, `10..60000` ms. |
| `monitor.maxChecks` | `6` | Hard attempt bound, `1..20`. |
| `monitor.checkTimeoutMs` | flow timeout | Per-probe command timeout; minimum 1000 ms. |
| `monitor.reactor` | `{ agent: "analyst" }` | Diagnoses impact/cause, recommends bounded actions, and names missing evidence after a trigger. |

If no trigger fires, the mode returns retryable `MONITOR_NOT_TRIGGERED` plus the
bounded observations. `monitor` is not durable scheduling: it stops when the flow
call ends and should not replace a daemon, cron job, alerting system, or Codex
automation.

## Human checkpoints and Reflexion

`checkpoint` adds an explicit human approval gate:

```json
{ "task": "...", "evaluate": {}, "checkpoint": { "before": "spawn" } }
```

`before:"spawn"` asks before any child agent runs. `before:"finalize"` asks after
child work finishes but before the final answer is returned. In headless
contexts, checkpoints fail closed with `CHECKPOINT_APPROVAL_REQUIRED`.

This top-level checkpoint wraps any mode. `workflow` approval phases are different:
they can appear between persisted work phases and resume from `workflow.stateFile`.

`reflexion` is opt-in local cross-run learning:

```json
{ "task": "...", "loop": { "body": { "agent": "operator" } }, "reflexion": { "enabled": true } }
```

When enabled, recent lessons are read from `.pi/flow-reflections.jsonl` and
prepended to compatible prompts. Completed `evaluate`, `orchestrate`, `graph`,
`loop`, and `search` runs append redacted lessons to that JSONL file.

## Details object

`flow` returns content plus `details`:

- `version`: pi-flows version.
- `mode`: `list`, `config`, `single`, `parallel`, `chain`, `evaluate`, `vote`, `route`, `orchestrate`, `graph`, `loop`, `search`, `workflow`, `worktree`, `debate`, `dossier`, or `monitor`.
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
/flows inspect
/flows report [trace-file]
```

Invalid arguments return an error instead of silently falling back to another scope.
