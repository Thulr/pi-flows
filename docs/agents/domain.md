# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

The domain knowledge is split across three surfaces, each for a distinct purpose:

| Surface | Purpose |
|---|---|
| [`CONTEXT.md`](../../CONTEXT.md) | The **domain glossary** — canonical terms with concise, implementation-free definitions and Avoid lists. |
| [`docs/reference/architecture.md`](../reference/architecture.md) | The **architecture classification ledger** — which subdomain every module belongs to, and the import direction between subdomains. |
| [`docs/explanation/domain-model.md`](../explanation/domain-model.md) | The **rationale** — why the split and the import direction are what they are. |
| [`docs/adr/`](../adr/) | Architecture decision records for hard-to-reverse decisions. |

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary, so you speak the domain's language.
- **`docs/reference/architecture.md`** — the classification, so you know which subdomain a module lives in before you touch it.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Keep the classification current

`docs/reference/architecture.md` classifies every module under `extensions/pi-flows/` into exactly one subdomain (Core / Supporting / Generic / shared kernel / composition root) and declares the import direction between subdomains. `npm run score:domain` reads that file directly and enforces the placement, the import direction, naming, foreign-package containment, and spelled-once containment (the `SPELLED_ONCE` ledger in `scripts/domain-spelled-once.mjs` holds each shipped consolidation's concept to its one home); it runs inside `npm run check` and CI posts the full score on each PR.

Adding a module means classifying it in the architecture ledger. Changing a Core module means either re-running `/domain-driven-design` and updating `docs/domain-review.json` — the rows no check can settle are carried from there — or accepting that those rows report as stale on the PR.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
