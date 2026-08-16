# Flow reference

## Workflow presets

Presets are the intent-level entrypoint over the raw mode table. A call such as:

```json
{
  "preset": "code-review",
  "task": "Review HEAD against main and issue #25 exactly once",
  "why": "author-independent verification"
}
```

loads one Markdown definition and substitutes `{task}`. It applies the declared
workflow-shape overrides, plus safe caller controls such as capture, tracing,
trust, and `maxCostUsd`. Then it validates and runs the expanded call as an
ordinary mode. Presets do not bypass mode bounds, budgets, delegation contracts,
project trust, capture policy, or traces.

For `code-review`, the caller task names the Git range as `base..head`,
`base...head`, or `head against base`. The harness resolves both refs before
dispatch, pins those commit IDs into both review tasks, and derives the
changed-file manifest from that requested range. A three-dot range is pinned at
the merge base, so the manifest is the branch's own change set rather than a
two-endpoint diff. Both typed returns must attest to those exact IDs.
Unresolvable, mismatched, or incomplete ranges produce `PARTIAL`.

Bundled presets:

| Preset | Expansion | Bounded outcome |
|---|---|---|
| `scout` | One `recon` run | One read-only evidence pass |
| `map-codebase` | `orchestrate` with at most four recon subtasks | One decomposed map and synthesis |
| `code-review` | Two concurrent read-only (`bash-ro`) `overwatch` runs, roles `standards` and `spec` | Exactly one pass, typed coverage/findings, and `CLEAN`, `FINDINGS`, or `PARTIAL` |

`code-review` is deliberately one-shot: it never fixes findings, posts review
comments, or repeats until clean.

Preset discovery uses the same precedence as agents: bundled `presets/*.md`,
user `~/.pi/agent/flow-presets/*.md`, then project
`.pi/flow-presets/*.md`. Project presets require `agentScope:"project"` or
`"all"` and use the project-local trust gate. A preset file contains
frontmatter plus a JSON body:

```md
---
name: my-scout
description: Inspect one target with recon.
overrides: cwd,timeoutMs,maxGeneratedTokens
---
{"agent":"recon","task":"{task}","timeoutMs":900000,"maxGeneratedTokens":4000}
```

A preset declares which top-level parameters callers can override (`overrides` in
its frontmatter). Undeclared or workflow-shape overrides fail with
`PRESET_OVERRIDE_INVALID`.

A template can set `recordContent`/`redactSecrets` to tighten capture, but never
to loosen it. The effective policy is the stricter of the caller's policy and
the template's policy, in both directions. A template cannot turn the caller's
redaction off, and a caller cannot re-enable content a template withholds.
`traceStrict` follows the same rule: a template can turn the evidence gate on,
but a template-authored `traceStrict:false` is dropped, so the caller and
`PI_FLOWS_TRACE_STRICT` still decide. `why`, `agentScope`,
`confirmProjectAgents`, and `allowSharedWriteCwd` are caller-only. A template
cannot justify its own delegation, opt its source into trust, or take the
shared-write exception for the caller.

## Modes

Exactly one mode is valid per call.

| Mode | Shape | Runs a child pi process? |
|---|---|---:|
| List | `{ "list": true }` | No |
| Config | `{ "showConfig": true }` | No |
| Single | `{ "agent": "recon", "task": "..." }` | Yes |
| Parallel | `{ "tasks": [{ "agent": "recon", "task": "...", "tier": "fast" }, { "agent": "analyst", "task": "...", "tier": "deep" }] }` | Yes |
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

A raw parallel call with two or more tasks must make sizing intentional before
child spend begins. Set `tier` or `model` on every task. If every task truly
needs the same capability, a flow-wide `tier` or `model` is the explicit
uniform-sizing acknowledgement. If you set neither, the call is refused with
`PARALLEL_SIZING_REQUIRED`. `thinking` alone does not satisfy the gate, because
it changes reasoning effort without selecting model capability.

## Live TUI monitoring

Two surfaces cover a flow's life in interactive Pi, both fed by the same
in-memory flow updates:

- **The tool row is live.** While children run, the `flow` tool row shows a
  progress bar, per-run state with a spinner, each running child's current
  tool call or latest message, and a token/cost rollup. It updates in place.
  Before the first child starts, the tool call and row also disclose every
  configured cost/token ceiling as a `flow ceiling` or `contract ceiling`.
  `ctrl+o` expands the settled row into full per-run output.

  <img alt="The live flow tool row updating in place while children run" src="https://raw.githubusercontent.com/Thulr/pi-flows/main/docs/images/flow-live-row.gif" width="100%">
- **`/flows inspect` drills into one child.** Select a queued or running child
  to see its task, status, usage, and recent text/tool activity. Use Up/Down to
  scroll, End to return to the latest activity, and Escape to close the overlay
  without interrupting the child.

### What the fan-out counter counts

