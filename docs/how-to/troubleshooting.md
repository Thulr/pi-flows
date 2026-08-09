# Troubleshooting

This page is the **canonical, CI-tested catalog** of every `flow` error `code`
(with its cause and fix), plus common setup issues. Every error the `flow` tool
returns carries `code`, `message`, `cause`, `fix`, and `retryable`; the
[Error codes](#error-codes) catalog below is verified in CI
(`tests/pi-flows.test.ts`) to cover **every** code in the source, so a new code
cannot ship undocumented.

## Setup & environment

### pi: command not found

Cause: the `pi` host CLI is not installed or not on your `PATH`. pi-flows is a
pi extension and cannot run without it — and `npm ci` / `npm run check` do **not**
install pi (they only build and test this package).

Fix: install the `pi` CLI (`>=0.82.0`). The `pi` binary ships in
`@earendil-works/pi-coding-agent`; get it from the
[pi project](https://github.com/earendil-works/pi), for example:

```bash
npm i -g @earendil-works/pi-coding-agent
```

Then confirm it is on your PATH:

```bash
npm run preflight   # or: pi --version
```

See the [README Install section](../../README.md#install) for the full prerequisite
list (Node `>=24`, npm `>=11`, pi `>=0.82.0`).

### pi is older than the minimum supported version

Cause: `pi` is on your PATH, but its version is below the floor pi-flows is
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

If preflight instead warns that it could not read a version, `pi` answered but
its `--version` output had no recognizable `major.minor.patch` in it. That is a
warning rather than a failure — confirm your version by hand with `pi --version`.

Preflight names the executable it checked, and that executable is the one your
shell would run. In a clone, npm prepends `node_modules/.bin` to PATH while it
runs a script, and `@earendil-works/pi-coding-agent` is a peer dependency — so
there is a `pi` there that your shell never sees. Preflight skips it deliberately:
the host that loads the extension is the `pi` from `pi -e ./extensions/pi-flows/index.ts`,
not npm's copy. If your only `pi` is that local one, preflight reports it as not
found and points at it, because the documented command would fail.

Only the directories npm actually injects are skipped — this checkout's
`node_modules/.bin` and its ancestors', compared by canonical path. A
`node_modules/.bin` you put on your own PATH is a normal install location and is
checked like any other.

### Provider/auth failures

pi-flows does not create provider credentials. Child pi processes inherit the
environment of the parent pi process. Verify your provider environment with the
normal pi docs, then retry a small single-agent task.

### Invalid agent files

Invalid frontmatter is reported in `/flows status` and `flow showConfig:true`.
The same surfaces report invalid preset frontmatter or non-JSON preset bodies.

Valid minimal agent:

```md
---
name: my-agent
description: What this agent does
---

Prompt body.
```

## Error codes

Listed in source order, matching the `FlowErrorCode` union in
`extensions/pi-flows/index.ts`. CI asserts this list stays in sync.

### `UNKNOWN_AGENT`

Cause: no discovered agent matched the requested name.

Fix: list the available agents and check scope/discovery:

```text
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

Confirm `agentScope` and review any discovery issues reported by `/flows status`.

### `UNKNOWN_PRESET`

Cause: no discovered workflow preset matched the requested `preset` name in the
effective scope.

Fix: run `flow` with `{"list":true}`, `/flows`, or `showConfig:true`; then use
the exact preset name and confirm `agentScope`.

### `PRESET_TASK_REQUIRED`

Cause: the selected preset contains a `{task}` placeholder, but the call did not
supply a non-empty top-level `task`.

Fix: pass the complete goal, fixed point, and relevant issue/spec context in
`task`.

### `PRESET_OVERRIDE_INVALID`

Cause: the call tried to replace a top-level workflow parameter the preset did
not declare in its `overrides` frontmatter.

Fix: remove the override. If you own the preset and the changed shape is safe,
add that key to `overrides` after reviewing its bounds and trust implications.
Use a raw mode call when the requested topology is materially different.

### `PRESET_EXPANSION_INVALID`

Cause: a preset template or a caller-supplied override expanded to parameters
outside the public `FlowParams` schema.

Fix: inspect `flow showConfig:true` for preset discovery issues, then correct the
invalid template field or remove the invalid override.

### `PROJECT_PRESET_APPROVAL_REQUIRED`

Cause: a headless run requested a repository-controlled preset from
`.pi/flow-presets` while project confirmation remained enabled.

Fix: review the preset file. Run interactively to approve it, or pass
`confirmProjectAgents:false` only in a trusted non-UI repository.

### `PROJECT_PRESET_APPROVAL_DENIED`

Cause: the interactive prompt for a project-local preset was declined.

Fix: review `.pi/flow-presets`, then retry and approve only if the workflow
parameters are trusted.

### `WHY_REQUIRED`

Cause: the call selected a mode that spawns child agents but did not include
`why` — the one-sentence justification for delegating instead of doing the work
directly in the parent context. This gate is deliberate friction against
reflexive delegation: spawning a child costs a full separate model context.

Fix: pass `why` naming the reason delegation is warranted — an explicit user
request for delegation, fan-out that one context cannot hold, or verification
that must be independent of the author:

```text
{"agent":"recon","task":"map the auth module","why":"user asked for a delegated read-only scout"}
```

If no such reason exists, that is the signal to do the work directly instead of
calling `flow`. `list:true` and `showConfig:true` never need `why`.

### `INVALID_MODE`

Cause: the parameters did not select exactly one mode — zero modes, more than
one conflicting mode, or a required field for the chosen mode (most modes need a
top-level `task`) was missing.

Fix: choose exactly one of `list:true`, `showConfig:true`, `agent`+(`task` or `contract`),
`tasks[]`, `chain[]`, `evaluate{}`, `vote{}`, `route{}`, `orchestrate{}`,
`graph{}`, `loop{}`, `search{}`, `workflow{}`, `worktree{}`, `debate{}`,
`dossier{}`, or `monitor{}`, and supply that mode's required fields. Run
`showConfig:true` to inspect defaults before execution.

### `INVALID_SCOPE`

Cause: an agent scope other than `user`, `project`, or `all` was requested.

Fix: use one of `user`, `project`, or `all`. Both the `/flows <scope>` argument
parser and the `flow` tool's `agentScope` schema reject unknown scopes, so this
typically surfaces as a direct "Unknown scope" message before a typed error is
produced.

### `INVALID_CONCURRENCY`

Cause: `concurrency` was fractional or outside `1..8`.

Fix: omit it (defaults to `4`) or use an integer from `1` to `8`.

### `TOO_MANY_TASKS`

Cause: `parallel` mode received more than `8` tasks, or `vote` mode more than
`8` voters — the hard cap (`MAX_PARALLEL_TASKS`) that prevents runaway
subprocess fanout.

Fix: split the work into batches of `8` or fewer.

### `TOO_FEW_VOTERS`

Cause: `vote` mode was given fewer than 2 voters.

Fix: set `vote.count >= 2`, or provide at least 2 entries in `vote.voters`. One
voter is just single mode.

### `ROUTE_UNRESOLVED`

Cause: the `controller` (router) output did not name any agent in
`route.candidates`.

Fix: tighten the `controller` prompt, widen/adjust `route.candidates`, or set
`route.fallback` to a default agent.

### `ORCHESTRATE_NO_SUBTASKS`

Cause: the `commander` decomposer did not return a JSON array of subtasks.

Fix: tighten the `commander` prompt to return a JSON array of strings. For work
that does not decompose, use `chain` or `single` mode instead.

### `FLOW_DEPTH_EXCEEDED`

Cause: a flow agent that is itself running inside a flow subprocess tried to
spawn more flow children, beyond the nesting cap (`MAX_FLOW_DEPTH`).

Fix: flatten the delegation — do the work directly in that agent, or restructure
so deep flow-within-flow nesting is not required. The cap is intentional harness
discipline against runaway nested delegation, not a bug.

### `BUDGET_EXCEEDED`

Cause: a flow budget or contract budget reached its `maxCostUsd`, `maxTokens`,
or `maxGeneratedTokens` ceiling. Cost and generated-output ceilings
stop the active child after its completed model response; the legacy total-token
ceiling preserves that response. All three prevent further child spawns. This
bounds the **cost** dimension of runaway delegation that the iteration, fan-out,
and time caps do not cover. A child that was already steered to wrap up (the
80% wrap-up notice) does not produce this error when it crosses the ceiling —
it settles gracefully with `stopReason: "budget_wrap_up"` and its envelope is
validated normally — so seeing `BUDGET_EXCEEDED` means the ceiling was crossed
before any wrap-up could be requested or honored.

Fix: do not automatically replay the same Flow unchanged. Ask for direction, or
make a material, visible change that stays within the configured ceiling:
narrow the task or reduce fan-out (fewer voters, subtasks, or `maxIterations`).
Preserve the owning flow/contract budget unless the user explicitly approves
raising or removing it. The partial results produced before the ceiling was hit
are still in `details`. When a ceiling binds inside the *normal* cost range of
the task (roughly half of comparable runs breach it), the ceiling is missized:
resize it as a runaway backstop (~3x the observed normal spend) rather than
narrowing the task further.

### `BUDGET_UNOBSERVABLE`

Cause: a flow budget or contract budget set `maxCostUsd`, but a completed model
response omitted its numeric cost telemetry. The child stops at that response
boundary because treating unknown spend as zero would silently make the cost
ceiling non-binding.

Fix: use a provider/model that reports cost telemetry, or bind the same flow or
delegation contract with `maxTokens`, `maxGeneratedTokens`, or `timeoutMs`
instead.

### `CHECK_COMMAND_FAILED`

Cause: an `evaluate.checkCommand` (the deterministic gate) could **not be
started** — for example, the command is not found on `PATH` or is not runnable
from the cwd. This is distinct from the command running and exiting non-zero,
which is a normal `REVISE` signal, not an error.

Fix: verify the command exists and runs from the operator's `cwd` (try it in a
shell first). A non-runnable check is a configuration error, so the loop aborts
rather than looping to `maxIterations` against a check that can never pass.

### `ORCHESTRATE_VERIFY_FAILED`

Cause: `orchestrate.verify` was configured as a hard gate (`verifyPolicy:"fail"`
or `"revise"`), and the verifier either returned `VERDICT: REVISE` after the
allowed synthesize→verify rounds or the verifier child could not produce a usable
passing verdict. The merged answer is returned with the verifier critique, but
the flow result is marked as failed.

Fix: read the verifier critique and rerun after narrowing the task or improving
the worker/synthesis contract. For advisory-only verification, set
`orchestrate.verifyPolicy:"note"`. For revision policy, raise
`orchestrate.verifyMaxIterations` up to the cap or make the acceptance criteria
more concrete.

### `GRAPH_INVALID`

Cause: `graph` mode was given an invalid static DAG: no nodes, too many nodes,
duplicate/missing node ids, missing `agent`/`task`, or a `dependsOn` reference to
an unknown node.

Fix: provide 1-16 graph nodes. Every node needs a unique `id`, `agent`, and
`task`; every `dependsOn` value must match another node id.

### `GRAPH_CYCLE`

Cause: no remaining graph node could run because the dependency graph contains a
cycle or an unsatisfied dependency chain.

Fix: remove cycles. At least one node must have no dependencies, and every
dependency chain must eventually reach an already-runnable node.

### `LOOP_DID_NOT_CONVERGE`

Cause: `loop` mode reached `loop.maxIterations` before the body emitted
`LOOP: DONE` or the optional judge emitted `VERDICT: PASS`.

Fix: narrow the task, improve the stop condition, add a judge with concrete
criteria, or raise `loop.maxIterations` within the cap.

### `SEARCH_NO_CANDIDATES`

Cause: `search` mode generated no usable candidates, or scoring eliminated all
candidates before final synthesis.

Fix: narrow the task, reduce `search.candidates`, choose a generator better
suited to the work, or inspect scorer output for overly strict scoring.

### `WORKFLOW_INVALID`

Cause: `workflow.phases` is empty, exceeds the phase cap, repeats an id, or a
phase does not select exactly one of `agent`+`task` and `approval`.

Fix: provide 1-12 uniquely named phases. Work phases need both `agent` and
`task`; approval phases need only `approval.message`.

### `WORKFLOW_STATE_INVALID`

Cause: a resumed workflow state file is unreadable, malformed, or belongs to a
different workflow definition.

Fix: resume with the same task and phase definition, or remove the stale state
file and restart without `resume:true`.

### `WORKFLOW_GATE_FAILED`

Cause: a phase's deterministic `checkCommand` ran and exited non-zero.

Fix: inspect the captured command output, correct the phase artifact or gate,
then resume the workflow after the failure is addressed.

### `WORKFLOW_APPROVAL_REQUIRED`

Cause: a headless workflow reached an approval phase. Progress was persisted,
but no interactive UI was available to collect a decision.

Fix: resume the same workflow in interactive pi, or replace the human approval
with a deterministic `checkCommand` for unattended runs.

### `WORKFLOW_APPROVAL_DENIED`

Cause: the interactive approval phase was declined.

Fix: review the persisted phase outputs, revise the workflow inputs if needed,
then resume when the approval can be granted.

### `APPROVAL_RECEIPT_INVALID`

Cause: the step about to run is gated by an approval, but the resume state
carries no usable receipt for it — the state file was truncated, hand-edited, or
written by a tool that does not understand `pi-flows.approval-receipt.v1`. This
also fires when a recorded field (approver, issue time, expiry, or consumption
record) was changed without re-stamping the receipt's `receiptDigest`.

Fix: re-run the workflow in an interactive Pi UI so the phase is approved again.
A malformed receipt cannot be repaired in place; approvals are only minted by an
actual approval.

### `APPROVAL_RECEIPT_STALE`

Cause: an approval was granted, then the action it authorizes changed. A receipt
binds the gated phases' effective definitions — agent, task template, cwd, model,
tier, tools, checkCommand, delegation contract — plus the `agentScope`,
`returnContract`, `requireEvidence`, and `incompleteHandoffPolicy` in force when
consent was given. Editing any of them between approval and resume means the
approval no longer covers what would run. Flipping `agentScope` to `project` is
the case worth naming: it swaps which repo-controlled prompt executes.

Fix: resume in an interactive Pi UI — the approval phase reopens automatically
and asks again, naming what changed. Restoring the approved parameters is not
enough on its own: reopening discards consent that no longer held, so the phase
still needs a fresh approval.

If part of the gated run already executed, the approval is **not** reopened and
this stays a hard refusal naming the phases that ran. Restore the parameters that
were approved and resume, or start a fresh run so the whole gated sequence
executes under one approval.

### `APPROVAL_RECEIPT_EXPIRED`

Cause: the resume arrived after the approval's window closed, before the
authorized action had begun. Receipts expire so consent cannot be banked
indefinitely; the default window is 24 hours from the moment approval was
granted. The window gates *starting* the action — a gated run already under way
finishes rather than aborting halfway when the clock passes.

Fix: resume in an interactive Pi UI — the approval phase reopens and asks again,
so a lapsed window never strands the state file. Set
`workflow.approvalTtlMs` (60000..2592000000 ms) to a longer window *before*
approving if the gap is expected; widening it afterwards does not revive a spent
window, since the expiry is stamped into the receipt at issue time.

### `APPROVAL_RECEIPT_CONSUMED`

Cause: a receipt that was already spent by one action was presented to authorize
a different one. Approvals are single use: one approval authorizes one action,
spanning every step between it and the next consent point.

Fix: give the second action its own approval phase. Retrying a failed phase
inside the gated run the approval already covers is not a replay and is allowed —
this error only fires when the action differs from the one recorded on the
receipt.

### `WORKTREE_NOT_GIT`

Cause: `worktree` mode was invoked outside a Git repository or with an invalid
`baseRef`.

Fix: run from a Git checkout and choose a base ref that resolves to a commit.

### `WORKTREE_DIRTY_SOURCE`

Cause: the source checkout has uncommitted changes while `requireClean` is true,
so worker branches would silently omit local work.

Fix: commit or stash the local changes, or set `requireClean:false` only when
omitting them is intentional.

### `WORKTREE_SETUP_FAILED`

Cause: pi-flows could not create a worker branch/worktree or commit a worker's
changes.

Fix: inspect Git's captured error, remove stale conflicting refs/worktrees, and
confirm the writer actually produces tracked changes before retrying.

### `WORKTREE_INTEGRATION_FAILED`

Cause: worker commits could not be merged cleanly into the integration branch,
or the integrator could not resolve the combined result.

Fix: inspect the retained integration branch and worker refs, resolve the
conflict there, or repartition overlapping writer tasks.

### `WORKTREE_VERIFY_FAILED`

Cause: the integration `checkCommand` ran on the merged branch and exited
non-zero.

Fix: inspect the retained integration branch and captured test output, correct
the integrated result, and rerun verification.

### `DEBATE_TOO_FEW_PARTICIPANTS`

Cause: `debate` mode received fewer than two independent advocates.

Fix: provide at least two participant agent refs. For one perspective, use
`single`; for independent same-task answers without rebuttal, use `vote`.

### `DOSSIER_TOO_FEW_SECTIONS`

Cause: `dossier` mode received fewer than two evidence-extraction sections.

Fix: assign at least two independent sources or claim families. A single-source
lookup should use `single` instead.

### `MONITOR_INVALID`

Cause: the monitor configuration is invalid, such as `trigger:"match"` without
a valid regular-expression `pattern`.

Fix: choose `success`, `failure`, or `match`; for `match`, supply a valid regex
pattern and keep the interval/check counts inside their documented bounds.

### `MONITOR_NOT_TRIGGERED`

Cause: the bounded monitor exhausted `maxChecks` without observing its trigger.

Fix: treat this as a conclusive bounded no-trigger result; widen the check
budget or adjust the probe/trigger only when the original bound was too narrow.

### `CHECKPOINT_APPROVAL_REQUIRED`

Cause: a flow requested a human checkpoint (`checkpoint.before`) in a headless
non-UI context, so pi-flows could not collect approval.

Fix: run in an interactive pi session, remove the checkpoint for non-interactive
runs, or replace the checkpoint with a deterministic gate such as
`evaluate.checkCommand`.

### `CHECKPOINT_APPROVAL_DENIED`

Cause: the interactive human checkpoint prompt was declined.

Fix: review the flow request or final result and retry if it should proceed.

### `SHARED_WRITE_CWD`

Cause: two or more write-capable agents would run concurrently in the same
working directory. Agents with `tools` omitted are treated as write-capable
because they inherit pi's default toolset; agents whose effective tools include
`bash`, `edit`, or `write` are also write-capable. The classification comes from
the effective toolset alone — a read-only role name or prompt does not change
it, so retrying with a different agent name and the same tools refuses again.
The refusal names each agent with the tools that classified it.

Fix: serialize with `concurrency:1` (the guard only applies to concurrent
writers), use agents whose effective tools exclude `bash`/`edit`/`write`, swap
`bash` for `bash-ro` (bash under a child-enforced read-only allowlist, which is
not write-capable), or give each writer a distinct `cwd`/worktree. For review
fan-out specifically, prefer the `code-review` preset, which runs its reviewers
under `bash-ro`. Pass `allowSharedWriteCwd:true` only as a last resort, when
concurrent writes in one checkout are actually intended.

### `BASH_READONLY_UNENFORCEABLE`

Cause: a role's tools included `bash-ro`, but no layer can enforce it — the OS
read-only-checkout sandbox is unavailable or opted out
(`PI_FLOWS_BASH_RO_NO_SANDBOX`, or a non-macOS host) *and* the command-allowlist
fallback is unavailable, because `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX` is set or the
enforcer extension could not be located. Spawning anyway would grant the child
unrestricted bash in the shared checkout, so the spawn is refused before any
process starts. (Note `PI_FLOWS_CHILD_NO_EXTENSIONS` alone does not trigger
this: the enforcer loads via an explicit `-e`, which pi keeps under
`--no-extensions`. And by default, off the sandbox, the allowlist fallback runs
rather than refusing.)

Fix: run on macOS (without `PI_FLOWS_BASH_RO_NO_SANDBOX`) so the sandbox
enforces it; unset `PI_FLOWS_BASH_RO_REQUIRE_SANDBOX` to allow the best-effort
allowlist fallback; or change the role's tools — `bash` if write-capable
classification (and the shared-write guard) is acceptable, or `read,grep,find,ls`
if the child does not need a shell.

### `PROJECT_AGENT_APPROVAL_REQUIRED`

Cause: a headless (non-UI) run requested a project-local agent from
`.pi/flow-agents`.

Fix: review the project-local agent file. In an interactive session, approve the
prompt. In a trusted non-UI run, pass `confirmProjectAgents:false` explicitly
after reviewing the files.

### `PROJECT_AGENT_APPROVAL_DENIED`

Cause: the interactive approval prompt for project-local agents was declined.

Fix: review the project-local agent files in `.pi/flow-agents`. Retry and
approve if you trust them, or pass `confirmProjectAgents:false` in a trusted
non-UI run.

### `INVALID_DELEGATION_CONTRACT`

Cause: a delegation `contract` is missing a required field, contains a malformed
authority/budget/side-effect value, or has a `returnSchema` that cannot compile.

Fix: provide the complete delegation contract documented in
[Flow reference](../reference/flow-reference.md#return-requirements-delegation-contracts-and-write-isolation).
Delegation-contract validation happens before the affected single, chain, or evaluate child
is dispatched.

### `RETURN_ENVELOPE_INVALID`

Cause: a child governed by a delegation contract returned prose or malformed JSON,
its `data` did not satisfy `contract.returnSchema`, or an artifact reference was
missing or escaped the child working directory.

Fix: for the parent — do not automatically replay the flow; an unchanged retry
re-spends its budget to produce the same invalid envelope. Report the failure
to the user, and retry only with a material change to the child's return
instructions or `contract.returnSchema`. The requirement the child must meet:
return one `pi-flows.return-envelope.v1` JSON object with every required
field, keep artifact paths inside the child `cwd`, and make `data` satisfy the
declared JSON Schema. The handoff is not passed downstream until it validates;
where the rejected envelope was at least structurally valid, its unvalidated
claims are still surfaced (e.g. by the code-review formatter) so the spend is
not lost with the validation.

### `RETURN_CONTRACT_MISMATCH`

Cause: a contracted child returned a return envelope with no `contractId`, or
with an identity from an older/different delegation contract.

Fix: discard the stale handoff and rerun the child with the current delegation contract.
Contracted modes compare the echoed `sha256:` identity before dependent
dispatch, synthesis, persisted state, or worktree merge.

### `RETURN_ENVELOPE_INCOMPLETE`

Cause: a contracted child reported `partial`, `blocked`, or `failed`, and the
integration mode refused to summarize it as complete.

Fix: resolve/retry the child. If incomplete evidence is intentionally useful,
set `incompleteHandoffPolicy:"include"` explicitly for `partial` or `blocked`
handoffs; the final header and provenance envelope will retain the incomplete
status. A `failed` handoff is always terminal and must be retried.

### `RETURN_DIGEST_MISMATCH`

Cause: a return envelope declared a SHA-256 digest that did not match the
referenced artifact's bytes.

Fix: treat the artifact and envelope as untrusted, regenerate them together,
then retry. Do not copy the failed handoff into a downstream child.

### `HANDOFF_POLICY_VIOLATION`

Cause: an inter-agent handoff matched an injection marker while the effective
`handoffPolicy` was `fail`, or individually benign fragments combined into an
injection-shaped instruction across multiple handoff boundaries. The effective
policy is the stricter of the call's `handoffPolicy` and the current entry in
`modeHandoffPolicy`.

Fix: remove or isolate the flagged content. If the workflow can continue
without that payload, explicitly use `handoffPolicy:"quarantine"` so the
recipient receives only a fixed quarantine marker. Use `warn` only when
compatibility is more important than enforced withholding. Under `fail`, the
recipient is refused at the dispatch seam before a child process spawns.

### `CHILD_PROTOCOL_ERROR`

Cause: the child pi process did not emit valid `--mode json` events, or exited
without an assistant message.

Fix: check pi version, provider startup output, `stderr`, and `stdoutSample` in
details. Run `/flows status` and `flow showConfig:true` first.

### `CHILD_EXIT_NONZERO`

Cause: a child pi process failed. Either it could not be **started** (for
example, `pi` is not on `PATH`), or it **started and returned a non-zero exit
code**.

Fix: if it could not start, confirm pi is installed and on PATH — see
[`pi: command not found`](#pi-command-not-found). If it started, inspect
`stderr` and `stdoutSample` in details and verify provider auth, model name,
`cwd`, and your pi installation.

### `CHILD_ABORTED`

Cause: the parent request was interrupted before the child pi process completed.

Fix: retry the flow if the interruption was accidental.

### `CHILD_TIMEOUT`

Cause: a child process exceeded `timeoutMs`.

Fix: increase `timeoutMs` for intentionally long tasks, or split the task. For
stuck auth/provider cases, run a smaller no-model smoke check first.

### `CHILD_PROVIDER_ERROR`

Cause: the child's model provider returned a terminal error (for example
"input exceeds the context window of this model") and the child process then
stalled instead of exiting, so pi-flows terminated it after a short grace
period rather than letting it hang until `timeoutMs`.

Fix: narrow the task or the material the child reads (a smaller issue thread,
fewer files), or pick a larger-context model via `tier`/`model`, then retry.
`PI_FLOWS_ERROR_GRACE_MS` tunes the grace period (default 30000ms).

### `TRACE_INCOMPLETE`

Cause: the call ran with strict tracing on (`traceStrict:true` or
`PI_FLOWS_TRACE_STRICT=1`) and the coordination trace it produced is not
complete evidence. Either no `traceFile` was configured at all, or the export
settled with dropped spans / failed writes — for example an unwritable trace
path or a full disk.

The in-process gate sees what the exporter failed to write. Spans lost *after* a
successful write (a truncating concurrent writer, a rotated file) are caught on
the read-back side instead, by comparing the root span's declared expectation
against the rows present: `npm run trace:report -- --strict <trace-file>`.

Note what this is *not*: it is never a statement about the agents. The children
may all have succeeded. Strict mode only refuses to report the run as
evidence-backed when the evidence is missing, which is what an evaluation or
release gate needs.

Fix: point `traceFile` (or `PI_FLOWS_TRACE_FILE`) at a writable JSONL path,
check for a concurrent writer truncating it, and rerun. Ordinary interactive
flows should leave `traceStrict` off — tracing is best-effort by default and
never fails a flow. Inspect the health counters with
`/flows report <trace-file>` or `npm run trace:report -- --strict <trace-file>`.
