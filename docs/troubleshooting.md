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

### `INVALID_MODE`

Cause: the parameters did not select exactly one mode — zero modes, more than
one conflicting mode, or a required field for the chosen mode (most modes need a
top-level `task`) was missing.

Fix: choose exactly one of `list:true`, `showConfig:true`, `agent`+`task`,
`tasks[]`, `chain[]`, `evaluate{}`, `vote{}`, `route{}`, or `orchestrate{}`, and
supply that mode's required fields. Run `showConfig:true` to inspect defaults
before execution.

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

Cause: the flow tree's cumulative child spend reached the `maxCostUsd` or
`maxTokens` ceiling, so no further child was spawned. This bounds the **cost**
dimension of runaway delegation that the iteration, fan-out, and time caps do not
cover.

Fix: raise `maxCostUsd` / `maxTokens`, narrow the task, or reduce fan-out (fewer
voters, subtasks, or `maxIterations`). Omit both to run uncapped. The partial
results produced before the ceiling was hit are still in `details`.

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
