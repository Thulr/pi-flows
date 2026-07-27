# pi-flows

**Use [pi](https://github.com/earendil-works/pi) for the work you want to keep out of your main session: repo scouting, parallel investigation, implementation plus review, and large-task decomposition.**

pi-flows adds a `flow` tool that runs separate, disposable pi subprocesses and returns compact findings to the parent session. Instead of asking one long-running chat to explore, edit, review, remember every file it opened, and stay within budget, you can send bounded work to specialized child agents and keep the main thread focused on the decision.

## When it helps you

Use pi-flows when the next step would otherwise make your main pi session noisy, expensive, or hard to trust:

| Your situation | What you ask pi | What pi-flows gives back |
|---|---|---|
| You need to understand a code path before touching it. | "Have a read-only agent find the billing routes." | A compact, cited recon report from an agent that cannot mutate the repo or run shell commands. |
| You have several independent areas to inspect. | "Check frontend auth and backend auth in parallel." | Separate child runs with capped fan-out instead of one context stuffed with every file. |
| You want an implementation checked before you accept it. | "Add `/health` with a test, and don't call it done until `npm test` passes." | A bounded generator-evaluator loop where a builder, critic, and optional command gate must pass. |
| You have a broad research task. | "Document how auth works across login, refresh, and sessions." | Decompose, fan out, synthesize, and optionally verify the merged answer. |
| A release or migration has named gates and an approval point. | "Analyze, plan, verify, then pause for approval before rollout." | Persisted phase state, deterministic gates, and a resumable human approval node. |
| Several independent writers need to land one verified result. | "Fix frontend and backend in isolated worktrees, integrate them, then run tests." | Separate worker branches plus a durable, reviewed integration branch. |
| A consequential decision has credible opposing options. | "Have advocates test both queue designs against the constraints, then adjudicate." | Bounded rebuttal rounds and an independent decision record. |
| Several sources disagree or leave evidence gaps. | "Reconcile the runbook, deployed config, incident report, and ticket." | Source-specific extraction followed by cited synthesis that preserves conflicts and unknowns. |
| A transient condition must be captured before diagnosis. | "Poll health up to six times; on `DEGRADED`, hand the event to an analyst." | A bounded deterministic probe, typed trigger, and one reactor agent. |
| You care what the delegation cost. | "Run this with a $0.25 cap and save a trace." | Cumulative cost/token ceilings plus OpenInference-shaped JSONL traces and `/flows report`. |

Do not use pi-flows as the default path for small tasks. Simple answers, obvious
shell commands, tiny edits, and quick single-file lookups are usually cheaper and
clearer in the parent session.

Treat each mode as an activation threshold, not a feature to match by keyword.
Do not auto-use flows for simple or **saturated** work: if the parent can already
meet the acceptance criteria reliably, extra agents add cost and latency without
quality headroom. Escalate only when isolation, independent evidence, adversarial
reasoning, deterministic gates, or bounded multi-step control materially changes
correctness. The [flow reference](./docs/flow-reference.md#activation-thresholds)
spells out the threshold for each advanced mode.

## Why this instead of another sub-agent extension

pi-flows is a small harness, not just a folder of specialist prompts. The distinction matters when you want delegation to be repeatable and auditable.

- **Native isolation over prompt promises.** `recon` and `analyst` run with read-only tools and no shell, so exploration cannot accidentally edit files. Concurrent write-capable agents cannot share one checkout unless you explicitly opt in.
- **Verification is a first-class mode.** `evaluate` runs builder and critic in separate child contexts, can require `npm test` or another `checkCommand`, and revises under a hard iteration cap. This is stronger than asking one agent to "double-check itself."
- **Multiple proven patterns share one contract.** From `single`, `parallel`, and `evaluate` through explicit `workflow`, isolated `worktree`, adjudicated `debate`, evidence `dossier`, and bounded `monitor`, every mode uses the same `flow` tool. Start with the least coordination the task needs. See [Patterns](./docs/patterns.md).
- **Delegation is bounded.** Count, concurrency, timeout, nesting depth, total tokens, and total USD spend are capped by the harness. A runaway fan-out returns `BUDGET_EXCEEDED` instead of quietly burning through the rest of the task.
- **Handoffs are treated as an attack surface.** Content passed from one child to another is capped, redacted, stripped of invisible/bidi characters, and scanned for instruction-override markers before reuse.
- **You can inspect what happened.** Structured errors include cause and fix fields, traces are plain JSONL, and `/flows report` summarizes success rate, cost, token use, budget hits, route choices, and voting warnings.
- **It stays inside pi.** You install it as a pi package, use your existing pi provider setup, and talk to pi in plain English. The JSON in these docs is the contract behind the scenes, not something you must write for normal use.

You probably do **not** need pi-flows if you only want a single custom prompt, a long-lived autonomous swarm, or peer-to-peer agents that talk to each other. pi-flows deliberately uses a star topology: parent delegates bounded work, children return compact results, parent decides.

## What it looks like

You talk to pi in plain English — it reads the `flow` tool and writes the call for you. Load the extension, then just ask:

```text
Have a read-only agent find the API routes for billing.
```

pi delegates that to `recon`, which runs in its own subprocess and hands back just the findings. You never hand-write JSON — pi fills in the agent and the mode. (The call here is `{"agent":"recon","task":"Find the API routes for billing","why":"user asked for a delegated read-only scout"}`; these docs show the JSON as the exact contract, for when you want to verify it or take manual control.)

Ask for a *verified* result and pi reaches for a stronger mode on its own:

```text
Add a /health endpoint that returns 200 and a JSON status, with a test — and don't call it done until `npm test` passes.
```

pi runs this as an evaluate loop — the `operator` builds the change, a separate `redteam` critic judges the result, and `npm test` must exit `0`, revising until both pass or it hits `maxIterations`. The call behind it:

```json
{
  "task": "Add a /health endpoint that returns 200 and a JSON status, with a test",
  "evaluate": { "checkCommand": "npm test", "maxIterations": 3 },
  "why": "the result needs an author-independent critic plus a deterministic gate"
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

- `flow` tool: runs isolated pi subprocesses for single, parallel, chain, evaluate (generator-evaluator), vote, route, orchestrate, graph, loop, search, workflow, worktree, debate, dossier, and monitor delegation.
- `/flows` command: lists available flow agents and shows help/status/version output.
- Live TUI inspector: press `F8` (or run `/flows inspect`) during a flow to pick a queued or running child and watch its status, task, usage, and recent activity. Closing it does not stop the child.
- Bundled agents in [`agents/`](./agents/): `recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, and `debrief`.
- Your own agents, no code required — one markdown file (frontmatter + system prompt) per agent. User agents live in `~/.pi/agent/flow-agents/*.md`; project agents in `.pi/flow-agents/*.md` (loaded with `agentScope: "project"` or `"all"`, and trust-gated). Project shadows user shadows bundled, with a visible diagnostic. See [Custom agents](./docs/custom-agents.md).

## Safety model

Project-local agents are repo-controlled prompts. In interactive pi sessions, pi-flows asks before running them. In headless (non-UI) runs, pi-flows **fails closed by default** and refuses project-local agents unless you explicitly pass `confirmProjectAgents:false` after reviewing the files.

pi-flows also redacts secret-shaped content and home paths from returned content/details by default. Inter-agent **handoffs** — where one child's output becomes another child's prompt (`{previous}` in chain, the evaluate artifact, vote ballots, orchestrate findings) — are an indirect prompt-injection surface, so pi-flows strips invisible/bidi characters and flags instruction-override markers in that content before reuse, surfacing a warning rather than silently trusting it. See [Privacy & telemetry](./docs/privacy-telemetry.md).

Cost is bounded as well as count and time: pass `maxCostUsd`, `maxTokens`, or `maxGeneratedTokens` to cap cumulative spend across the whole flow tree (`BUDGET_EXCEEDED` once reached). Concurrent fan-out also refuses multiple write-capable agents in the same `cwd` (`SHARED_WRITE_CWD`) unless `allowSharedWriteCwd:true` is explicit. Read-only agents (`recon`, `analyst`) ship **without** a shell, so their read-only boundary is enforced by the toolset, not by prompt instructions alone.

## `flow` tool quick reference

You don't type these objects — you describe what you want and pi builds the call. This is the exact contract behind those requests: skim it to see what pi will run, or to take manual control (pin a specific agent, model, or budget). Each block is the JSON pi passes to the `flow` tool.

Every spawning call also requires `"why"` — one sentence naming the reason delegation beats direct execution (missing it returns `WHY_REQUIRED` before any child spawns).

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
{ "agent": "recon", "task": "Find the API routes for billing", "why": "user asked for a delegated read-only scout" }
```

For machine-checked handoffs, use a typed `contract` instead of (or alongside)
prose `task`. Contracts work in single/chain/evaluate and on integration-mode
tasks, nodes, phases, writers, voters, advocates, evidence sections, and final
debrief/integrator roles:

```json
{
  "agent": "recon",
  "contract": {
    "objective": "Find the configured sample identifier.",
    "constraints": ["Read only."],
    "nonGoals": ["Do not edit configuration."],
    "dependencies": ["settings.txt"],
    "authority": { "may": ["Read files."], "mustNot": ["Write files."], "requiresApproval": [] },
    "sideEffectClass": "read-only",
    "budget": { "timeoutMs": 30000, "maxGeneratedTokens": 2000 },
    "acceptanceChecks": ["Return the exact value and source path."],
    "returnSchema": {
      "type": "object",
      "required": ["answer"],
      "properties": { "answer": { "type": "string" } }
    },
    "owner": "parent"
  },
  "why": "user asked for a delegated read-only scout with a validated handoff"
}
```

The child returns a validated `pi-flows.return-envelope.v1` containing a stable
`contractId`, status,
evidence, artifact references/digests, changed state, unresolved questions,
retry information, schema-checked `data`, and runtime usage when available.
Missing/stale identity, schema, artifact, or digest failures stop before downstream
dispatch, synthesis, persistence, or merge. Existing prose results remain
supported through an explicit `pi-flows.handoff-envelope.v1` compatibility
envelope with source provenance. Typed `partial`/`blocked` handoffs fail closed
unless `incompleteHandoffPolicy:"include"` records an explicit policy decision.
Contract budgets tighten child timeouts and enforce cost/token limits separately
from flow-wide budgets.
See [Return contracts](./docs/flow-reference.md#return-contracts-and-write-isolation).

### Parallel

```json
{
  "tasks": [
    { "agent": "recon", "task": "Find frontend auth code" },
    { "agent": "recon", "task": "Find backend auth code" }
  ],
  "concurrency": 2,
  "why": "frontend and backend auth are independent areas one context should not serialize"
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
  ],
  "why": "research and planning benefit from a fresh planning context fed a bounded handoff"
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
  },
  "why": "the result needs an author-independent critic plus a deterministic gate"
}
```

The `operator` builds against `task`; a separate `redteam` judges the artifact (not the builder's trace) and returns `VERDICT: PASS` or `VERDICT: REVISE` with critique. On `REVISE` the operator is re-shown its prior artifact plus the critique and revises in place. The loop revises until it passes or hits `maxIterations` (default 3, cap 8).

Two optional reliability levers: **`checkCommand`** is a deterministic gate (a shell command that must exit `0` — level-1 code assertions alongside the LLM critic; non-zero is an automatic `REVISE`), and **`redteam` may be an array** of critics (a decomposed panel — e.g. one per dimension; `PASS` requires all of them). See [Flow reference](./docs/flow-reference.md#evaluate-mode-generator-evaluator-loop).

### Vote (parallelization / voting)

```json
{
  "task": "Is /^(a+)+$/ vulnerable to catastrophic backtracking?",
  "vote": { "voters": [{ "agent": "recon" }, { "agent": "overwatch" }], "debrief": { "agent": "debrief" } },
  "why": "independent votes suppress a single model's non-deterministic error"
}
```

Runs the same task across ≥2 voters (use different models to break correlated errors) and synthesizes one answer via the optional `debrief` aggregator. When voters share the same agent/model, pi-flows adds complementary stances so ballots are not identical prompt replays. Without an aggregator, all answers are returned.

### Route (classify → dispatch)

```json
{ "task": "The billing webhook returns 500s in prod", "route": { "candidates": ["recon", "strategist", "overwatch"], "fallback": "recon" }, "why": "the right specialist for this request is not obvious up front" }
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
  },
  "why": "a broad cross-codebase map is more reading than one context should serialize"
}
```

The `commander` splits the task into a JSON list of subtasks, `recon` workers run them in parallel with the overall goal/contract plus their assigned subtask, and the `debrief` agent merges the findings. An optional `verify` critic checks the merged answer against the goal in the same call. `verifyPolicy:"note"` keeps the verdict advisory, `"fail"` hard-fails on `REVISE`, and `"revise"` reruns `debrief` with the critique until pass or `verifyMaxIterations`.

### Graph (static DAG)

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
  },
  "why": "independent areas fan out while the summary depends on both"
}
```

