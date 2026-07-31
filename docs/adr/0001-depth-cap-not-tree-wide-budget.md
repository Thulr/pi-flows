# Nested delegation is bounded by a depth cap, not a tree-wide budget

A flow budget bounds one flow call. When a child starts its own flow, that nested
flow builds a fresh budget from its own parameters and the outer ceiling never sees
its spend — the only thing crossing the process boundary is `PI_FLOWS_DEPTH`. Runaway
nesting is contained by refusing a `flow` call at or beyond `MAX_FLOW_DEPTH`
(`FLOW_DEPTH_EXCEEDED`) rather than by threading remaining budget down the tree.

## Considered Options

**Propagate remaining budget to nested flows.** Rejected because the transport is not
trustworthy in the direction that matters. A child is an untrusted adapter: the model
inside it composes its own `flow` call, and an agent with a shell can read and rewrite
its own environment. An inherited ceiling would therefore have to be a floor the child
*cannot raise*, which means either a tamper-evident channel or accepting that the guard
is advisory. `currentFlowDepth()` sidesteps this entirely — it clamps to a non-negative
integer, so a hostile or garbage `PI_FLOWS_DEPTH` can only ever make the guard stricter,
never disable it. A budget has no equivalent fail-safe direction: garbage input to a
spend ceiling is as likely to loosen it as tighten it.

**Forbid nested flows outright.** Rejected as too blunt — one level of nesting is
legitimately useful (a worker that needs its own fan-out), and the cap already makes
the depth explicit and reviewable.

## Consequences

Total spend across a nested tree is bounded by depth and fan-out, not by a single
number. An operator who wants a hard cost ceiling over everything must keep delegation
flat, which the cap already pushes toward: the `FLOW_DEPTH_EXCEEDED` fix text tells the
caller to flatten rather than restructure for depth.

This is the one place where "flow" and "flow tree" come apart, so both terms are defined
in [CONTEXT.md](../../CONTEXT.md) and the budget parameters say per-flow explicitly —
`maxCostUsd` and friends previously read as tree-wide in the tool schema, which is the
misreading this ADR exists to prevent.
