<picture>
  <source media="(prefers-color-scheme: dark)"
          srcset="https://raw.githubusercontent.com/Thulr/pi-flows/main/assets/banner-dark.svg">
  <img alt="pi-flows: delegate pi work to isolated, budgeted children with verification loops and tracing"
       src="https://raw.githubusercontent.com/Thulr/pi-flows/main/assets/banner-light.svg" width="100%">
</picture>

# pi-flows

**Use [pi](https://github.com/earendil-works/pi) for the work you want to keep out of your parent session: repo scouting, parallel investigation, implementation plus review, and large-task decomposition.**

pi-flows adds a `flow` tool that runs separate, disposable pi subprocesses and returns compact findings to the parent session. You send bounded work to children that run purpose-built agents. The parent session stays focused on the decision, not on every file the children opened.

[![npm](https://img.shields.io/npm/v/pi-flows)](https://www.npmjs.com/package/pi-flows)
[![CI](https://img.shields.io/github/actions/workflow/status/Thulr/pi-flows/ci.yml?branch=main&label=CI)](https://github.com/Thulr/pi-flows/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/Thulr/pi-flows)](./LICENSE)

## Quick start

Prerequisites: Node.js `>=24`, npm `>=11`, and the [pi](https://github.com/earendil-works/pi) CLI `>=0.82.0` on your `PATH`. The pi binary ships in `@earendil-works/pi-coding-agent` (`npm i -g @earendil-works/pi-coding-agent`).

1. Install the extension:

   ```bash
   # From npm (recommended) — the published release
   pi install npm:pi-flows

   # Add -l to install into the current project only (.pi/settings.json)
   pi install -l npm:pi-flows

   # Or track the latest main straight from GitHub, no clone required
   pi install git:github.com/Thulr/pi-flows
   ```

2. Reload pi with `/reload`, or restart it.

3. Make sure that the install worked. The first line is a command. The second line is plain English that pi turns into a `flow` call:

   ```text
   /flows version
   list the available flow agents
   ```

   The `flow list` output must show all nine bundled agents: `recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, and `debrief`. If pi is not found, see [Troubleshooting → `pi: command not found`](./docs/how-to/troubleshooting.md#pi-command-not-found).

4. Ask pi for your first delegated task:

   ```text
   Scout the codebase and find the extension entrypoint.
   ```

   pi delegates this to `recon`, a read-only scout, and returns the findings. You do not name an agent or write JSON — pi reads your intent and picks for you. To be explicit, name the agent (*"use recon to find the extension entrypoint"*), or pass the exact call `{"agent":"recon","task":"...","why":"..."}`. The `why` field is the required one-sentence delegation justification.

   For a broad task, you can ask pi to review the Decomposition before any worker starts:

   ```text
   Document login, refresh, and session storage. Have overwatch review the breakdown before the research starts.
   ```

   The reviewer can request a bounded commander revision. Workers start only after the Decomposition receives PASS.

If your provider credentials are not configured, the no-model calls still work: `/flows help`, `/flows status`, `Use flow with {"list":true}`, and `Use flow with {"showConfig":true}`. For setup problems, see [Troubleshooting](./docs/how-to/troubleshooting.md).

## When it helps you

When the next step makes your parent pi session noisy, expensive, or hard to trust, use pi-flows:

| Your situation | What you ask pi | What pi-flows gives back |
|---|---|---|
| You need to understand a code path before you touch it. | "Have a read-only agent find the billing routes." | A compact, cited recon report from an agent that cannot mutate the repo or run shell commands. |
| You want one bounded review of a PR or branch. | "Review HEAD against main and issue #25 exactly once." | Two `overwatch` runs in named `standards` and `spec` roles, typed file coverage, and a harness-derived `CLEAN`, `FINDINGS`, or `PARTIAL` outcome. |
| You want an implementation checked before you accept it. | "Add `/health` with a test, and accept it only after `npm test` passes." | A bounded generator-evaluator loop where a builder, a critic, and an optional command gate must pass. |
| You have a broad research task. | "Document how auth works across login, refresh, and sessions." | Decompose, fan out, synthesize, and optionally verify the merged answer. |
| Several independent writers need to land one gate-checked result. | "Fix frontend and backend in isolated worktrees, integrate them, then run tests." | Separate worker branches plus a durable, reviewed integration branch. |
| You care what the delegation cost. | "Run this with a $0.25 cap and save a trace." | Cumulative cost and token ceilings, OpenInference-shaped JSONL traces, and `/flows report`. |

The [Patterns](./docs/explanation/patterns.md#when-a-flow-helps-you) page has the full situations table: parallel inspection, gated migrations, debate, dossier, and monitor. It also explains why a harness beats a folder of agent prompts.

Do not use pi-flows as the default path for small tasks. Simple answers, obvious shell commands, tiny edits, and quick single-file lookups are usually cheaper and clearer in the parent session.

Treat each mode as an activation threshold, not a feature to match by keyword. If the parent can already meet the acceptance criteria, extra agents add cost and latency without a quality gain. Escalate only when isolation, independent evidence, adversarial review, deterministic gates, or bounded multi-step control changes correctness. The [flow reference](./docs/reference/flow-reference.md#activation-thresholds) gives the threshold for each advanced mode.

## What it looks like

You talk to pi in plain English. pi reads the `flow` tool and writes the call for you. Load the extension, then ask:

```text
Have a read-only agent find the API routes for billing.
```

pi delegates the task to `recon`. The agent runs in its own subprocess and hands back only the findings. The call here is `{"agent":"recon","task":"Find the API routes for billing","why":"user asked for a delegated read-only scout"}`. The [flow reference](./docs/reference/flow-reference.md) shows the exact JSON interface for when you want to verify a call or take manual control.

While children run, pi shows a live tool row. After the flow settles, a durable card keeps the outcome, the cost rollup, and the configured ceilings in the transcript:

<img alt="The durable flow card in the pi transcript: status, per-run duration bars, cost rollup, and configured ceilings" src="https://raw.githubusercontent.com/Thulr/pi-flows/main/docs/images/flow-run-card.gif" width="100%">

Some terminals speak an inline-image protocol (Ghostty, Kitty, iTerm2, WezTerm). There, the settled card shows a rendered timeline of the run: one rail per child, offset by real start times. Each agent gets an identicon, so repeated agents share a visible mark. Failed runs are hatched in the theme's error color. Other terminals get the text card:

<img alt="The settled card's timeline: one rail per child offset by real start times, a per-agent identicon beside each label, and a duration axis" src="https://raw.githubusercontent.com/Thulr/pi-flows/main/docs/images/flow-gantt.png" width="100%">

For common shapes, pi can choose a named [workflow preset](./docs/reference/flow-reference.md#workflow-presets) — `scout`, `map-codebase`, or the one-shot, typed `code-review` — instead of raw mode parameters. When you ask for a *verified* result, pi picks a stronger mode on its own:

```text
Add a /health endpoint that returns 200 and a JSON status, with a test — accept it only after `npm test` passes.
```

pi runs this as an [evaluate loop](./docs/reference/flow-reference.md#evaluate-mode-generator-evaluator-loop). The `operator` agent builds the change. A separate `redteam` critic judges the result, and `npm test` must exit `0`. The loop revises until both pass, or until it reaches `maxIterations`.

## What it adds

- The `flow` tool: fifteen delegation modes behind one interface, from `single` through `monitor`. Every task and agent-reference role accepts an optional machine-checked [delegation contract](./docs/reference/flow-reference.md#return-requirements-delegation-contracts-and-write-isolation). With a contract, the child's Return must validate — contract attribution, artifact digests, and return-schema conformance — before coordination can act on it. Without one, the child returns an ordinary Result: the child's own account, with no machine contract assurance.
- The `/flows` command and [live TUI monitoring](./docs/reference/flow-reference.md#live-tui-monitoring): a live tool row, `/flows inspect`, and a durable flow card. Every configured cost or token ceiling is disclosed, with its authority, before work starts.
- Nine bundled agents in [`agents/`](./agents/) and three workflow presets in [`presets/`](./presets/).
- Your own agents and presets, with no code required: one markdown file each, user-scoped or project-scoped. Project files are trust-gated, and shadowing shows visible diagnostics. See [Custom agents](./docs/how-to/custom-agents.md).

## Modes at a glance

Each call uses exactly one mode. `{"list": true}` and `{"showConfig": true}` answer without spawning a child. Every spawning call also requires `"why"`: one sentence that names the reason delegation beats direct execution.

Raw parallel fan-out also requires deliberate model sizing before spend. Set `tier` or `model` on every task, or set one flow-wide `tier` or `model` to state that uniform sizing is deliberate. If the work has mixed complexity, use per-task `fast`, `capable`, or `deep` tiers.

| Mode | What it runs |
|---|---|
| [Presets](./docs/reference/flow-reference.md#workflow-presets) | `scout`, `map-codebase`, `code-review` — intent-level templates expanded before ordinary mode validation. |
| [Single / parallel / chain](./docs/reference/flow-reference.md#modes) | One agent, a capped independent fan-out, or a fixed pipeline fed by sanitized `{previous}` handoffs. |
| [Evaluate](./docs/reference/flow-reference.md#evaluate-mode-generator-evaluator-loop) | Generator-evaluator loop with an optional deterministic `checkCommand` gate and critic panel. |
| [Vote](./docs/reference/flow-reference.md#vote-mode-parallelization--voting) | The same task across independent voters, merged by an optional aggregator. |
| [Route](./docs/reference/flow-reference.md#route-mode-classify--dispatch) | A classifier picks one candidate agent — or falls back instead of forcing a guess. |
| [Orchestrate](./docs/reference/flow-reference.md#orchestrate-mode-decompose--review--fan-out--synthesize) | Decompose → optional Decomposition review → workers → synthesis, with an optional outcome verifier and one bounded mid-flow replan for stranded or unaffordable remaining work. |
| [Graph](./docs/reference/flow-reference.md#graph-mode-static-dag) | A bounded static DAG run wave by wave with `{node.id}` handoffs. |
| [Loop](./docs/reference/flow-reference.md#loop-mode-generic-bounded-loop) | Repeat a body agent until `LOOP: DONE`, a judge's `VERDICT: PASS`, or the iteration cap. |
| [Search](./docs/reference/flow-reference.md#search-mode-bounded-beam-search) | Bounded beam search: generate candidates, score `0..100`, keep the beam, debrief the winner. |
| [Workflow](./docs/reference/flow-reference.md#workflow-mode-gated-resumable-phases) | Gated, resumable phases with persisted state and single-use [approval receipts](./docs/reference/flow-reference.md#approval-receipts). |
| [Worktree](./docs/reference/flow-reference.md#worktree-mode-isolated-writers-and-integration) | Isolated writer worktrees merged onto a durable integration branch, with an integrator review and an optional deterministic check. |
| [Debate](./docs/reference/flow-reference.md#debate-mode-advocates-and-adjudicator) | Independent advocates, bounded rebuttal, separate adjudication. |
| [Dossier](./docs/reference/flow-reference.md#dossier-mode-evidence-mapreduce) | Per-source evidence extraction synthesized without smoothing conflicts away. |
| [Monitor](./docs/reference/flow-reference.md#monitor-mode-bounded-trigger-and-react) | A bounded deterministic probe whose typed trigger hands one reactor the event. |

Any mode composes with [flow budgets and tracing](./docs/reference/flow-reference.md#trace-export-observability) (`maxCostUsd`, `maxTokens`, `maxGeneratedTokens`, `traceFile`) and [human checkpoints and Reflexion](./docs/reference/flow-reference.md#human-checkpoints-and-reflexion).

## Safety model

Project-local agents and presets are repo-controlled prompts. Interactive sessions ask before they use them. Headless (non-UI) runs **fail closed** — to open them, review the files, then pass `confirmProjectAgents:false`. Read-only agents (`recon`, `analyst`) ship without a shell, so the toolset enforces their boundary, not prompt instructions alone. Roles that need shell inspection without write access use `bash-ro`: bash under a read-only allowlist, enforced inside the child. When the child cannot enforce the allowlist, the run is refused as `BASH_READONLY_UNENFORCEABLE`. This is how the `code-review` preset runs its two reviewers concurrently in one checkout.

Resumable workflow consent is bound to the effective Agent profile of each gated Role. The profile holds the selected source, the non-disclosing prompt identity, the effective tools, the canonical cwd target with its filesystem identity, the concrete model, and the Thinking level. The runner rechecks the cwd identity immediately before spawn. If the profile drifts, unspent approval reopens — the flow does not run under old consent. Malformed or replayed receipts stay hard failures. A rare bounded v3 migration can take a digest-checked `workflow.historicalThinking` witness. The witness never controls dispatch. See [Approval receipts](./docs/reference/flow-reference.md#approval-receipts).

Returned content is redacted by default: secret-shaped strings and home paths are removed. Every handoff from one child to another is capped, stripped of invisible and bidi characters, and scanned for injected instructions. `handoffPolicy` selects `warn`, `quarantine`, or `fail`. `modeHandoffPolicy` can set a stricter minimum that cannot be downgraded. See [Handoff injection policy](./docs/reference/flow-reference.md#handoff-injection-policy) and [Privacy & telemetry](./docs/explanation/privacy-telemetry.md).

Delegation is bounded on count, concurrency, time, nesting depth, and spend. The disclosed ceilings are `maxCostUsd` (cost), `maxTokens` (input plus output), and `maxGeneratedTokens` (output only — not input, context, total tokens, or cost). Cost, generated tokens, and a contract's total tokens stop live runs. A flow's `maxTokens` is a spawn gate only. At 80% of a live-run ceiling, live children are steered to wrap up and emit a partial return envelope. If the flow crosses a ceiling before the steer reaches the child, the run stops hard (`BUDGET_EXCEEDED`). Before workers spawn, orchestrate also projects the admitted Decomposition against the remaining ceilings. Each subtask can carry a relative `effortWeight`. A Decomposition that does not fit is refused (`BUDGET_HEADROOM_EXCEEDED`) before any worker spends. The projection runs again between waves, on the settled workers' own spend. A refused or stranded remainder routes to the commander for one bounded mid-flow replan. Concurrent write-capable agents must not share one `cwd` (`SHARED_WRITE_CWD`) unless you explicitly allow it.

[Human checkpoints](./docs/reference/flow-reference.md#human-checkpoints-and-reflexion) add an explicit approval point to any mode. `checkpoint.before:"spawn"` asks before any child runs. `"finalize"` asks before the final result returns. Headless runs fail closed.

## Documentation

The [documentation index](./docs/README.md) lists every page. The most useful pages:

- [Flow reference](./docs/reference/flow-reference.md) — every mode, parameter, and structured error.
- [Package reference](./docs/reference/package.md) — what ships in the npm package, and every install method.
- [Custom agents](./docs/how-to/custom-agents.md) — write your own agents and presets as markdown files.
- [Troubleshooting](./docs/how-to/troubleshooting.md) — setup fixes, and the catalog of every structured error code.
- [Examples cookbook](./examples/README.md) — copy-paste invocations for every mode, including error cases.
- [Patterns](./docs/explanation/patterns.md) — when a flow helps, and which agent-design pattern each mode encodes.
- [Privacy & telemetry](./docs/explanation/privacy-telemetry.md) — what leaves your machine (nothing by default), and the controls.
- [Release runbook](./docs/how-to/release.md) — how maintainers cut, evidence, and roll back a release.

Contributor surfaces: [Contributing](./CONTRIBUTING.md) · [Agent instructions](./AGENTS.md) · [Domain glossary](./CONTEXT.md) · [Architecture classification](./docs/reference/architecture.md) · [Changelog](./CHANGELOG.md)

## Development

To hack on pi-flows or try unreleased `main`, work from a checkout:

```bash
git clone https://github.com/Thulr/pi-flows
cd pi-flows
npm ci
npm run check       # build + test this package (does not require pi)
npm run preflight   # make sure that the pi CLI is on PATH and meets the version floor
```

Load the local extension with `pi -e ./extensions/pi-flows/index.ts`, or install your working copy as a project-local package with `pi install -l ..`. Smoke-test with the extension commands `/flows help` and `/flows status` — they need no model call. Then, with a provider configured, ask pi to `Use flow with {"list":true}` or `{"showConfig":true}`. Details are in the [package reference](./docs/reference/package.md).

See [Contributing](./CONTRIBUTING.md) for the individual checks, the commit conventions, and the PR evidence expectations.
