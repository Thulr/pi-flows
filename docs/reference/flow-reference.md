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

loads one Markdown definition, substitutes `{task}`, applies its declared
workflow-shape overrides plus safe caller controls such as capture, tracing,
trust, and `maxCostUsd`, then validates and runs the expanded call as an
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
| `code-review` | Two concurrent read-only (`bash-ro`) `overwatch` runs, roles `standards` and `spec` | Exactly one pass; typed coverage/findings; `CLEAN`, `FINDINGS`, or `PARTIAL` |

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

A preset declares which top-level parameters callers may override (`overrides` in
its frontmatter); undeclared or workflow-shape overrides fail with
`PRESET_OVERRIDE_INVALID`.

A template may set `recordContent`/`redactSecrets` to tighten capture, but never
to loosen it. The effective policy is the stricter of the caller's and the
template's in both directions: a template cannot turn the caller's redaction
off, and a caller cannot re-enable content a template deliberately withholds.
`traceStrict` follows the same rule — a template can turn the evidence gate on,
but a template-authored `traceStrict:false` is dropped so the caller and
`PI_FLOWS_TRACE_STRICT` still decide. `why`, `agentScope`,
`confirmProjectAgents`, and `allowSharedWriteCwd` are caller-only: a template
cannot justify its own delegation, opt its source into trust, or take the
shared-write exception on the caller's behalf.

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

## Live TUI monitoring

Three surfaces cover a flow's life in interactive Pi, all fed by the same
in-memory flow updates:

- **The tool row is live.** While children run, the `flow` tool row shows a
  progress bar, per-run state with a spinner, each running child's current
  tool call or latest message, and a token/cost rollup — updating in place.
  Before the first child starts, the tool call and row also disclose every
  configured cost/token ceiling as a `flow ceiling` or `contract ceiling`.
  `ctrl+o` expands the settled row into full per-run output.

  <img alt="The live flow tool row updating in place while children run" src="https://raw.githubusercontent.com/Thulr/pi-flows/main/docs/images/flow-live-row.gif" width="100%">
- **`F8` toggles the fleet panel**, a non-modal overlay listing every live flow
  at once with the runs beneath each one: per-run state and activity, failures,
  and budget burn-down when `maxCostUsd` is set. A flow stays listed until its
  handler settles, so it remains visible between stages even when every run it
  has started so far is settled. The panel never takes keyboard focus — keep typing while
  it is open. Press `F8` again (or Escape when focused) to close it; closing
  never interrupts children. It hides automatically on terminals narrower than
  80 columns.

  <img alt="The F8 fleet panel overlay listing every live flow with per-run state and budget burn-down" src="https://raw.githubusercontent.com/Thulr/pi-flows/main/docs/images/flow-fleet-panel.gif" width="100%">
- **`/flows inspect` drills into one child.** Select a queued or running child
  to see its task, status, usage, and recent text/tool activity. Use Up/Down to
  scroll, End to return to the latest activity, and Escape to close the overlay
  without interrupting the child.

### What the fan-out counter counts

