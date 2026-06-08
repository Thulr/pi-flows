# pi-flows

**Delegate work to isolated sub-agents from inside [pi](https://github.com/earendil-works/pi) — with proven multi-agent patterns, safety, cost limits, and tracing built in.**

pi-flows adds a single `flow` tool to the pi coding agent. It runs your task in separate, disposable pi subprocesses — from a single specialist to a parallel fan-out, a generate-and-critique loop, or a full decompose-and-synthesize — so heavy exploration and verification happen in clean contexts instead of bloating your main session.

## Why use it

- **Keep your main context clean.** Sub-agents explore, build, and review in their own subprocess and hand back a compact result — not a wall of tool output.
- **Proven patterns, one tool.** `single`, `parallel`, `chain`, `evaluate`, `vote`, `route`, and `orchestrate` — each a named agent-design pattern (from Anthropic's *Building Effective Agents*, Andrew Ng, and Google's ADK), not an ad-hoc prompt. See [Patterns](./docs/patterns.md).
- **Safe by default.** Repo-controlled agent prompts fail closed in headless runs, secrets and home paths are redacted, inter-agent handoffs are scanned for prompt injection, concurrent write agents cannot share one checkout unless you opt in, and read-only agents (`recon`, `analyst`) ship with no shell. See [Safety model](#safety-model).
- **Bounded — including cost.** Every run is capped on count, time, and nesting depth; `maxCostUsd` / `maxTokens` cap total spend across the whole flow tree.
- **Inspectable.** Structured errors that name the fix, an offline test suite, and OpenInference-shaped trace export you can read with `jq` or any OpenTelemetry backend.

## What it looks like

You talk to pi in plain English — it reads the `flow` tool and writes the call for you. Load the extension, then just ask:

```text
Have a read-only agent find the API routes for billing.
```

pi delegates that to `recon`, which runs in its own subprocess and hands back just the findings. You never hand-write JSON — pi fills in the agent and the mode. (The call here is `{"agent":"recon","task":"Find the API routes for billing"}`; these docs show the JSON as the exact contract, for when you want to verify it or take manual control.)

Ask for a *verified* result and pi reaches for a stronger mode on its own:

```text
Add a /health endpoint that returns 200 and a JSON status, with a test — and don't call it done until `npm test` passes.
```

pi runs this as an evaluate loop — the `operator` builds the change, a separate `redteam` critic judges the result, and `npm test` must exit `0`, revising until both pass or it hits `maxIterations`. The call behind it:

```json
{
  "task": "Add a /health endpoint that returns 200 and a JSON status, with a test",
  "evaluate": { "checkCommand": "npm test", "maxIterations": 3 }
}
```

→ [Quickstart](./docs/quickstart.md)

## Install

pi-flows runs inside the [pi](https://github.com/earendil-works/pi) coding agent, so you install it as a pi package — no clone required.

**Prerequisites:** Node.js `>=24`, npm `>=11`, and the pi CLI `>=0.78.0` on your `PATH`. Don't have pi? It ships in `@earendil-works/pi-coding-agent`:

```bash
npm i -g @earendil-works/pi-coding-agent
```

Install it with the `pi` CLI — from npm for the published release, or from GitHub to track `main`:

```bash
# From npm (recommended) — the published release
pi install npm:pi-flows

# Add -l to install into the current project only (.pi/settings.json)
pi install -l npm:pi-flows

# Or track the latest main straight from GitHub, no clone required
pi install git:github.com/Thulr/pi-flows
```

Reload pi with `/reload` (or restart it), then verify — `/flows version` is a command, and the second line is plain English that pi turns into a `flow` call:

```text
/flows version
list the available flow agents
```

Success looks like all nine bundled agents in the `flow list` output — `recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, and `debrief`. If pi isn't found, see [Troubleshooting → `pi: command not found`](./docs/troubleshooting.md#pi-command-not-found). → [Quickstart](./docs/quickstart.md)

## Run from a clone (development)

To hack on pi-flows or try unreleased `main`, work from a checkout:

```bash
git clone https://github.com/Thulr/pi-flows
cd pi-flows
npm ci
npm run preflight   # verify the pi CLI is installed and on PATH
pi -e ./extensions/pi-flows/index.ts   # load the local extension in pi
```

Inside pi, smoke-test with no model call:

```text
/flows help
/flows status
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

Or install your working copy as a package with `pi install -l ./`. See [Development](#development) for the build/test loop and [Contributing](./CONTRIBUTING.md).

## What it adds

- `flow` tool: runs isolated pi subprocesses for single, parallel, chain, evaluate (generator-evaluator), vote, route, and orchestrate delegation.
- `/flows` command: lists available flow agents and shows help/status/version output.
- Bundled agents in [`agents/`](./agents/): `recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, and `debrief`.
- User agents: `~/.pi/agent/flow-agents/*.md`.
- Project agents: `.pi/flow-agents/*.md` when `agentScope: "project"` or `"all"` is used.

## Safety model

Project-local agents are repo-controlled prompts. In interactive pi sessions, pi-flows asks before running them. In headless (non-UI) runs, pi-flows **fails closed by default** and refuses project-local agents unless you explicitly pass `confirmProjectAgents:false` after reviewing the files.

pi-flows also redacts secret-shaped content and home paths from returned content/details by default. Inter-agent **handoffs** — where one child's output becomes another child's prompt (`{previous}` in chain, the evaluate artifact, vote ballots, orchestrate findings) — are an indirect prompt-injection surface, so pi-flows strips invisible/bidi characters and flags instruction-override markers in that content before reuse, surfacing a warning rather than silently trusting it. See [Privacy & telemetry](./docs/privacy-telemetry.md).

Cost is bounded as well as count and time: pass `maxCostUsd` / `maxTokens` to cap cumulative spend across the whole flow tree (`BUDGET_EXCEEDED` once reached). Concurrent fan-out also refuses multiple write-capable agents in the same `cwd` (`SHARED_WRITE_CWD`) unless `allowSharedWriteCwd:true` is explicit. Read-only agents (`recon`, `analyst`) ship **without** a shell, so their read-only boundary is enforced by the toolset, not by prompt instructions alone.

## `flow` tool quick reference

You don't type these objects — you describe what you want and pi builds the call. This is the exact contract behind those requests: skim it to see what pi will run, or to take manual control (pin a specific agent, model, or budget). Each block is the JSON pi passes to the `flow` tool.

### List

```json
{ "list": true }
```

### Show effective config

```json
{ "showConfig": true }
```

### Single

```json
{ "agent": "recon", "task": "Find the API routes for billing" }
```

### Parallel

```json
{
  "tasks": [
    { "agent": "recon", "task": "Find frontend auth code" },
    { "agent": "recon", "task": "Find backend auth code" }
  ],
  "concurrency": 2
}
```

Defaults: `concurrency=4` (per-call). `maxParallelTasks` is a fixed hard cap of `8`, not a per-call input.

### Chain

```json
{
  "task": "Add Redis caching to the session store",
  "chain": [
    { "agent": "recon", "task": "Research this task: {task}" },
    { "agent": "strategist", "task": "Plan using this context:\n\n{previous}" }
  ]
}
```

Chain `{previous}` handoffs are capped, redacted, and scanned for injection before they become the next prompt.

### Evaluate (generator-evaluator loop)

```json
{
  "task": "Add a /health endpoint that returns 200 and a JSON status, with a test",
  "evaluate": {
    "operator": { "agent": "operator" },
    "redteam": { "agent": "redteam" },
    "checkCommand": "npm test",
    "maxIterations": 3
  }
}
```

The `operator` builds against `task`; a separate `redteam` judges the artifact (not the builder's trace) and returns `VERDICT: PASS` or `VERDICT: REVISE` with critique. On `REVISE` the operator is re-shown its prior artifact plus the critique and revises in place. The loop revises until it passes or hits `maxIterations` (default 3, cap 8).

Two optional reliability levers: **`checkCommand`** is a deterministic gate (a shell command that must exit `0` — level-1 code assertions alongside the LLM critic; non-zero is an automatic `REVISE`), and **`redteam` may be an array** of critics (a decomposed panel — e.g. one per dimension; `PASS` requires all of them). See [Flow reference](./docs/flow-reference.md#evaluate-mode-generator-evaluator-loop).

### Vote (parallelization / voting)

```json
{
  "task": "Is /^(a+)+$/ vulnerable to catastrophic backtracking?",
  "vote": { "voters": [{ "agent": "recon" }, { "agent": "overwatch" }], "debrief": { "agent": "debrief" } }
}
```

Runs the same task across ≥2 voters (use different models to break correlated errors) and synthesizes one answer via the optional `debrief` aggregator. Without it, all answers are returned.

### Route (classify → dispatch)

```json
{ "task": "The billing webhook returns 500s in prod", "route": { "candidates": ["recon", "strategist", "overwatch"], "fallback": "recon" } }
```

The `controller` picks one candidate (`ROUTE: <agent>`) and runs it — or emits `ROUTE: none` when nothing fits, falling back instead of forcing a guess.

### Orchestrate (decompose → fan out → synthesize)

```json
{
  "task": "Document how auth works across the codebase",
  "returnContract": "Return sections for login, token refresh, session storage, and gaps.",
  "requireEvidence": true,
  "orchestrate": {
    "recon": { "agent": "recon" },
    "verify": { "agent": "overwatch" },
    "verifyPolicy": "revise",
    "maxSubtasks": 5
  }
}
```

The `commander` splits the task into a JSON list of subtasks, `recon` workers run them in parallel, and the `debrief` agent merges the findings. An optional `verify` critic checks the merged answer against the goal in the same call. `verifyPolicy:"note"` keeps the verdict advisory, `"fail"` hard-fails on `REVISE`, and `"revise"` reruns `debrief` with the critique until pass or `verifyMaxIterations`.

### Cost budget and tracing

Any mode accepts a cumulative spend ceiling and a trace sink:

```json
{ "task": "...", "orchestrate": {}, "maxCostUsd": 0.50, "traceFile": "flow-trace.jsonl", "traceLabel": "release-gate" }
```

`maxCostUsd` / `maxTokens` cap total spend across the whole flow tree (`BUDGET_EXCEEDED` once reached). `traceFile` (or `PI_FLOWS_TRACE_FILE`) appends one OpenInference-shaped JSON span per child plus a root span — JSONL any OpenTelemetry backend, or a coding agent, can read. Summarize local traces with `/flows report flow-trace.jsonl` or `npm run trace:report -- flow-trace.jsonl` from a checkout.

## Agent definition format

Create markdown files with YAML frontmatter:

```md
---
name: my-agent
description: What this agent does
tools: read,grep,find,ls
tier: capable
---

System prompt for the delegated agent.
```

`tier` keeps agents portable — no vendor model is hard-coded. `capable` runs on your pi default model; `fast` runs on `PI_FLOWS_FAST_MODEL` if you set one (e.g. a cheaper model for your provider, like `openai-codex/gpt-5.4-mini`), otherwise your default too. So flows use whatever model you have pi set up with, and the extension never needs updating as providers ship new models. Pin an explicit `model:` to override the tier (a flow-call `model` overrides too). `tools: none` disables built-in tools. Omitting `tools` uses pi defaults. Invalid agent files are reported in `/flows status` and `flow showConfig:true`.

## Documentation ladder

- [Quickstart](./docs/quickstart.md)
- [Flow reference](./docs/flow-reference.md)
- [Patterns](./docs/patterns.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Privacy & telemetry](./docs/privacy-telemetry.md)
- [Examples](./examples/README.md)
- [Contributing](./CONTRIBUTING.md)
- [Agent instructions](./AGENTS.md)
- [Changelog](./CHANGELOG.md)

## Development

```bash
npm ci
npm run check
```

Useful individual checks:

```bash
npm run typecheck
npm test
npm run validate:agents
npm run pack:dry-run
```
