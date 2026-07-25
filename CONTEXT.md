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

### Guardrails and selection

**Gate**:
A deterministic, machine-evaluated pass/fail check that blocks progress — a check command, a workflow phase gate, the delegation justification. Never a human decision.
_Avoid_: check, approval

**Checkpoint**:
A human approval point in a flow, before spawning or before finalizing. A checkpoint is not a gate.
_Avoid_: approval gate, human gate

**Tier**:
A portable capability level (fast, capable, deep) that resolves to a concrete model per install.
_Avoid_: model class, size

**Reflexion**:
Locally persisted cross-run lessons that future flows can read.
_Avoid_: memory, learning
