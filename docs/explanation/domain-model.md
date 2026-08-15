# Domain model

Why pi-flows is split the way it is — the reasoning behind the subdomain classification, the import direction, and the review policy. This page carries the *why*; the classification itself (which module goes where, which imports are constrained) is in [Architecture classification](../reference/architecture.md), and the terms are defined in the [domain glossary](../../CONTEXT.md).

## The differentiator is checkability

pi-flows' value is not the spawning — anything can spawn a subprocess. It is that what comes back is **checkable**: a finding arrives bound to the contract it was produced under, carrying its own evidence, provenance, and cost, so the parent can act on it without re-reading the transcript that produced it.

The subdomain split is a direct consequence. The part of the codebase that makes a finding checkable — delegation contracts and their identity, return and handoff envelopes, injection policy, approval receipts, budget authority, capture policy, and the coordination evidence that shows what happened — is the **Core** domain. Everything else is either a recombination of those primitives (**Supporting**), commodity plumbing (**Generic**), shared vocabulary (**Shared kernel**), or the wiring that connects them (**Composition root**).

## Why the four contested placements land where they do

A first pass tends to put four things in the wrong place. They are stated outright because each is the kind of misclassification that quietly hollows out the split:

- **Tracing is Core, not reporting.** Coordination evidence is what makes a returned finding checkable, which is the whole value proposition. A flow that cannot show what it did has lost the thing being sold.
- **Redaction is Core, not plumbing.** `sanitize.ts` implements Capture policy, and what may leave a child is a guardrail, not a formatting concern.
- **The views are Supporting, not Generic.** They render domain concepts and must speak the glossary's terms, so they are not interchangeable commodity — but they hold no invariants, so they are not Core either.
- **The shared-write gate's fan-out position is plumbing, not policy.** The rule is Core (the shared-write predicate); the fan-out invokes it at the one position that knows the concurrent set, so the fan-out enforces the Core-owned predicate without owning it.

## Why the import direction is narrow

Only the direction that carries meaning is constrained; anything not listed imports freely.

Core reaching down into Generic plumbing is fine — commodity exists to be used, and an adapter implementing a Core-defined seam depends on the domain rather than the reverse. Core reaching *sideways* into Supporting is the real inversion: it makes the differentiator depend on the recombinations of itself, and it is how a core model starts absorbing mode special-cases and view concerns. The shared kernel is held to vocabulary only, because a rule that belongs to one concept belongs in that concept's module, not in the file everything imports.

## Why the review has two halves, and why one goes stale

The domain score has two halves and they are deliberately not mixed.

**Structure** is mechanical — naming, module classification, import direction, and foreign-model containment are facts; a regression in one is a build failure, not an opinion. Those rows are re-checked from the tree on every run.

**Judgment** is not — whether an aggregate is the right size, whether the core model is rich or merely CRUD, whether the language holds together across docs, code, and tests. No grep settles those. Inventing a number for them would produce a metric that reads 10/10 while the model rots. So they are *carried* from the last recorded review, and each carried row is labelled with when it was taken.

A carried row goes stale when the ground it was measured against has moved: when a Core module was touched more recently than the review. A stale row drops out of the verified score rather than being repeated as fact — the same rule the codebase applies to an approval receipt whose digest no longer matches, and to trace health versus execution success. The review is re-recorded by editing `docs/domain-review.json`; staleness is measured from when that file was last touched relative to the Core modules, so editing it *is* the re-recording — no commit id is maintained by hand.
