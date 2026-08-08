# pi-flows

pi-flows lets a parent pi session delegate bounded work to disposable children and get compact findings back, instead of doing everything in one long-running context.

The value is not the spawning — anything can spawn a subprocess. It is that what comes back is **checkable**: a finding arrives bound to the contract it was produced under, carrying its own evidence, provenance, and cost, so the parent can act on it without re-reading the transcript that produced it.

## Where the modeling goes

Not every part of this repo earns the same depth. This split says where to spend design effort and review attention, and where deliberately not to. Revisit it when the differentiator moves.

`scripts/domain-score.mjs` enforces this split — every module below is checked for placement and for which subdomains it may import from — so the classification cannot quietly go stale as modules are added.

**Core — coordination under guardrails.** Delegation contracts and their identity, return and handoff envelopes, injection policy, artifact digests, approval receipts, budget authority, capture policy, and the coordination evidence that shows what actually happened. This is the part that makes a returned finding checkable rather than merely plausible. Model it deeply, give every new concept a glossary entry below, and expect changes here to come with a test that names the invariant and, where it is a coordination failure, a fault-scenario entry.
_Modules_: `delegation.ts`, `handoff.ts`, `handoff-types.ts`, `handoff-consumption.ts`, `approval.ts`, `budget.ts`, `integration.ts`, `contract-resolution.ts`, `validate.ts`, `validate-workflow.ts`, `sanitize.ts`, `trace.ts`, `trace-scope.ts`, `trace-sink.ts`, `trace-attributes.ts`, `trace-structure.ts`, `trace-report.ts`, `trace-identity.mjs`.

**Supporting — coordination patterns and the views onto them.** The modes and their topologies, preset and agent discovery, reflexion, and the live/settled surfaces (fleet panel, inspector, flow card, live board). Necessary, and often the reason someone reaches for the tool, but they recombine the core's primitives rather than being the differentiator. Build them plainly and resist per-mode special cases a new mode would have to re-implement; the views must speak the glossary's terms but hold no invariants of their own.
_Modules_: `modes/*`, `presets.ts`, `preset-catalog.ts`, `preset-approval.ts`, `agents.ts`, `agent-catalog.ts`, `reflexion.ts`, `budget-disclosure.ts`, `ui.ts`, `ui-live-row.ts`, `ui-flow-card.ts`, `fleet-panel.ts`, `inspector.ts`.

**Generic — plumbing and adapters.** Child-process transport, the anti-corruption layer over a child pi run, fan-out plumbing, param schema and arithmetic, command execution, text parsing. Keep thin, keep replaceable, do not model. `runner.ts` and `jsonl-child.mjs` are where a foreign protocol is allowed to be spoken; everything above them should see domain types only.
_Modules_: `runner.ts`, `dispatch.ts`, `jsonl-child.mjs`, `schema.ts`, `commands.ts`, `parse.ts`, `protocol.ts`, `topology.ts`, `model-roster.ts`, `roster-config.ts`, `roster-source.ts`.

**Shared kernel.** `types.ts` — the vocabulary every subdomain imports, re-exported from the concept modules that own each term. A change here ripples everywhere and nothing above owns it, so keep it declarative: a rule that belongs to one concept belongs in that concept's module (see `budget.ts`), not here. `roster-types.ts` is vocabulary of the same kind, held apart only because the kernel may not import the Generic module that derives a roster.
_Modules_: `types.ts`, `roster-types.ts`, `preset-types.ts`.

**Composition root.** `index.ts` — registers the tool and command and wires every subdomain together, so it alone may import from all of them. That privilege is also why flow-level invariants keep accumulating in its `execute()` body rather than in a Flow root; treat new ordering rules there as a smell.
_Modules_: `index.ts`.

The enforced direction is narrow on purpose: **Core may not import Supporting**, and the shared kernel may import only Core. Core reaching down into Generic plumbing is fine — commodity is there to be used. Core reaching sideways into the modes or the views is not: it would make the differentiator depend on the recombinations of it.

