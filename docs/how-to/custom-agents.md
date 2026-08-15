# Custom flow agents

The nine bundled agents are markdown files, and your agents work the same way: one `.md` file per agent, with YAML frontmatter for configuration and a body for the system prompt. Put a file in the correct directory. It then appears in `flow list:true` and `/flows` with no extension code, no restart, and no extra configuration.

## Where agents live

| Source | Directory | Loaded when |
|---|---|---|
| `package` | `agents/` inside the installed pi-flows package | always |
| `user` | `~/.pi/agent/flow-agents/` | `agentScope: "user"` (the default) or `"all"` |
| `project` | the nearest `.pi/flow-agents/` walking up from the working directory | `agentScope: "project"` or `"all"` |

Later sources win: a `user` agent shadows a `package` agent with the same `name`, and a `project` agent shadows both. Shadowing is permitted but flagged. `/flows status` reports an `AGENT_NAME_SHADOWED` warning with both file paths, so an override is always visible, never silent. If resumable workflow consent gates that Agent, a different same-name source invalidates the old receipt and requires fresh approval.

## A minimal working example

Save this as `~/.pi/agent/flow-agents/sql-reviewer.md`:

```markdown
---
name: sql-reviewer
description: Reviews SQL migrations for destructive operations, lock risk, and missing indexes. Read-only.
tools: read,grep,find,ls
tier: fast
thinking: low
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

## Frontmatter schema

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | How flow calls reference the agent. The name must be unique within its source. Duplicates across sources shadow by precedence. |
| `description` | yes | Shown in `flow list:true` and `/flows`. The parent model reads this text when it chooses an agent, so state what the agent is *for*. |
| `tools` | no | Comma-separated pi tool list, for example `read,grep,find,ls`. `none` runs with no built-in tools. Omit the field for the pi defaults, which include `bash`, `edit`, and `write`. The defaults make the agent **write-capable** and subject to the `SHARED_WRITE_CWD` fan-out guard. `bash-ro` grants bash under a child-enforced read-only allowlist and stays classified as read-only (listing both `bash` and `bash-ro` resolves to plain `bash`). |
| `model` | no | Pin an exact model id. Prefer `tier` so the agent stays portable across providers. |
| `tier` | no | `capable` (default — the model of the user's session), `fast` (the cheapest model their install can run), or `deep` (the most capable model, for the hardest reasoning and critique work). Tiers resolve against the [model roster](../reference/flow-reference.md#the-model-roster), which is derived from the models the user has, so an agent stays portable with zero configuration. Resolution order: flow-call `model` > flow-call `tier` > agent `model` pin > agent `tier`. A flow-call `tier: capable` always resolves, and forces the session's model even on a `fast` or `deep` agent. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` — how hard this agent thinks, independent of which model it runs. Omit it to take the tier's level. For `capable`, that level is inherited from the parent session. Set it when the agent's effort must stay fixed (bundled `strategist` pins `high`, `recon` pins `low`). The level is lowered automatically to what the resolved model supports. An unrecognized level is ignored with an `AGENT_THINKING_INVALID` warning. |

A file without `name` or `description` is skipped, with an `AGENT_FRONTMATTER_INVALID` warning in `/flows status`. It does not break discovery of the other agents.

Everything below the frontmatter is the agent's system prompt. Write it for a child that starts with zero context: state the task, the output shape, and that the parent sees only the final summary. The bundled [`agents/*.md`](../../agents/) are working examples of the style.

Durable workflow approval binds these values:

- the selected source
- a SHA-256 identity of this prompt body
- the effective tools
- the canonical cwd target and its filesystem identity
- the concrete model
- the Thinking level

If any effective value changes, reapproval is required. Raw prompt text is not copied into the receipt or workflow state. Pi's default tools and implicit model/Thinking settings are not concrete before spawn. Because of this, an approval-gated Role must resolve those values from its Agent, Role overrides, or flow fallbacks.

## Verify what's loaded

```text
/flows                 # bundled + user agents
/flows project         # bundled + project agents
/flows all             # everything
/flows status all      # directories, defaults, and discovery issues (shadowing, bad frontmatter)
```

## Project agents and trust

Project agents (`.pi/flow-agents/`) are **repo-controlled prompts**: a cloned repository must not silently get a delegation surface. So they load only under an explicit `agentScope` of `"project"` or `"all"`. Interactive sessions ask for confirmation before they run them. Headless runs **fail closed** with `PROJECT_AGENT_APPROVAL_REQUIRED`. To open them, review the files, then pass `confirmProjectAgents:false`. The project-source trust decision is separate from a workflow receipt: trust in the source does not let an edited or newly shadowed profile reuse earlier workflow consent. Details are in the [README safety model](../../README.md#safety-model) and [troubleshooting](./troubleshooting.md).

Use `user` agents for your personal toolkit. Use `project` agents for prompts that a team versions and reviews together.
