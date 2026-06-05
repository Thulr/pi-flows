# pi-flows examples

These examples are designed to be copy/pasteable in pi after loading the extension:

```bash
pi -e ./extensions/pi-flows/index.ts
```

## No-model smoke checks

```text
/flows help
/flows status
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

Expected: output lists all nine bundled agents (`recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, `debrief`).

## Single-agent example

```json
{ "agent": "recon", "task": "Find the extension entrypoint and summarize what it registers" }
```

Expected: recon returns paths including `extensions/pi-flows/index.ts` and mentions `flow` plus `/flows`.

## Parallel example

```json
{
  "tasks": [
    { "agent": "recon", "task": "Find docs and README surfaces" },
    { "agent": "recon", "task": "Find package/test scripts" }
  ],
  "concurrency": 2
}
```

Expected: both tasks complete; details include one result per agent and durations.

## Chain example

```json
{
  "task": "Improve flow error messages",
  "chain": [
    { "agent": "recon", "task": "Find error-handling code for this task: {task}" },
    { "agent": "strategist", "task": "Plan the change using this context:\n\n{previous}" }
  ]
}
```

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
  }
}
```

Expected: `details.results` interleaves `operator` and `redteam` runs (one pair per iteration); the loop stops early on `VERDICT: PASS`, otherwise returns the last attempt plus the final critique after 3 iterations.

### With a deterministic gate and a critic panel

```json
{
  "task": "Add a /health endpoint returning 200 and {status:'ok'}, with a test",
  "evaluate": {
    "operator": { "agent": "operator" },
    "redteam": [{ "agent": "redteam" }, { "agent": "overwatch" }],
    "checkCommand": "npm test",
    "maxIterations": 4
  }
}
```

Expected: each round, `npm test` must exit `0` (a failing run is an automatic `REVISE` whose output becomes the critique, and the LLM critics are skipped that round); when the gate passes, **both** `redteam` and `overwatch` must return `VERDICT: PASS` for the loop to pass. A `checkCommand` that cannot start returns `CHECK_COMMAND_FAILED`.

## Vote example (parallelization / voting)

```json
{
  "task": "Does this loop have an off-by-one error? for (i=0;i<=n;i++) arr[i]=0;",
  "vote": {
    "voters": [{ "agent": "recon" }, { "agent": "recon", "model": "claude-haiku-4-5" }, { "agent": "overwatch" }],
    "debrief": { "agent": "debrief" }
  }
}
```

Expected: three independent answers; the `debrief` agent returns one consensus answer. Drop `debrief` to get all three answers back instead.

## Route example (classify → dispatch)

```json
{
  "task": "Plan how to add rate limiting to the public API",
  "route": { "candidates": ["recon", "strategist", "overwatch"], "fallback": "strategist" }
}
```

Expected: the `controller` emits `ROUTE: strategist`, then strategist runs the task. `details.results` is `[controller, strategist]`.

## Orchestrate example (decompose → fan out → synthesize)

```json
{
  "task": "Summarize how this repo handles errors, logging, and configuration",
  "orchestrate": { "recon": { "agent": "recon" }, "maxSubtasks": 3 }
}
```

Expected: the `commander` returns ~3 subtasks, three `recon` workers run in parallel, and the `debrief` agent merges them. `details.results` is `[commander, ...workers, debrief]`.

Add `"verify": { "agent": "overwatch" }` to `orchestrate` to append a `VERDICT: PASS/REVISE` check on the merged answer; `details.results` then ends `[..., debrief, verify]`.

## Cost budget and tracing example

```json
{
  "task": "Summarize how this repo handles errors, logging, and configuration",
  "orchestrate": { "recon": { "agent": "recon" }, "maxSubtasks": 3 },
  "maxCostUsd": 0.25,
  "traceFile": "flow-trace.jsonl"
}
```

Expected: the run stops spawning children once cumulative cost reaches `$0.25` (returning `BUDGET_EXCEEDED` for any refused child), and `flow-trace.jsonl` gains one OpenInference-shaped span per child plus a root `flow.orchestrate` span. Inspect it with `jq` — e.g. total cost: `jq -s 'map(.attributes["flow.cost_usd"] // 0) | add' flow-trace.jsonl`.

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
{ "agent": "hello-flow", "task": "Say hello" }
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

Interactive sessions prompt before running this agent. Headless runs refuse unless you pass:

```json
{
  "agent": "project-check",
  "task": "What check should I run?",
  "agentScope": "project",
  "confirmProjectAgents": false
}
```

Only set `confirmProjectAgents:false` after reviewing the project-local prompt.

## Error-case examples

Unknown agent:

```json
{ "agent": "not-real", "task": "test" }
```

Expected error code: `UNKNOWN_AGENT`.

Bad concurrency:

```json
{ "tasks": [{ "agent": "recon", "task": "test" }], "concurrency": 1.5 }
```

Expected error code: `INVALID_CONCURRENCY`.

Budget exhausted before any child runs:

```json
{ "agent": "recon", "task": "Find the API routes", "maxCostUsd": 0 }
```

Expected error code: `BUDGET_EXCEEDED` (the ceiling trips before the first child spawns).

Headless project-agent refusal:

```json
{
  "agent": "project-check",
  "task": "test",
  "agentScope": "project"
}
```

Expected in non-UI: `PROJECT_AGENT_APPROVAL_REQUIRED`.

## Cleanup

Remove example agents when done:

```bash
rm -f ~/.pi/agent/flow-agents/hello.md
rm -f .pi/flow-agents/project-check.md
```
