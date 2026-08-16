# Domain model

This page explains why pi-flows is split the way it is: the reasoning behind the subdomain classification, the import direction, and the review policy. The classification itself (which module goes where, which imports are constrained) is in [Architecture classification](../reference/architecture.md). The terms are defined in the [domain glossary](../../CONTEXT.md).

## The differentiator is checkability

The value of pi-flows is not the spawning — anything can spawn a subprocess. The value is that what comes back states its own assurance. An ordinary Result is the Child's account, with no machine contract assurance. Under a delegation contract, a finding is **checkable**: it arrives bound to the contract it was produced under, and it carries its own evidence, provenance, and cost. So the parent can act on it without a re-read of the transcript that produced it. Checkable is not verified — only an independent verifier can establish that the outcome met its acceptance criteria (Verified outcome success).

The subdomain split is a direct consequence. The **Core** domain is the part of the codebase that makes a finding checkable: delegation contracts and their identity, return and handoff envelopes, injection policy, approval receipts, budget authority, capture policy, and the coordination evidence that shows what happened. Everything else is a recombination of those primitives (**Supporting**), commodity plumbing (**Generic**), shared vocabulary (**Shared kernel**), or the wiring that connects them (**Composition root**).

## Why the four contested placements land where they do

A first pass tends to put four things in the wrong place. They are stated outright because each one is the kind of misclassification that quietly erodes the split:

- **Tracing is Core, not reporting.** Coordination evidence is what makes a returned finding checkable, which is the whole value proposition. A flow that cannot show what it did has lost the thing being sold.
- **Redaction is Core, not plumbing.** `sanitize.ts` implements Capture policy, and what can leave a child is a guardrail, not a formatting concern.
- **The views are Supporting, not Generic.** They render domain concepts and must speak the glossary's terms, so they are not interchangeable commodity — but they hold no invariants, so they are not Core either.
- **The shared-write gate's fan-out position is plumbing, not policy.** The rule is Core (the shared-write predicate). The fan-out invokes it at the one position that knows the concurrent set, so the fan-out enforces the Core-owned predicate without owning it.

## Why the import direction is narrow

Only the direction that carries meaning is constrained. Anything not listed imports freely.

Core can reach down into Generic plumbing — commodity exists to be used. An adapter that implements a Core-defined seam depends on the domain, not the reverse. Core that reaches *sideways* into Supporting is the real inversion. It makes the differentiator depend on the recombinations of itself, and it is how a core model starts to absorb mode special-cases and view concerns. The shared kernel is held to vocabulary only. A rule that belongs to one concept belongs in the module of that concept, not in the file that everything imports.

## Why the review has two halves, and why one goes stale

The domain score has two halves and they are deliberately not mixed.

**Structure** is mechanical. Naming, module classification, import direction, and foreign-model containment are facts. A regression in one is a build failure, not an opinion. Those rows are re-checked from the tree on every run.

**Judgment** is not mechanical: whether an aggregate is the right size, whether the core model is rich or only CRUD, whether the language stays consistent across docs, code, and tests. No grep settles those. An invented number for them produces a metric that reads 10/10 while the model rots. So those rows are *carried* from the last recorded review, and each carried row is labeled with when it was taken. The rows themselves are fixed in `scripts/domain-judgment.mjs`. A row deleted from the ledger reads as a missing judgment and fails the score. The denominator cannot decrease silently.

A carried row goes stale when the ground it was measured against has moved. Each row declares its surfaces: the code, mode, shared-kernel, documentation, and test files that can invalidate it. The recorded review stamps a content digest for each surface. When a surface's current digest no longer matches, the row leaves the verified score. The report does not repeat it as fact. The codebase applies the same rule to an approval receipt whose digest no longer matches. Content digests need no git history. A dirty tree, a merged branch the review never saw, and a shallow clone all give the same answer.

To re-record, run the `/domain-driven-design` review over the changed surfaces. Then run `node scripts/domain-score.mjs --record=<rows|all>`. The stamp names the rows reviewed and the tree content they were reviewed against. An edit to the prose of `docs/domain-review.json` changes no digest, so a ledger edit cannot mark an unrelated row fresh. Staleness stays advisory. A missing or explicitly failed judgment fails the build.