Ready nodes run by dependency wave, with the same caps, redaction, trace, and write-collision guards as other modes.

### Loop (bounded repeat-until-done)

```json
{
  "task": "Draft release notes",
  "loop": { "body": { "agent": "operator" }, "judge": { "agent": "redteam" }, "maxIterations": 3 },
  "why": "drafting needs bounded revise-until-done with an independent judge"
}
```

The body repeats until it emits `LOOP: DONE`, or the optional judge emits `VERDICT: PASS`.

### Search (bounded beam search)

```json
{
  "task": "Pick a cache strategy",
  "search": { "generator": { "agent": "strategist" }, "scorer": { "agent": "redteam", "tools": "none" }, "debrief": { "agent": "debrief" }, "candidates": 3, "beamWidth": 1, "maxRounds": 2 },
  "why": "candidate designs need independent generation and scoring"
}
```

`search` generates candidate paths, scores each with `SCORE: 0..100`, keeps the best beam, and debriefs the winner. The default scorer is `redteam` with tools disabled so parallel scoring stays read-only.

### Workflow (gated, resumable phases)

```json
{
  "task": "Ship the cache migration",
  "workflow": {
    "stateFile": ".pi/flow-workflows/cache-migration.json",
    "phases": [
      { "id": "plan", "agent": "strategist", "task": "Produce an evidence-backed rollout plan for {task}" },
      { "id": "approve", "approval": { "message": "Approve the rollout plan?" } },
      { "id": "apply", "agent": "operator", "task": "Implement the approved plan:\n{phase.plan}", "checkCommand": "npm test" }
    ],
    "debrief": { "agent": "debrief" }
  },
  "why": "the migration needs gated phases with a resumable human approval"
}
```

