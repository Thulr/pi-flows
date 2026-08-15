# pi-flows

pi-flows lets a parent pi session delegate bounded work to disposable children and get compact findings back, instead of doing everything in one long-running context.

The value is not the spawning — anything can spawn a subprocess. It is that what comes back is **checkable**: a finding arrives bound to the contract it was produced under, carrying its own evidence, provenance, and cost, so the parent can act on it without re-reading the transcript that produced it.

## Where the modeling goes

Not every part of this repo earns the same depth. This split says where to spend design effort and review attention, and where deliberately not to. Revisit it when the differentiator moves.

`scripts/domain-score.mjs` enforces this split — every module below is checked for placement and for which subdomains it may import from — so the classification cannot quietly go stale as modules are added.

**Core — coordination under guardrails.** Delegation contracts and their identity, return and handoff envelopes, injection policy, artifact digests, approval receipts, budget authority, capture policy, and the coordination evidence that shows what actually happened. This is the part that makes a returned finding checkable rather than merely plausible. Model it deeply, give every new concept a glossary entry below, and expect changes here to come with a test that names the invariant and, where it is a coordination failure, a fault-scenario entry.
_Modules_: `flow.ts`, `run.ts`, `settle.ts`, `delegation.ts`, `handoff.ts`, `handoff-types.ts`, `handoff-consumption.ts`, `approval.ts`, `agent-profile.ts`, `budget.ts`, `integration.ts`, `contract-resolution.ts`, `validate.ts`, `validate-workflow.ts`, `bash-readonly.ts`, `sanitize.ts`, `trace.ts`, `trace-scope.ts`, `trace-sink.ts`, `trace-verify.ts`, `trace-attributes.ts`, `trace-structure.ts`, `trace-report.ts`, `trace-identity.mjs`.

**Supporting — coordination patterns and the views onto them.** The modes and their topologies, preset and agent discovery, reflexion, and the live/settled surfaces (inspector, flow card, live board). Necessary, and often the reason someone reaches for the tool, but they recombine the core's primitives rather than being the differentiator. Build them plainly and resist per-mode special cases a new mode would have to re-implement; the views must speak the glossary's terms but hold no invariants of their own.
_Modules_: `modes/*`, `presets.ts`, `preset-review.ts`, `preset-catalog.ts`, `preset-approval.ts`, `agents.ts`, `agent-catalog.ts`, `reflexion.ts`, `budget-disclosure.ts`, `ui.ts`, `ui-style.ts`, `ui-gantt.ts`, `ui-live-row.ts`, `ui-flow-card.ts`, `inspector.ts`.

**Generic — plumbing and adapters.** Child-process transport, the anti-corruption layer over a child pi run, fan-out plumbing, param schema and arithmetic, command execution, text parsing. Keep thin, keep replaceable, do not model. `runner.ts` and `jsonl-child.mjs` are where a foreign protocol is allowed to be spoken; everything above them should see domain types only.
_Modules_: `runner.ts`, `runner-budget.ts`, `child-model.ts`, `provider-failure.ts`, `dispatch.ts`, `jsonl-child.mjs`, `schema.ts`, `commands.ts`, `parse.ts`, `png.ts`, `protocol.ts`, `topology.ts`, `model-roster.ts`, `roster-config.ts`, `roster-source.ts`, `bash-readonly-extension.ts`, `bash-readonly-sandbox.ts`, `wrapup.ts`.

**Shared kernel.** `types.ts` — the vocabulary every subdomain imports, re-exported from the concept modules that own each term. A change here ripples everywhere and nothing above owns it, so keep it declarative: a rule that belongs to one concept belongs in that concept's module (see `budget.ts`), not here. `roster-types.ts` is vocabulary of the same kind, held apart only because the kernel may not import the Generic module that derives a roster.
_Modules_: `types.ts`, `roster-types.ts`, `preset-types.ts`.

**Composition root.** `index.ts` — registers the tool and command and wires every subdomain together, so it alone may import from all of them. Flow-level ordering does not live here: the `Flow` aggregate (`flow.ts`) owns the lifecycle, and `execute()` only adapts pi's context into the aggregate's ports. A new ordering rule belongs in the aggregate; a positional rule reappearing in `execute()` is the smell this split exists to catch.
_Modules_: `index.ts`.

The enforced direction is narrow on purpose: **Core may not import Supporting**, and the shared kernel may import only Core. Core reaching down into Generic plumbing is fine — commodity is there to be used. Core reaching sideways into the modes or the views is not: it would make the differentiator depend on the recombinations of it.

