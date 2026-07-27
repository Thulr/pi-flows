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

Fix: install the `pi` CLI (`>=0.78.0`). The `pi` binary ships in
`@earendil-works/pi-coding-agent`; get it from the
[pi project](https://github.com/earendil-works/pi), for example:

```bash
npm i -g @earendil-works/pi-coding-agent
```

Then confirm it is on your PATH:

```bash
npm run preflight   # or: pi --version
```

See the [README Install section](../README.md#install) for the full prerequisite
list (Node `>=24`, npm `>=11`, pi `>=0.78.0`).

### Provider/auth failures

pi-flows does not create provider credentials. Child pi processes inherit the
environment of the parent pi process. Verify your provider environment with the
normal pi docs, then retry a small single-agent task.

### Invalid agent files

Invalid frontmatter is reported in `/flows status` and `flow showConfig:true`.

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

Fix: choose exactly one of `list:true`, `showConfig:true`, `agent`+`task`,
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

Cause: the `commander` (orchestrator) did not return a JSON array of subtasks.

Fix: tighten the `commander` prompt to return a JSON array of strings. For work
that does not decompose, use `chain` or `single` mode instead.

### `FLOW_DEPTH_EXCEEDED`

Cause: a flow agent that is itself running inside a flow subprocess tried to
spawn more flow children, beyond the nesting cap (`MAX_FLOW_DEPTH`).

Fix: flatten the delegation — do the work directly in that agent, or restructure
so deep flow-within-flow nesting is not required. The cap is intentional harness
discipline against runaway nested delegation, not a bug.

### `BUDGET_EXCEEDED`

Cause: the flow tree's cumulative child spend reached the `maxCostUsd`,
`maxTokens`, or `maxGeneratedTokens` ceiling, so the active child stopped after
its completed model response and no further child was spawned. This bounds the **cost**
dimension of runaway delegation that the iteration, fan-out, and time caps do not
cover.

Fix: raise the configured budget, narrow the task, or reduce fan-out (fewer
voters, subtasks, or `maxIterations`). Omit all budget fields to run uncapped. The partial
results produced before the ceiling was hit are still in `details`.

### `BUDGET_UNOBSERVABLE`

Cause: `maxCostUsd` was configured, but a completed model response omitted its
numeric cost telemetry. The child stops at that response boundary because treating
unknown spend as zero would silently make the cost ceiling non-binding.

Fix: use a provider/model that reports cost telemetry, or bind execution with
`maxTokens`, `maxGeneratedTokens`, or `timeoutMs` instead.

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
`bash`, `edit`, or `write` are also write-capable.

Fix: use read-only agents for parallel fan-out, give each writer a distinct
`cwd`/worktree, or pass `allowSharedWriteCwd:true` only when concurrent writes in
one checkout are intentional.

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
