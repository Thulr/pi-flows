# Custom flow agents

The nine bundled agents are markdown files, and yours work exactly the same way: one `.md` file per agent — YAML frontmatter for the contract, body for the system prompt. Drop a file in the right directory and it appears in `flow list:true` and `/flows` with no extension code, restart, or configuration.

## Where agents live

| Source | Directory | Loaded when |
|---|---|---|
| `package` | `agents/` inside the installed pi-flows package | always |
| `user` | `~/.pi/agent/flow-agents/` | `agentScope: "user"` (the default) or `"all"` |
| `project` | the nearest `.pi/flow-agents/` walking up from the working directory | `agentScope: "project"` or `"all"` |

Later sources win: a `user` agent shadows a `package` agent with the same `name`, and a `project` agent shadows both. Shadowing is allowed but flagged — `/flows status` reports an `AGENT_NAME_SHADOWED` warning with both file paths so an override is always visible, never silent.

## A minimal working example

Save this as `~/.pi/agent/flow-agents/sql-reviewer.md`:

```markdown
---
name: sql-reviewer
description: Reviews SQL migrations for destructive operations, lock risk, and missing indexes. Read-only.
tools: read,grep,find,ls
tier: fast
---

You are a SQL migration reviewer.

- Flag DROP/TRUNCATE/ALTER that can lose data, long-lock operations on hot
  tables, and new query paths without index coverage.
- Return findings as a compact list with file:line evidence. The parent agent
  cannot see your exploration, so each finding must stand on its own.
```

Then ask pi to use it like any bundled agent:

```text
Have sql-reviewer check the migrations in db/migrate added this week.
```

(the call behind it: `{ "agent": "sql-reviewer", "task": "Check the migrations in db/migrate added this week" }`).

## Frontmatter contract

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | How flow calls reference the agent. Must be unique within its source; duplicates across sources shadow by precedence. |
| `description` | yes | Shown in `flow list:true` and `/flows` — this is what the parent model reads when choosing an agent, so make it say what the agent is *for*. |
| `tools` | no | Comma-separated pi tool list, e.g. `read,grep,find,ls`. `none` runs with no built-in tools. Omit for pi defaults — which include `bash`, `edit`, and `write`, making the agent **write-capable** and subject to the `SHARED_WRITE_CWD` fan-out guard. |
| `model` | no | Pin an exact model id. Prefer `tier` so the agent stays portable across providers. |
| `tier` | no | `capable` (default — the child uses the user's default pi model), `fast` (uses `PI_FLOWS_FAST_MODEL` when the user has set one), or `deep` (uses `PI_FLOWS_DEEP_MODEL` for the hardest reasoning/critique work). Resolution order: flow-call `model` > flow-call `tier` > agent `model` pin > agent `tier` > pi default. A flow-call `tier: capable` always resolves (it forces the default model, even on a `fast`/`deep` agent); an unmapped flow-call `fast`/`deep` falls through, so agents stay portable with zero configuration. |

A file missing `name` or `description` is skipped with an `AGENT_FRONTMATTER_INVALID` warning in `/flows status` — it does not break discovery of the other agents.

Everything below the frontmatter is the agent's system prompt. Write it for a child that starts with zero context: state the job, the output shape, and that the parent only sees the final summary. The bundled [`agents/*.md`](../agents/) are working examples of the style.

## Verify what's loaded

```text
/flows                 # bundled + user agents
/flows project         # bundled + project agents
/flows all             # everything
/flows status all      # directories, defaults, and discovery issues (shadowing, bad frontmatter)
```

## Project agents and trust

Project agents (`.pi/flow-agents/`) are **repo-controlled prompts**: cloning a repository must not silently hand it a delegation surface. So they only load under an explicit `agentScope` of `"project"` or `"all"`, interactive sessions ask for confirmation before running them, and headless runs **fail closed** with `PROJECT_AGENT_APPROVAL_REQUIRED` unless `confirmProjectAgents:false` is passed after reviewing the files. Details in the [README safety model](../README.md#safety-model) and [troubleshooting](./troubleshooting.md).

Use `user` agents for your personal toolkit, and `project` agents for prompts a team should version and review together.
