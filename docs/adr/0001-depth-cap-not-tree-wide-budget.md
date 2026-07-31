# Nested delegation is bounded by a depth cap, not a tree-wide budget

A flow budget bounds one flow call. When a child starts its own flow, that nested
flow builds a fresh budget from its own parameters and the outer ceiling never sees
its spend — the only thing crossing the process boundary is `PI_FLOWS_DEPTH`. Runaway
nesting is contained by refusing a `flow` call at or beyond `MAX_FLOW_DEPTH`
(`FLOW_DEPTH_EXCEEDED`) rather than by threading remaining budget down the tree.

## Considered Options

**Propagate remaining budget to nested flows.** Rejected on blast radius, not on
tamper-resistance — neither mechanism is tamper-proof, and it is worth being precise
about that. A child is an untrusted adapter: the model inside it composes its own
`flow` call, and an agent with a shell can rewrite its own environment. `PI_FLOWS_DEPTH`
is no exception. `currentFlowDepth()` resolves a corrupted, negative, or non-numeric
value to `0`, which is *less* restrictive than the depth the child actually inherited,
so tampering buys additional nesting rather than being rejected.

What differs is what that tampering costs. The depth cap still applies from whatever
value is read, so corrupting it yields at most `MAX_FLOW_DEPTH` further levels from the
tampering point, each one a separate visible process. Corrupting a propagated budget
resets cumulative spend, and the ceiling stops meaning anything at all — the failure is
unbounded in the dimension the ceiling exists to bound. A propagated ceiling would also
have to be enforced as a floor the child *cannot raise*, since the child's model chooses
its own budget parameters; that is a materially larger mechanism than passing a number
down, and it would still rest on the same untrusted transport.

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
