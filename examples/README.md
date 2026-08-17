# pi-flows examples

You can copy and paste these examples into pi after you load the extension:

```bash
pi -e ./extensions/pi-flows/index.ts
```

> **You do not type these JSON objects.** You talk to pi in plain English, and pi builds the `flow` call for you. pi selects the agent and the mode from what you ask. The objects below use the exact tool interface. Copy and paste them when you want to see the exact behavior or take manual control. Most have a natural-language equivalent. For example, the single-agent example below is *"scout the repo for the extension entrypoint and summarize what it registers."*

## No-model smoke checks

```text
/flows help
/flows status
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

Expected: output lists all nine bundled agents (`recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, `debrief`).

## Single-agent example

Plain English: *"scout the repo for the extension entrypoint and summarize what it registers."* The call pi builds:

```json
{ "agent": "recon", "task": "Find the extension entrypoint and summarize what it registers", "why": "user asked for a delegated read-only scout" }
```

Expected: recon returns paths including `extensions/pi-flows/index.ts` and mentions `flow` plus `/flows`.

## Delegation-contract single-agent example

```json
{
  "agent": "recon",
  "contract": {
    "objective": "Find the extension entrypoint.",
    "constraints": ["Read only."],
    "nonGoals": ["Do not modify source files."],
    "dependencies": ["extensions/pi-flows"],
    "authority": {
      "may": ["Read repository files."],
      "mustNot": ["Write repository files."],
      "requiresApproval": []
    },
    "sideEffectClass": "read-only",
    "budget": { "timeoutMs": 30000, "maxGeneratedTokens": 2000 },
    "acceptanceChecks": ["Return the exact entrypoint path."],
    "returnSchema": {
      "type": "object",
      "required": ["entrypoint"],
      "properties": { "entrypoint": { "type": "string" } },
      "additionalProperties": false
    },
    "owner": "parent"
  },
  "why": "user asked for a delegated read-only scout with a validated handoff"
}
```

Expected: `details.results[0].envelope` has
`schemaVersion:"pi-flows.return-envelope.v1"`, the dispatched delegation contract's
`sha256:` `contractId`, declared evidence and schema-checked `data`, plus runtime usage. A
response whose `data` violates `returnSchema` returns
`RETURN_ENVELOPE_INVALID`. A declared SHA-256 digest that does not match its
artifact returns `RETURN_DIGEST_MISMATCH`. Integration modes also reject
missing or stale identities with `RETURN_CONTRACT_MISMATCH`.

## Parallel example

```json
{
  "tasks": [
    { "agent": "recon", "task": "Find docs and README surfaces", "tier": "fast" },
    { "agent": "recon", "task": "Find package/test scripts", "tier": "fast" }
  ],
  "concurrency": 2,
  "why": "docs and scripts are independent areas worth inspecting in parallel"
}
```

Expected: both tasks complete, and details include one result per agent and durations.
Raw parallel calls must set `tier` or `model` per task. Alternatively, set one
flow-wide `tier` or `model` when uniform sizing is intentional.
Each task can also set a delegation `contract`. Valid return envelopes and legacy prose results are
normalized into `details.results[*].handoff`. Prose uses
`compatibility:"legacy-prose"`. Contracted handoffs preserve delegation-contract identity,
status, evidence, artifacts, and source provenance. `partial`/`blocked` contracted
returns stop by default. Set `incompleteHandoffPolicy:"include"` only when
incomplete synthesis is an intentional policy choice.

## Chain example

```json
{
  "task": "Improve flow error messages",
  "handoffPolicy": "quarantine",
  "chain": [
    { "agent": "recon", "task": "Find error-handling code for this task: {task}" },
    { "agent": "strategist", "task": "Plan the change using this context:\n\n{previous}" }
  ],
  "why": "research and planning benefit from a fresh planning context fed a bounded handoff"
}
```

`quarantine` lets the planning step run but replaces any injection-shaped recon
payload with a fixed marker. For a high-consequence resumable workflow, combine
`"handoffPolicy":"warn"` with
`"modeHandoffPolicy":{"workflow":"fail"}`. The mode requirement wins and is
bound into workflow approval receipts.

Expected: recon output is capped/redacted before it becomes strategist context.

## Evaluate example (generator-evaluator loop)

