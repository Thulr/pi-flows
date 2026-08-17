# Decomposition

This page explains what a Decomposition is, what the flow checks in one, and what it deliberately does not check. The field-by-field contract is in the [flow reference](../reference/flow-reference.md#the-decomposition). The terms are defined in the [domain glossary](../../CONTEXT.md).

## What a Decomposition is

A **Decomposition** is the breakdown a `commander` returns for a goal: the subtasks, plus any dependency edges between them. A flat list of subtask strings is a Decomposition with no edges. An array of subtask objects is the structured shape, which can declare edges. This page does not call either shape a "plan". In pi-flows a plan is the set of waves a mode declares before it spawns anything, and the `commander` writes no plan.

The `commander` writes the Decomposition, so it arrives as model output. That output then decides how many children spawn, in what order, and in which working directory. The flow therefore treats it the same way it treats any other untrusted input to a spawn decision. It validates the Decomposition once, after the `commander` settles and before the first worker starts.

## Why the check is deterministic only

The validation reads the Decomposition and nothing else. It compares ids, follows edges, counts subtasks, and looks at the worker role's tools. No model judges the result.

This keeps the refusal reproducible. The same Decomposition always gets the same answer, and the answer arrives before any budget is spent on workers. A model-based gate would add a child run, a cost, and a second source of non-determinism. The decision it guards exists to bound the first one.

The price is a narrow set of defects. The check finds only the defects that make the Decomposition unrunnable:

- a missing id or objective, and a duplicate id
- an id outside the permitted characters
- an edge to a subtask that does not exist, and a dependency loop
- a size above the cap
- a shared-write topology that no wave schedule could admit

Each of these defects has one correct answer. A reader does not need the goal to find that answer.

## Why an id is not prose

A subtask id looks like a label, but the flow uses it as a key. It addresses the dependency edges. It becomes the unit key of the worker span. It also becomes a heading: the flow writes the id into the prompt of each dependent worker, and into the manifest that `debrief` reads.

The `commander` writes that id, so it is model output in a position the reader trusts. An id with a line break in it could add a heading to a worker prompt. The worker could read that heading as an instruction from the flow, not as data from another subtask. The flow therefore holds an id to a small character set, and refuses anything else.

The refusal is not a repair. The id is the name that the `dependsOn` entries use, so a flow that rewrote it would break the edges the `commander` declared.

## Why coverage and overlap are not refused

A Decomposition can be structurally perfect and still be a bad breakdown of the goal. It can miss a part of the goal. Two subtasks can cover the same ground. A subtask can be too large for one worker.

The flow does not refuse any of these. To decide whether a Decomposition covers a goal, a reader must understand the goal. That is a judgment, not a rule, and a deterministic gate that guesses at it would refuse good decompositions. A false refusal here is expensive: it discards a settled `commander` run and returns nothing.

So coverage stays the `commander`'s responsibility, and the synthesis stage stays the place where a gap becomes visible. If you need the breakdown itself reviewed, add your own critic. Model review of a Decomposition is tracked as [issue #160](https://github.com/Thulr/pi-flows/issues/160).

## Why a subtask cannot name its agent

Every subtask of one Decomposition runs the single worker role that `orchestrate.recon` sets. The flow refuses a subtask that names an `agent`. It does not obey the name.

The worker role carries a toolset, a write-capability classification, and a contract. The flow uses that classification before dispatch, when it checks the shared-write topology across the whole Decomposition. If each subtask could pick its own agent, model output would choose which of those classifications applies. A pre-dispatch check over one role is a fact. The same check over roles the model picks is a check on the model's own choice.

Work that needs a different agent for each unit has a mode already: [graph mode](../reference/flow-reference.md#graph-mode-static-dag). The difference is who writes the units. In graph mode you write the DAG, so you also choose each node's agent, task text, and tools. In orchestrate mode the `commander` writes the units at run time, so the units get the role you fixed in the call.

## Why one shape is cut at the cap and the other is refused

`orchestrate.maxSubtasks` caps the size of a Decomposition. Above the cap, the flow cuts a flat list. Above the same cap, the flow refuses a structured Decomposition.

This asymmetry follows from the edges. A flat list states no relations, so the first eight of ten subtask strings are still eight complete units of work. A structured Decomposition can state relations, so the same cut can delete subtasks that other subtasks name. What survives is a Decomposition the `commander` never wrote: some edges point at nothing, and the work behind them is silently gone. A refusal that names the count is the honest answer, because only the caller can decide between a higher cap and a narrower goal.

## What stranding means for the synthesis

A subtask runs after every subtask it depends on has succeeded. If a dependency fails, its dependents are **stranded**: they never start.

Stranding is a containment rule, not a repair. The flow does not retry the failed subtask, and it does not run the dependents without the input they declared they need. Findings built on missing evidence are worse than absent findings. They read the same as complete ones.

That is also why the `debrief` prompt receives the "Subtasks not completed" manifest by name. A merged answer that quietly omits a failed subtask looks like a full answer to the goal. The manifest makes the missing work visible to the synthesizer, and the flow header repeats the counts to the caller. Read a synthesized answer with the header beside it: a run with stranded subtasks answers less of the goal than its text suggests.

If no terminal subtask succeeds, there is nothing worth merging, and the flow says so instead of running `debrief` on partial evidence.

## The boundary with graph mode

Orchestrate and graph both run units wave by wave, and both refuse cycles. They differ in who writes the units.

- **Graph mode** runs an author-supplied DAG. You state each node, its agent, and its task text. Use it when the shape of the work is known before the call.
- **Orchestrate mode** runs a Decomposition. The `commander` states the subtasks at run time, and the flow validates and dispatches them. Use it when the shape of the work is what you want the flow to discover.

The dependency edge means the same thing in both: the dependent unit runs later, and receives the output of the units it names. In graph mode you place that output yourself with a `{node.id}` placeholder. In orchestrate mode the flow inserts it, because the `commander` cannot know how the flow renders its subtask output.

## What this version does not do

Two capabilities are out of scope on purpose:

- **Quality review of a Decomposition** — no model judges coverage, overlap, or subtask size ([issue #160](https://github.com/Thulr/pi-flows/issues/160)).
- **Replanning** — the `commander` runs once. A failed subtask does not send the goal back for a new Decomposition ([issue #161](https://github.com/Thulr/pi-flows/issues/161)).

Both stay out until the trust question behind them is answered. A gate that revises model output is a second decision maker in the flow, and it needs its own bounds on cost, iterations, and evidence.