The tool row heads a fan-out with `1/3 settled`. The numerator
counts [**settled**](../../CONTEXT.md#delegation-model) runs, not successful ones.
After the flow itself settles, the outcome (`2 failed` or `3 ok`) replaces the
ratio, because `3/3` reads as a success total. A single-run flow
shows neither, because the header only restates the one run below it.

A multi-stage mode settles one stage's runs before it spawns the next. For
example, `evaluate` returns its generator before the check command and the
critic panel run. Between stages, the header keeps the labeled ratio and the
spinner. It does not announce an outcome the flow has not reached. `2/2 settled`
with a spinner means that both runs so far are done and the flow is still
working.

The inline tool row is the single primary live progress view. The extension
clears its footer status and above-editor widget, and does not repeat that
row's summary elsewhere. Both board surfaces report a flow-level error beside
the run counts: a status icon on the tool row, and an `error:` line on both.

After a flow settles, a durable flow card entry stays in the session transcript
and re-renders after `pi` restarts. It keeps the status, per-run duration bars,
cost rollup, failure codes, and the trace file pointer when tracing was on.

## Activation thresholds

Use the least coordination that improves correctness. Do not auto-use
any flow for a simple task or a **saturated** task. A task is saturated when
direct parent execution already meets the acceptance criteria reliably and
leaves no useful quality headroom. In that case, extra subprocesses are only
cost and latency.

Every spawning call must pass `why`: one sentence that names the reason
delegation beats direct execution. Valid reasons include an explicit user
request, fan-out one context cannot hold, or author-independent verification. A
call without it is refused with `WHY_REQUIRED` before any child spawns. This
friction is deliberate: if no justification can be stated, the task belongs in
the parent context.

| Mode | Activate when | Stay direct or use a simpler mode when |
|---|---|---|
| `workflow` | Named phases, persisted artifacts, deterministic gates, or a resumable human approval are part of correctness. | The work is one small edit or an ordinary linear handoff. Use the parent, `single`, `chain`, or `evaluate`. |
| `worktree` | Isolation, ownership boundaries, or shared integration conflicts are part of correctness for multiple write-capable tasks, and a gate-checked integration branch is required. | The parent can safely make the edits in one checkout, even when two files are involved. Use direct execution, `single`/`evaluate`, or read-only `parallel`. |
| `debate` | The user explicitly requests independent advocates/rebuttal/adjudication for a consequential decision. | Debate is not an automatic route today: direct Codex matched its decision quality with lower latency/tokens in the paired baseline. Answer directly unless independent opposition is itself requested. |
| `dossier` | At least two sources or claim families must be cited and reconciled, including contradictions and gaps. | One source or lookup is enough. Use `single` with `recon`/`analyst`. |
| `monitor` | A deterministic probe must be repeated under a hard bound, and a typed event must trigger one diagnosis/response. | One status check is enough, or the need is durable/background scheduling. Run the command directly or use an external automation system. |

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| `preset` | (none) | Named workflow preset expanded before mode validation. Prefer it when its intent matches. |
| `why` | (required to spawn) | One sentence that justifies delegation over direct parent execution. Required for every spawning mode. `list`/`showConfig` never need it. Missing/empty ⇒ `WHY_REQUIRED`. |
| `agentScope` | `user` | Applies to both presets and agents: `user` = package + user, `project` = package + project, `all` = all three sources. |
| `confirmProjectAgents` | `true` | Interactive sessions prompt. Headless sessions refuse project presets/agents unless this is explicitly `false` after review. |
| `concurrency` | `4` | Concurrent fan-out, including parallel, vote, orchestrate, worktree, debate, and dossier. Integer `1..8`, validated once at dispatch for every mode — an out-of-range value is refused even in modes that run sequentially. |
| `timeoutMs` | `36000000` | Per child process timeout (10 hours). Independently of it, a child that reports a terminal provider error and then stalls is terminated after a short grace (`PI_FLOWS_ERROR_GRACE_MS`, default 30000ms) with `CHILD_PROVIDER_ERROR`. |
| `recordContent` | `true` | Return/store child message content after redaction. Set `false` to retain structural status/usage only. |
| `redactSecrets` | `true` | Redacts secret-shaped strings, emails, and home paths from content/details. |
| `maxCostUsd` | (none) | Cumulative USD cost ceiling across every child in this flow. Once reached at a completed model-response boundary, the active child stops and no further child spawns. |
| `maxTokens` | (none) | Cumulative input+output token ceiling across every child in this flow. Once reached, no further child spawns. |
| `maxGeneratedTokens` | (none) | Cumulative generated/output token ceiling across every child in this flow. Once reached, the active child stops at the completed model-response boundary and no further child spawns. Omit to run uncapped. |
| `traceFile` | (none) | Append OpenInference-shaped JSON spans to this JSONL file — one per child run, one per stage (wave/round/phase), one per coordination event, plus a root span. Trace data any OpenTelemetry pipeline (or a coding agent via `jq`/SQL) can read. Also settable via `PI_FLOWS_TRACE_FILE`. Relative paths resolve against `cwd`. Values are redacted/capped first. |
| `traceLabel` | (none) | Use-case label attached to trace spans so reports can group execution success, verified outcome success, TPSO, cost, and warning counts by journey/release gate. |
| `traceContext` | (none) | Stable `{runId,caseId,trialId,trialIndex?,arm?,attempt?}` linkage for eval/runtime correlation. Redacted, bounded identifiers are copied to every runtime span and `details.trace` returns the exact trace/root-span reference plus trace health. |
| `traceStrict` | `false` | Require complete trace evidence. A missing `traceFile`, dropped spans, failed writes, or an export that is complete but does not read back as a span tree fail the call with `TRACE_INCOMPLETE`. For evaluation/release gates. Ordinary flows keep best-effort tracing. Also settable via `PI_FLOWS_TRACE_STRICT`. |
| `handoffPolicy` | `warn` | Call-level injection handling at inter-agent boundaries: `warn` preserves the flagged payload with a warning, `quarantine` substitutes a payload-free marker, and `fail` returns `HANDOFF_POLICY_VIOLATION` before the recipient spawns. |
| `modeHandoffPolicy` | (none) | Per-mode minimums, for example `{"workflow":"fail"}`. The effective policy is the stricter of this mode requirement and `handoffPolicy`. A call cannot downgrade a high-consequence mode. |
| `returnContract` | (none) | Prose return requirements appended to delegated worker/generator/synthesis tasks. Use it to require a shape, fields, max length, or evidence format. It is prompt-enforced, not a machine-checked delegation contract. |
| `requireEvidence` | `false` | Appends an evidence requirement to delegated prompts: load-bearing claims need file:line refs, command output, citations, or explicit gaps. |
| `contract` | (none) | Optional machine-checked delegation contract. It can replace `task` in single/evaluate or be a documented `resolved`-role fallback. Every task/role contract resolves before that Child spawns and requires a validated `pi-flows.return-envelope.v1`. Supplying one proves contract attribution, declared artifact integrity, and return-schema conformance — never that the Return's claims are true or that `acceptanceChecks` were satisfied. Without one, the child returns an ordinary Result. Role contracts override fallbacks. |
| `incompleteHandoffPolicy` | `fail` | Integration modes reject `partial`/`blocked` return envelopes by default. Set `"include"` only as an explicit decision to synthesize while preserving incomplete status and provenance in the returned handoffs/header. |
| `allowSharedWriteCwd` | `false` | By default, concurrent write-capable agents must not share one `cwd`. Set `true` only when shared writes are intentional. |
| `checkpoint` | (none) | Optional human checkpoint. `checkpoint.before:"spawn"` asks before any child runs. `"finalize"` asks after child work, before the final answer returns. Headless contexts fail closed. |
| `reflexion` | disabled | Optional local cross-run lessons. `reflexion.enabled:true` reads/appends recent lessons from `.pi/flow-reflections.jsonl` by default. |
| `model` | agent/default | Flow-wide exact-model fallback. A task, phase, participant, or role-level `model` overrides it. On raw multi-task parallel calls, setting it explicitly acknowledges intentional uniform sizing. Prefer `tier` unless the user named a concrete model. |
| `tier` | agent/default | Flow-wide capability-tier fallback (`fast`, `capable`, `deep`), overridable per task/phase/role. On raw multi-task parallel calls, setting it explicitly acknowledges intentional uniform sizing. Resolves against the [model roster](#the-model-roster) derived from the models this install can run, so it works with no configuration. A call-level `tier:"capable"` always resolves and forces the default model, even on a `fast`/`deep` agent. A `fast`/`deep` tier the roster cannot resolve falls through to the agent's own pin. |
| `thinking` | agent/tier | Flow-wide thinking-level fallback (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), overridable per task/phase/role. Independent of `tier`: sets effort without changing which model runs. Lowered automatically to what the resolved model supports, and a child with no level named anywhere leaves pi's own default alone. |
| `tools` | agent/default | Comma-separated tools, `none`, or `default`. `bash-ro` grants bash under a child-enforced read-only allowlist (see [write isolation](#return-requirements-delegation-contracts-and-write-isolation)). A toolset carrying both `bash` and `bash-ro` resolves to plain `bash`. |
| `cwd` | parent cwd | Child process working directory. |

### The model roster

`tier` and `thinking` resolve against a roster derived from pi's model registry: the models this install has configured auth for. pi-flows does not maintain its own list. `fast` takes the cheapest usable model at `low`, and prefers the parent's own provider. `capable` names the model this session is running, at the session's current thinking level — not pi's configured default, which a fresh child otherwise loads. `deep` takes the most capable model at `max`, and prefers one that supports extended thinking. When the default model is already the best available, `deep` differs by thinking level instead of pinning a redundant `--model`.

When the session has a model scope (`/scoped-models`, `--models`), automatic derivation ranks `fast` and `deep` within that scope only. A model you disabled is never auto-assigned a tier. `capable` still mirrors the session's active model, even when that model sits outside the cycling scope. Explicit `model` pins (call, agent, or config) remain deliberate overrides that the scope does not rewrite. A non-empty scope that leaves the automatic tiers nothing rankable fails closed down a ladder, never through. First, the tiers anchor to the session's own model. Without one, they bind to a decoded scoped reference directly, even below the ranking floor, because the user enabled exactly those models. A scope with no readable reference and no session model refuses the automatic tier outright (`MODEL_SCOPE_UNSATISFIABLE`). It does not spawn an unpinned child, because that child loads pi's configured default — a model the scope can exclude. A scope you configured is never silently widened back to the full registry. Only an absent or empty scope means unscoped, and an explicit model (call, agent, or config) always clears the refusal.

Inspect the roster with `/flows models` or `flow showConfig:true`. Every rung states the model, the level, and the reason for the choice:

```text
modelTier.fast: anthropic/claude-haiku-4-5, thinking low — cheapest model this install can run on anthropic
modelTier.capable: anthropic/claude-opus-5, thinking high — the model this session is running, at its current thinking level (high)
modelTier.deep: anthropic/claude-opus-5, thinking max — the model this session is running is already the most capable available, so deep differs by thinking level (max), not by model
```

Override a tier from `/flows models`, or in `~/.pi/agent/pi-flows.json`:

```json
{
  "models": {
    "fast": "anthropic/claude-haiku-4-5:low",
    "deep": { "model": "anthropic/claude-opus-5", "thinking": "max" },
    "capable": { "model": null, "thinking": "high" }
  }
}
```

`"model": null` (shorthand `"default"`) runs that tier with no `--model`, so the child loads pi's configured default. This is distinct from omitting `model`, which keeps the derived one, and from `capable`, which names this session's model. A level set beside it cannot be pre-checked against that model, because pi does not expose its configured default to an extension. Configuration that fails to parse is reported as a `modelRoster.issue` line beside the roster. An override that never took effect is visible, not silent.

A trusted project can override tiers in `.pi/pi-flows.json`. Like project agents, the file is found by walking up from the working directory, so it applies when you start pi in a subdirectory. The walk searches for the file itself, so an unrelated nested `.pi` does not shadow it. An untrusted project's file is ignored, because choosing the model also chooses which vendor sees the task. A project override narrows a tier field by field: a project that sets only `thinking` keeps your model pin. `/flows models` warns before it saves a tier the project already claims, because project configuration outranks your user file. `PI_FLOWS_FAST_MODEL` / `PI_FLOWS_DEEP_MODEL` still work but are outranked by the configuration file. Full order, narrowest first: call `model` > call `tier`/`thinking` > agent `model` pin > agent `tier`/`thinking` > project config (trusted) > user config > env > derived roster > pi default.

A flow budget bounds one flow call. It does not cross the process boundary. The
outer ceiling never sees a nested flow's spend. That nested flow is bounded only
by the ceilings its own call sets — with none set, it runs uncapped, which is
the default.

The fan-out ceiling `maxParallelTasks` (`8`) is a fixed internal cap on `tasks`,
voters, subtasks, worktree writers, debate participants, and dossier sections.
It is not a per-call input. The runtime enforces it and surfaces it read-only in
`details.config`.

### Handoff injection policy

Every value that crosses from one coordination role into another is treated as
untrusted data. The flow-scoped guard strips invisible/bidi controls and scans
for high-signal instruction-override and exfiltration markers. It also retains
a bounded history. Some fragments are benign alone but malicious when joined
across several boundaries — the history lets the guard detect them as a
compositional attack. This includes child
output, retrieved content repeated by a child, routing metadata, ballots,
critic/check-command feedback, graph dependencies, workflow phases, and
synthesis inputs.

`handoffPolicy` selects the call behavior:

- `warn` (default) preserves current compatibility: the cleaned payload crosses
  with a visible untrusted-data notice.
- `quarantine` withholds the flagged payload and carries only a fixed
  quarantine marker. Downstream coordination can continue, but it cannot read
  the flagged content.
- `fail` returns `HANDOFF_POLICY_VIOLATION` and the child-dispatch seam refuses
  the recipient before a process is spawned.

`modeHandoffPolicy` declares a non-downgradable minimum for a mode. Resolution
uses `warn < quarantine < fail`, so
`handoffPolicy:"warn", modeHandoffPolicy:{"workflow":"fail"}` resolves to
`fail`. Workflow approval receipts bind that resolution. A resume with a changed
call or mode policy requires fresh approval.

`maxCostUsd` / `maxTokens` / `maxGeneratedTokens` form the **flow budget** and close the cost dimension of bounded execution. The iteration, fan-out, and time caps bound how *many* children run and how *long* each runs, but not total spend. Usage is known only after a model response completes, so a response can cross a ceiling. At that accounting boundary, cost and generated-output ceilings stop the active child and refuse subsequent children. The legacy total-token ceiling preserves the completed response and refuses subsequent children. If a provider omits cost telemetry, a cost-bounded child stops with `BUDGET_UNOBSERVABLE` — unknown spend is never treated as zero. A delegation contract can independently impose a **contract budget**, including a tighter timeout.

The dimensions are independent: `maxCostUsd` is cost, `maxTokens` cumulative
input+output, and `maxGeneratedTokens` output only — not total/input, context,
or cost. Compact disclosure says so.

At 80% of any ceiling that stops the live run (cost, generated output, or a contract's total tokens), the child receives a **wrap-up notice**. This steered message asks the child to stop working and emit its return envelope now. Unfinished work is recorded as skipped coverage and `unresolvedQuestions`, with status `partial`. The transition belongs to the ceiling, not to one child. When any child's settled turn crosses the threshold of a shared budget, every live child governed by that budget is steered at the same moment. A child spawned while a shared ceiling is already inside the window is steered at spawn, before its first turn. A child can cross the ceiling after the notice demonstrably reached it (the steered message is seen echoed into its session). That child is still terminated, so the spend stays bounded. But the run settles gracefully (`stopReason: "budget_wrap_up"`, exit 0), and its final output proceeds to envelope validation instead of being forfeited as `BUDGET_EXCEEDED`. For a contracted child, that graceful settlement is provisional. Delivery of the notice is not compliance. A wrap-up response that then fails envelope validation revokes the success. The run reports the validation error (for example `RETURN_ENVELOPE_INVALID`, naming the failing role) instead of rendering as ✓ beside a flow error. A contracted child's notice also states the exact envelope requirement — the `contractId` it must carry, and the return-envelope format its final message must be — so the notice is possible to honor. Two cases keep the hard-stop semantics: a ceiling crossed before any wrap-up request was possible (one turn jumping from below 80% past 100%), and a notice that never reached the child (for example with child extensions disabled). The wrap-up request (`child.wrap_up`, with `flow.budget.wrapup_delivered`) and a graceful exhaustion (`child.exhausted` with `flow.budget.graceful`) are recorded as budget events on the trace. Size ceilings as runaway backstops (~3x the expected normal spend), not as governors inside the normal cost range. A ceiling that sits inside the normal range converts routine runs into losses.

The generated tool call, collapsed live row, and durable Flow card
all disclose configured cost/token ceilings with their authority. Identical
contract ceilings are collapsed into one compact line. Distinct ceilings remain
separate. The durable entry persists these static ceiling definitions, so a
`BUDGET_EXCEEDED` result still names the binding configuration after a session
reload. Timeout-only contracts are not presented as cost/token ceilings. A call
that omits all ceiling fields runs uncapped — there is no hidden default.

For `CHILD_PROVIDER_ERROR`, collapsed views show category, diagnostic,
runtime/context facts (`?` when telemetry is absent), and safe recovery.
Expansion keeps redacted/capped detail, or withholds prose under `recordContent:false`.

### Trace export (observability)

Set `traceFile` (or `PI_FLOWS_TRACE_FILE`) to write one append-only JSON span per delegated child, plus a root span for the whole flow call. Child spans carry per-run `flow.duration_ms`. Root spans carry distinct `flow.elapsed_time_ms` (end-to-end wall clock), `flow.worker_time_ms` (sum of completed child runtimes), and, when the mode topology is known, `flow.critical_path_ms`. `flow.critical_path_available:false` means the runtime did not have enough dependency data and did not fabricate a value. Other OpenInference-style attributes include `flow.mode`, `flow.agent`, `llm.model_name`, `llm.token_count.*`, `flow.cost_usd`, status, and (when `recordContent` is on) redacted `input.value` / `output.value`. `flow.thinking_level` is the level passed to the child, after clamping to its model. Its pair `flow.thinking_level_verified` states whether the clamp was applied. It is `false` for a child that names no model: pi-flows cannot read that child's configured default, and pi can lower the level internally, so treat the value as requested rather than effective. When `traceContext` is supplied, redacted `flow.run_id`, `flow.case_id`, `flow.trial_id`, `flow.trial_index`, and `flow.arm` values are copied to every span. `details.trace` reports health and the exact trace/root identifiers, and redacts and bounds the displayed trace path, context, and write error. The trace and root-span ids are derived stably from `traceContext` and the mode — that derivation is the eval linkage. Two calls that share both, such as a traced pre-spawn refusal and the retry after it, share the same ids. Every row therefore also carries `flow.invocation_id`, a random per-call discriminator returned as `details.trace.invocationId`. Both the strict read-back and the trace report judge each invocation only on its own rows. Export is best-effort and never fails a flow.

#### Span topology

Every span declares its role in `flow.span_role`:

| Role | What it is |
| --- | --- |
| `root` | The whole flow call. |
| `stage` | A wave, round, iteration, fan-out group, or workflow phase. |
| `child` | One delegated child run. |
| `event` | A zero-duration coordination boundary (see below). |

Children nest under the stage that scheduled them, not flat off the root. A critic belongs to a visible revision round, and a graph node to a visible wave. `flow.unit_key` names the unit (`alpha`, `worker-2`, `phase-deploy`), and `flow.stage_key` / `flow.stage_span_count` describe the stage.

Consumers link through the boundary that produced what they read, not around it. A synthesizer that consumes a validated handoff depends on `<unit>.handoff` rather than on `<unit>`. Validation, filtering, and the injection scan sit between a child's output and what the next prompt actually carried. This holds wherever one agent's output becomes another's prompt, not only in the modes that use the integration adapter. An evaluate critic reads the prepared artifact, a loop judge reads the prepared body, and a search scorer reads the prepared candidate.

Dependencies are recorded as **links, not parentage**. A graph node that consumed another node's output was scheduled by its wave, not spawned by the node it read. `flow.depends_on` lists the unit keys, and `flow.depends_on_span_ids` lists the resolved span ids. Both are comma-joined. Node, phase, and task ids are author-supplied, so `%` and `,` inside a key are percent-escaped (`build,linux` → `build%2Clinux`). Decode before you match a key against `flow.unit_key`, which is escaped the same way. `flow.depends_on_unresolved` lists any declared keys that resolved to no span at write time, with the same escaping and the same structural cap. It is the writer's record of a handler bug: a `dependsOn` that names a unit that never registered. `flow.depends_on_unresolved_truncated` mirrors `flow.depends_on_truncated`. A row that carries the marker is structurally valid. Read-back counts such edges as **dangling links**, reported separately from incomplete or structurally invalid traces, and `npm run trace:report -- --strict` still passes. An honest record of a bad link is not lost evidence.

#### Coordination events

Not every failure happens inside a child run. Approvals, state transitions, budget refusals, gate results, and handoff acceptance move the flow without spawning anything, so each is written as its own zero-duration span with `flow.event_kind` ∈ `artifact`, `state`, `retry`, `approval`, `budget`, `validation`, `handoff`.

Every event also states whose hand wrote it. Some actions pass through a framework seam: a deterministic gate run, an approval receipt issued, a handoff consumed, or the export's own certification. The seam mints those events, and the row carries `flow.event_minted:true` (omitted otherwise, never `false`). The handler records a mode's own decisions: state transitions, retries, and the verdicts its controllers parse from child output (`evaluate.panel_verdict`, `orchestrate.verify_verdict`, `loop.judge_verdict`, `debate.judge_verdict`, `vote.tally`, `search.scores`, each a `validation` event). Each mode declares once, on the mode table, which kinds its own hand records. The root span carries that declaration as `flow.trace.owed_event_kinds`, comma-joined and sorted. An empty value is a declaration of none. An absent value means the trace was written before the declaration existed. A declaration bounds kinds, not counts, because whether a retry fires is runtime-dependent. But it makes an unminted event of an undeclared kind readable as corruption rather than as a mode's quirk (see strict mode below).

Contract validation is recorded at every contracted consumption, and the event name says whether a role boundary was crossed. `handoff.accepted` / `handoff.rejected` mean another role consumed the result. `envelope.validated` / `envelope.rejected` mean a terminal (parent-facing) report, which the glossary says is not a handoff. Each is followed by an `artifact.referenced` or `artifact.rejected` event per declared artifact. A terminal report stays exempt from injection-policy *enforcement*. Only the recording is unconditional, so a digest mismatch leaves the same evidence whether the spend fed another role or came straight back to the parent.

Handoff events record what crossed the boundary: `flow.handoff.status`, `.compatibility`, `.acceptance` (`accepted` or `rejected:<CODE>`), `.raw_bytes` / `.carried_bytes` / `.filtered`, `.injection_warnings`, `.policy`, `.policy_action`, `.compositional`, `.scan_flagged`, `.payload_propagated`, `.payload_withheld`, `.sensitive_request_propagated`, `.artifact_refs`, and `.preserved_constraint_ids`. They never record the summary prose or the envelope `data`. Constraint ids are content-derived (`constraint.1:<digest>`), so the same constraint keeps the same id at every hop. "Was this preserved?" is answerable without copying the constraint text into the trace. These are operational enforcement facts, not ground-truth attack outcomes. The deterministic fault-portfolio report keeps benign utility, attack success, propagation, containment, sensitive exposure, and false-positive block rates separate, and does not derive them from scanner labels. Its scripted scenarios know whether content was benign and what the recipient actually did.

Child spans additionally identify the authority they ran under: `flow.agent_prompt_version` (a digest of the system prompt that actually ran), `flow.allowed_tools`, `flow.authority_may` / `_must_not` / `_requires_approval`, `flow.side_effect_class`, `flow.contract_id`, `flow.return_schema_digest`, `flow.constraint_ids`, `flow.delegation_reason` (the call's `why`), and the budget state after the run.

#### Trace health and strict mode

The root span accounts for the export itself: `flow.trace.expected_spans`, `.observed_spans`, `.dropped_spans`, `.redacted_spans`, `.failed_exports`, and `.health` (`recorded` / `degraded` / `missing`). The same counters come back on `details.trace.spans`. Reading a trace back compares the declared expectation against the rows actually present, so spans lost *after* a successful write still register as dropped. A strict run additionally returns `details.trace.structure` (`FlowTraceStructure`): whether the read-back found a span tree, with `issue` naming the fault when it did not. The field is present only when the run verified its own export — today `traceStrict` — and **absent means unverified, never verified-fine**. A strict root also declares one span beyond its pre-verification count: the slot for the certification event the reader requires. A landed certification then matches the declaration exactly, and a missing one reads as loss.

Trace health is deliberately not folded into execution success. A run whose spans were dropped is not a failed run — it is an unauditable one. Conflating the two turns every exporter problem into a phantom agent regression.

Tracing stays best-effort by default. Set `traceStrict:true` (or `PI_FLOWS_TRACE_STRICT=1`) to make evidence a gate: a missing trace file, dropped spans, or failed writes then fail the call with `TRACE_INCOMPLETE`. A strict run also reads its own export back before it reports a result. A trace that was written completely but does not hold together as a span tree — a span that never reaches the root, or one outside its parent's interval — fails the same way. It does not pass on the writer's count. The same reading holds unminted event rows to the root's declared `flow.trace.owed_event_kinds`, so an event span of a kind the mode never declared refuses the call too. Rows that carry `flow.event_minted` are the seams' own statements and are exempt, as are traces written before the declaration existed. The read-back reads only from the point the file had reached when the flow call began. The file is append-only, so earlier bytes cannot belong to the call. When many flows share one `traceFile`, this keeps each finalize's cost proportional to its own rows, plus anything co-tenants append while it runs. Rows already in the file before the call, under any trace id, are judged by whole-file readers such as the report, not by the call's own gate. `npm run trace:report -- --strict` reruns that same reading over a trace you still have. Use it for evaluation and release runs, not for ordinary user flows. The eval harness has the matching switch: `npm run eval -- --strict-trace` blocks a run whose runtime traces are incomplete, reported as its own score family rather than as subject failures.

Summarize a trace file from inside pi:

```text
/flows report flow-trace.jsonl
```

Or from a checkout:

```bash
npm run trace:report -- flow-trace.jsonl
npm run trace:report -- --strict flow-trace.jsonl   # exit 1 on incomplete evidence
```

The report groups runs by `flow.mode` and `traceLabel`. **Execution success** means a run or flow settled without a process or coordination failure. It does not establish that the requested outcome was correct. **Verified outcome success** means an independent verifier established that the requested outcome met its acceptance criteria. It and verified TPSO are available only when an `evaluate` critic, an explicit orchestrate verifier, or the `code-review` preset's harness-derived outcome returned evidence. The report never promotes ordinary process completion to verified outcome success. A validated Return envelope does not qualify either: contract validation proves attribution, artifact integrity, and schema conformance. It never proves that the Return's claims are true. A **Return assurance** line counts the child runs dispatched under a delegation contract against ordinary Results, which carry no machine contract assurance. Elapsed, worker, and critical-path time remain separate. A trace-health line reports observed-vs-expected spans, drops, redactions, failed exports, how many runs are incomplete, and, when any exist, event spans of a kind the mode never declared. An undeclared-kind event makes its invocation incomplete, so `--strict` refuses the file. A topology line counts stage spans and coordination events. Older traces with root `flow.duration_ms_total` remain readable, are interpreted as accumulated worker time, and are explicitly marked as legacy compatibility data. Traces written before span roles existed are read as root-plus-children.

## Return requirements, delegation contracts, and write isolation

A child's output carries one of three assurance levels. An **ordinary Result**
is the child's own account, with no machine contract assurance. A
**contract-bound Return** passed validation under a delegation contract:
attribution to the resolved contract identity, declared artifact integrity,
and return-schema conformance. Validation never proves that the Return's
claims are true or that prose `acceptanceChecks` were satisfied. **Verified
outcome success** exists only when an independent verifier assessed the
outcome (see the trace report above).

`returnContract` and `requireEvidence` supply prose **return requirements** that
prevent summary loss at handoff boundaries. They are appended to child tasks in `single`, `parallel`, `chain`,
`evaluate`, `vote`, `route`, and to `orchestrate` workers/synthesis. Workflow
phases, worktree tasks, and dossier sections accept task-level return requirements.
Those override the top-level return requirements. Dossier sections and worktree tasks require
evidence by default. `orchestrate.workerReturnContract` can set a worker-specific
set of return requirements while the top-level `returnContract` still applies to synthesis.

For durable machine-checked handoffs, a delegation `contract` is the structured alternative.
It contains `objective`, `constraints`, `nonGoals`, `dependencies`, `authority`
(`may`, `mustNot`, `requiresApproval`), `sideEffectClass`, `budget`,
`acceptanceChecks`, a JSON Schema `returnSchema`, and `owner`. All fields are
required. Arrays and the budget object can be empty. Each dispatched delegation
contract has a canonical `sha256:` identity. Every contracted mode, chain steps
included, requires the child to echo that identity as `contractId`. Missing or
stale returns fail with `RETURN_CONTRACT_MISMATCH` before a dependent child,
synthesizer, or worktree merge can consume them. JSON Schema, artifact-boundary,
and digest validation also happen before integration.

Single and the evaluate operator use the top-level delegation contract, and chain
uses it as the step fallback. Parallel tasks and vote/debate roles can use it
directly. Graph nodes, workflow phases, worktree tasks, dossier sections, and
orchestrate roles can set their own delegation contract, because their
objectives and return schemas often differ. Final debrief/integrator roles in those modes
fall back to the top-level delegation contract where their mode plan declares a
`resolved` role.

Every agent-reference role enforces its own `contract`, including evaluate critics,
route controller, loop body/judge, search generator/scorer/debrief, and monitor
reactor. Unless documented as `resolved`, it does not inherit the top-level contract.
Control decisions read schema-checked `data` directly. They never scan markers
in a serialized copy or in summary prose. Contracted readers accept only their
documented structured fields and values. Schema-valid strings, booleans, or
legacy synonyms are not coerced into verdicts, loop status, or scores. With
`recordContent:false`, stored data remains omitted while schema-checked
Integration control stays usable ephemerally. Concurrent waves validate every
successful Return before they expose any result. If one or more Returns fail,
all spent Runs and rejection evidence are retained.

Every result a downstream role consumes becomes a **handoff envelope**
(`pi-flows.handoff-envelope.v1`) with source agent and step provenance. A terminal
(parent-facing) result is not a handoff: it keeps its validated return envelope on
`details.results[].envelope` and attaches no `handoff` field, because no role
consumed it. Return envelopes retain delegation-contract identity, status, evidence,
artifact references/digests, and schema-checked data. Existing prose-only results
remain supported as `compatibility:"legacy-prose"` handoff envelopes with
`contractId:null`. Downstream prompts receive that explicit compatibility shape
instead of trusting unlabeled prose. Partial and blocked return envelopes fail
closed unless `incompleteHandoffPolicy:"include"` is explicitly selected.

Contract budgets apply at dispatch: timeout tightens each run's top-level limit,
while cost/token spend is shared by contract identity within the flow. Chain
deliberately resets that spend per step because each step is a distinct
delegation. Flow budgets remain shared across the flow.

```json
{
  "agent": "recon",
  "contract": {
    "objective": "Find the configured sample identifier.",
    "constraints": ["Read only."],
    "nonGoals": ["Do not edit configuration."],
    "dependencies": ["settings.txt"],
    "authority": {
      "may": ["Read repository files."],
      "mustNot": ["Write repository files."],
      "requiresApproval": []
    },
    "sideEffectClass": "read-only",
    "budget": { "timeoutMs": 30000, "maxGeneratedTokens": 2000 },
    "acceptanceChecks": ["Return the exact value and source path."],
    "returnSchema": {
      "type": "object",
      "required": ["answer"],
      "properties": { "answer": { "type": "string" } },
      "additionalProperties": false
    },
    "owner": "parent"
  }
}
```

The child must return `pi-flows.return-envelope.v1` with `status`, `summary`,
`evidence`, `artifactReferences`, `digests`, `changedState`,
`unresolvedQuestions`, `retry`, and `data`. That output is a **Return
candidate** until validation accepts it. A candidate can omit `contractId` or
carry a stale one, and the rejection reports the identity it saw. Only a
candidate that passes attribution, integrity, and conformance becomes a
validated **Return envelope**. The envelope always carries the resolved
contract identity. `data` is checked against `returnSchema`. Declared SHA-256
digests are checked against files inside the child `cwd`. Runtime usage is
attached when available. Invalid schema data, unsafe/missing artifacts, or
digest mismatches fail closed with a structured error before the Return can
drive a dependent role or coordination decision. Only validation attaches the
envelope, retained on `details.results[].envelope`. For downstream validators,
the public schema `FlowReturnCandidate` matches the candidate shape and
`FlowReturnEnvelope` matches only the validated form.

Existing `task`, `returnContract`, and `requireEvidence` calls remain prose-based
and behave as before.

Parallel fan-out is read-optimized by default. If a call asks two write-capable
agents to run concurrently in the same `cwd`, pi-flows returns
`SHARED_WRITE_CWD` before it spawns them. A role is write-capable when its
effective tools are pi defaults, or include `bash`, `edit`, or `write`. The
toolset decides, never the role name or prompt. The refusal names the tools that
classified each agent. To recover, serialize with `concurrency:1`, use agents
whose effective tools exclude `bash`/`edit`/`write`, swap `bash` for `bash-ro`,
or give each writer a separate worktree/cwd. Set `allowSharedWriteCwd:true` only
as a last resort, after you decide that concurrent writes in one shared checkout
are intentional.

`bash-ro` is not write-capable. It is enforced in two layers:

- **OS sandbox (the security boundary).** On macOS the child runs under
  `sandbox-exec` with a profile that denies file writes anywhere under the
  reviewed `cwd` and allows everything else. A write into the shared checkout
  fails at the kernel, whatever command produced it. Writes
  outside the checkout (pi's own temp files, npm/node caches) still work.
  Opt out with `PI_FLOWS_BASH_RO_NO_SANDBOX=1`.
- **In-child command allowlist (defense-in-depth, and an opt-in fallback).**
  The child loads an enforcer extension via an explicit `-e`. The explicit flag
  survives `--no-extensions`, because pi only drops *discovered* extensions.
  The enforcer blocks bash commands outside a read-only allowlist: git
  inspection (`log`/`diff`/`show`/`blame`/`status`/...), file inspection
  (`ls`/`cat`/`grep`/`find`/...), and repo verification (`npm test`,
  `npm run <script>`, `node --test`). It refuses shell expansion/substitution,
  and known write/exec flags fail closed. Command parsing can never be
  exhaustive — getopt-style option abbreviation alone yields endless new
  spellings across every tool — so the allowlist is **best-effort, not a
  security boundary**. It is the default fallback where the OS sandbox is
  unavailable. A caller who needs a kernel-enforced guarantee sets
  `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX=1`, which refuses
  (`BASH_READONLY_UNENFORCEABLE`) instead of falling back.

Every bash-ro child also runs with several repository-configured git helpers
neutralized via `GIT_CONFIG_*`: the pager, a command-valued `fsmonitor`, and
hooks. `diff.external` and textconv drivers are deliberately *not* forced off,
because an empty `diff.external` makes git abort every diff. A configured
external-diff/textconv program can therefore still launch on a plain
`git diff`/`git show`. On the sandbox path, its checkout writes are denied at
the kernel. On the fallback path, it is a documented residual (see the
limitations below).

When the sandbox enforces, verification commands that write *into* the checkout
(a build cache, `*.tsbuildinfo`) fail. That is the same shared-checkout
mutation the guard exists to prevent. Run those commands in a non-`bash-ro`
role or a distinct cwd. A toolset carrying both `bash` and `bash-ro` is
write-capable (plain bash wins). A `bash-ro` spawn is refused with
`BASH_READONLY_UNENFORCEABLE` only when no layer can enforce it: the enforcer
extension cannot be located, or `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX` is set on a
host without the sandbox. It never silently grants an unrestricted shell.
The child span records which layer enforced it (`flow.bash_ro.enforcement` =
`sandbox` or `allowlist`).

**Known limitations of the best-effort allowlist fallback.** Where the OS
sandbox does not run (non-macOS, or opted out), a few git behaviors can still
touch the checkout and are accepted residuals of a path documented as
best-effort, not a security boundary:

- A repository-configured `diff.external` or textconv driver runs on a plain
  `git diff`/`git show`. Its command comes from *local* git config, which the
  untrusted reviewed tree cannot set. Git offers no config/env switch to
  disable it without breaking internal diff — only the per-command
  `--no-ext-diff`.
- `git status`/`git diff` can refresh `.git/index` stat data.
- Command parsing cannot be exhaustive (option abbreviation).

All three are contained on the sandbox path: the writes are denied at the
kernel, and git inspection still succeeds. Where the sandbox is unavailable,
set `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX=1` to refuse rather than run best-effort.

## Coordination-control protocol

Verdict, loop, route, and score decisions are read from a child's output under
one fail-closed grammar. A control token is authoritative only when it occupies
the **authoritative position**: the child's **first non-empty line**, and that
line is exactly the marker and one documented value with nothing after it. The
instructions a mode sends its child and the grammar the parser accepts are both
derived from one vocabulary, so they cannot drift.

| Protocol | Marker | Documented values | Authoritative position | Unparseable fallback |
|---|---|---|---|---|
| Verdict | `VERDICT` | `PASS`, `REVISE` | first non-empty line, for example `VERDICT: PASS` | `REVISE` |
| Loop | `LOOP` | `DONE`, `CONTINUE` | first non-empty line, for example `LOOP: DONE` | `CONTINUE` |
| Route | `ROUTE` | one candidate name exactly, or `none` | first non-empty line, for example `ROUTE: recon` | unresolved route (fallback agent, else `ROUTE_UNRESOLVED`) |
| Score | `SCORE` | an integer or decimal in `0..100` | first non-empty line, for example `SCORE: 88` | unscored candidate (`0`) |

A mention, quotation, negation, example, or a longer word that merely begins
with an allowed token is ordinary prose and fails closed. `PASSPORT`,
`APPROVED`, `LOOP: COMPLETE`, `SCORE: 150`, or a negated line such as `I cannot
issue VERDICT: PASS` do not terminate or redirect coordination. Marker and
value match case-insensitively. Structured `data` values match their documented
value and type exactly: the lowercase `"pass"`/`"revise"` and `"done"`/`"continue"`
strings, a candidate-name route string, or a score number in `0..100`.

Each protocol also accepts a JSON fallback: `{"verdict":"pass"}`,
`{"loop":"done"}`, `{"route":"recon"}`, `{"score":88}`. The fallback accepts
only the documented field and value type. Anything else is unparseable.

## Evaluate mode (generator-evaluator loop)

The `operator` builds an artifact against the top-level `task`. A separate `redteam` judges that artifact against the goal and returns a verdict. Top-level `task` is preferred, but `evaluate.operator.task` is accepted as the goal when the top-level field is omitted. On `REVISE`, the operator is re-shown **its previous artifact plus the critique** and revises it in place, not from scratch. The loop stops on `PASS` or when it reaches `maxIterations`. Either way, it returns the last attempt.

The two roles run in separate child processes with separate contexts. The `redteam` sees only the `operator`'s **output**, never its reasoning trace, so its judgment is independent (see the wiki's generator-evaluator-harness design rules).

Two reliability levers beyond the single LLM critic:

- **`checkCommand` — a deterministic gate (level-1 / code assertions).** A shell command run in the operator's `cwd` that must exit `0` each round. A non-zero exit is an automatic `REVISE`: the command output becomes the critique, and the LLM critic is skipped that round, which saves cost. `PASS` requires **both** the check (exit 0) **and** the critic(s). The harness guarantees this verification — the prompt does not merely request it. A command that cannot start (for example, not found) fails with `CHECK_COMMAND_FAILED` rather than looping forever.
- **`redteam` as a panel (god-metric → decomposed evaluators).** Pass an array of critics — for example one per dimension (correctness, security, tests). They run in parallel. `PASS` requires **every** critic to pass, and the `REVISE` critiques are merged for the next round.

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
| `evaluate.operator` | `{ agent: "operator" }` | Builds the artifact. Its optional `contract` overrides the top-level contract. `task` can supply the goal when top-level `task` is omitted. |
| `evaluate.redteam` | `{ agent: "redteam" }` | One critic or an array. Each accepts its own `contract` (no top-level fallback). Contracted verdicts come from `data.verdict`. With a panel, `PASS` needs every critic to pass. |
| `evaluate.checkCommand` | (none) | Deterministic gate: a shell command that must exit `0` each round. Non-zero → forced `REVISE`. Non-runnable → `CHECK_COMMAND_FAILED`. |
| `evaluate.maxIterations` | `3` | Integer `1..8`. Hard cap on generate→evaluate rounds. |
| `evaluate.passContract` | (none) | Explicit acceptance criteria appended to the critic's rubric. Concrete criteria make the verdict reliable. |

Without a role contract, `redteam` signals `VERDICT: PASS|REVISE` as its first non-empty line (or JSON `{ "verdict": "pass" }`). With a contract, validated `data.verdict` is authoritative and marker-like text in other fields is ignored. When both roles are contracted, the critic sees the operator's admitted terms as review context, but only the critic's own contract supplies its required Return protocol and identity. An unparseable verdict means `REVISE`. `details.results` interleaves each operator run with that round's critic panel.

## Vote mode (parallelization / voting)

Runs the same `task` across two or more voters. Then it either aggregates the answers via a `debrief` agent or returns all of them. Independent voters suppress non-deterministic errors. **Different models** (vendor-diverse voting) additionally break correlated blind spots. When every voter has the same agent/model identity, pi-flows keeps the original task but adds complementary voter stances (for example solver, skeptic, and evidence checker), so the ballots are not identical prompt replays.

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
| `vote.voters` | (none) | Explicit voter list (heterogeneous models recommended). Each runs the same goal. Identical agent/model voters get complementary stances. |
| `vote.agent` + `vote.count` | count `3` | Same-agent voting: run one agent `count` times with complementary stances. `count` is `2..8`. |
| `vote.debrief` | (none) | Optional `debrief` agent that merges the voter answers. Without it, all voter answers are returned for the parent to judge. |

At least 2 voters are required (`TOO_FEW_VOTERS` otherwise) and at most `maxParallelTasks`. `concurrency` controls fan-out. Voter answers are free text, so the `debrief` agent decides consensus, not a programmatic majority.

## Route mode (classify → dispatch)

The `controller` reads the `task` plus the candidate descriptions and picks one agent to run.

```json
{
  "task": "The billing webhook is returning 500s in production",
  "route": { "controller": { "agent": "controller" }, "candidates": ["recon", "strategist", "overwatch"], "fallback": "recon" }
}
```

| Field | Default | Notes |
|---|---|---|
| `route.controller` | `{ agent: "controller" }` | Classifier. Sees the task and candidate descriptions. Accepts its own `contract`, whose validated `data.route` is authoritative. |
| `route.candidates` | (required) | Agent names the `controller` can choose from. |
| `route.fallback` | (none) | Agent to run if the `controller` names no valid candidate. Without it, an unresolved route returns `ROUTE_UNRESOLVED`. |

Without a contract, the controller can return `ROUTE: <agent>` as its first non-empty line, or JSON `{ "route": "<agent>" }`. A candidate named anywhere else is prose and never selects. A contracted controller uses only validated `data.route`. Embedded marker text cannot override it. A quarantined controller payload cannot select a candidate and falls back like `none`. Without `route.fallback`, either case returns `ROUTE_UNRESOLVED`.

## Orchestrate mode (decompose → fan out → synthesize)

The `commander` decomposes the `task` into independent subtasks, `recon` workers run them in parallel, and the `debrief` agent merges the results. This is the deep-research / orchestrator-workers shape. Top-level `task` is preferred. `orchestrate.task` is accepted as its fallback. Each worker sees both the overall goal or delegation contract and its assigned subtask, so terse decomposition output does not detach findings from the final answer requirements.

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
| `orchestrate.commander` | `{ agent: "commander" }` | Returns a JSON subtask array without a contract. Its own contract carries that array as validated envelope `data`. |
| `orchestrate.recon` | `{ agent: "recon" }` | Runs one subtask each, in parallel, with the overall goal or delegation contract included for context. Use `analyst` for deeper per-subtask investigation. |
| `orchestrate.debrief` | `{ agent: "debrief" }` | Merges the subtask findings into one answer. |
| `orchestrate.verify` | (none) | Optional critic. Without its own contract, it returns PASS/REVISE prose. With one, validated `data.verdict` controls the decision. |
| `orchestrate.verifyPolicy` | `note` | `note` appends the verifier verdict. `fail` returns `ORCHESTRATE_VERIFY_FAILED` on `REVISE`. `revise` reruns `debrief` with the critique and re-verifies until pass or cap. |
| `orchestrate.verifyMaxIterations` | `2` | Integer `1..4`. Maximum synthesize→verify rounds when `verifyPolicy:"revise"`. |
| `orchestrate.workerReturnContract` | (none) | Prose return requirements appended to every worker subtask before fan-out. |
| `orchestrate.returnContract` | (none) | Alias for top-level `returnContract`. When top-level `task` is also omitted, this text can serve as the goal fallback for model-generated calls. |
| `orchestrate.maxSubtasks` | `maxParallelTasks` | Cap on subtasks (also bounded by `maxParallelTasks`). |

If the `commander` returns no usable subtask array, the call fails with `ORCHESTRATE_NO_SUBTASKS`. `concurrency` controls worker fan-out. `details.results` is ordered commander → workers → debrief → (optional) verify.

Composed with return requirements and a revising verifier:

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
  "why": "a broad cross-codebase map is more reading than one context can serialize"
}
```

Workers receive the goal, the return requirements, and their assigned subtask. The `overwatch` verifier checks the merged answer against the goal, and `verifyPolicy:"revise"` reruns `debrief` with the critique until pass or `verifyMaxIterations`.

## Graph mode (static DAG)

`graph` runs a bounded static DAG. A node runs after all its `dependsOn` nodes
complete. Ready nodes in the same dependency wave can run in parallel.

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

`loop` repeats a body agent until an uncontracted body emits `LOOP: DONE` as its
first non-empty line, or an uncontracted judge emits `VERDICT: PASS` the same
way. Contracted roles use validated `data.loop` / `data.verdict` instead.
Anything but the exact `LOOP: DONE` marker — `LOOP: COMPLETE`, a negated
`LOOP: DONE`, or no marker at all — means `CONTINUE`.

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

| Field | Default | Notes |
|---|---|---|
| `loop.body` | (required) | Iteration agent. Accepts its own `contract`. Without a judge, contracted `data.loop` controls DONE/CONTINUE. |
| `loop.judge` | (none) | Optional critic with its own `contract`. Contracted `data.verdict` controls PASS/REVISE. |
| `loop.maxIterations` | `3` | Bounded iteration cap. |

If the loop reaches `maxIterations` without a stop signal, pi-flows returns
`LOOP_DID_NOT_CONVERGE` with the last output/critique.

## Search mode (bounded beam search)

`search` generates candidate paths and scores them. A score comes from a legacy
`SCORE: 0..100` marker on the first non-empty line, or from contracted
`data.score`. The mode keeps the best beam, optionally refines, then debriefs
the winner. An out-of-range or unparseable score leaves the candidate unscored
(`0`).

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

| Field | Default | Notes |
|---|---|---|
| `search.generator` | `{ agent: "strategist" }` | Accepts its own `contract`. Every successful Return validates before it reaches a scorer. |
| `search.scorer` | `{ agent: "redteam", tools: "none" }` | Accepts its own `contract`. Contracted scores come from validated `data.score`. |
| `search.debrief` | `{ agent: "debrief" }` | Finalizer with its own contract. Its terminal Return validates before the mode reports success. |
| `search.candidates` / `beamWidth` / `maxRounds` | `3` / `1` / `2` | Bounds generation, retained beam, and refinement rounds. |

Use `search` when several plausible plans or artifacts must be explored and
ranked before synthesis. It is intentionally bounded by candidate count, beam
width, rounds, concurrency, timeout, and cost/token ceilings.

If `scorer` is omitted, it defaults to `redteam` with `tools:"none"` so
parallel scoring cannot mutate the workspace.

## Workflow mode (gated, resumable phases)

`workflow` runs an ordered state machine of work phases and approval nodes. It
persists redacted outputs and structured handoff envelopes after every work
phase, so a headless approval pause or later retry does not discard completed
work. Version-2 and later state also stores a content-free attestation. The
attestation is created only after the original contract, schema, artifact, and
digest validation succeeds. Resume
binds the sanitized envelope to that attestation and the current contract
identity instead of revalidating policy-transformed content. Existing version-1
states migrate to legacy compatibility envelopes before downstream reuse. The
current state schema is version 5. Version 4 added the effective Agent-profile
binding described below. Version 5 changed the workflow identity to a canonical
digest that does not depend on object key order (see `workflow.stateFile`).

```json
{
  "task": "Ship the cache migration",
  "thinking": "medium",
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
        "tools": "read,bash,edit,write",
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
| `workflow.stateFile` | `.pi/flow-workflows/<digest>.json` | Audit/resume state. The digest is a canonical SHA-256 short form over the top-level task, the phases in order, and the debrief configuration. Object key order does not change it. Task text, phase order, phase values, and debrief meaning do. The file is written atomically with owner-only permissions. |
| `workflow.resume` | `false` | Load completed phases from `stateFile`. The task and workflow digest must match, and every outstanding approval is rechecked against the profiles that execute now. Resuming an already completed workflow is an audit-only no-op and spawns no Child. The default lookup prefers the canonical-digest file. When only a legacy (version 1–4) digest-named file exists, resume reads it, migrates it, writes it under the canonical name, and removes the legacy file. |
| `workflow.historicalThinking` | (none) | Optional v3 migration witness with `phases: { "<phase-id>": "<effective-level>" }` and/or `debrief`. Use only when bounded reconstruction requests it. A value never controls dispatch and is accepted only when it reproduces the spent receipt's binding digest. |
| `workflow.debrief` | (none) | Optional final synthesizer over all persisted phase artifacts. A trailing approval binds its effective Agent profile too. |
| `workflow.approvalTtlMs` | `86400000` (24h) | How long an approval receipt authorizes its gated action. Integer `60000..2592000000`. A resume after the window needs a fresh approval. |
| `phase.task` | required for work | Supports `{task}`, `{previous}`, and `{phase.<id>}` output placeholders. |
| `phase.checkCommand` | (none) | Deterministic gate run in the phase `cwd`. Non-zero stops with `WORKFLOW_GATE_FAILED`. |
| `phase.cwd` / `model` / `tier` / `thinking` / `tools` | inherited | Per-phase process and gate overrides. Approval binds their effective values after Agent and flow fallbacks. |
| `phase.returnContract` / `requireEvidence` | top-level values | Per-phase handoff requirements. |

Interactive approval nodes call the Pi confirmation UI. In headless contexts
they fail closed with `WORKFLOW_APPROVAL_REQUIRED` after they persist completed
artifacts and the next phase. Resume the same task/phases/state file in an
interactive UI with `workflow.resume:true`. A denied approval returns
`WORKFLOW_APPROVAL_DENIED`. It never silently advances.

### Approval receipts

A granted approval becomes a durable, expiring, single-use **approval receipt**
(`pi-flows.approval-receipt.v1`) in the state
file rather than a bare `APPROVED` marker. Each receipt binds one action (the
approval phase and the contiguous run of work phases it gates) to the exact
parameters approved. It also records the requesting and approving actors, the
workflow digest, the state schema version, an issue time, and an expiry.

An approval authorizes exactly one action. That action spans every step
between the approval and the next consent point: the work phases it gates, the
approval that ends the run, and the workflow's own completion when nothing else
follows. Each of those steps re-verifies the receipt against the live spec
before it runs. A resume that lands in the middle of a gated run is therefore
checked — it does not walk in behind a check it never reached. The receipt is
spent once, by the action, at the first gated step that completes. A retry of a
failed phase inside its own gated run is a resume. Presenting the receipt for a
different action is a replay and returns `APPROVAL_RECEIPT_CONSUMED`.

For every gated Role, and for the debrief when the approval reaches workflow
completion, the binding identifies these effective execution conditions:

- selected Agent source (`package`, `user`, or `project`)
- a full SHA-256 identity of the selected Agent system prompt, never its text
- effective tools after the Role override or Agent inheritance is applied
- canonical working-directory target plus a non-disclosing filesystem identity
  (symlinks resolved)
- concrete resolved model
- Thinking level passed to Pi

The canonical cwd binding retained by verification is passed through the opaque
Integration plan and child-run seam. The handler rechecks it after awaited state
writes, and the production adapter checks both path and filesystem identity again
immediately before process spawn, after its own asynchronous setup.

The same binding also covers the approval action/message, task and gate terms,
effective delegation contract and Return/evidence requirements, `agentScope`,
the resolved handoff policies, and `incompleteHandoffPolicy`. Source shadowing,
prompt edits, inherited-tool changes, model-roster changes, repointing a cwd
symlink, replacing the canonical directory itself, or moving the default working
directory therefore produce `APPROVAL_RECEIPT_STALE` even when the authored
phase is unchanged. Some conditions cannot be identified exactly: a missing
Agent, a nonexistent, non-directory, unreadable, or unsearchable cwd, a
Pi-default toolset, a model selector without an exact current registry match, or
an implicit Thinking level. Until those conditions are concrete, a gated
workflow refuses with `WORKFLOW_INVALID` before it asks for consent — or before
approved dispatch, if a canonical target disappeared.

A completed approval whose receipt lapsed or was superseded is **reopened**
rather than stranding the state file. The phase is un-completed, its receipt is
discarded, and consent is asked for again in the same pass, with the reason
carried into the prompt. Headless runs still fail closed with
`WORKFLOW_APPROVAL_REQUIRED`. Only `APPROVAL_RECEIPT_STALE` and
`APPROVAL_RECEIPT_EXPIRED` reopen. A consumed or malformed receipt is evidence
of tampering and stays a hard refusal.

Reopening applies only while the receipt is unconsumed and **none** of the gated
run has executed. After a phase completed or a gated debrief began, a fresh
receipt cannot be issued: it claims to authorize work that already ran under the
old conditions, and it erases the receipt that authorized that work. That case
is refused outright, and the refusal names the completed phases or begun
debrief. The operator then decides: restore the approved profile and resume, or
start a fresh run.

When the workflow itself is already `completed`, resume is an audit-only no-op.
It rechecks persisted handoff and receipt integrity. It does not reopen stale or
expired consent, and it does not rerun a Child, because no action remains to
authorize. Malformed receipts and receipts consumed by another action still fail
closed.

The expiry gates *starting* the authorized action. After the receipt is spent on
it, a gated run finishes — it does not abort halfway because the clock passed.
The binding still has to match, so nothing about the action can have changed.

Every recorded field (actors, issue time, expiry, consumption) is also covered
by a `receiptDigest`. A partial write, a half-applied merge, or a tool that
rewrites one field is caught rather than honored. A receipt that fails that
check is reported with `validation: "unverified"` wherever it surfaces. Its
claims are not repeated as fact.

Receipts surface in `details.approvals`, in the final answer, and on the trace
root span (`flow.approval_receipt_ids`, `flow.approval_receipt_count`,
`flow.approval_consumed_count`, `flow.approval_blocked`) as identifiers and
status only. The effective conditions, including the prompt digest, participate
in the binding digest but are not persisted as receipt fields. Raw prompt text
is never placed in workflow state. Set
`PI_FLOWS_APPROVAL_ACTOR` to label the approving actor. It is an audit
attribution, not an authenticated identity.

Version-2 state files migrate on resume. A completed approval recorded as
`APPROVED` becomes a `legacy-compatibility` receipt with no approver and no
expiry, which still binds the gated action. An unstarted v2 action reopens. A
partially completed one fails closed, because no receipt can prove one set of
conditions for both halves. Version-3 receipts predate effective Agent-profile
binding. Unconsumed outstanding v3 consent reopens. A valid receipt
consumed by its own action keeps its identity as `legacy-compatibility`: audit-only
after completion, or able to resume the same interrupted gated run or debrief.
An in-progress migration binds new profile fields to the current bindable
profile. Later drift is caught. Completed audit reconstruction does not require
the old model or its Thinking metadata to remain in today's roster. Distinct
workflow-bound Role requests reconstruct independently when current metadata
clamps them alike. Reconstruction models one coherent capability profile per
model. If the bounded product is too large, resume leaves the v3 state intact
and requests a `workflow.historicalThinking` witness for one or more phases.
The witness is accepted only when the old binding digest verifies, and every
supplied entry must belong to a spent binding search. Irrelevant, contradictory,
malformed, and replayed v3 evidence remains a hard failure.

Version-4 states carry the older, key-order-sensitive workflow digest. Resume
restamps the state with the canonical digest. It revalidates every completed
approval receipt against the version-4 encoding of the live workflow, then
rebinds the receipt to the version-5 encoding. A receipt that revalidates keeps
its identity, actors, expiry, consumption record, and `typed` validation,
because the approved action did not change. If a spent receipt does not
revalidate, the migration fails with `APPROVAL_RECEIPT_STALE` and keeps the
version-4 state. Restore the approved conditions to retry it. An unspent
receipt that does not revalidate reopens or fails closed through the normal
receipt paths described above. A run without `resume:true` always starts new
work under the canonical name. It does not read or remove a legacy file.

This protects against replay and drift in a local state file. It does not
protect against an attacker who can write that file: any key that signs a
receipt would live beside it.

## Worktree mode (isolated writers and integration)

`worktree` provisions one branch and one temporary git worktree per writer,
then runs the writers concurrently and commits each result. It merges the
results into a separate integration branch, asks an integrator to review and
fix the combined result, and optionally runs a deterministic integration check.

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
| `worktree.integrator` | `{ agent: "operator" }` | Resolves merge conflicts, reviews the integrated diff, and can make integration fixes. |
| `worktree.checkCommand` | (none) | Deterministic command run on the integration branch after integration review. |
| `worktree.checkTimeoutMs` | flow timeout | Timeout for the integration command. Minimum 1000 ms. |
| `worktree.requireClean` | `true` | Refuses a dirty source checkout. `false` still branches from committed `baseRef`. Uncommitted source changes are intentionally omitted. |

The mode never switches or merges the source checkout. On success, temporary
worktrees and worker branches are removed. The durable
`pi-flow/<run>/integration` branch remains for explicit review/merge.
A failed `checkCommand` returns the integration branch name instead of merging
a result that failed its gate. Worker failure or return-envelope rejection retains the
isolated worker state and returns every branch and worktree path needed for
recovery. Conflict-resolution prompts include the validated handoff envelopes
for the already-integrated and incoming workers. Delegation-contract identity,
evidence, artifact references, and digests are preserved through each conflict
choice and into the final integration review. Use this mode only when the tasks
are genuinely independent. One writer belongs in `single` or `evaluate`.

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
| `debate.rounds` | `2` | Integer `1..3`. Round 1 opens independently. Later rounds rebut and repair positions. |

At least two advocates must produce usable arguments in every round. Debate is
deliberately expensive. Use it for high-consequence choices with real opposing
cases, not for quick preferences or questions one fact already settles. It is not an
automatic route: in the paired Codex baselines, direct execution matched
debate's decision quality, and the hard-case token rerun used 16.56× the tokens
and 6.58× the estimated subject spend.

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

At least two extractors must succeed, or the mode returns
`DOSSIER_TOO_FEW_SECTIONS`. One surviving source cannot support cross-source
reconciliation. Prefer read-only `recon`/`analyst` extractors unless source
preparation requires writes.

## Monitor mode (bounded trigger and react)

`monitor` runs a deterministic shell probe under a hard check/time bound. It does
not spawn an agent until a typed trigger fires. The captured observation then
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
| `monitor.pattern` | (none) | Required when `trigger:"match"`. Invalid regexes return `MONITOR_INVALID`. |
| `monitor.intervalMs` | `5000` | Delay between probes, `10..60000` ms. |
| `monitor.maxChecks` | `6` | Hard attempt bound, `1..20`. |
| `monitor.checkTimeoutMs` | flow timeout | Per-probe command timeout. Minimum 1000 ms. |
| `monitor.reactor` | `{ agent: "analyst" }` | Diagnoses impact/cause and bounded actions after a trigger. Accepts its own `contract`, whose terminal Return validates before success. |

If no trigger fires, the mode returns retryable `MONITOR_NOT_TRIGGERED` plus the
bounded observations. `monitor` is not durable scheduling: it stops when the
flow call ends. Do not use it to replace a daemon, cron job, alerting system,
or Codex automation.

## Human checkpoints and Reflexion

`checkpoint` adds an explicit human approval point:

```json
{ "task": "...", "evaluate": {}, "checkpoint": { "before": "spawn" } }
```

`before:"spawn"` asks before any child agent runs. `before:"finalize"` asks after
child work finishes but before the final answer is returned. In headless
contexts, checkpoints fail closed with `CHECKPOINT_APPROVAL_REQUIRED`.

This top-level checkpoint wraps any mode. `workflow` approval phases are different:
they can appear between persisted work phases and resume from `workflow.stateFile`.

`reflexion` provides opt-in local cross-run lessons:

```json
{ "task": "...", "loop": { "body": { "agent": "operator" } }, "reflexion": { "enabled": true } }
```

When enabled, reflexion applies flow-wide, to every mode. Recent lessons from
`.pi/flow-reflections.jsonl` are appended to the top-level `task` before the
mode runs. After any run that spawned at least one child, a redacted lesson is
recorded from the flow's final output. Lessons are injected only into the
top-level `task`. A goal supplied only via `evaluate.operator.task` is not
lesson-augmented.

## Details object

`flow` returns content plus `details`:

- `version`: pi-flows version.
- `mode`: `list`, `config`, `single`, `parallel`, `chain`, `evaluate`, `vote`, `route`, `orchestrate`, `graph`, `loop`, `search`, `workflow`, `worktree`, `debate`, `dossier`, or `monitor`.
- `preset`, `presetOutcome`: resolved preset provenance and, for `code-review`, `CLEAN`, `FINDINGS`, or `PARTIAL`.
- `agentScope`: effective scope.
- `config`: defaults and caps.
- `agentsDir`: package/user/project directories with home paths redacted to `~`.
- `presetsDir`: package/user/project preset directories with home paths redacted to `~`.
- `presets`: discovered preset summaries and their declared override keys.
- `agents`: discovered agent summaries.
- `discoveryIssues`: invalid frontmatter, unreadable files, or shadowed names.
- `results`: redacted child summaries with usage, duration, stderr, optional validated `envelope`, and structured error. A result another role consumed also carries its provenance-bearing `handoff`. A terminal result does not. Provider errors add sanitized classification/diagnostic, termination path, known context window, and thinking-level verification. Prior runs retain usage/cost.

## Structured errors

Every error returned by the `flow` tool is structured:

- `code` — a stable identifier from a fixed set (see catalog below)
- `message` — what happened
- `cause` — why
- `fix` — the suggested next action
- `retryable` — whether a retry with the unchanged call can succeed

The model-visible error text repeats that last field as
`Retryable unchanged: yes|no`. A `no` is terminal for the unchanged call:
the parent must apply the stated fix before another Flow. In particular,
`BUDGET_EXCEEDED` must not automatically replay the same work or loosen the
configured ceiling. Unless the user explicitly approves a budget change, the
parent preserves that ceiling and asks for direction or materially narrows the
task or fan-out first.

The full list of `code` values, each with its cause and fix, lives in the
**[canonical error-code catalog](../how-to/troubleshooting.md#error-codes)** in
Troubleshooting. That catalog is the single source of truth. CI verifies that it
covers every code the tool can return, so it never drifts from the source.

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

Invalid arguments return an error instead of a silent fallback to another scope.
List and status output include both presets and agents. Status also reports both
sets of discovery directories and diagnostics.