```json
{
  "task": "Write a function that parses a duration string like \"1h30m\" into seconds, with tests",
  "evaluate": {
    "operator": { "agent": "operator" },
    "redteam": { "agent": "redteam" },
    "maxIterations": 3,
    "passContract": "Handles hours, minutes, seconds, and mixed forms; rejects invalid input; tests pass."
  },
  "why": "the result needs verification by a critic independent of the author"
}
```

Expected: `details.results` interleaves `operator` and `redteam` runs (one pair per iteration). The loop stops early on `VERDICT: PASS`. Otherwise it returns the last attempt plus the final critique after 3 iterations.

### With a deterministic gate and a critic panel

```json
{
  "task": "Add a /health endpoint returning 200 and {status:'ok'}, with a test",
  "evaluate": {
    "operator": { "agent": "operator" },
    "redteam": [{ "agent": "redteam" }, { "agent": "overwatch" }],
    "checkCommand": "npm test",
    "maxIterations": 4
  },
  "why": "the result needs an author-independent critic panel plus a deterministic gate"
}
```

Expected: each round, `npm test` must exit `0`. A failing run is an automatic `REVISE` whose output becomes the critique, and the LLM critics are skipped that round. When the gate passes, **both** `redteam` and `overwatch` must return `VERDICT: PASS` for the loop to pass. A `checkCommand` that cannot start returns `CHECK_COMMAND_FAILED`.

## Vote example (parallelization / voting)

```json
{
  "task": "Does this loop have an off-by-one error? for (i=0;i<=n;i++) arr[i]=0;",
  "vote": {
    "voters": [{ "agent": "recon" }, { "agent": "recon", "model": "claude-haiku-4-5" }, { "agent": "overwatch" }],
    "debrief": { "agent": "debrief" }
  },
  "why": "independent votes suppress a single model's non-deterministic error"
}
```

Expected: three independent answers, which the `debrief` agent merges into one consensus answer. Remove `debrief` to get all three answers back instead.

## Route example (classify → dispatch)

```json
{
  "task": "Plan how to add rate limiting to the public API",
  "route": { "candidates": ["recon", "strategist", "overwatch"], "fallback": "strategist" },
  "why": "the right agent for this request is not obvious up front"
}
```

Expected: the `controller` emits `ROUTE: strategist`, then strategist runs the task. `details.results` is `[controller, strategist]`.

## Orchestrate example (decompose → fan out → synthesize)

```json
{
  "task": "Summarize how this repo handles errors, logging, and configuration",
  "orchestrate": { "recon": { "agent": "recon" }, "maxSubtasks": 3 },
  "why": "a broad three-area map is more reading than one context should serialize"
}
```

Expected: the `commander` returns ~3 subtasks, three `recon` workers run in parallel, and the `debrief` agent merges them. `details.results` is `[commander, ...workers, debrief]`.

Add `"verify": { "agent": "overwatch" }` to `orchestrate` to append a `VERDICT: PASS/REVISE` gate on the merged answer. `details.results` then ends `[..., debrief, verify]`.

### With dependent subtasks

```json
{
  "task": "Explain how a request is authenticated, from the entry point to the session store",
  "orchestrate": { "recon": { "agent": "recon" }, "maxSubtasks": 6 },
  "why": "the later reading only makes sense after the entry points are known"
}
```

Expected: the `commander` can return subtask objects instead of subtask strings. For example, it returns a `survey` subtask, plus `login` and `refresh` subtasks that both declare `"dependsOn": ["survey"]`. The `survey` worker runs first. The two dependent workers then run together, and each prompt carries the survey output as untrusted data. If `survey` fails, both dependents are stranded, and the flow header reports `1 failed, 2 stranded`. A defective decomposition returns `DECOMPOSITION_INVALID` or `DECOMPOSITION_CYCLE` before any worker starts.

## Workflow example

```json
{
  "task": "Ship the cache migration",
  "workflow": {
    "phases": [
      { "id": "plan", "agent": "strategist", "task": "Plan {task}" },
      { "id": "approve", "approval": { "message": "Approve the migration plan?" } },
      { "id": "apply", "agent": "operator", "task": "Apply {phase.plan}", "tools": "read,bash,edit,write", "thinking": "medium", "checkCommand": "npm test" }
    ]
  },
  "why": "the migration needs gated phases with a resumable human approval"
}
```

## Worktree example

```json
{
  "task": "Fix frontend and backend auth, then integrate",
  "worktree": {
    "tasks": [
      { "id": "frontend", "agent": "operator", "task": "Fix frontend auth" },
      { "id": "backend", "agent": "operator", "task": "Fix backend auth" }
    ],
    "checkCommand": "npm test"
  },
  "why": "two concurrent writers need isolated worktrees and a gate-checked integration branch"
}
```