Four placements are worth stating outright, because a first pass tends to put them elsewhere. **Tracing is Core, not reporting**: coordination evidence is what makes a returned finding checkable, which is the whole value proposition above — a flow that cannot show what it did has lost the thing being sold. **Redaction is Core, not plumbing**: `sanitize.ts` implements Capture policy, and what may leave a child is a guardrail, not a formatting concern. **The views are Supporting, not Generic**: they render domain concepts and must speak the glossary's terms, so they are not interchangeable commodity — but they hold no invariants, so they are not Core either. **The shared-write gate's fan-out position is plumbing, not policy**: the rule is Core (`validateSharedWriteCwd` in `validate.ts`); `runWave` in Generic `dispatch.ts` invokes it at the one position that knows the concurrent set, so the fan-out enforces the Core-owned predicate without owning it.

## Language

### Delegation model

**Flow**:
One bounded delegation — a single call of the `flow` tool, covering every child it spawns. A flow is not its runs: it has a mode and a settled outcome of its own, and it is the thing a budget, a root span, and a checkpoint attach to when the call configures them. A flow refused before it spawns anything is still a flow. A flow call's **admission outcome** is exactly one of **Described**, **Refused**, or **Admitted** — Described and Refused are terminal alternatives, and only an Admitted flow owns a mode and a lifecycle of its own, an explicit progression through **Dispatched → Settled** — all owned by the aggregate root in `flow.ts`. A **described** flow answered a describe surface (`list`, `showConfig`) from inside the admission walk: it spawned nothing, never reached mode detection, and is neither refused nor admitted; the walk fixes its precedence (list over showConfig over run modes, before preset expansion).
_Avoid_: job, session

**Admission**:
The ordered walk of every pre-spawn gate that turns a flow call into something dispatchable, owned by the Flow aggregate. Each gate is a supplied predicate or approval object; the order they run in is the aggregate's own. Admission yields exactly one of three outcomes — **Described** (answered a describe surface), **Refused** (stopped by a gate), or **Admitted** (handed a single-use dispatch capability). A call that fails admission is a refused flow; a describing call is neither refused nor admitted and claims no mode. Because the capability is the only way to dispatch, skipping or reordering a gate is not a call sequence that exists.
_Avoid_: validation (that names one kind of gate), pre-flight

**Resolved call**:
What one flow call resolved to after preset expansion — the single copy of the post-preset params, capture policy, and preset selection, constructed and carried by the Flow aggregate. Ports that need post-preset state receive the resolved call (or a value derived from it, like the one details builder) as an argument; a port reading resolved state back through a composition-root closure is the smell this term exists to name.
_Avoid_: expanded params (that names only one field), shared state

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

**Effective Agent profile**:
The selected Agent source plus the execution conditions after Role overrides and flow fallbacks resolve: prompt identity, tools, canonical cwd target and filesystem identity, model, and Thinking level. It is both what durable workflow approval authorizes and what the Child runs as; gated dispatch carries that cwd binding from verification, and the production adapter rechecks it immediately before spawn rather than trusting a path after asynchronous setup. Raw prompt text is execution content; its SHA-256 identity is the approval-safe term.
_Avoid_: authored Agent (that is only the discovered definition), requested profile, executable profile

**Role**:
The slot in a mode's topology that an agent fills (generator, critic, worker, adjudicator).
_Avoid_: position

**Wave**:
The set of roles a mode spawns concurrently at one step of its topology. A wave is the planned concurrent set; a stage is the recorded span that step becomes in the trace. Each mode declares its pre-spawn waves once as its plan (`modes/plan.ts` vocabulary, a `plan` member on the mode table beside the handler); requested agents, the shared-write admissibility mirror, and budget disclosure read that declaration rather than re-deriving the topology by hand.
_Avoid_: batch, group

**Task**:
The bounded unit of work text handed to a child.
_Avoid_: prompt, job

**Subtask**:
A task produced by orchestrate's decomposition rather than authored upstream. A subtask is a kind of task.

**Run**:
One child executing one task. A flow contains zero or more runs: a refused flow has none, and a `single` flow has exactly one without the two becoming the same thing. The run object (`run.ts`) owns its result's lifecycle: an envelope candidate is retained and consumed exactly once, and an envelope or handoff attaches to a result only through the run's own transitions.
_Avoid_: execution, invocation

