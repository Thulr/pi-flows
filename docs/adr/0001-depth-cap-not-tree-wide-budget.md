# Nested delegation is bounded by a depth cap, not a tree-wide budget

A flow budget bounds one flow call. When a child starts its own flow, that nested flow
builds a fresh budget from its own parameters and the outer ceiling never sees its
spend. Runaway nesting is contained by refusing a `flow` call at or beyond
`MAX_FLOW_DEPTH` (`FLOW_DEPTH_EXCEEDED`) rather than by threading remaining budget down
the tree.

## The depth cap is harness discipline, not a security boundary

`PI_FLOWS_DEPTH` is trusted, and treating it otherwise has already produced two wrong
claims in this file's history. Stating the limits plainly instead:

- `currentFlowDepth()` resolves a corrupted, negative, or non-numeric value to `0`,
  which is *less* restrictive than the inherited depth. The clamp prevents a negative
  counter; it does not make tampering stricter.
- A descendant that resets the counter at every level receives a fresh allowance at
  every level, so the cap bounds nesting only while the inherited counter is preserved.
- The bypass does not require env tampering at all. `overwatch` and `redteam` ship with
  `bash`, and an agent with a shell can invoke `pi` directly without going through the
  `flow` tool, where no depth accounting applies.

What the cap does do is stop the ordinary failure mode: a model that keeps delegating
because delegating is cheap and each level looks locally reasonable. That is the
failure this harness actually sees, and a trusted counter is proportionate to it.

## Considered Options

**Propagate remaining budget to nested flows.** Rejected because it needs a materially
larger mechanism to mean anything, and would rest on the same trusted transport as the
counter above. The child's model composes its own nested `flow` call and chooses its own
budget parameters, so an inherited ceiling only binds if it is enforced as a floor the
child cannot raise — not merely a number passed down. Against a cooperative child the
depth cap already bounds the tree structurally, and against a hostile one neither
mechanism holds. The complexity buys enforcement in neither case.

**Forbid nested flows outright.** Rejected as too blunt — one level of nesting is
legitimately useful (a worker that needs its own fan-out), and the cap already makes the
depth explicit and reviewable.

## Consequences

Total spend across a nested tree is bounded by depth and fan-out, not by a single number,
and only for cooperative children. An operator who wants a hard cost ceiling must keep
delegation flat, which the cap already pushes toward: the `FLOW_DEPTH_EXCEEDED` fix text
tells the caller to flatten rather than restructure for depth. An operator who needs a
ceiling that survives a hostile child needs a control outside pi-flows — a provider-side
spend limit, or an agent roster without shell access.

This is the one place where "flow" and "flow tree" come apart, so both terms are defined
in [CONTEXT.md](../../CONTEXT.md) and the budget parameters say per-flow explicitly.
`maxCostUsd` and friends previously read as tree-wide in the tool schema, which is the
misreading this ADR exists to prevent.
