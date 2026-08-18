# pi-flows

pi-flows lets a parent pi session delegate bounded work to disposable children and get compact findings back, instead of doing everything in one long-running context.

The value is not the spawning — anything can spawn a subprocess. It is that what comes back states its own assurance. An ordinary Result is the Child's account and claims nothing more. Under a delegation contract, a finding arrives **checkable**: bound to the contract it was produced under, its artifacts digest-checked, its shape schema-checked, carrying its own evidence, provenance, and cost. The parent can act on a checkable finding without re-reading the transcript that produced it. Checkable is not verified: only an independent verifier can establish that a finding is true.

This document is the project's domain glossary: the canonical terms, each with a concise definition and the synonyms it deliberately avoids. Which subdomain each module belongs to, and the import direction between subdomains, is the [architecture classification](./docs/reference/architecture.md); the reasoning behind that split is the [domain model](./docs/explanation/domain-model.md).

## Language

### Delegation model

**Flow**:
One bounded delegation — a single call of the `flow` tool, covering every child it spawns. A flow is not its runs: it has a mode and a settled outcome of its own, and it is the thing a budget, a root span, and a checkpoint attach to when the call configures them. A flow refused before it spawns anything is still a flow. A flow call's **admission outcome** is exactly one of **Described**, **Refused**, or **Admitted** — Described and Refused are terminal alternatives, and only an Admitted flow owns a mode and a lifecycle of its own, an explicit progression through **Dispatched → Settled**. A **described** flow answered a describe surface (`list`, `showConfig`) from inside the admission walk: it spawned nothing, never reached mode detection, and is neither refused nor admitted; the walk fixes their precedence.
_Avoid_: job, session

**Admission**:
The ordered walk of every pre-spawn gate that turns a flow call into something dispatchable. Each gate is a supplied predicate or approval object; the order they run in is fixed. Admission yields exactly one of three outcomes — **Described** (answered a describe surface), **Refused** (stopped by a gate), or **Admitted** (handed a single-use dispatch capability). A call that fails admission is a refused flow; a describing call is neither refused nor admitted and claims no mode. Because the capability is the only way to dispatch, skipping or reordering a gate is not a call sequence that exists.
_Avoid_: validation (that names one kind of gate), pre-flight

**Resolved call**:
What one flow call resolved to after preset expansion — the single copy of the post-preset params, capture policy, and preset selection. Ports that need post-preset state receive the resolved call (or a value derived from it, like the one details builder) as an argument; a port reading resolved state back through a shared closure is the smell this term exists to name.
_Avoid_: expanded params (that names only one field), shared state

**Flow tree**:
A flow plus any flows its children start. Budget accounting is per flow: every flow in the tree charges only its own budget, so no ceiling spans the tree.
_Avoid_: flow graph, nested run

**Mode**:
The coordination pattern a flow uses (single, parallel, evaluate, debate, …).
_Avoid_: workflow (that names one specific mode), strategy

**Preset**:
A named, discoverable workflow template that expands an intent and task into one ordinary mode call before validation. A preset is data, not a mode, and cannot bypass the expanded mode's budgets or trust checks.
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

**Effective Agent profile**:
The selected Agent source plus the execution conditions after Role overrides and flow fallbacks resolve: prompt identity, tools, canonical cwd, model, and Thinking level. It is both what durable workflow approval authorizes and what the Child runs as. Raw prompt text is execution content; its digest identity is the approval-safe term.
_Avoid_: authored Agent (that is only the discovered definition), requested profile, executable profile

**Role**:
The slot in a mode's topology that an agent fills (generator, critic, worker, adjudicator).
_Avoid_: position

**Wave**:
The set of roles a mode spawns concurrently at one step of its topology. A wave is the planned concurrent set; a stage is the recorded span that step becomes in the trace. Each mode declares its pre-spawn waves once as its plan, which requested agents, shared-write admissibility, and budget disclosure read rather than re-deriving the topology by hand.
_Avoid_: batch, group

**Task**:
The bounded unit of work text handed to a child.
_Avoid_: prompt, job

