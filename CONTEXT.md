# pi-flows

pi-flows lets a parent pi session delegate bounded work to disposable child agents and get compact findings back, instead of doing everything in one long-running context.

## Language

### Delegation model

**Flow**:
One bounded delegation — a single call of the `flow` tool, covering every child it spawns.
_Avoid_: job, session

**Mode**:
The coordination pattern a flow uses (single, parallel, evaluate, debate, …).
_Avoid_: workflow (that names one specific mode), strategy

**Parent**:
The main pi session that delegates work and makes the final decision.
_Avoid_: main session, orchestrator (that suggests the orchestrate mode)

**Child**:
The disposable pi subprocess that executes one task under a flow.
_Avoid_: sub-agent, spawn

**Agent**:
A named profile — prompt, tools, model or tier — that a child runs as, discovered from package, user, or project sources.
_Avoid_: persona, specialist, subagent

**Role**:
The slot in a mode's topology that an agent fills (generator, critic, worker, adjudicator).
_Avoid_: position

**Task**:
The bounded unit of work text handed to a child.
_Avoid_: prompt, job

**Subtask**:
A task produced by orchestrate's decomposition rather than authored upstream. A subtask is a kind of task.

**Run**:
One child executing one task. A flow contains one or more runs.
_Avoid_: execution, invocation

**Settled**:
A run (or a whole flow) that has finished executing, whether it completed or failed. The opposite of live.
_Avoid_: done, finished (both read as "succeeded")

**Fleet**:
Every run currently queued or executing, across all live flows.
_Avoid_: dashboard, active agents (runs execute; agents are profiles)

### Coordination evidence

**Span**:
One recorded unit of a flow's execution in a trace. Every span declares a **span role**: `root` (the flow call), `stage`, `child` (one run), or `event`.
_Avoid_: log line, trace entry

**Stage**:
A grouping span for work that belongs together — a graph wave, a debate round, an evaluate iteration, a fan-out group, a workflow phase. Children nest under their stage rather than under the root.
_Avoid_: group, batch, phase (that names one specific stage kind)

**Unit key**:
The stable name a stage or child span carries inside one flow, so another span can reference it. Referenced from `dependsOn`.
_Avoid_: id, node name

**Dependency link**:
A recorded "this unit consumed that unit's output" edge. Deliberately not parentage: a graph node that reads another node's output was scheduled by its wave, not spawned by the node it read.
_Avoid_: parent, edge

**Coordination event**:
A zero-duration span for a boundary that is not a run — an artifact reference, a state transition, a retry, an approval, a budget change, a validation result, a handoff. Named by its `flow.event_kind`.
_Avoid_: log, marker

**Approval** (as an event kind):
The recorded fact that a human approval point was reached and how it resolved. Covers both **Checkpoint** approvals and workflow-phase approval receipts, which is why the event kind is broader than either term.
_Avoid_: gate (a gate is machine-evaluated)

**Trace health**:
How complete a flow's exported evidence is (`recorded`, `degraded`, `missing`), counted as expected vs observed spans. Reported separately from execution success: a run whose spans were dropped is unauditable, not failed.
_Avoid_: trace status, telemetry health

**Flow card**:
The durable summary of one settled flow — status, per-run outcomes, spend, and evidence pointer — that outlives any live view of it.
_Avoid_: run-card (it summarizes a flow, not a run)

### Guardrails and selection

**Gate**:
A deterministic, machine-evaluated pass/fail check that blocks progress — a check command, a workflow phase gate, the delegation justification. Never a human decision.
_Avoid_: check, approval

**Checkpoint**:
A human approval point in a flow, before spawning or before finalizing. A checkpoint is not a gate.
_Avoid_: approval gate, human gate

**Budget**:
A machine-enforced spending ceiling for one flow — cost or tokens — charged as runs settle. A budget is a gate, not a checkpoint: exceeding it stops the flow without a human decision.
_Avoid_: quota, allowance

**Tier**:
A portable capability level (fast, capable, deep) that resolves to a concrete model per install.
_Avoid_: model class, size

**Reflexion**:
Locally persisted cross-run lessons that future flows can read.
_Avoid_: memory, learning
