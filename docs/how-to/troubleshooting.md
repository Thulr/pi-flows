# Troubleshooting

This page is the **canonical, CI-tested catalog** of every `flow` error `code`,
with its cause and fix, plus common setup problems. Every error that the `flow`
tool returns carries `code`, `message`, `cause`, `fix`, and `retryable`. CI
(`tests/pi-flows.test.ts`) makes sure that the [Error codes](#error-codes)
catalog covers **every** code in the source. Thus a new code cannot ship
undocumented.

## Setup & environment

### pi: command not found

Cause: the `pi` host CLI is not installed, or it is not on your `PATH`. pi-flows
is a pi extension and cannot run without the host. `npm ci` and `npm run check`
do **not** install pi. They only build and test this package.

Fix: install the `pi` CLI (`>=0.82.0`). The `pi` binary ships in
`@earendil-works/pi-coding-agent`. Get it from the
[pi project](https://github.com/earendil-works/pi), for example:

```bash
npm i -g @earendil-works/pi-coding-agent
```

Then make sure that it is on your PATH:

```bash
npm run preflight   # or: pi --version
```

See the [README quick start](../../README.md#quick-start) for the full
prerequisite list (Node `>=24`, npm `>=11`, pi `>=0.82.0`).

### pi is older than the minimum supported version

Cause: `pi` is on your PATH, but its version is below the floor that pi-flows is
built against (`engines.pi` in `package.json`, currently `>=0.82.0`). Older
hosts are unsupported and can fail when the extension loads. `npm run preflight`
reports this as, for example:

```
✗ pi 0.81.0 is older than the minimum supported version 0.82.0 (/opt/homebrew/bin/pi).
```

Fix: upgrade the CLI, then re-run the check:

```bash
npm i -g @earendil-works/pi-coding-agent@latest
npm run preflight
```

Preflight can instead warn that it found no readable version. Then `pi` answered,
but its `--version` output had no recognizable `major.minor.patch` in it. That
is a warning, not a failure. Make sure of your version by hand with
`pi --version`.

Preflight names the executable it examined, and that executable is the one your
shell runs. In a clone, npm prepends `node_modules/.bin` to PATH while it runs a
script, and `@earendil-works/pi-coding-agent` is a peer dependency. So a `pi`
is there that your shell never sees. Preflight skips it deliberately: the host
that loads the extension is the `pi` from `pi -e ./extensions/pi-flows/index.ts`,
not npm's copy. If your only `pi` is that local one, preflight reports it as not
found and points at it, because the documented command fails there.

Preflight skips only the directories that npm injects: this checkout's
`node_modules/.bin` and its ancestors', compared by canonical path. A
`node_modules/.bin` that you put on your own PATH is a normal install location.
Preflight examines it like any other.

### Provider/auth failures

pi-flows does not create provider credentials. Child pi processes inherit the
environment of the parent pi process. Make sure that your provider environment
follows the normal pi docs. Then retry a small single-agent task.

### Invalid agent files

`/flows status` and `flow showConfig:true` report invalid frontmatter. The same
surfaces report invalid preset frontmatter and non-JSON preset bodies.

Valid minimal agent:

```md
---
name: my-agent
description: What this agent does
---

Prompt body.
```

## Error codes

The codes are listed in source order and match the `FlowErrorCode` union in
`extensions/pi-flows/index.ts`. CI makes sure that this list stays in sync.

### `UNKNOWN_AGENT`

Cause: no discovered agent matched the requested name.

Fix: list the available agents, then examine the scope and the discovery:

```text
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

Make sure that `agentScope` is correct, and read the discovery problems that
`/flows status` reports.

### `UNKNOWN_PRESET`

Cause: no discovered workflow preset matched the requested `preset` name in the
effective scope.

Fix: run `flow` with `{"list":true}`, `/flows`, or `showConfig:true`. Then use
the exact preset name, and make sure that `agentScope` is correct.

### `PRESET_TASK_REQUIRED`

Cause: the selected preset contains a `{task}` placeholder, but the call did not
supply a non-empty top-level `task`.

Fix: pass the complete goal, fixed point, and relevant issue/spec context in
`task`.

### `PRESET_OVERRIDE_INVALID`

Cause: the call tried to replace a top-level workflow parameter the preset did
not declare in its `overrides` frontmatter.

Fix: remove the override. If you own the preset and the changed shape is safe,
review its bounds and trust implications, then add that key to `overrides`. If
the requested topology is materially different, use a raw mode call.

### `PRESET_EXPANSION_INVALID`

Cause: a preset template or a caller-supplied override expanded to parameters
outside the public `FlowParams` schema.

Fix: inspect `flow showConfig:true` for preset discovery problems. Then correct
the invalid template field, or remove the invalid override.

### `PROJECT_PRESET_APPROVAL_REQUIRED`

Cause: a headless run requested a repository-controlled preset from
`.pi/flow-presets` while project confirmation remained enabled.

Fix: review the preset file. Run interactively to approve it, or pass
`confirmProjectAgents:false` only in a trusted non-UI repository.

### `PROJECT_PRESET_APPROVAL_DENIED`

Cause: the interactive prompt for a project-local preset was declined.

Fix: review `.pi/flow-presets`. If you trust the workflow parameters, retry and
approve.

### `WHY_REQUIRED`

Cause: the call selected a mode that spawns child agents, but it did not include
`why`. `why` is the one-sentence justification for delegation instead of direct
work in the parent context. This gate is deliberate friction against reflexive
delegation: a child costs a full separate model context.

Fix: pass a `why` that names the reason for delegation — an explicit user
request for delegation, fan-out that one context cannot hold, or verification
that must be independent of the author:

```text
{"agent":"recon","task":"map the auth module","why":"user asked for a delegated read-only scout"}
```

If no such reason exists, do the work directly instead of a `flow` call.
`list:true` and `showConfig:true` never need `why`.

### `INVALID_MODE`

Cause: the parameters did not select exactly one mode. Either they selected zero
modes or more than one mode, or a required field for the chosen mode was
missing. Most modes need a top-level `task`.

Fix: choose exactly one of `list:true`, `showConfig:true`, `agent`+(`task` or `contract`),
`tasks[]`, `chain[]`, `evaluate{}`, `vote{}`, `route{}`, `orchestrate{}`,
`graph{}`, `loop{}`, `search{}`, `workflow{}`, `worktree{}`, `debate{}`,
`dossier{}`, or `monitor{}`. Supply that mode's required fields. Run
`showConfig:true` to inspect the defaults before execution.

### `INVALID_SCOPE`

Cause: an agent scope other than `user`, `project`, or `all` was requested.

Fix: use one of `user`, `project`, or `all`. Both the `/flows <scope>` argument
parser and the `flow` tool's `agentScope` schema reject unknown scopes. Thus
this error usually shows as a direct "Unknown scope" message before a typed
error is produced.

### `INVALID_CONCURRENCY`

Cause: `concurrency` was fractional or outside `1..8`.

Fix: omit it (the default is `4`), or use an integer from `1` to `8`.

### `TOO_MANY_TASKS`

Cause: `parallel` mode received more than `8` tasks, or `vote` mode received
more than `8` voters. The hard cap (`MAX_PARALLEL_TASKS`) prevents runaway
subprocess fan-out.

Fix: split the work into batches of `8` or fewer.

### `PARALLEL_SIZING_REQUIRED`

Cause: a raw parallel call contains two or more tasks, at least one task omits
both `tier` and `model`, and the call names no flow-wide `tier` or `model`.
Without this gate, agent defaults can place mixed-complexity work uniformly on
the parent session model, and that cost choice stays invisible.

Fix: set `tier` (`fast`, `capable`, or `deep`) or an exact `model` on every
task. If every task intentionally needs the same capability, set one flow-wide
`tier` or `model` as the explicit uniform-sizing choice. `thinking` alone does
not select a model and does not satisfy this gate.

### `TOO_FEW_VOTERS`

Cause: `vote` mode was given fewer than 2 voters.

Fix: set `vote.count >= 2`, or provide at least 2 entries in `vote.voters`. One
voter is the same as `single` mode.

### `ROUTE_UNRESOLVED`

Cause: the `controller` (router) output did not name any agent in
`route.candidates`.

Fix: make the `controller` prompt more specific, widen or adjust
`route.candidates`, or set `route.fallback` to a default agent.

### `ORCHESTRATE_NO_SUBTASKS`

Cause: the `commander` returned no usable subtask array. Either the legacy
output contained no non-empty JSON array with usable entries, or the contracted
envelope `data` was not a non-empty array of strings.

Fix: require a JSON string array directly, or in envelope `data` when
`orchestrate.commander.contract` is set. For work that does not decompose, use
`chain` or `single` mode instead.

### `FLOW_DEPTH_EXCEEDED`

Cause: a flow agent that is itself running inside a flow subprocess tried to
spawn more flow children, beyond the nesting cap (`MAX_FLOW_DEPTH`).

Fix: flatten the delegation. Do the work directly in that agent, or restructure
the flow so that deep flow-within-flow nesting is not necessary. The cap is
deliberate harness discipline against runaway nested delegation, not a bug.

### `BUDGET_EXCEEDED`

Cause: a flow budget or contract budget reached its `maxCostUsd`, `maxTokens`,
or `maxGeneratedTokens` ceiling. Cost and generated-output ceilings stop the
active child after its completed model response. The legacy total-token ceiling
preserves that response. All three prevent more child spawns. This bounds the
**cost** dimension of runaway delegation, which the iteration, fan-out, and
time caps do not cover.

A child that demonstrably received the 80% wrap-up notice does not produce this
error when it crosses the ceiling. (The proof is the steered message echoed
into its session.) That child settles gracefully with
`stopReason: "budget_wrap_up"`, and its envelope is validated normally. Thus
`BUDGET_EXCEEDED` means one of two things: the ceiling was crossed before a
wrap-up request was possible, or the notice never reached the child. The notice
cannot arrive when child extensions are disabled, or when one turn jumped from
below 80% past 100%. For a contracted child, the graceful settlement is
provisional. If its wrap-up response then fails envelope validation, the run is
reported as failed with that validation error (`RETURN_ENVELOPE_INVALID`,
naming the role). Notice delivery alone never renders as a success.

`maxCostUsd` caps cost. `maxTokens` caps cumulative input plus output.
`maxGeneratedTokens` caps output only — not total, input, context, or cost.
Compact views label these scopes.

Fix: do not automatically replay the same Flow unchanged. Ask for direction, or
make a material, visible change that stays inside the configured ceiling.
Narrow the task, or reduce the fan-out: fewer voters, fewer subtasks, or a
lower `maxIterations`. Keep the owning flow or contract budget unless the user
explicitly approves a raise or a removal. The partial results produced before
the ceiling are still in `details`. A ceiling that binds inside the *normal*
cost range of the task is missized (roughly half of comparable runs breach it).
Then resize it as a runaway backstop, about 3x the observed normal spend,
instead of a narrower task.

### `BUDGET_UNOBSERVABLE`

Cause: a flow budget or contract budget set `maxCostUsd`, but a completed model
response omitted its numeric cost telemetry. If unknown spend counted as zero,
the cost ceiling silently becomes non-binding. Thus the child stops at that
response boundary.

Fix: use a provider/model that reports cost telemetry, or bind the same flow or
delegation contract with `maxTokens`, `maxGeneratedTokens`, or `timeoutMs`
instead.

### `CHECK_COMMAND_FAILED`

Cause: an `evaluate.checkCommand` (the deterministic gate) did **not start**.
For example, the command is not found on `PATH`, or it cannot run from the cwd.
This is different from a command that runs and exits non-zero — that is a
normal `REVISE` signal, not an error.

Fix: make sure that the command exists and runs from the operator's `cwd`. Try
it in a shell first. A non-runnable check is a configuration error. Thus the
loop aborts instead of a run to `maxIterations` against a check that can never
pass.

### `ORCHESTRATE_VERIFY_FAILED`

Cause: `orchestrate.verify` was configured as a hard gate (`verifyPolicy:"fail"`
or `"revise"`). The verifier returned `VERDICT: REVISE` after the permitted
synthesize→verify rounds, or the verifier child did not produce a usable
passing verdict. The merged answer is returned with the verifier critique, but
the flow result is marked as failed.

Fix: read the verifier critique. Narrow the task, or improve the worker or
synthesis contract, then rerun. For advisory-only verification, set
`orchestrate.verifyPolicy:"note"`. For revision policy, raise
`orchestrate.verifyMaxIterations` up to the cap, or make the acceptance
criteria more concrete.

### `GRAPH_INVALID`

Cause: `graph` mode was given an invalid static DAG: no nodes, too many nodes,
duplicate/missing node ids, missing `agent`/`task`, or a `dependsOn` reference to
an unknown node.

Fix: provide 1-16 graph nodes. Every node needs a unique `id`, `agent`, and
`task`. Every `dependsOn` value must match another node id.

### `GRAPH_CYCLE`

Cause: no remaining graph node can run. The dependency graph contains a cycle
or an unsatisfied dependency chain.

Fix: remove the cycles. At least one node must have no dependencies, and every
dependency chain must reach an already-runnable node.

### `LOOP_DID_NOT_CONVERGE`

Cause: `loop` mode reached `loop.maxIterations` before the body emitted
`LOOP: DONE` or the optional judge emitted `VERDICT: PASS`.

Fix: narrow the task, improve the stop condition, add a judge with concrete
criteria, or raise `loop.maxIterations` within the cap.

### `SEARCH_NO_CANDIDATES`

Cause: `search` mode generated no usable candidates, or scoring eliminated all
candidates before final synthesis.

Fix: narrow the task, reduce `search.candidates`, or select a generator that
fits the work better. Or inspect the scorer output for too-strict scoring.

### `WORKFLOW_INVALID`

Cause: `workflow.phases` is empty, exceeds the phase cap, or repeats an id. Or
a phase does not select exactly one of `agent`+`task` and `approval`. Or an
approval gates an Agent profile whose source and prompt, effective tools, cwd,
model, or Thinking level cannot all be identified before consent or approved
dispatch.

Fix: provide 1-12 uniquely named phases. Work phases need both `agent` and
`task`. Approval phases need only `approval.message`. For gated work: select a
discovered Agent, and create its cwd as a readable, searchable directory. Where
the Agent profile does not supply a concrete value, make the tools, the model
or tier, and the Thinking level explicit. `tools:"default"` is not a concrete
approval toolset. A direct model must exactly match a model in the current
registry — Pi's alias or pattern matching is not sufficient.

### `WORKFLOW_STATE_INVALID`

Cause: a resumed workflow state file is unreadable or malformed, or it belongs
to a different workflow definition. Or a v3 receipt has more coherent
historical Thinking combinations than the bounded migration verifier can
examine at once. A v2 state that completed only part of an approved action also
fails here. One new receipt over work run under different conditions is never
minted.

Fix: resume with the same task and phase definition. If the error requests a
historical Thinking witness, set the named effective v3 levels under
`workflow.historicalThinking.phases` (or `.debrief`), then retry. Those values
are accepted only when the spent receipt's binding digest verifies. Otherwise,
remove the stale state file and restart without `resume:true`.

### `WORKFLOW_GATE_FAILED`

Cause: a phase's deterministic `checkCommand` ran and exited non-zero.

Fix: inspect the captured command output. Correct the phase artifact or the
gate. Then resume the workflow.

### `WORKFLOW_APPROVAL_REQUIRED`

Cause: a headless workflow reached an approval phase, or a stale, expired, or
under-bound version-3 receipt reopened and needs fresh consent. Progress was
persisted, but no interactive UI was available to collect a decision.

Fix: resume the same workflow in interactive pi, or replace the human approval
with a deterministic `checkCommand` for unattended runs.

### `WORKFLOW_APPROVAL_DENIED`

Cause: the interactive approval phase was declined.

Fix: review the persisted phase outputs. If necessary, revise the workflow
inputs. Then resume when you can grant the approval.

### `APPROVAL_RECEIPT_INVALID`

Cause: an approval gates the step about to run, but the resume state carries no
usable receipt for it. The state file was truncated, hand-edited, or written by
a tool that does not understand `pi-flows.approval-receipt.v1`. This error also
fires when a recorded field (approver, issue time, expiry, or consumption
record) was changed without a re-stamp of the receipt's `receiptDigest`.

Fix: re-run the workflow in an interactive Pi UI, so that the phase is approved
again. A malformed receipt cannot be repaired in place. Only an actual approval
mints a receipt.

### `APPROVAL_RECEIPT_STALE`

Cause: an approval was granted, then the action it authorizes changed. For
every gated Role and gated debrief, a receipt binds: the selected Agent source,
the SHA-256 prompt identity, the effective tools after overrides and
inheritance, the canonical cwd target and filesystem identity (with symlinks
resolved), the concrete model, and the Thinking level. The runner examines that
identity again immediately before spawn. The receipt also binds the task and
gate terms, the effective delegation contract, `agentScope`, the Return and
evidence requirements, and the handoff policies. Thus consent becomes invalid
even when the phase-authored fields are unchanged. Examples: same-name source
shadowing, an edited Agent body, expanded inherited tools, a changed model
roster, a repointed cwd symlink, replacement of the canonical directory itself,
or a different default cwd.

Fix: resume in an interactive Pi UI. The approval phase reopens automatically
and asks again, and it names what changed. A restore of the approved parameters
is not enough on its own: the reopening discards consent that no longer held,
so the phase still needs a fresh approval.

If part of the gated run already executed, or a gated debrief began and
consumed the receipt, the approval is **not** reopened. This stays a hard
refusal that names the completed phases or the begun debrief. Restore the
approved effective profile and resume, or start a fresh run, so that the whole
gated sequence executes under one approval.

### `APPROVAL_RECEIPT_EXPIRED`

Cause: the resume arrived after the approval's window closed and before the
authorized action began. Receipts expire so that consent cannot be banked
indefinitely. The default window is 24 hours from the moment of approval. The
window gates the *start* of the action. A gated run already under way finishes
— it does not abort halfway when the clock passes.

Fix: resume in an interactive Pi UI. The approval phase reopens and asks again,
so a lapsed window never strands the state file. If you expect a long gap, set
`workflow.approvalTtlMs` (60000..2592000000 ms) to a longer window *before* you
approve. A wider window afterwards does not revive a spent window, because the
expiry is stamped into the receipt at issue time.

### `APPROVAL_RECEIPT_CONSUMED`

Cause: a receipt already spent by one action was presented to authorize a
different one. Approvals are single-use. One approval authorizes one action,
and the action spans every step between it and the next consent point.

Fix: give the second action its own approval phase. A retry of a failed phase
inside the gated run that the approval covers is not a replay, and it is
permitted. This error fires only when the action differs from the one recorded
on the receipt.

### `WORKTREE_NOT_GIT`

Cause: `worktree` mode was invoked outside a Git repository or with an invalid
`baseRef`.

Fix: run from a Git checkout and choose a base ref that resolves to a commit.

### `WORKTREE_DIRTY_SOURCE`

Cause: the source checkout has uncommitted changes while `requireClean` is
true. In that state, worker branches silently omit local work.

Fix: commit or stash the local changes. Set `requireClean:false` only when you
intend to omit them.

### `WORKTREE_SETUP_FAILED`

Cause: pi-flows failed to create a worker branch or worktree, or failed to
commit a worker's changes.

Fix: inspect Git's captured error, and remove stale conflicting refs or
worktrees. Before a retry, make sure that the writer produces tracked changes.

### `WORKTREE_INTEGRATION_FAILED`

Cause: the worker commits did not merge cleanly into the integration branch,
or the integrator did not resolve the combined result.

Fix: inspect the retained integration branch and worker refs, resolve the
conflict there, or repartition overlapping writer tasks.

### `WORKTREE_VERIFY_FAILED`

Cause: the integration `checkCommand` ran on the merged branch and exited
non-zero.

Fix: inspect the retained integration branch and the captured test output.
Correct the integrated result, then rerun the verification.

### `DEBATE_TOO_FEW_PARTICIPANTS`

Cause: `debate` mode received fewer than two independent advocates.

Fix: provide at least two participant agent refs. For one perspective, use
`single`. For independent same-task answers without rebuttal, use `vote`.

### `DOSSIER_TOO_FEW_SECTIONS`

Cause: `dossier` mode received fewer than two evidence-extraction sections.

Fix: assign at least two independent sources or claim families. For a
single-source lookup, use `single` instead.

### `MONITOR_INVALID`

Cause: the monitor configuration is invalid, such as `trigger:"match"` without
a valid regular-expression `pattern`.

Fix: choose `success`, `failure`, or `match`. For `match`, supply a valid regex
pattern, and keep the interval and check counts inside their documented bounds.

### `MONITOR_NOT_TRIGGERED`

Cause: the bounded monitor exhausted `maxChecks` without observing its trigger.

Fix: treat this as a conclusive bounded no-trigger result. Widen the check
budget, or adjust the probe or trigger, only when the original bound was too
narrow.

### `CHECKPOINT_APPROVAL_REQUIRED`

Cause: a flow requested a human checkpoint (`checkpoint.before`) in a headless
non-UI context, so pi-flows cannot collect approval.

Fix: run in an interactive pi session, remove the checkpoint for non-interactive
runs, or replace the checkpoint with a deterministic gate such as
`evaluate.checkCommand`.

### `CHECKPOINT_APPROVAL_DENIED`

Cause: the interactive human checkpoint prompt was declined.

Fix: review the flow request or the final result. If the flow must proceed,
retry.

### `SHARED_WRITE_CWD`

Cause: the call asked two or more write-capable agents to run concurrently in
the same working directory. Agents with `tools` omitted count as write-capable,
because they inherit pi's default toolset. Agents whose effective tools include
`bash`, `edit`, or `write` are also write-capable. The classification comes
from the effective toolset alone. A read-only role name or prompt does not
change it, so a retry with a different agent name and the same tools refuses
again. The refusal names each agent with the tools that classified it.

Fix: serialize with `concurrency:1` — the guard applies only to concurrent
writers. Or use agents whose effective tools exclude `bash`, `edit`, and
`write`. Or swap `bash` for `bash-ro` (bash under a child-enforced read-only
allowlist, which is not write-capable). Or give each writer a distinct `cwd` or
worktree. For review fan-out, prefer the `code-review` preset, which runs its
reviewers under `bash-ro`. Pass `allowSharedWriteCwd:true` only as a last
resort, when you intend concurrent writes in one checkout.

### `BASH_READONLY_UNENFORCEABLE`

Cause: a role's tools included `bash-ro`, but no layer can enforce it. The OS
read-only-checkout sandbox is unavailable or opted out
(`PI_FLOWS_BASH_RO_NO_SANDBOX`, or a non-macOS host), *and* the
command-allowlist fallback is unavailable, because
`PI_FLOWS_BASH_RO_REQUIRE_SANDBOX` is set or the enforcer extension was not
found. A spawn in that state grants the child unrestricted bash in the
shared checkout, so the spawn is refused before any process starts. (Note
`PI_FLOWS_CHILD_NO_EXTENSIONS` alone does not trigger this: the enforcer loads
via an explicit `-e`, which pi keeps under `--no-extensions`. And by default,
off the sandbox, the allowlist fallback runs instead of a refusal.)

Fix: run on macOS (without `PI_FLOWS_BASH_RO_NO_SANDBOX`), so that the sandbox
enforces it. Or unset `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX` to permit the
best-effort allowlist fallback. Or change the role's tools: `bash` if the
write-capable classification (and the shared-write guard) is acceptable, or
`read,grep,find,ls` if the child does not need a shell.

### `MODEL_SCOPE_UNSATISFIABLE`

Cause: the child asked for an automatic tier (`fast`/`deep`), but the session's
model scope (`/scoped-models`, `--models`) admits no model that the tier can
name. No scoped model is readable or present, the context supplied no session
model to anchor to, and nothing explicit (call `model`, agent pin, or pi-flows
configuration) named one. A spawn in that state launches the child with no
`--model`, which loads pi's configured default — possibly a model or provider
that the scope excludes. Thus the spawn is refused before any process starts.
(When the session model *is* known, or the scope contains readable references,
the tiers anchor or bind instead. See the model-roster section of the flow
reference.)

Fix: widen the session's model scope, name a model explicitly on the call,
agent, or `pi-flows.json`, or run the flow from a session with a current model.

### `PROJECT_AGENT_APPROVAL_REQUIRED`

Cause: a headless (non-UI) run requested a project-local agent from
`.pi/flow-agents`.

Fix: review the project-local agent file. In an interactive session, approve
the prompt. In a trusted non-UI run, review the files first, then pass
`confirmProjectAgents:false` explicitly.

### `PROJECT_AGENT_APPROVAL_DENIED`

Cause: the interactive approval prompt for project-local agents was declined.

Fix: review the project-local agent files in `.pi/flow-agents`. If you trust
them, retry and approve, or pass `confirmProjectAgents:false` in a trusted
non-UI run.

### `INVALID_DELEGATION_CONTRACT`

Cause: a delegation `contract` is missing a required field, contains a
malformed authority, budget, or side-effect value, or has a `returnSchema` that
cannot compile.

Fix: provide the complete delegation contract documented in
[Flow reference](../reference/flow-reference.md#return-requirements-delegation-contracts-and-write-isolation).
Validation precedes the affected Child in every role. For a later invalid
contract, prior Runs remain in `details.results`, but that role does not spawn.

### `RETURN_ENVELOPE_INVALID`

Cause: a child governed by a delegation contract returned prose or malformed
JSON, its `data` did not satisfy `contract.returnSchema`, or an artifact
reference was missing or escaped the child working directory.

Fix: for the parent — do not automatically replay the flow. An unchanged retry
re-spends its budget to produce the same invalid envelope. Report the failure
to the user. Retry only with a material change to the child's return
instructions or to `contract.returnSchema`. The child must meet this
requirement: return one `pi-flows.return-envelope.v1` JSON object with every
required field, keep artifact paths inside the child `cwd`, and make `data`
satisfy the declared JSON Schema. The handoff is not passed downstream until it
validates. Some rejected envelopes miss only the schema: the envelope was
attributable to the dispatched contract, its artifact references stayed inside
the child `cwd`, and its declared digests matched. Their unvalidated claims are
still surfaced (for example, by the code-review formatter), so the spend is not
lost with the validation. An envelope with a stale identity, escaped artifact
references, or a failed digest verification is untrustworthy, not merely
unchecked. Its claims are never surfaced, and an integrity failure is reported
as such even when the schema also missed.

### `RETURN_CONTRACT_MISMATCH`

Cause: a contracted child returned a return envelope with no `contractId`, or
with an identity from an older/different delegation contract.

Fix: discard the stale handoff and rerun the child with the current delegation contract.
Contracted modes compare the echoed `sha256:` identity before dependent
dispatch, synthesis, persisted state, or worktree merge.

### `RETURN_ENVELOPE_INCOMPLETE`

Cause: a contracted child reported `partial`, `blocked`, or `failed`, and the
integration mode refused to summarize it as complete.

Fix: resolve or retry the child. If incomplete evidence is useful on purpose,
set `incompleteHandoffPolicy:"include"` explicitly for `partial` or `blocked`
handoffs. The final header and the provenance envelope then retain the
incomplete status. A `failed` handoff is always terminal and must be retried.

### `RETURN_DIGEST_MISMATCH`

Cause: a return envelope declared a SHA-256 digest that did not match the
referenced artifact's bytes. This is reported even when the envelope's `data`
also failed `contract.returnSchema`. Integrity is examined before conformance,
so an envelope that fails both is reported as the integrity failure, not as
`RETURN_ENVELOPE_INVALID`.

Fix: treat the artifact and the envelope as untrusted. Regenerate them
together, then retry. Do not copy the failed handoff into a downstream child.
Unlike a plain schema miss, this envelope's claims are never surfaced as
unvalidated claims. A digest that does not match its artifact makes the whole
envelope untrustworthy, not merely unchecked.

### `HANDOFF_POLICY_VIOLATION`

Cause: an inter-agent handoff matched an injection marker while the effective
`handoffPolicy` was `fail`, or individually benign fragments combined into an
injection-shaped instruction across multiple handoff boundaries. The effective
policy is the stricter of the call's `handoffPolicy` and the current entry in
`modeHandoffPolicy`.

Fix: remove or isolate the flagged content. If the workflow can continue
without that payload, explicitly use `handoffPolicy:"quarantine"`, so that the
recipient receives only a fixed quarantine marker. Use `warn` only when
compatibility is more important than enforced withholding. Under `fail`, the
recipient is refused at the dispatch seam before a child process spawns.

### `CHILD_PROTOCOL_ERROR`

Cause: the child pi process did not emit valid `--mode json` events, or exited
without an assistant message.

Fix: run `/flows status` and `flow showConfig:true` first. Then examine the pi
version, the provider startup output, and `stderr` and `stdoutSample` in
`details`.

### `CHILD_EXIT_NONZERO`

Cause: a child pi process failed. Either it did **not start** (for example,
`pi` is not on `PATH`), or it **started and returned a non-zero exit code**.

Fix: if it did not start, make sure that pi is installed and on PATH — see
[`pi: command not found`](#pi-command-not-found). If it started, inspect
`stderr` and `stdoutSample` in `details`, and make sure that the provider auth,
the model name, the `cwd`, and your pi installation are correct.

### `CHILD_ABORTED`

Cause: the parent request was interrupted before the child pi process completed.

Fix: if the interruption was accidental, retry the flow.

### `CHILD_TIMEOUT`

Cause: a child process exceeded `timeoutMs`.

Fix: for a task that is long on purpose, increase `timeoutMs`, or split the
task. For stuck auth or provider cases, run a smaller no-model smoke check
first.

### `CHILD_PROVIDER_ERROR`

Cause: the provider returned a terminal error. The child normally exits. If it
stalls, pi-flows terminates it after a short grace period instead of a wait for
`timeoutMs`. The structured cause retains that path and the provider
diagnostic, not a generic `CHILD_EXIT_NONZERO`. Collapsed views classify
context, rate-limit, auth, capacity, or unknown failures. They show the
diagnostic, the model, the thinking level (marked as requested when
unverified), the usage, cost, and exit, and the known context usage and limit.
Missing context telemetry shows `?`, and expanded detail remains capped.

Fix by category: for context failures, reduce the input or use a larger
context. For rate limits, wait or reduce concurrency. For auth, repair access.
For capacity, wait or change the model or provider. For unknown failures,
inspect the details, the status, and the access. Provider text remains redacted
and capped, or omitted with `recordContent:false`. Never auto-replay. Retry
explicitly, within the remaining budget. Context, auth, and unknown failures
are not retryable unchanged. `PI_FLOWS_ERROR_GRACE_MS` tunes the stalled-child
grace period (default 30000ms).

### `TRACE_INCOMPLETE`

Cause: the call ran with strict tracing on (`traceStrict:true` or
`PI_FLOWS_TRACE_STRICT=1`), and the coordination trace it produced is not
complete evidence. Either no `traceFile` was configured at all, or the export
settled with dropped spans or failed writes — for example, an unwritable trace
path or a full disk.

The in-process gate sees both. It counts what the exporter failed to write, and
before it reports a result, it reads its own export back. Thus spans lost
*after* a successful write (a truncating concurrent writer, a rotated file)
also fail the call, instead of a pass on the writer's count. The reading also
holds hand-placed event rows to the mode's declared owed event kinds (the
root's `flow.trace.owed_event_kinds`). An unminted event of a kind that the
mode never declared refuses the call, the same way surplus rows do. Rows
stamped `flow.event_minted` are the framework seams' own statements, and they
are exempt.

The gate reads only the rows that carry its own `trace_id` *and* its own
`flow.invocation_id` (a random per-call stamp on every row). Thus flows that
share one file do not judge each other. This includes two calls that share a
stable trace id outright, such as a traced pre-spawn refusal and the retry
after it, under the same trace context and mode. The reading also starts where
the file had grown to when the call began. The file is append-only, so earlier
bytes cannot be the call's own rows. This keeps a finalize from a reread of
every predecessor in a shared file. Rows already there before the call (even
stampless ones under a shared trace id) are a predecessor's record. Whole-file
readers like `trace:report` judge them, not the call's own gate.

`npm run trace:report -- --strict <trace-file>` runs the same validator over a
trace you still have. It takes its expectation from the root span on disk, not
from the run that wrote it.

Note what this is *not*: it is never a statement about the agents. The children
can all have succeeded. Strict mode only refuses to report the run as
evidence-backed when the evidence is missing. That is what an evaluation or
release gate needs.

Fix: point `traceFile` (or `PI_FLOWS_TRACE_FILE`) at a writable JSONL path.
Make sure that no concurrent writer truncates it, then rerun. For ordinary
interactive flows, leave `traceStrict` off — tracing is best-effort by default
and never fails a flow. Inspect the health counters with
`/flows report <trace-file>` or `npm run trace:report -- --strict <trace-file>`.
