# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **single-context**: one `CONTEXT.md` and one `docs/adr/` at the repo root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-example-decision.md
│   └── 0002-another-decision.md
└── extensions/
```

## Keep the subdomain split current

`CONTEXT.md` opens with the subdomain classification (Core / Supporting / Generic / shared kernel / composition root) and every module under `extensions/pi-flows/` is placed in exactly one. `npm run score:domain` enforces that placement, the import direction between subdomains, naming, and foreign-package containment; it runs inside `npm run check` and CI posts the full score on each PR.

Adding a module means classifying it in `CONTEXT.md`. Changing a Core module means either re-running `/domain-driven-design` and updating `docs/domain-review.json` — the rows no check can settle are carried from there — or accepting that those rows report as stale on the PR.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