Three placements are worth stating outright, because a first pass tends to put them elsewhere. **Tracing is Core, not reporting**: coordination evidence is what makes a returned finding checkable, which is the whole value proposition above — a flow that cannot show what it did has lost the thing being sold. **Redaction is Core, not plumbing**: `sanitize.ts` implements Capture policy, and what may leave a child is a guardrail, not a formatting concern. **The views are Supporting, not Generic**: they render domain concepts and must speak the glossary's terms, so they are not interchangeable commodity — but they hold no invariants, so they are not Core either.

## Language

### Delegation model

**Flow**:
One bounded delegation — a single call of the `flow` tool, covering every child it spawns. A flow is not its runs: it has a mode and a settled outcome of its own, and it is the thing a budget, a root span, and a checkpoint attach to when the call configures them. A flow refused before it spawns anything is still a flow.
_Avoid_: job, session

**Flow tree**:
A flow plus any flows its children start. Budget accounting is per flow: every flow in the tree charges only its own budget, so no ceiling spans the tree.
_Avoid_: flow graph, nested run

**Mode**:
The coordination pattern a flow uses (single, parallel, evaluate, debate, …).
_Avoid_: workflow (that names one specific mode), strategy

**Preset**:
A named, discoverable workflow template that expands an intent and task into one
ordinary mode call before validation. A preset is data, not a mode, and cannot
bypass the expanded mode's budgets or trust checks.
_Avoid_: workflow (that names one mode), macro

**Parent**:
The pi session that delegates work and makes the final decision.
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

**Wave**:
The set of roles a mode spawns concurrently at one step of its topology. A wave is the planned concurrent set; a stage is the recorded span that step becomes in the trace.
_Avoid_: batch, group

**Task**:
The bounded unit of work text handed to a child.
_Avoid_: prompt, job

**Subtask**:
A task produced by orchestrate's decomposition rather than authored upstream. A subtask is a kind of task.

**Run**:
One child executing one task. A flow contains zero or more runs: a refused flow has none, and a `single` flow has exactly one without the two becoming the same thing.
_Avoid_: execution, invocation

**Live**:
A flow whose handler has not settled and may still spawn runs. Not the same question as whether any run is outstanding: a multi-stage mode settles every run of one stage before opening the next, so a live flow can hold at `N/N settled`.
_Avoid_: active, in-flight, running

**Settled**:
A run (or a whole flow) that has reached a terminal state, whether it completed or failed. The opposite of live.
_Avoid_: done, finished (both read as "succeeded")

**Replay**:
The parent re-issuing a flow after it failed. Distinct from a retry, which happens inside a flow against one run. A bounded refusal — budget exhausted, gate failed — is not a signal to replay unchanged.
_Avoid_: retry, rerun

**Fleet**:
Every live flow at once, each with the runs under it. Keyed by flow, because liveness is a property of the flow's handler, not of any one run.
_Avoid_: dashboard, active agents (runs execute; agents are profiles)

### Contracts and handoffs

**Delegation contract**:
A machine-checked task definition that binds a child's objective, authority, contract budget, acceptance checks, and required return shape.
_Avoid_: typed contract, task contract

**Resolved contract**:
A delegation contract admitted to the transition path: shape-validated, its return schema compiled, and its identity digested, all at construction. Task rendering, contract budgets, and return validation accept only this form.
_Avoid_: validated contract, compiled contract

**Return requirements**:
Prompt-enforced instructions that constrain a child's returned shape or evidence without creating a machine-checked delegation contract.
_Avoid_: return contract

**Return envelope**:
A structured child result bound to the delegation contract under which it was produced.
_Avoid_: response object, result contract

**Handoff**:
The prepared value that crosses from one role to another after applicable validation, redaction, and policy handling. A child's output is not a handoff until another role consumes it.
_Avoid_: child output, inter-agent prompt