**Run state**:
Which of four states a run is in — `queued`, `running`, `completed`, `failed` — derived in one place (`runState` in `run.ts`) from the fields that carry the answer. Every surface renders that derivation rather than reading the result's fields itself: the state is the run's, not the view's. Structural over every shape a run takes, and reading its error under both names those shapes use (`error`, `errorCode`), because a predicate that knew only one of them is how the live row, the flow card, and the timeline came to disagree about a single run. `running` names one run's state here and is the deliberate carve-out from the Live entry's Avoid list, which governs how a *flow*'s liveness is described.
_Avoid_: status (that names a flow's outcome on the card), outcome

**Live**:
A flow whose handler has not settled and may still spawn runs. Not the same question as whether any run is outstanding: a multi-stage mode settles every run of one stage before opening the next, so a live flow can hold at `N/N settled`.
_Avoid_: active, in-flight, running

**Settled**:
A run (or a whole flow) that has reached a terminal state, whether it completed or failed. The opposite of live. For a run the question is `runSettled` (`run.ts`), which is the one place that knows an exit code of `-1` also means "no child has exited yet"; `runFailed` answers it first, so an outstanding child reads as unfinished rather than failed. The liveness-unaware primitive `isFailed` (`sanitize.ts`) is what a mode handler wants about a run it just settled, and is deliberately wrong about a live one.
_Avoid_: done, finished (both read as "succeeded")

**Settle** (as an object):
The per-invocation object (`settle.ts`) a mode handler finishes through. It holds the mode identity, fixed from the registry row at construction, and every run tracked so far; its refuse/complete outputs are the only outputs a handler returns, so an error output that drops already-spent runs is not a value a handler can build. Its two decorators are the extension points workflow and worktree use: workflow decorates details with its approval receipts (`decorateDetails`), and worktree registers its integration-branch recovery pointer once as the refusal footer (`decorateFooter`), so a refusal written later cannot lose the pointer — which is how two shipped. `refuse` also owns the model-visible cap over the formatted error and per-call footer together (the registered pointer rides after the cap under a small allowance of its own, so truncation cannot swallow it and the refusal stays bounded regardless of what a mode registers); a mode capping its own refusal text and slicing the formatted prefix back off is the duplication this ended.
_Avoid_: output builder, result collector

**Replay**:
The parent re-issuing a flow after it failed. Distinct from a retry, which happens inside a flow against one run. A bounded refusal — budget exhausted, gate failed — is not a signal to replay unchanged.
_Avoid_: retry, rerun

### Contracts and handoffs

**Delegation contract**:
A machine-checked task definition that binds a child's objective, authority, contract budget, acceptance checks, and required return shape.
_Avoid_: typed contract, task contract

**Resolved contract**:
A delegation contract admitted to the transition path: shape-validated, its return schema compiled, and its identity digested, all at construction. Task rendering, contract budgets, and return validation accept only this form. A contracted Role cannot spawn or steer coordination without it: its admitted plan is an unforgeable single-use capability bound to the flow that created it, and only a Result that plan dispatched can be consumed through it.
_Avoid_: validated contract, compiled contract

**Integration control**:
The input from a settled Run in a Role that may steer coordination: either schema-checked data from its accepted return envelope or explicitly legacy prose from an uncontracted Role. The two forms remain distinct so validated strings cannot re-enter marker parsing and unvalidated prose cannot masquerade as contract data.
_Avoid_: control value, parsed output, ambiguous string

**Return requirements**:
Prompt-enforced instructions that constrain a child's returned shape or evidence without creating a machine-checked delegation contract.
_Avoid_: return contract

**Return envelope**:
A structured child result bound to the delegation contract under which it was produced.
_Avoid_: response object, result contract

**Rejected envelope**:
A structurally valid envelope that failed contract validation — its identity did not bind, its artifacts were uncontained or did not match their digests, or its `data` did not satisfy the return schema. It is never a handoff and never reaches `result.envelope`, but it is retained as trace evidence of what the spend produced: a digest mismatch's artifact claim is the record of the corruption. Not a kind of return envelope — the term above asserts a binding a rejected envelope may not have.
_Avoid_: invalid envelope, failed envelope (both read as "discard it")

**Unvalidated claims**:
The claims a rejected envelope still carries, surfaced to the parent labeled as unverified and never counted toward a verdict. Available from exactly one rejection: attribution and integrity held — the envelope binds to the dispatched contract, its artifact references stay inside the child cwd, and any digests it declared match — and only conformance failed. An envelope whose identity was stale, or whose artifacts escaped the cwd or failed a digest it declared, has no unvalidated claims — it is untrustworthy, not merely unchecked — which is why the three checks are ordered attribution, integrity, conformance, and why that order is an invariant rather than an implementation detail.
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
A coordination event recorded by the seam that performs the action instead of by the mode that requested it — the runner's child spans, the handoff consumer's handoff/validation/artifact events, the aggregate's `mode.approval` decision, the deterministic gate runner's outcome (`runCheckCommand`), receipt issuance's approval (`issueApprovalReceipt`). The caller supplies an `EventAttribution` — the event's name in its own vocabulary, its span placement, its own facts, and the recorder or its stated absence — and the seam's kind and outcome merge last through the one assembly home (`mintEvent`, trace-scope.ts), so attribution cannot override what happened. Performing the action and stating where its evidence lands are one call: a handler cannot silently omit the event, though it can still state absence (`record: undefined`) — deliberately weaker than the child-span model, where no such statement exists, because a stated absence is reviewable where a missing call was invisible. A mode's own decisions — its state transitions, retries, and the verdicts its controllers parse from child output — have no shared seam performing them and stay hand-placed in the handler; that boundary is deliberate, and the mode's **Owed event kinds** declaration now bounds it (#128, then #133): a minted row carries `flow.event_minted`, which is how the read-back tells the seams' statements from the mode's own hand. Minting is a capability, not a field a caller may claim — a seam records through `RecordMintedEvent`, whose event form requires the mark, while a mode's `RecordEvent` has no such member and is not a port the minting recorder can be wired to — because that mark is exactly the exemption the declaration exists to catch a handler taking.
_Avoid_: framework event, auto-event

**Owed event kinds**:
The coordination-event kinds a mode's handler itself records — state transitions, retries, the verdicts its controllers parse — declared once beside its handler as an `owedEventKinds` member on the mode table, like `plan`, `criticalPath`, and `preSpawnRefusal`; `noOwedEvents` is the declared answer for a mode that records none. A declaration cannot promise a count — whether a retry fires is runtime-dependent — but it bounds what a trace of the mode may contain: the sink stamps it on the root as `flow.trace.owed_event_kinds` (an empty value is a declaration of none; absence is a pre-declaration writer, exempt), and the read-back refuses an unminted event of an undeclared kind in the same forged-surplus direction the strict gate already refuses. Seam-minted events (**Minted event**) are the seam's own statement, marked `flow.event_minted`, and exempt — the declaration bounds the mode's own hand, not the seams'.
_Avoid_: expected events (Trace health's expectation is the writer's attempted count; this is neither a count nor the writer's), owed spans

**Trace health**:
How complete a flow's exported evidence is (`recorded`, `degraded`, `missing`), counted as expected vs observed spans. Reported separately from execution success: a run whose spans were dropped is unauditable, not failed. Strictly a *writer's* count — what the sink attempted against what reached the file — so it is answered while writing and cannot see anything that is only visible on reading the file back.
_Avoid_: trace status, telemetry health

**Trace structure**:
Whether an exported trace is a span tree at all — a root that reaches itself, every span inside its parent's interval, no duplicate ids, no surplus rows, no unminted event of a kind outside the root's declared **Owed event kinds**. A second question from **Trace health**, deliberately not folded into it: a file can be written completely and still be unreadable as a tree, and reporting either answer as the other is how a strict run would certify evidence nothing checked. Answered only when a caller asks for the export to be read back, which today means a strict run; absent means unverified, never verified-fine.
_Avoid_: trace health (that is the writer's count), trace validity

**Invocation id**:
The random discriminator one sink call stamps on every row it writes (`flow.invocation_id`). Deliberately not part of the trace identity: the trace and root-span ids are derived stably from the trace context and mode so an eval row and its runtime trace correlate, which means a traced refusal and the retry after it share them — so every reading (the strict read-back, the report) judges an invocation only on the rows carrying its own stamp. "Invocation" here is the deliberate carve-out from the Run entry's Avoid list: that list rejects it as a synonym for one child run, and this term names one sink call — a whole flow call's export — which no Run-adjacent word says.
_Avoid_: trace id (that is the stable eval linkage), attempt (that is part of the stable identity)

**Record extent**:
Where one invocation's record begins in a shared, append-only trace file — the file's size the moment its sink was born, before any of its rows could exist. The strict read-back reads only from there (#129): earlier bytes predate the invocation and cannot honestly carry its just-minted **Invocation id**, so a stampless remainder among them is a predecessor's record, judged by whole-file readers (the report) rather than by the live gate — the same way rows appended after finalize always were. Everything a concurrent writer lands after the sink exists falls inside the extent and is judged as before. Races can only under-estimate the boundary (appends grow the file), which reads extra foreign rows, never fewer own rows.
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
A deterministic, machine-evaluated pass/fail check that blocks progress — a check command, a workflow phase gate, the spawn gate. Never a human decision.
_Avoid_: check, approval

**Spawn gate**:
The gate that refuses a spawning call before any child starts when the delegation carries no justification. Surfaces that answer without spawning sit outside it.
_Avoid_: why check, delegation justification (as the gate's name)

**Admissibility**:
Whether the tool itself would admit a call rather than refuse it before any child spawns. Judged with the same predicates the tool enforces, so a scored rule cannot drift from the enforced one.
_Avoid_: validity, eligibility

**Mirror**:
A spawn-free re-derivation of a handler's pre-spawn decision, used to answer admissibility without running the flow. A mirror stays silent wherever the tool would refuse first for a different reason, so a refusal is never mislabeled. A mirror is a second derivation of a rule and must be kept in agreement with the first; prefer a **pre-spawn refusal** declaration, which removes the second copy entirely. Where a consolidation has already removed the second copy, the `SPELLED_ONCE` ledger (`scripts/domain-spelled-once.mjs`, enforced by `scripts/domain-score.mjs`) holds the concept to its one home so a mirror cannot quietly grow back.
_Avoid_: simulation, dry run

**Mode pre-spawn refusal**:
What one mode refuses before any of its children spawn, declared beside its handler as a `preSpawnRefusal` member on the mode table. The handler reaches the same rule through the same function — its declaration, or the shared predicate that declaration composes where part of the rule turns on context the declaration is given rather than reads — so the declared rule and the enforced one are never a rule plus a mirror of it. What a mode can only discover mid-run — a probe that fails to start, a cycle stranding only later waves — is not one of these and stays in the handler.
_Avoid_: the bare "pre-spawn refusal" (that covers any refusal before spawning, an Admission gate's or a Budget's included), pre-spawn declaration, pre-flight check, guard (that names the shared-write gate)

**Checkpoint**:
A human approval point in a flow, before spawning or before finalizing. A checkpoint is not a gate.
_Avoid_: approval gate, human gate

**Read-only bash (`bash-ro`)**:
A toolset token granting a child bash that cannot write the reviewed checkout, never requested by prompt. Enforced in two layers: the OS read-only-checkout sandbox (`bash-readonly-sandbox.ts`, macOS `sandbox-exec` denying writes under cwd — the security boundary) and an in-child command allowlist (`bash-readonly.ts` predicate loaded via `bash-readonly-extension.ts`) as defense-in-depth and the fallback where the sandbox is absent. Classified not write-capable for the shared-write guard, and refused (`BASH_READONLY_UNENFORCEABLE`) only when neither layer is available. Coordination safety against ad-hoc mutations of a shared checkout.
_Avoid_: safe bash (the sandbox is real, but the allowlist fallback is best-effort)

**Approval receipt**:
A durable, expiring, single-use record that binds one human approval to the exact workflow action and conditions it authorizes, including every gated Role's **Effective Agent profile** and a gated debrief's profile. A receipt persists only binding identity and status, never raw prompt or parameter content.

**Historical Thinking witness**:
A one-time effective Thinking value supplied only to bound v3 receipt migration when automatic model-clamp reconstruction would exceed its work limit. It is evidence, not a dispatch setting: only a value that reproduces the intact spent receipt's binding digest is accepted.
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
The steer a budget delivers at 80% of a ceiling it would stop a live run for — to every live child governed by that ceiling the moment any child's settled turn crosses it, and at spawn to a child joining a ceiling already inside the window: stop working and emit the return envelope now, recording unfinished work as skipped coverage and unresolved questions. Owned by the budget — the notice must name the authority and spend of the ceiling about to bind — and delivered over the file channel in `wrapup.ts`. Requesting is not receiving: only a notice seen echoed back into the child session counts as delivered. A ceiling crossed after a delivered notice settles the run gracefully (`budget_wrap_up`) instead of forfeiting it; a ceiling crossed before any notice could be delivered keeps the hard stop.
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