Each work phase persists its redacted output before the next phase. Approval nodes
prompt in the interactive UI and pause safely in headless runs; repeat the same
call with `workflow.resume:true` to continue from the persisted state.

### Worktree (isolated writers and integration)

```json
{
  "task": "Fix frontend and backend auth, then verify the integrated result",
  "worktree": {
    "tasks": [
      { "id": "frontend", "agent": "operator", "task": "Fix frontend auth only" },
      { "id": "backend", "agent": "operator", "task": "Fix backend auth only" }
    ],
    "integrator": { "agent": "operator" },
    "checkCommand": "npm test"
  },
  "why": "two concurrent writers need isolated worktrees and a verified integration branch"
}
```

`worktree` requires a git repo and at least two write tasks where isolation or
integration reconciliation is part of correctness. Two ordinary small file edits
should stay in the parent session. The mode leaves the source checkout untouched,
removes temporary worktrees, and returns a durable `pi-flow/<run>/integration`
branch for explicit review or merge.

### Debate (advocates and adjudicator)

```json
{
  "task": "Choose queue migration A or B against the constraints in decision.md",
  "debate": {
    "participants": [{ "agent": "strategist" }, { "agent": "analyst" }],
    "adjudicator": { "agent": "overwatch" },
    "rounds": 2
  },
  "why": "user asked for opposing advocates and independent adjudication"
}
```

