<picture>
  <source media="(prefers-color-scheme: dark)"
          srcset="https://raw.githubusercontent.com/Thulr/pi-flows/main/assets/banner-dark.svg">
  <img alt="pi-flows: delegate pi work to isolated, budgeted children with verification loops and tracing"
       src="https://raw.githubusercontent.com/Thulr/pi-flows/main/assets/banner-light.svg" width="100%">
</picture>

# pi-flows

**Use [pi](https://github.com/earendil-works/pi) for the work you want to keep out of your parent session: repo scouting, parallel investigation, implementation plus review, and large-task decomposition.**

pi-flows adds a `flow` tool that runs separate, disposable pi subprocesses and returns compact findings to the parent session. Instead of asking one long-running chat to explore, edit, review, remember every file it opened, and stay within budget, you can send bounded work to children running purpose-built agents and keep the parent focused on the decision.

[![npm](https://img.shields.io/npm/v/pi-flows)](https://www.npmjs.com/package/pi-flows)
[![CI](https://img.shields.io/github/actions/workflow/status/Thulr/pi-flows/ci.yml?branch=main&label=CI)](https://github.com/Thulr/pi-flows/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/Thulr/pi-flows)](./LICENSE)

## When it helps you

Use pi-flows when the next step would otherwise make your parent pi session noisy, expensive, or hard to trust:

| Your situation | What you ask pi | What pi-flows gives back |
|---|---|---|
| You need to understand a code path before touching it. | "Have a read-only agent find the billing routes." | A compact, cited recon report from an agent that cannot mutate the repo or run shell commands. |
| You want one bounded review of a PR or branch. | "Review HEAD against main and issue #25 exactly once." | Two `overwatch` runs in named `standards` and `spec` roles, typed file coverage, and a harness-derived `CLEAN`, `FINDINGS`, or `PARTIAL` outcome. |
| You want an implementation checked before you accept it. | "Add `/health` with a test, and accept it only after `npm test` passes." | A bounded generator-evaluator loop where a builder, critic, and optional command gate must pass. |
| You have a broad research task. | "Document how auth works across login, refresh, and sessions." | Decompose, fan out, synthesize, and optionally verify the merged answer. |
| Several independent writers need to land one verified result. | "Fix frontend and backend in isolated worktrees, integrate them, then run tests." | Separate worker branches plus a durable, reviewed integration branch. |
| You care what the delegation cost. | "Run this with a $0.25 cap and save a trace." | Cumulative cost/token ceilings plus OpenInference-shaped JSONL traces and `/flows report`. |

The full situations table — parallel inspection, gated migrations, debate, dossier, and monitor — is in [Patterns](./docs/explanation/patterns.md#when-a-flow-helps-you), along with why a harness beats a folder of agent prompts.

Do not use pi-flows as the default path for small tasks. Simple answers, obvious
shell commands, tiny edits, and quick single-file lookups are usually cheaper and
clearer in the parent session.

Treat each mode as an activation threshold, not a feature to match by keyword.
Do not auto-use flows for simple or **saturated** work: if the parent can already
meet the acceptance criteria reliably, extra agents add cost and latency without
quality headroom. Escalate only when isolation, independent evidence, adversarial
reasoning, deterministic gates, or bounded multi-step control materially changes
correctness. The [flow reference](./docs/reference/flow-reference.md#activation-thresholds)
spells out the threshold for each advanced mode.

## What it looks like

You talk to pi in plain English — it reads the `flow` tool and writes the call for you. Load the extension, then just ask:

```text
Have a read-only agent find the API routes for billing.
```

pi delegates that to `recon`, which runs in its own subprocess and hands back just the findings. You never hand-write JSON — pi fills in the agent and the mode. (The call here is `{"agent":"recon","task":"Find the API routes for billing","why":"user asked for a delegated read-only scout"}`; the [flow reference](./docs/reference/flow-reference.md) shows the exact JSON interface for when you want to verify it or take manual control.)

While children run you get a live tool row, and after the flow settles a durable card keeps the outcome, cost rollup, and configured ceilings in the transcript:

<img alt="The durable flow card in the pi transcript: status, per-run duration bars, cost rollup, and configured ceilings" src="https://raw.githubusercontent.com/Thulr/pi-flows/main/docs/images/flow-run-card.gif" width="100%">

For common shapes, pi can choose a named [workflow preset](./docs/reference/flow-reference.md#workflow-presets) — `scout`, `map-codebase`, or the one-shot, typed `code-review` — instead of assembling raw mode parameters. And when you ask for a *verified* result, pi reaches for a stronger mode on its own:

```text
Add a /health endpoint that returns 200 and a JSON status, with a test — accept it only after `npm test` passes.
```

pi runs this as an [evaluate loop](./docs/reference/flow-reference.md#evaluate-mode-generator-evaluator-loop): the `operator` builds the change, a separate `redteam` critic judges the result, and `npm test` must exit `0`, revising until both pass or it hits `maxIterations`.

→ [Quickstart](./docs/tutorials/quickstart.md)

## Install

**Prerequisites:** Node.js `>=24`, npm `>=11`, and the [pi](https://github.com/earendil-works/pi) CLI `>=0.82.0` on your `PATH` (it ships in `@earendil-works/pi-coding-agent`: `npm i -g @earendil-works/pi-coding-agent`).

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

Success looks like all nine bundled agents in the `flow list` output — `recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, and `debrief`. If pi isn't found, see [Troubleshooting → `pi: command not found`](./docs/how-to/troubleshooting.md#pi-command-not-found).

To hack on pi-flows or try unreleased `main`, work from a checkout: `git clone https://github.com/Thulr/pi-flows && cd pi-flows && npm ci`, then load the local extension with `pi -e ./extensions/pi-flows/index.ts` (or install your working copy as a project-local package with `pi install -l ..`). Smoke-test with the extension commands `/flows help` and `/flows status` (no model call needed), then — with a provider configured — ask pi to `Use flow with {"list":true}` or `{"showConfig":true}`. Details in the [package reference](./docs/reference/package.md); see [Development](#development) for the check loop.

## What it adds

- The `flow` tool: fifteen delegation modes behind one interface, from `single` through `monitor`, plus machine-checked [delegation contracts](./docs/reference/flow-reference.md#return-requirements-delegation-contracts-and-write-isolation) and validated return envelopes.
- The `/flows` command and [live TUI monitoring](./docs/reference/flow-reference.md#live-tui-monitoring): a live tool row, the `F8` fleet panel, `/flows inspect`, and a durable flow card — every configured cost/token ceiling is disclosed with its authority before work starts.
- Nine bundled agents in [`agents/`](./agents/) and three workflow presets in [`presets/`](./presets/).
- Your own agents and presets, no code required — one markdown file each, user- or project-scoped, trust-gated and shadowed with visible diagnostics. See [Custom agents](./docs/how-to/custom-agents.md).

## Modes at a glance

Exactly one mode per call. `{"list": true}` and `{"showConfig": true}` answer without spawning a child; every spawning call also requires `"why"` — one sentence naming the reason delegation beats direct execution.

| Mode | What it runs |
|---|---|
| [Presets](./docs/reference/flow-reference.md#workflow-presets) | `scout`, `map-codebase`, `code-review` — intent-level templates expanded before ordinary mode validation. |
| [Single / parallel / chain](./docs/reference/flow-reference.md#modes) | One agent; capped independent fan-out; a fixed pipeline fed by sanitized `{previous}` handoffs. |
| [Evaluate](./docs/reference/flow-reference.md#evaluate-mode-generator-evaluator-loop) | Generator-evaluator loop with an optional deterministic `checkCommand` gate and critic panel. |
| [Vote](./docs/reference/flow-reference.md#vote-mode-parallelization--voting) | The same task across independent voters, merged by an optional aggregator. |
| [Route](./docs/reference/flow-reference.md#route-mode-classify--dispatch) | A classifier picks one candidate agent — or falls back instead of forcing a guess. |
| [Orchestrate](./docs/reference/flow-reference.md#orchestrate-mode-decompose--fan-out--synthesize) | Decompose → parallel workers → synthesis, with an optional verifier. |
| [Graph](./docs/reference/flow-reference.md#graph-mode-static-dag) | A bounded static DAG run wave by wave with `{node.id}` handoffs. |
| [Loop](./docs/reference/flow-reference.md#loop-mode-generic-bounded-loop) | Repeat a body agent until `LOOP: DONE`, a judge's `VERDICT: PASS`, or the iteration cap. |
| [Search](./docs/reference/flow-reference.md#search-mode-bounded-beam-search) | Bounded beam search: generate candidates, score `0..100`, keep the beam, debrief the winner. |
| [Workflow](./docs/reference/flow-reference.md#workflow-mode-gated-resumable-phases) | Gated, resumable phases with persisted state and single-use [approval receipts](./docs/reference/flow-reference.md#approval-receipts). |
| [Worktree](./docs/reference/flow-reference.md#worktree-mode-isolated-writers-and-integration) | Isolated writer worktrees merged onto a durable, verified integration branch. |
| [Debate](./docs/reference/flow-reference.md#debate-mode-advocates-and-adjudicator) | Independent advocates, bounded rebuttal, separate adjudication. |
| [Dossier](./docs/reference/flow-reference.md#dossier-mode-evidence-mapreduce) | Per-source evidence extraction synthesized without smoothing conflicts away. |
| [Monitor](./docs/reference/flow-reference.md#monitor-mode-bounded-trigger-and-react) | A bounded deterministic probe whose typed trigger hands one reactor the event. |

Any mode composes with [flow budgets and tracing](./docs/reference/flow-reference.md#trace-export-observability) (`maxCostUsd`, `maxTokens`, `maxGeneratedTokens`, `traceFile`) and [human checkpoints and Reflexion](./docs/reference/flow-reference.md#human-checkpoints-and-reflexion).

## Safety model

Project-local agents and presets are repo-controlled prompts. Interactive sessions ask before using them; headless (non-UI) runs **fail closed** unless you explicitly pass `confirmProjectAgents:false` after reviewing the files. Read-only agents (`recon`, `analyst`) ship without a shell, so their boundary is enforced by the toolset, not by prompt instructions alone. Roles that need shell-based inspection without write capability use `bash-ro` — bash under a read-only allowlist enforced inside the child (and refused as `BASH_READONLY_UNENFORCEABLE` when it cannot be enforced), which is how the `code-review` preset runs its two reviewers concurrently in one checkout.

Returned content is redacted by default (secret-shaped strings, home paths), and every handoff that crosses from one child to another is capped, stripped of invisible/bidi characters, and scanned for injected instructions — `handoffPolicy` selects `warn`, `quarantine`, or `fail`, and `modeHandoffPolicy` can impose a stricter non-downgradable minimum. See [Handoff injection policy](./docs/reference/flow-reference.md#handoff-injection-policy) and [Privacy & telemetry](./docs/explanation/privacy-telemetry.md).

Delegation is bounded on count, concurrency, time, and nesting depth, and on spend: `maxCostUsd` / `maxTokens` / `maxGeneratedTokens` cap the whole flow, with every configured ceiling disclosed before work starts. At 80% of a ceiling the live child is steered to wrap up and emit a partial return envelope; a ceiling crossed before the steer could reach the child is a hard stop (`BUDGET_EXCEEDED`). Concurrent write-capable agents may not share one `cwd` (`SHARED_WRITE_CWD`) unless explicitly allowed.

[Human checkpoints](./docs/reference/flow-reference.md#human-checkpoints-and-reflexion) add an explicit approval point to any mode: `checkpoint.before:"spawn"` asks before any child runs, `"finalize"` before the final result returns. Headless runs fail closed.

## Documentation

The docs follow the [Diátaxis](https://diataxis.fr/) framework:

- **Tutorials** — [Quickstart](./docs/tutorials/quickstart.md): install, load, and run your first delegated task.
- **How-to guides** — [Custom agents](./docs/how-to/custom-agents.md) · [Troubleshooting](./docs/how-to/troubleshooting.md) · [Release runbook](./docs/how-to/release.md) · [Examples cookbook](./examples/README.md)
- **Reference** — [Flow reference](./docs/reference/flow-reference.md): every mode, parameter, and structured error. [Package reference](./docs/reference/package.md): what ships and how to install it.
- **Explanation** — [Patterns](./docs/explanation/patterns.md) · [Privacy & telemetry](./docs/explanation/privacy-telemetry.md)

Contributor surfaces: [Contributing](./CONTRIBUTING.md) · [Agent instructions](./AGENTS.md) · [Domain glossary](./CONTEXT.md) · [Changelog](./CHANGELOG.md)

## Development

```bash
npm ci
npm run check
```

See [Contributing](./CONTRIBUTING.md) for the individual checks, the commit
conventions, and PR evidence expectations.