The tool row and the fleet panel head a fan-out with `1/3 settled`: the numerator
counts [**settled**](../../CONTEXT.md#delegation-model) runs, not successful ones.
Once the flow itself has settled the ratio is replaced by the outcome —
`2 failed` or `3 ok` — because `3/3` reads as a success total. On those two
surfaces a single-run flow shows neither, since the header would only restate the
one run below it.

A multi-stage mode settles one stage's runs before spawning the next: `evaluate`
returns its generator before the check command and the critic panel run. Between
stages the header keeps the labeled ratio and the spinner rather than announcing
an outcome the flow has not reached, so `2/2 settled` with a spinner means "both
runs so far are done, the flow is still working".

The inline tool row is the single primary live progress view. The extension
clears its footer status and above-editor widget instead of repeating that row's
summary elsewhere. On the two board surfaces a flow-level error is reported
alongside the run counts, as a status icon on the tool row and an `error:` line
on both.

After a flow settles, a durable flow card entry stays in the session transcript
(and re-renders after `pi` restarts): status, per-run duration bars, cost
rollup, failure codes, and the trace file pointer when tracing was on.

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
| `preset` | (none) | Named workflow preset expanded before mode validation. Prefer it when its intent matches. |
| `why` | (required to spawn) | One sentence justifying delegation over direct parent execution. Required for every spawning mode; `list`/`showConfig` never need it. Missing/empty ⇒ `WHY_REQUIRED`. |
| `agentScope` | `user` | Applies to both presets and agents: `user` = package + user; `project` = package + project; `all` = all three sources. |
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
| `traceStrict` | `false` | Require complete trace evidence. A missing `traceFile`, dropped spans, or failed writes fail the call with `TRACE_INCOMPLETE`. For evaluation/release gates; ordinary flows keep best-effort tracing. Also settable via `PI_FLOWS_TRACE_STRICT`. |
| `handoffPolicy` | `warn` | Call-level injection handling at inter-agent boundaries: `warn` preserves the flagged payload with a warning, `quarantine` substitutes a payload-free marker, and `fail` returns `HANDOFF_POLICY_VIOLATION` before the recipient spawns. |
| `modeHandoffPolicy` | (none) | Per-mode minimums, e.g. `{"workflow":"fail"}`. The effective policy is the stricter of this mode requirement and `handoffPolicy`; a call cannot downgrade a high-consequence mode. |
| `returnContract` | (none) | Prose return requirements appended to delegated worker/generator/synthesis tasks. Use it to require a shape, fields, max length, or evidence format. It is prompt-enforced, not a machine-checked delegation contract. |
| `requireEvidence` | `false` | Appends an evidence requirement to delegated prompts: load-bearing claims need file:line refs, command output, citations, or explicit gaps. |
| `contract` | (none) | Machine-checked delegation contract. It may replace prose `task` in single/evaluate, acts as the final-role fallback in integration modes, and requires a validated `pi-flows.return-envelope.v1` response. Fan-out tasks, graph nodes, workflow phases, worktree tasks, voters/participants, dossier sections, and agent refs can set role-specific delegation contracts. |
| `incompleteHandoffPolicy` | `fail` | Integration modes reject `partial`/`blocked` return envelopes by default. Set `"include"` only as an explicit decision to synthesize while preserving incomplete status and provenance in the returned handoffs/header. |
| `allowSharedWriteCwd` | `false` | By default, concurrent write-capable agents may not share one `cwd`. Set `true` only when shared writes are intentional. |
| `checkpoint` | (none) | Optional human checkpoint. `checkpoint.before:"spawn"` asks before any child runs; `"finalize"` asks after child work before returning the final answer. Headless contexts fail closed. |
| `reflexion` | disabled | Optional local cross-run lessons. `reflexion.enabled:true` reads/appends recent lessons from `.pi/flow-reflections.jsonl` by default. |
| `model` | agent/default | Flow-wide exact-model fallback. A task, phase, participant, or role-level `model` overrides it. Prefer `tier` unless the user named a concrete model. |
| `tier` | agent/default | Flow-wide capability-tier fallback (`fast`, `capable`, `deep`), overridable per task/phase/role. Resolves against the [model roster](#the-model-roster) derived from the models this install can run, so it works with no configuration. A call-level `tier:"capable"` always resolves, forcing the default model even on a `fast`/`deep` agent; a `fast`/`deep` tier the roster could not resolve falls through to the agent's own pin. |
| `thinking` | agent/tier | Flow-wide thinking-level fallback (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), overridable per task/phase/role. Independent of `tier`: sets effort without changing which model runs. Lowered automatically to what the resolved model supports, and a child with no level named anywhere leaves pi's own default alone. |
| `tools` | agent/default | Comma-separated tools, `none`, or `default`. `bash-ro` grants bash under a child-enforced read-only allowlist (see [write isolation](#return-requirements-delegation-contracts-and-write-isolation)); a toolset carrying both `bash` and `bash-ro` resolves to plain `bash`. |
| `cwd` | parent cwd | Child process working directory. |

### The model roster

`tier` and `thinking` resolve against a roster derived from pi's model registry — the models this install has configured auth for — rather than from a list pi-flows maintains. `fast` takes the cheapest usable model (preferring the parent's own provider) at `low`; `capable` names the model this session is running (not pi's configured default, which a fresh child would otherwise load) at the session's current thinking level; `deep` takes the most capable model, preferring one that supports extended thinking, at `max`. When the default model is already the best available, `deep` differs by thinking level instead of pinning a redundant `--model`.

Inspect it with `/flows models` or `flow showConfig:true` — every rung states the model, the level, and the reason it was chosen:

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

`"model": null` (shorthand `"default"`) runs that tier with no `--model`, so the child loads pi's configured default — distinct from omitting `model`, which keeps the derived one, and from `capable`, which names this session's model. A level set alongside it cannot be pre-checked against that model, since pi does not expose its configured default to an extension. Config that fails to parse is reported as a `modelRoster.issue` line beside the roster, so an override that never took effect is visible rather than silent.

A trusted project may override in `.pi/pi-flows.json` — found by walking up from the working directory (searching for the file itself, so an unrelated nested `.pi` does not shadow it), like project agents, so it applies when you start pi in a subdirectory. An untrusted project's file is ignored, since choosing the model also chooses which vendor sees the task. A project override narrows a tier field by field — a project that sets only `thinking` keeps your model pin — and `/flows models` warns before saving a tier the project already claims, since project config outranks your user file. `PI_FLOWS_FAST_MODEL` / `PI_FLOWS_DEEP_MODEL` still work but are outranked by the config file. Full order, narrowest first: call `model` > call `tier`/`thinking` > agent `model` pin > agent `tier`/`thinking` > project config (trusted) > user config > env > derived roster > pi default.

A flow budget bounds one flow call. It does not cross the process boundary: the outer
ceiling never sees a nested flow's spend, and that nested flow is bounded only by the
ceilings its own call sets — uncapped if it sets none, which is the default.

The fan-out ceiling `maxParallelTasks` (`8`) is a fixed internal cap on `tasks`,
voters, subtasks, worktree writers, debate participants, and dossier sections --
not a per-call input. It is enforced by the runtime and surfaced read-only in
`details.config`.

### Handoff injection policy

Every value that crosses from one coordination role into another is treated as
untrusted data. The flow-scoped guard strips invisible/bidi controls, scans
high-signal instruction-override and exfiltration markers, and retains a bounded
history so fragments that are benign alone but malicious when joined across
several boundaries are detected as a compositional attack. This includes child
output, retrieved content repeated by a child, routing metadata, ballots,
critic/check-command feedback, graph dependencies, workflow phases, and
synthesis inputs.

`handoffPolicy` selects the call behavior:

- `warn` (default) preserves current compatibility: the cleaned payload crosses
  with a visible untrusted-data notice.
- `quarantine` withholds the flagged payload and carries only a fixed
  quarantine marker. Downstream coordination may continue, but it cannot read
  the flagged content.
- `fail` returns `HANDOFF_POLICY_VIOLATION` and the child-dispatch seam refuses
  the recipient before a process is spawned.

`modeHandoffPolicy` declares a non-downgradable minimum for a mode. Resolution
uses `warn < quarantine < fail`, so
`handoffPolicy:"warn", modeHandoffPolicy:{"workflow":"fail"}` resolves to
`fail`. Workflow approval receipts bind that resolution; resuming with a changed
call or mode policy requires fresh approval.

`maxCostUsd` / `maxTokens` / `maxGeneratedTokens` form the **flow budget** and close the cost dimension of bounded execution: the iteration, fan-out, and time caps bound how *many* children run and how *long* each runs, but not total spend. Usage is known only after a model response completes, so a response can cross a ceiling. At that accounting boundary, cost and generated-output ceilings stop the active child and refuse subsequent children; the legacy total-token ceiling preserves the completed response and refuses subsequent children. A cost-bounded child also stops with `BUDGET_UNOBSERVABLE` if its provider omits cost telemetry, rather than treating unknown spend as zero. A delegation contract may independently impose a **contract budget**, including a tighter timeout.

At 80% of any ceiling that would stop the live run (cost, generated output, or a contract's total tokens), the child receives a **wrap-up notice**: a steered message asking it to stop working and emit its return envelope now, recording unfinished work as skipped coverage and `unresolvedQuestions` with status `partial`. The transition belongs to the ceiling, not to one child: when any child's settled turn crosses the threshold of a shared budget, every live child governed by that budget is steered at the same moment, and a child spawned while a shared ceiling is already inside the window is steered at spawn, before its first turn. A child that crosses the ceiling after the notice demonstrably reached it (the steered message is seen echoed into its session) is still terminated — the spend stays bounded — but the run settles gracefully (`stopReason: "budget_wrap_up"`, exit 0) and its final output proceeds to envelope validation instead of being forfeited as `BUDGET_EXCEEDED`. A ceiling crossed before any wrap-up could be requested (one turn jumping from below 80% past 100%), or whose notice never reached the child (for example with child extensions disabled), keeps the hard-stop semantics. The wrap-up request (`child.wrap_up`, with `flow.budget.wrapup_delivered`) and a graceful exhaustion (`child.exhausted` with `flow.budget.graceful`) are recorded as budget events on the trace. Size ceilings as runaway backstops (~3x the expected normal spend), not as governors inside the normal cost range — a ceiling that sits inside the normal range converts routine runs into losses.

The generated tool call, collapsed live row, fleet panel, and durable Flow card
all disclose configured cost/token ceilings with their authority. Identical
contract ceilings are collapsed into one compact line; distinct ceilings remain
separate. The durable entry persists these static ceiling definitions, so a
`BUDGET_EXCEEDED` result still names the binding configuration after a session
reload. Timeout-only contracts are not presented as cost/token ceilings, and
omitting all ceiling fields means uncapped execution rather than a hidden
default.

### Trace export (observability)

Set `traceFile` (or `PI_FLOWS_TRACE_FILE`) to write one append-only JSON span per delegated child, plus a root span for the whole flow call. Child spans carry per-run `flow.duration_ms`; root spans carry distinct `flow.elapsed_time_ms` (end-to-end wall clock), `flow.worker_time_ms` (sum of completed child runtimes), and, when the mode topology is known, `flow.critical_path_ms`. `flow.critical_path_available:false` means the runtime did not have enough dependency data and did not fabricate a value. Other OpenInference-style attributes include `flow.mode`, `flow.agent`, `llm.model_name`, `flow.thinking_level` (the level passed to the child, after clamping to its model) paired with `flow.thinking_level_verified` (whether that clamp could be applied — `false` for a child naming no model, whose configured default pi-flows cannot read and whose level pi may lower internally, so treat the value as requested rather than effective), `llm.token_count.*`, `flow.cost_usd`, status, and (when `recordContent` is on) redacted `input.value` / `output.value`. When `traceContext` is supplied, redacted `flow.run_id`, `flow.case_id`, `flow.trial_id`, `flow.trial_index`, and `flow.arm` values are copied to every span; `details.trace` reports health and the exact trace/root identifiers while redacting and bounding the displayed trace path, context, and write error. Export is best-effort and never fails a flow.

#### Span topology

Every span declares its role in `flow.span_role`:

| Role | What it is |
| --- | --- |
| `root` | The whole flow call. |
| `stage` | A wave, round, iteration, fan-out group, or workflow phase. |
| `child` | One delegated child run. |
| `event` | A zero-duration coordination boundary (see below). |

Children nest under the stage that scheduled them rather than hanging flat off the root, so a critic belongs to a visible revision round and a graph node to a visible wave. `flow.unit_key` names the unit (`alpha`, `worker-2`, `phase-deploy`), and `flow.stage_key` / `flow.stage_span_count` describe the stage.

Consumers link through the boundary that produced what they read, not around it: a synthesizer that consumes a validated handoff depends on `<unit>.handoff` rather than on `<unit>`, because validation, filtering, and the injection scan sit between a child's output and what the next prompt actually carried. This holds wherever one agent's output becomes another's prompt — an evaluate critic reads the prepared artifact, a loop judge the prepared body, a search scorer the prepared candidate — not only in the modes that use the integration adapter.

Dependencies are recorded as **links, not parentage**: a graph node that consumed another node's output was scheduled by its wave, not spawned by the node it read. `flow.depends_on` lists the unit keys and `flow.depends_on_span_ids` the resolved span ids. Both are comma-joined, and because node/phase/task ids are author-supplied, `%` and `,` inside a key are percent-escaped (`build,linux` → `build%2Clinux`) — decode before matching a key against `flow.unit_key`, which is escaped the same way.

#### Coordination events

Not every failure happens inside a child run. Approvals, state transitions, budget refusals, gate results, and handoff acceptance move the flow without spawning anything, so each is written as its own zero-duration span with `flow.event_kind` ∈ `artifact`, `state`, `retry`, `approval`, `budget`, `validation`, `handoff`.

Handoff events record what crossed the boundary — `flow.handoff.status`, `.compatibility`, `.acceptance` (`accepted` or `rejected:<CODE>`), `.raw_bytes` / `.carried_bytes` / `.filtered`, `.injection_warnings`, `.policy`, `.policy_action`, `.compositional`, `.scan_flagged`, `.payload_propagated`, `.payload_withheld`, `.sensitive_request_propagated`, `.artifact_refs`, and `.preserved_constraint_ids` — but never the summary prose or the envelope `data`. Constraint ids are content-derived (`constraint.1:<digest>`), so the same constraint keeps the same id at every hop and "was this preserved?" is answerable without copying the constraint text into the trace. These are operational enforcement facts, not ground-truth attack outcomes. The deterministic fault-portfolio report, whose scripted scenarios know whether content was benign and what the recipient actually did, keeps benign utility, attack success, propagation, containment, sensitive exposure, and false-positive block rates separate rather than deriving them from scanner labels.

Child spans additionally identify the authority they ran under: `flow.agent_prompt_version` (a digest of the system prompt that actually ran), `flow.allowed_tools`, `flow.authority_may` / `_must_not` / `_requires_approval`, `flow.side_effect_class`, `flow.contract_id`, `flow.return_schema_digest`, `flow.constraint_ids`, `flow.delegation_reason` (the call's `why`), and the budget state after the run.

#### Trace health and strict mode

The root span accounts for the export itself: `flow.trace.expected_spans`, `.observed_spans`, `.dropped_spans`, `.redacted_spans`, `.failed_exports`, and `.health` (`recorded` / `degraded` / `missing`). The same counters come back on `details.trace.spans`. Reading a trace back compares the declared expectation against the rows actually present, so spans lost *after* a successful write still register as dropped.

Trace health is deliberately not folded into execution success. A run whose spans were dropped is not a failed run — it is an unauditable one, and conflating the two turns every exporter hiccup into a phantom agent regression.

Tracing stays best-effort by default. Set `traceStrict:true` (or `PI_FLOWS_TRACE_STRICT=1`) to make evidence a gate: a missing trace file, dropped spans, or failed writes then fail the call with `TRACE_INCOMPLETE`. The in-process gate covers what the exporter failed to write; spans lost after a successful write are caught on read-back by `npm run trace:report -- --strict`. Use it for evaluation and release runs, not for ordinary user flows. The eval harness has the matching switch — `npm run eval -- --strict-trace` blocks a run whose runtime traces are incomplete, reported as its own score family rather than as subject failures.

Summarize a trace file from inside pi:

```text
/flows report flow-trace.jsonl
```

Or from a checkout:

```bash
npm run trace:report -- flow-trace.jsonl
npm run trace:report -- --strict flow-trace.jsonl   # exit 1 on incomplete evidence
```

The report groups runs by `flow.mode` and `traceLabel`. **Execution success** means a run or flow settled without a process or coordination failure; it does not establish that the requested outcome was correct. **Verified outcome success** means an independent verifier established that the requested outcome met its acceptance criteria. It and verified TPSO are available only when an `evaluate` critic or explicit orchestrate verifier returned evidence; ordinary process completion is never promoted to verified outcome success. Elapsed, worker, and critical-path time remain separate. A trace-health line reports observed-vs-expected spans, drops, redactions, failed exports, and how many runs are incomplete, plus a topology line counting stage spans and coordination events. Older traces with root `flow.duration_ms_total` remain readable, are interpreted as accumulated worker time, and are explicitly marked as legacy compatibility data; traces written before span roles existed are read as root-plus-children.

## Return requirements, delegation contracts, and write isolation

`returnContract` and `requireEvidence` supply prose **return requirements** that
prevent summary loss at handoff boundaries. They are appended to child tasks in `single`, `parallel`, `chain`,
`evaluate`, `vote`, `route`, and to `orchestrate` workers/synthesis. Workflow
phases, worktree tasks, and dossier sections accept task-level return requirements; those
override the top-level return requirements. Dossier sections and worktree tasks require
evidence by default. `orchestrate.workerReturnContract` can set a worker-specific
set of return requirements while the top-level `returnContract` still applies to synthesis.

For durable machine-checked handoffs, a delegation `contract` is the structured alternative.
It contains `objective`, `constraints`, `nonGoals`, `dependencies`, `authority`
(`may`, `mustNot`, `requiresApproval`), `sideEffectClass`, `budget`,
`acceptanceChecks`, a JSON Schema `returnSchema`, and `owner`. All fields are
required; arrays and the budget object may be empty. Each dispatched delegation contract has
a canonical `sha256:` identity. Every contracted mode, chain steps included, requires the child to echo
that identity as `contractId`, so missing/stale returns fail with
`RETURN_CONTRACT_MISMATCH` before a dependent child, synthesizer, or worktree
merge can consume them. JSON Schema, artifact-boundary, and digest validation
also happen before integration.

Single/evaluate use the top-level delegation contract and chain uses it as the step fallback.
Parallel tasks and vote/debate roles may use it directly; graph nodes, workflow
phases, worktree tasks, dossier sections, and orchestrate roles can set their own
delegation contract because their objectives and return schemas often differ. Final
debrief/integrator roles fall back to the top-level delegation contract.

Every consumed result becomes a **handoff envelope** (`pi-flows.handoff-envelope.v1`)
with source agent and step provenance. Return envelopes retain delegation-contract identity, status, evidence,
artifact references/digests, and schema-checked data. Existing prose-only results
remain supported as `compatibility:"legacy-prose"` handoff envelopes with
`contractId:null`; downstream prompts receive that explicit compatibility shape
instead of trusting unlabelled prose. Partial and blocked return envelopes fail
closed unless `incompleteHandoffPolicy:"include"` is explicitly selected.

Contract budgets apply at dispatch: timeout tightens the top-level limit, while
cost and token limits are independently enforced. Chain resets the contract
budget per step; evaluate shares it across generator revisions. Flow budgets
remain shared across the flow.

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
`unresolvedQuestions`, `retry`, and `data`. `data` is checked against
`returnSchema`; declared SHA-256 digests are checked against files inside the
child `cwd`; runtime usage is attached when available. Invalid schema data,
unsafe/missing artifacts, or digest mismatches fail closed with a structured
error before a chain step or evaluate critic can consume the handoff. The
validated envelope is retained on `details.results[].envelope`.

Existing `task`, `returnContract`, and `requireEvidence` calls remain prose-based
and behave as before.

Parallel fan-out is read-optimized by default. If two write-capable agents would
run concurrently in the same `cwd`, pi-flows returns `SHARED_WRITE_CWD` before
spawning them. A role is write-capable when its effective tools are pi defaults,
or include `bash`, `edit`, or `write` — the toolset decides, never the role name
or prompt, and the refusal names the tools that classified each agent. To
recover, serialize with `concurrency:1`, use agents whose effective tools
exclude `bash`/`edit`/`write`, swap `bash` for `bash-ro`, or give each writer a
separate worktree/cwd. Set `allowSharedWriteCwd:true` only as a last resort,
after deciding that concurrent writes in one shared checkout are intentional.

`bash-ro` is not write-capable. It is enforced in two layers:

- **OS sandbox (the security boundary).** On macOS the child runs under
  `sandbox-exec` with a profile that denies file writes anywhere under the
  reviewed `cwd` while allowing everything else, so a write into the shared
  checkout fails at the kernel regardless of what command produced it. Writes
  outside the checkout (pi's own temp files, npm/node caches) still work.
  Opt out with `PI_FLOWS_BASH_RO_NO_SANDBOX=1`.
- **In-child command allowlist (defense-in-depth, and an opt-in fallback).**
  The child loads an enforcer extension via an explicit `-e` (which survives
  `--no-extensions`, since pi only drops *discovered* extensions) that blocks
  bash commands outside a read-only allowlist: git inspection
  (`log`/`diff`/`show`/`blame`/`status`/...), file inspection
  (`ls`/`cat`/`grep`/`find`/...), and repo verification (`npm test`,
  `npm run <script>`, `node --test`). It refuses shell expansion/substitution
  and known write/exec flags fail-closed. Because command parsing can never be
  exhaustive (getopt-style option abbreviation alone yields endless new
  spellings across every tool), the allowlist is **best-effort, not a security
  boundary**. It is the default fallback where the OS sandbox is unavailable;
  a caller who needs a kernel-enforced guarantee sets
  `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX=1`, which refuses
  (`BASH_READONLY_UNENFORCEABLE`) instead of falling back.

Every bash-ro child additionally runs with several repository-configured git
helpers neutralized via `GIT_CONFIG_*` — pager, a command-valued `fsmonitor`,
and hooks. `diff.external` and textconv drivers are deliberately *not* forced
off (an empty `diff.external` makes git abort every diff), so a configured
external-diff/textconv program can still launch on a plain `git diff`/`git
show`; on the sandbox path its checkout writes are denied at the kernel, and on
the fallback path it is a documented residual (see the limitations below).

When the sandbox enforces, verification commands that write *into* the checkout
(a build cache, `*.tsbuildinfo`) will fail — that is the same shared-checkout
mutation the guard exists to prevent; run those in a non-`bash-ro` role or a
distinct cwd. A toolset carrying both `bash` and `bash-ro` is write-capable
(plain bash wins). A `bash-ro` spawn is refused with
`BASH_READONLY_UNENFORCEABLE` only when no layer can enforce it — the enforcer
extension cannot be located, or `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX` is set on a
host without the sandbox — rather than silently granting an unrestricted shell.
The child span records which layer enforced it (`flow.bash_ro.enforcement` =
`sandbox` or `allowlist`).

**Known limitations of the best-effort allowlist fallback.** Where the OS
sandbox does not run (non-macOS, or opted out), a few git behaviors can still
touch the checkout and are accepted residuals of a path documented as
best-effort, not a security boundary:

- A repository-configured `diff.external` or textconv driver runs on a plain
  `git diff`/`git show`. Its command comes from *local* git config, which the
  untrusted reviewed tree cannot set, and git offers no config/env switch to
  disable it without breaking internal diff (only per-command `--no-ext-diff`).
- `git status`/`git diff` may refresh `.git/index` stat data.
- Command parsing cannot be exhaustive (option abbreviation).

All three are contained on the sandbox path — the writes are denied at the
kernel and git inspection still succeeds. Set
`PI_FLOWS_BASH_RO_REQUIRE_SANDBOX=1` to refuse rather than run best-effort where
the sandbox is unavailable.

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

The `controller` reads the `task` plus the candidate descriptions and picks one agent to run.

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

The `commander` decomposes the `task` into independent subtasks, `recon` workers run them in parallel, and the `debrief` agent merges the results — the deep-research / orchestrator-workers shape. Top-level `task` is preferred; `orchestrate.task` is accepted as its fallback. Each worker sees both the overall goal or delegation contract and its assigned subtask, so terse decomposition output does not detach findings from the final answer requirements.

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
| `orchestrate.recon` | `{ agent: "recon" }` | Runs one subtask each, in parallel, with the overall goal or delegation contract included for context. Use `analyst` for deeper per-subtask investigation. |
| `orchestrate.debrief` | `{ agent: "debrief" }` | Merges the subtask findings into one answer. |
| `orchestrate.verify` | (none) | Optional critic that checks the merged answer against the goal or delegation contract (orchestrator-workers composed with evaluator-optimizer). |
| `orchestrate.verifyPolicy` | `note` | `note` appends the verifier verdict; `fail` returns `ORCHESTRATE_VERIFY_FAILED` on `REVISE`; `revise` reruns `debrief` with the critique and re-verifies until pass or cap. |
| `orchestrate.verifyMaxIterations` | `2` | Integer `1..4`. Maximum synthesize→verify rounds when `verifyPolicy:"revise"`. |
| `orchestrate.workerReturnContract` | (none) | Prose return requirements appended to every worker subtask before fan-out. |
| `orchestrate.returnContract` | (none) | Alias for top-level `returnContract`; when top-level `task` is also omitted, this text may serve as the goal fallback for model-generated calls. |
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
  "why": "a broad cross-codebase map is more reading than one context should serialize"
}
```

Workers receive the goal, the return requirements, and their assigned subtask; the `overwatch` verifier checks the merged answer against the goal, and `verifyPolicy:"revise"` reruns `debrief` with the critique until pass or `verifyMaxIterations`.

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
persists redacted outputs and structured handoff envelopes after every work
phase, so a headless approval pause or later retry does not discard completed
work. Version-2 state also stores a content-free attestation created only after
the original contract, schema, artifact, and digest validation succeeds. Resume
binds the sanitized envelope to that attestation and the current contract
identity instead of revalidating policy-transformed content. Existing version-1
states migrate to legacy compatibility envelopes before downstream reuse.

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
| `workflow.approvalTtlMs` | `86400000` (24h) | How long an approval receipt authorizes its gated action. Integer `60000..2592000000`. A resume after the window needs a fresh approval. |
| `phase.task` | required for work | Supports `{task}`, `{previous}`, and `{phase.<id>}` output placeholders. |
| `phase.checkCommand` | (none) | Deterministic gate run in the phase `cwd`; non-zero stops with `WORKFLOW_GATE_FAILED`. |
| `phase.cwd` / `model` / `tools` | inherited | Per-phase process and gate overrides. |
| `phase.returnContract` / `requireEvidence` | top-level values | Per-phase handoff requirements. |

Interactive approval nodes call the Pi confirmation UI. In headless contexts they
fail closed with `WORKFLOW_APPROVAL_REQUIRED` after persisting completed artifacts
and the next phase. Resume the same task/phases/state file in an interactive UI
with `workflow.resume:true`. A denied approval returns
`WORKFLOW_APPROVAL_DENIED`; it never silently advances.

### Approval receipts

A granted approval becomes a durable, expiring, single-use **approval receipt**
(`pi-flows.approval-receipt.v1`) in the state
file rather than a bare `APPROVED` marker. Each receipt binds one action — the
approval phase and the contiguous run of work phases it gates — to the exact
parameters approved, plus the requesting and approving actors, the workflow
digest, the state schema version, an issue time, and an expiry.

An approval authorizes exactly one action, and that action spans every step
between the approval and the next consent point: the work phases it gates, the
approval that ends the run, and the workflow's own completion when nothing else
follows. Each of those steps re-verifies the receipt against the live spec before
running, so a resume landing in the middle of a gated run is checked rather than
walking in behind a check it never reached. The receipt is spent once, by the
action, at the first gated step that completes — so retrying a failed phase
inside its own gated run is a resume, while presenting the receipt for a
different action is a replay and returns `APPROVAL_RECEIPT_CONSUMED`.

The binding covers what the workflow digest cannot see: the gated phases'
effective definitions after flow-level fallbacks (`returnContract`,
`requireEvidence`, the resolved contract) plus `agentScope` and
`incompleteHandoffPolicy`. When the gated run reaches the end of the workflow the
binding also covers the debrief's resolved `contract`, `returnContract`, and
`requireEvidence`, since a trailing approval gates the debrief too. Changing `agentScope` between approval and resume
swaps which repo-controlled prompt runs, so it invalidates the approval with
`APPROVAL_RECEIPT_STALE`.

A completed approval whose receipt has lapsed or been superseded is **reopened**
rather than stranding the state file: the phase is un-completed, its receipt
discarded, and consent asked for again in the same pass, with the reason carried
into the prompt. Headless runs still fail closed with
`WORKFLOW_APPROVAL_REQUIRED`. Only `APPROVAL_RECEIPT_STALE` and
`APPROVAL_RECEIPT_EXPIRED` reopen; a consumed or malformed receipt is evidence of
tampering and stays a hard refusal.

Reopening applies only while **none** of the gated run has executed. Once part of
it has, a fresh receipt would claim to authorize work that already ran under the
old parameters — one receipt describing two different actions — and would erase
the receipt that authorized the completed half. That case is refused outright,
naming which phases already ran, so restoring the approved parameters or starting
a fresh run stays the operator's call.

The expiry gates *starting* the authorized action. Once the receipt has been
spent on it, a gated run finishes rather than aborting halfway because the clock
passed — the binding still has to match, so nothing about the action can have
changed.

Every recorded field — actors, issue time, expiry, consumption — is additionally
covered by a `receiptDigest`, so a partial write, a half-applied merge, or a tool
that rewrites one field is caught rather than honoured. A receipt that fails that
check is reported with `validation: "unverified"` wherever it surfaces, rather
than having its claims repeated as fact.

Receipts surface in `details.approvals`, in the final answer, and on the trace
root span (`flow.approval_receipt_ids`, `flow.approval_receipt_count`,
`flow.approval_consumed_count`, `flow.approval_blocked`) as identifiers and
status only — the approved parameters never leave the binding digest. Set
`PI_FLOWS_APPROVAL_ACTOR` to label the approving actor; it is an audit
attribution, not an authenticated identity.

Version-2 state files migrate on resume: a completed approval recorded as
`APPROVED` becomes a `legacy-compatibility` receipt with no approver and no
expiry, which still binds the gated action.

This protects against replay and drift in a local state file, not against an
attacker who can write that file — there is no key to sign a receipt with that
would not live beside it.

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
result. Worker failure or return-envelope rejection retains the isolated worker
state and returns every branch and worktree path needed for recovery.
Conflict-resolution prompts include the validated handoff envelopes for
the already-integrated and incoming workers, preserving delegation-contract identity,
evidence, artifact references, and digests through each conflict choice and into
the final integration review. Use this mode only when the tasks are genuinely
independent; one writer belongs in `single` or `evaluate`.

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
cases, not quick preferences or questions one fact already settles. It is not an
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

When enabled, reflexion applies flow-wide, to every mode: recent lessons from
`.pi/flow-reflections.jsonl` are appended to the top-level `task` before the
mode runs, and after any run that spawned at least one child, a redacted lesson
is recorded from the flow's final output. Lessons are injected only into the
top-level `task` — a goal supplied solely via `evaluate.operator.task` is not
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
- `results`: child run summaries with redacted task preview, usage, duration, stderr, optional validated return `envelope`, and structured error when applicable. On error, `results` still contains every run that completed before the failure — a graph that ran two waves before hitting a cycle reports those runs' usage and cost alongside `error`.

## Structured errors

Every error returned by the `flow` tool is structured:

- `code` — a stable identifier from a fixed set (see catalog below)
- `message` — what happened
- `cause` — why
- `fix` — the suggested next action
- `retryable` — whether retrying unchanged may succeed

The model-visible error text repeats that last field as
`Retryable unchanged: yes|no`. A `no` is terminal for the unchanged call:
the parent must apply the stated fix before another Flow. In particular,
`BUDGET_EXCEEDED` must not automatically replay the same work or loosen the
configured ceiling. Unless the user explicitly approves a budget change, the
parent preserves that ceiling and asks for direction or materially narrows the
task or fan-out first.

The full list of `code` values, each with its cause and fix, lives in the
**[canonical error-code catalog](../how-to/troubleshooting.md#error-codes)** in
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
List and status output include both presets and agents; status also reports both
sets of discovery directories and diagnostics.