Use `debate` when independent advocates, rebuttal, and adjudication are explicitly
requested. It is not an automatic route today: paired Codex baselines found no
stable quality lift over direct execution; the hard-case token rerun used 16.56x
the tokens and 6.58x the estimated subject spend. Advocates open independently,
rebut the prior round, and a separate adjudicator chooses against the original
constraints.

### Dossier (evidence map/reduce)

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
  },
  "why": "three sources must be cited and reconciled without smoothing conflicts away"
}
```

At least two source- or claim-specific sections must succeed. The synthesizer
returns claims, citations, conflicts, confidence, unresolved gaps, and the next
evidence needed instead of smoothing disagreement into false consensus.

### Monitor (bounded trigger and react)

```json
{
  "task": "Diagnose the first degraded health event",
  "monitor": {
    "command": "./health-check",
    "trigger": "match",
    "pattern": "DEGRADED",
    "intervalMs": 5000,
    "maxChecks": 6,
    "reactor": { "agent": "analyst" }
  },
  "why": "a bounded probe must fire before a fresh context diagnoses the event"
}
```

`monitor` polls only within one bounded flow call; it is not a daemon, scheduler,
or background automation system. When the trigger fires, one reactor receives the
captured observation as untrusted evidence. If the bound is reached first, the
call returns `MONITOR_NOT_TRIGGERED` with the last observations.

### Cost budget and tracing

Any mode accepts a cumulative spend ceiling and a trace sink:

```json
{ "task": "...", "orchestrate": {}, "why": "...", "maxCostUsd": 0.50, "traceFile": "flow-trace.jsonl", "traceLabel": "release-gate" }
```

`maxCostUsd` / `maxTokens` / `maxGeneratedTokens` cap total spend across the whole flow tree (`BUDGET_EXCEEDED` once reached). Cost and generated-output ceilings stop the active child at a completed model-response boundary; the legacy total-token ceiling prevents subsequent child spawns after the completed response. `traceFile` (or `PI_FLOWS_TRACE_FILE`) appends one OpenInference-shaped JSON span per child plus a root span — JSONL any OpenTelemetry backend, or a coding agent, can read. Root spans keep elapsed time, accumulated worker time, and known critical-path latency separate. Reports label child completion as execution success and only claim outcome success when `evaluate` or an explicit orchestrate verifier supplied a verdict. Eval harnesses also set `traceContext` so `details.trace` and eval artifacts link stable run/case/trial/arm ids to the exact runtime trace and root span without weakening redaction. Summarize local traces with `/flows report flow-trace.jsonl` or `npm run trace:report -- flow-trace.jsonl` from a checkout.

### Human checkpoints and Reflexion

```json
{ "task": "...", "evaluate": {}, "checkpoint": { "before": "spawn" } }
{ "task": "...", "loop": { "body": { "agent": "operator" } }, "reflexion": { "enabled": true } }
```

`checkpoint.before:"spawn"` asks for approval before any child runs; `"finalize"` asks before returning the final result. Headless runs fail closed. `reflexion.enabled:true` opts into local cross-run lessons in `.pi/flow-reflections.jsonl`.

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

`tier` keeps agents portable — no vendor model is hard-coded. `capable` runs on your pi default model; `fast` runs on `PI_FLOWS_FAST_MODEL` if you set one (e.g. a cheaper model for your provider, like `openai-codex/gpt-5.4-mini`), otherwise your default too; `deep` runs on `PI_FLOWS_DEEP_MODEL` for the hardest reasoning and critique work (bundled `redteam` and `strategist` declare it). So flows use whatever model you have pi set up with, and the extension never needs updating as providers ship new models.

A flow call can also pass `tier` per task, phase, or role — the parent picks capability by task nature ("fast" scout, "deep" adjudicator) without knowing which models you have. Resolution order: flow-call `model` > flow-call `tier` > agent `model` pin > agent `tier` > your pi default; an unmapped tier just falls back to the default, so everything works with zero configuration. `flow showConfig:true` shows the effective tier mappings. `tools: none` disables built-in tools. Omitting `tools` uses pi defaults. Invalid agent files are reported in `/flows status` and `flow showConfig:true`.

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