**Subtask**:
A task produced by a Decomposition rather than authored upstream. A subtask is a kind of task, and it may depend on other subtasks of the same Decomposition.
_Avoid_: node (that names graph mode's author-supplied unit), planned unit

**Decomposition**:
The breakdown a commander returns for a goal — subtasks, plus any dependency edges between them — validated before any worker spawns. A flat subtask list is a Decomposition with no edges. Deliberately not a "plan": that word names a mode's declared pre-spawn waves and the admitted dispatch capability.
_Avoid_: plan, work breakdown, task graph (that reads as graph mode's author-supplied DAG)

**Decomposition review**:
An optional pre-dispatch judgment that a Decomposition covers its goal with suitably bounded, non-overlapping subtasks and necessary dependency edges. If the caller requests Decomposition review, the review must pass before workers can run.
_Avoid_: plan review, validation (that names deterministic structural admission), verification (that judges the synthesized outcome)

**Run**:
One child executing one task. A flow contains zero or more runs: a refused flow has none, and a `single` flow has exactly one without the two becoming the same thing. The run object owns its result's lifecycle: an envelope candidate is retained and consumed exactly once, and an envelope or handoff attaches to a result only through the run's own transitions.
_Avoid_: execution, invocation

**Run state**:
Which of four states a run is in — `queued`, `running`, `completed`, `failed` — derived in one place from the fields that carry the answer. Every surface renders that derivation rather than reading the result's fields itself: the state is the run's, not the view's, and it is read under both names a result's error takes so no surface can disagree with another about a single run. `running` names one run's state here and is the deliberate carve-out from the Live entry's Avoid list, which governs how a *flow*'s liveness is described.
_Avoid_: status (that names a flow's outcome on the card), outcome

**Live**:
A flow whose handler has not settled and may still spawn runs. Not the same question as whether any run is outstanding: a multi-stage mode settles every run of one stage before opening the next, so a live flow can hold at `N/N settled`.
_Avoid_: active, in-flight, running

**Settled**:
A run (or a whole flow) that has reached a terminal state, whether it completed or failed. The opposite of live. The question has one home, which knows an outstanding child reads as unfinished rather than failed; the liveness-unaware check is what a mode handler wants about a run it just settled, and is deliberately wrong about a live one.
_Avoid_: done, finished (both read as "succeeded")

**Settle** (as an object):
The per-invocation object a mode handler finishes through. It holds the mode identity and every run tracked so far; its refuse/complete outputs are the only outputs a handler returns, so an error output that drops already-spent runs is not a value a handler can build. Its decorators are the extension points the modes use to attach details and a refusal footer without subclassing.
_Avoid_: output builder, result collector

**Replay**:
The parent re-issuing a flow after it failed. Distinct from a retry, which happens inside a flow against one run. A bounded refusal — budget exhausted, gate failed — is not a signal to replay unchanged.
_Avoid_: retry, rerun

### Contracts and handoffs

**Ordinary Result**:
What an uncontracted Run reports back — the Child's own account of its work, settled and sanitized, with no machine contract assurance. The harness still judges its Execution success; every claim inside its content stays the Child's assertion. Return requirements can shape it, but shaping is prompting, not checking.
_Avoid_: unverified Return (it is not a Return at all), raw output (sanitization still applies)

**Delegation contract**:
A machine-checked task definition that binds a child's objective, authority, contract budget, acceptance checks, and required return shape.
_Avoid_: typed contract, task contract

**Resolved contract**:
A delegation contract admitted to the transition path: shape-validated, its return schema compiled, and its identity digested. Task rendering, contract budgets, and return validation accept only this form. A contracted Role cannot spawn or steer coordination without it.
_Avoid_: validated contract, compiled contract

**Integration control**:
The input from a settled Run in a Role that may steer coordination: either schema-checked data from its accepted return envelope or explicitly legacy prose from an uncontracted Role. The two forms remain distinct so validated strings cannot re-enter marker parsing and unvalidated prose cannot masquerade as contract data.
_Avoid_: control value, parsed output, ambiguous string

**Return requirements**:
Prompt-enforced instructions that constrain a child's returned shape or evidence without creating a machine-checked delegation contract.
_Avoid_: return contract

**Return candidate**:
Untrusted child output that is structurally a return envelope, offered for contract validation. Its contract identity may be missing or stale, and the candidate keeps that identity as parsed so a rejection stays diagnosable. A candidate is never a return envelope: only validation makes one, and malformed output is not even a candidate.
_Avoid_: unvalidated envelope, envelope candidate (that is the bounded final-message text a candidate is parsed from)

**Return envelope**:
A child return that passed attribution, integrity, and conformance under a resolved delegation contract. Only the validation transition constructs or attaches one, so it always carries the exact resolved contract identity. What it carries is the Contract-bound Return assurance, no more.
_Avoid_: response object, result contract, candidate (that is the pre-validation form)

**Contract-bound Return**:
The assurance a validated Return envelope carries: attribution to the exact resolved delegation contract, integrity of the artifacts whose digests it declared, and conformance of its `data` to the Return schema. It proves how the Return was produced and shaped — never that its claims are true or that prose acceptance checks were satisfied. Truth is a separate assurance only Verified outcome success grants.
_Avoid_: verified Return (verification is an independent verifier's act), machine-checked findings (the shape is checked, the findings are not)

**Rejected Return candidate**:
A Return candidate that failed contract validation — its identity did not bind, its artifacts were uncontained or did not match their digests, or its `data` did not satisfy the return schema. It is never a handoff and never reaches `result.envelope`, but it is retained as trace evidence of what the spend produced: a digest mismatch's artifact claim is the record of the corruption. Not a kind of return envelope — that term asserts a binding a rejected candidate may not have.
_Avoid_: rejected envelope (asserts the binding the rejection refused), invalid envelope, failed envelope (both read as "discard it")

**Unvalidated claims**:
The claims a rejected Return candidate still carries, surfaced to the parent labeled as unverified and never counted toward a verdict. Available from exactly one rejection: attribution and integrity held — the candidate binds to the dispatched contract, its artifact references stay inside the child cwd, and any digests it declared match — and only conformance failed. A candidate whose identity was stale, or whose artifacts escaped the cwd or failed a digest it declared, has no unvalidated claims — it is untrustworthy, not merely unchecked — which is why the three checks are ordered attribution, integrity, conformance, and why that order is an invariant rather than an implementation detail.
_Avoid_: salvaged findings, partial results (that names an envelope status), unverified evidence

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

**Minted event**:
A coordination event recorded by the seam that performs the action instead of by the mode that requested it — the runner's child spans, the handoff consumer's events, the aggregate's approval decision, the deterministic gate's outcome, receipt issuance. The caller supplies an attribution — the event's name, placement, and facts — and the seam's kind and outcome merge last, so attribution cannot override what happened. Recording through the seam is a capability a mode handler does not have; a mode's own decisions — its state transitions, retries, and parsed verdicts — stay hand-placed and are the separate remainder the **Owed event kinds** declaration bounds.
_Avoid_: framework event, auto-event

**Owed event kinds**:
The coordination-event kinds a mode's handler itself records — state transitions, retries, the verdicts its controllers parse — declared once beside its handler. A declaration cannot promise a count — whether a retry fires is runtime-dependent — but it bounds what a trace of the mode may contain: a mode that records none declares so, and a read-back refuses an unminted event of an undeclared kind. Seam-minted events (**Minted event**) are the seams' own statements and exempt — the declaration bounds the mode's own hand, not the seams'.
_Avoid_: expected events (Trace health's expectation is the writer's attempted count; this is neither a count nor the writer's), owed spans

**Trace health**:
How complete a flow's exported evidence is (`recorded`, `degraded`, `missing`), counted as expected vs observed spans. Reported separately from execution success: a run whose spans were dropped is unauditable, not failed. Strictly a *writer's* count — what the sink attempted against what reached the file — so it is answered while writing and cannot see anything that is only visible on reading the file back.
_Avoid_: trace status, telemetry health

**Trace structure**:
Whether an exported trace is a span tree at all — a root that reaches itself, every span inside its parent's interval, no duplicate ids, no surplus rows, no unminted event of a kind outside the root's declared **Owed event kinds**. A second question from **Trace health**, deliberately not folded into it: a file can be written completely and still be unreadable as a tree, and reporting either answer as the other is how a strict run would certify evidence nothing checked. Answered only when a caller asks for the export to be read back; absent means unverified, never verified-fine.
_Avoid_: trace health (that is the writer's count), trace validity

**Invocation id**:
The random discriminator one sink call stamps on every row it writes. Deliberately not part of the trace identity: the trace and root-span ids are derived stably from the trace context and mode so an eval row and its runtime trace correlate, which means a traced refusal and the retry after it share them — so every reading judges an invocation only on the rows carrying its own stamp. "Invocation" here is the deliberate carve-out from the Run entry's Avoid list: that list rejects it as a synonym for one child run, and this term names one sink call — a whole flow call's export — which no Run-adjacent word says.
_Avoid_: trace id (that is the stable eval linkage), attempt (that is part of the stable identity)

**Record extent**:
Where one invocation's record begins in a shared, append-only trace file — the file's size the moment its sink was born, before any of its rows could exist. The strict read-back reads only from there: earlier bytes predate the invocation and cannot honestly carry its just-minted **Invocation id**, so a stampless remainder among them is a predecessor's record, judged by whole-file readers rather than by the live gate. Everything a concurrent writer lands after the sink exists falls inside the extent and is judged as before. Races can only under-estimate the boundary, which reads extra foreign rows, never fewer own rows.
_Avoid_: offset (a byte position claims no ownership), byte range

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
A deterministic, machine-evaluated pass/fail check that blocks progress — a check command, a workflow phase gate, the spawn gate. Never a human decision. An outcome that passed one is **gate-checked**, which asserts only what the gate's command checked.
_Avoid_: check, approval

**Spawn gate**:
The gate that refuses a spawning call before any child starts when the delegation carries no justification. Surfaces that answer without spawning sit outside it.
_Avoid_: why check, delegation justification (as the gate's name)

**Admissibility**:
Whether the tool itself would admit a call rather than refuse it before any child spawns. Judged with the same predicates the tool enforces, so a scored rule cannot drift from the enforced one.
_Avoid_: validity, eligibility

**Mirror**:
A spawn-free re-derivation of a handler's pre-spawn decision, used to answer admissibility without running the flow. A mirror stays silent wherever the tool would refuse first for a different reason, so a refusal is never mislabeled. A mirror is a second derivation of a rule and must be kept in agreement with the first; prefer a **Mode pre-spawn refusal** declaration, which removes the second copy entirely.
_Avoid_: simulation, dry run

**Mode pre-spawn refusal**:
What one mode refuses before any of its children spawn, declared beside its handler. The handler reaches the same rule through the same declaration, so the declared rule and the enforced one are never a rule plus a mirror of it. What a mode can only discover mid-run — a probe that fails to start, a cycle stranding only later waves — is not one of these.
_Avoid_: the bare "pre-spawn refusal" (that covers any refusal before spawning, an Admission gate's or a Budget's included), pre-spawn declaration, pre-flight check, guard (that names the shared-write gate)

**Checkpoint**:
A human approval point in a flow, before spawning or before finalizing. A checkpoint is not a gate.
_Avoid_: approval gate, human gate

**Read-only bash (`bash-ro`)**:
A toolset token granting a child bash that cannot write the reviewed checkout, never requested by prompt. Enforced in two layers: an OS read-only-checkout sandbox (the security boundary) and an in-child command allowlist as defense-in-depth and the fallback where the sandbox is absent. Classified not write-capable for the shared-write guard, and refused only when neither layer is available. Coordination safety against ad-hoc mutations of a shared checkout.
_Avoid_: safe bash (the sandbox is real, but the allowlist fallback is best-effort)

**Workflow digest**:
The content identity of one workflow — its top-level Task, phases in order, and debrief — as the extension's canonical (recursively key-sorted) digest, so authoring order never reads as different work. The persisted state version records which algorithm produced a stored digest; the order-sensitive legacy digest exists only to find and verify state from versions 1–4, never to name new state.
_Avoid_: workflow hash, workflow fingerprint, state file name (the digest names the default file, it is not the file)

**Approval receipt**:
A durable, expiring, single-use record that binds one human approval to the exact workflow action and conditions it authorizes, including every gated Role's **Effective Agent profile** and a gated debrief's profile. A receipt persists only binding identity and status, never raw prompt or parameter content.

**Historical Thinking witness**:
A one-time effective Thinking value supplied only to bound legacy receipt migration when automatic reconstruction would exceed its work limit. It is evidence, not a dispatch setting: only a value that reproduces the intact spent receipt's binding digest is accepted.
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

**Wrap-up notice**:
The steer a budget delivers at 80% of a ceiling it would stop a live run for — to every live child governed by that ceiling the moment any child's settled turn crosses it, and at spawn to a child joining a ceiling already inside the window: stop working and emit the return envelope now, recording unfinished work as skipped coverage and unresolved questions. Owned by the budget — the notice must name the authority and spend of the ceiling about to bind. Requesting is not receiving: only a notice seen echoed back into the child session counts as delivered. A ceiling crossed after a delivered notice settles the run gracefully instead of forfeiting it; a ceiling crossed before any notice could be delivered keeps the hard stop.
_Avoid_: soft limit, warning threshold, grace period

**Capture policy**:
The pair of switches that decide what child content may appear in returned content, details, and spans. It governs disclosure, not execution: a redacted span is still a recorded span.
_Avoid_: redaction settings, privacy mode

**Tier**:
A portable capability level (fast, capable, deep) that resolves to a concrete model per install.
_Avoid_: model class, size

**Roster**:
The concrete model and thinking level each tier resolves to on one install, derived by ranking the models that install can actually run. Derived rather than configured, so tiers mean something with no setup; overridable per tier in `pi-flows.json`. A roster names models, never running children.
_Avoid_: fleet, model map, tier mapping

**Thinking level**:
The reasoning effort one child runs at, lowered to what its model supports. Reported as what the child ran at, never as what was requested.
_Avoid_: effort, reasoning budget

**Reflexion**:
Locally persisted cross-run lessons that future flows can read.
_Avoid_: memory, learning