**Handoff envelope**:
The provenance-bearing form in which a handoff is carried. It preserves a return envelope's delegation-contract identity or explicitly identifies a legacy prose result.
_Avoid_: return envelope (that is the child's result before it crosses a role boundary)

**Handoff policy**:
What happens when a handoff's injection scan flags content — `warn`, `quarantine`, or `fail`. Resolved once per flow from the call's setting and any per-mode floor; the stronger of the two wins.
_Avoid_: injection policy, scan mode

**Compositional injection**:
Injection-shaped instructions that emerge only when handoffs are read together, with no single handoff flagged on its own. Named separately because a per-handoff scan cannot see it.
_Avoid_: multi-hop attack, chained injection

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

**Execution success**:
A run or flow settled without a process or coordination failure. It does not establish that the requested outcome was correct.
_Avoid_: task success, verified success

**Verified outcome success**:
Independent verification established that a flow's requested outcome met its acceptance criteria. It is unavailable when no verifier assessed the outcome.
_Avoid_: execution success, completion

**Flow card**:
The durable summary of one settled flow — status, per-run outcomes, spend, and evidence pointer — that outlives any live view of it.
_Avoid_: run-card (it summarizes a flow, not a run)

### Guardrails and selection

**Gate**:
A deterministic, machine-evaluated pass/fail check that blocks progress — a check command, a workflow phase gate, the spawn gate. Never a human decision.
_Avoid_: check, approval

**Spawn gate**:
The gate that refuses a spawning call before any child starts when the delegation carries no justification. Surfaces that answer without spawning sit outside it.
_Avoid_: why check, delegation justification (as the gate's name)

**Admissibility**:
Whether the tool itself would admit a call rather than refuse it before any child spawns. Judged with the same predicates the tool enforces, so a scored rule cannot drift from the enforced one.
_Avoid_: validity, eligibility

**Mirror**:
A spawn-free re-derivation of a handler's pre-spawn decision, used to answer admissibility without running the flow. A mirror stays silent wherever the tool would refuse first for a different reason, so a refusal is never mislabeled.
_Avoid_: simulation, dry run

**Checkpoint**:
A human approval point in a flow, before spawning or before finalizing. A checkpoint is not a gate.
_Avoid_: approval gate, human gate

**Approval receipt**:
A durable, expiring, single-use record that binds one human approval to the exact workflow action and conditions it authorizes.
_Avoid_: approval marker, checkpoint receipt

**Approval authorization**:
The capability to spend an approval receipt, produced only by verifying the receipt against the action about to run and bound to that action. Consuming without verifying is not a call order that exists.
_Avoid_: verified receipt, consumption token

**Flow budget**:
A machine-enforced cost or token ceiling shared by every run in one flow.
_Avoid_: quota, allowance

**Contract budget**:
A machine-enforced time, cost, or token ceiling scoped to the runs fulfilling one delegation contract, independent of the flow budget.
_Avoid_: quota, allowance

**Budget ceiling**:
One configured cost or token limit, disclosed before work starts rather than discovered when it binds.
_Avoid_: cap, limit

**Budget authority**:
Which budget a ceiling belongs to — flow or contract. Carried wherever a ceiling is shown or a refusal is reported, so a refusal is never attributed to a budget the run never had.
_Avoid_: budget owner, budget scope

**Capture policy**:
The pair of switches that decide what child content may appear in returned content, details, and spans. It governs disclosure, not execution: a redacted span is still a recorded span.
_Avoid_: redaction settings, privacy mode

**Tier**:
A portable capability level (fast, capable, deep) that resolves to a concrete model per install.
_Avoid_: model class, size

**Roster**:
The concrete model and thinking level each tier resolves to on one install, derived by ranking the models that install can actually run. Derived rather than configured, so tiers mean something with no setup; overridable per tier in `pi-flows.json`. Distinct from the fleet panel, which shows running children, not models.
_Avoid_: fleet, model map, tier mapping

**Thinking level**:
The reasoning effort one child runs at, lowered to what its model supports. Reported as what the child ran at, never as what was requested.
_Avoid_: effort, reasoning budget

**Reflexion**:
Locally persisted cross-run lessons that future flows can read.
_Avoid_: memory, learning