## Debate example

```json
{
  "task": "Choose queue A or B against the migration constraints",
  "debate": {
    "participants": [{ "agent": "strategist" }, { "agent": "analyst" }],
    "adjudicator": { "agent": "overwatch" },
    "rounds": 2
  },
  "why": "user asked for opposing advocates and independent adjudication"
}
```

## Dossier example

```json
{
  "task": "Reconcile the deployment incident evidence",
  "dossier": {
    "sections": [
      { "agent": "recon", "task": "Extract evidence from runbook.md" },
      { "agent": "analyst", "task": "Extract evidence from incident.md" }
    ]
  },
  "why": "two sources must be cited and reconciled without smoothing conflicts away"
}
```

## Monitor example

```json
{
  "task": "Diagnose the first degraded health check",
  "monitor": {
    "command": "./health-check",
    "trigger": "match",
    "pattern": "DEGRADED",
    "intervalMs": 5000,
    "maxChecks": 6
  },
  "why": "a bounded probe must fire before a fresh context diagnoses the event"
}
```

## Resource budget and tracing example

```json
{
  "task": "Summarize how this repo handles errors, logging, and configuration",
  "orchestrate": { "recon": { "agent": "recon" }, "maxSubtasks": 3 },
  "maxCostUsd": 0.25,
  "maxGeneratedTokens": 4000,
  "traceFile": "flow-trace.jsonl",
  "why": "a broad three-area map is more reading than one context should serialize"
}
```

Expected: when cumulative cost reaches `$0.25` or generated output reaches 4,000
tokens at a completed model-response boundary, the active child stops and no
further child is spawned (`BUDGET_EXCEEDED`). `flow-trace.jsonl` gains one
OpenInference-shaped span per child plus a root `flow.orchestrate` span. Examine
it with `jq` — for example, the total cost:
`jq -s 'map(.attributes["flow.cost_usd"] // 0) | add' flow-trace.jsonl`.

## User custom-agent example

Create `~/.pi/agent/flow-agents/hello.md`:

```md
---
name: hello-flow
description: Says hello with no tools
tools: none
---

You are a tiny test agent. Reply with exactly: hello from flow
```

Then run:

```json
{ "agent": "hello-flow", "task": "Say hello", "why": "smoke-testing a custom user agent end to end" }
```

## Project-agent example

Create `.pi/flow-agents/project-check.md` in a trusted repo:

```md
---
name: project-check
description: Reviews this project using repo-local instructions
tools: read,grep,find,ls
---

Follow AGENTS.md and report the most relevant check command.
```

Interactive sessions prompt before they run this agent. Headless runs refuse unless you pass:

```json
{
  "agent": "project-check",
  "task": "What check should I run?",
  "agentScope": "project",
  "confirmProjectAgents": false,
  "why": "user asked to run the repo-local reviewer agent"
}
```

Set `confirmProjectAgents:false` only after you review the project-local prompt.

## Error-case examples

Missing delegation justification:

```json
{ "agent": "recon", "task": "Find the API routes" }
```

Expected error code: `WHY_REQUIRED` (every spawning call needs a one-sentence `why`, and `list`/`showConfig` are exempt).

Unknown agent:

```json
{ "agent": "not-real", "task": "test", "why": "error-path demo" }
```

Expected error code: `UNKNOWN_AGENT`.

Bad concurrency:

```json
{ "tasks": [{ "agent": "recon", "task": "test" }], "concurrency": 1.5, "why": "error-path demo" }
```

Expected error code: `INVALID_CONCURRENCY`.

Budget exhausted before any child runs:

```json
{ "agent": "recon", "task": "Find the API routes", "maxCostUsd": 0, "why": "error-path demo" }
```

Expected error code: `BUDGET_EXCEEDED` (the ceiling trips before the first child spawns).

Headless project-agent refusal:

```json
{
  "agent": "project-check",
  "task": "test",
  "agentScope": "project",
  "why": "error-path demo"
}
```

Expected in non-UI: `PROJECT_AGENT_APPROVAL_REQUIRED`.

## Cleanup

Remove the example agents after the checks:

```bash
rm -f ~/.pi/agent/flow-agents/hello.md
rm -f .pi/flow-agents/project-check.md
```
