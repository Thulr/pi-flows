# Architecture classification

The single source of truth for which subdomain every module belongs to, and for the import direction between subdomains. `npm run score:domain` reads this file directly — the document a contributor edits and the rule the build enforces are the same statement, so the classification cannot quietly go stale as modules are added. The *why* behind this split (what makes a finding checkable, why the four contested placements land where they do) is explained in [Domain model](../explanation/domain-model.md); the *what* — the terms themselves — is the [domain glossary](../../CONTEXT.md).

## Subdomain split

Not every part of this repo earns the same depth. This split says where to spend design effort and review attention, and where deliberately not to. Revisit it when the differentiator moves.

**Core — coordination under guardrails.** Delegation contracts and their identity, return and handoff envelopes, injection policy, artifact digests, approval receipts, budget authority, capture policy, and the coordination evidence that shows what actually happened. This is the part that makes a returned finding checkable rather than merely plausible. Model it deeply, give every new concept a glossary entry, and expect changes here to come with a test that names the invariant and, where it is a coordination failure, a fault-scenario entry.
_Modules_: `flow.ts`, `run.ts`, `settle.ts`, `delegation.ts`, `handoff.ts`, `handoff-types.ts`, `handoff-consumption.ts`, `return-types.ts`, `decomposition.ts`, `approval.ts`, `agent-profile.ts`, `budget.ts`, `integration.ts`, `contract-resolution.ts`, `validate.ts`, `validate-workflow.ts`, `bash-readonly.ts`, `sanitize.ts`, `trace.ts`, `trace-scope.ts`, `trace-sink.ts`, `trace-verify.ts`, `trace-attributes.ts`, `trace-structure.ts`, `trace-report.ts`, `trace-identity.mjs`.

**Supporting — coordination patterns and the views onto them.** The modes and their topologies, preset and agent discovery, reflexion, and the live/settled surfaces (inspector, flow card, live board). Necessary, and often the reason someone reaches for the tool, but they recombine the core's primitives rather than being the differentiator. Build them plainly and resist per-mode special cases a new mode would have to re-implement; the views must speak the glossary's terms but hold no invariants of their own.
_Modules_: `modes/*`, `decomposition-review.ts`, `presets.ts`, `preset-review.ts`, `preset-catalog.ts`, `preset-approval.ts`, `agents.ts`, `agent-catalog.ts`, `reflexion.ts`, `budget-disclosure.ts`, `ui.ts`, `ui-style.ts`, `ui-gantt.ts`, `ui-live-row.ts`, `ui-flow-card.ts`, `inspector.ts`.

**Generic — plumbing and adapters.** Child-process transport, the anti-corruption layer over a child pi run, fan-out plumbing, param schema and arithmetic, command execution, text parsing. Keep thin, keep replaceable, do not model. `runner.ts` and `jsonl-child.mjs` are where a foreign protocol is allowed to be spoken; everything above them should see domain types only.
_Modules_: `runner.ts`, `runner-budget.ts`, `child-model.ts`, `provider-failure.ts`, `dispatch.ts`, `jsonl-child.mjs`, `schema.ts`, `commands.ts`, `parse.ts`, `png.ts`, `protocol.ts`, `topology.ts`, `model-roster.ts`, `roster-config.ts`, `roster-source.ts`, `bash-readonly-extension.ts`, `bash-readonly-sandbox.ts`, `wrapup.ts`.

**Shared kernel.** `types.ts` — the vocabulary every subdomain imports, re-exported from the concept modules that own each term. A change here ripples everywhere and nothing above owns it, so keep it declarative: a rule that belongs to one concept belongs in that concept's module (see `budget.ts`), not here. `roster-types.ts` is vocabulary of the same kind, held apart only because the kernel may not import the Generic module that derives a roster.
_Modules_: `types.ts`, `roster-types.ts`, `preset-types.ts`.

**Composition root.** `index.ts` — registers the tool and command and wires every subdomain together, so it alone may import from all of them. Flow-level ordering does not live here: the `Flow` aggregate owns the lifecycle, and `execute()` only adapts pi's context into the aggregate's ports. A new ordering rule belongs in the aggregate; a positional rule reappearing in `execute()` is the smell this split exists to catch.
_Modules_: `index.ts`.

## Import direction

The enforced direction is narrow on purpose: **Core may not import Supporting**, and the shared kernel may import only Core. Core reaching down into Generic plumbing is fine — commodity is there to be used. Core reaching sideways into the modes or the views is not: it would make the differentiator depend on the recombinations of it.

Only the rows below constrain an import; a subdomain not listed may import freely.

- **Core** → Core, Generic, Shared kernel
- **Shared kernel** → Core, Shared kernel

## Review policy

The structural half of the domain-model score — expert-readable names, module classification, subdomain import direction, foreign-import containment, and spelled-once containment — is re-checked from the tree on every `npm run score:domain` run, and a new finding is a build failure. The judgment half — whether an aggregate is the right size, whether the core model is rich or merely CRUD, whether the language holds together across docs, code, and tests — is not something a grep settles, so those rows are carried from `docs/domain-review.json` and labelled with when the review was taken.

The judgment rows have a fixed identity. `scripts/domain-judgment.mjs` names the expected rows and their required fields. If you delete or rename a ledger row, the score reads a missing judgment and fails. The denominator does not decrease.

Each row declares its surfaces: the code, mode, shared-kernel, documentation, and test files that can invalidate it. A recorded review stamps a content digest for each surface. A row is **stale** when a declared surface's digest no longer matches. A stale row is carried: the report shows it separately, and the verified score does not include it. A stale row does not fail the build. A missing or explicitly failed judgment does fail the build. The codebase applies the same rule to an approval receipt whose digest no longer matches.

When you add a module, classify it here. When you change a declared surface of a judgment row, you have two options. Re-run the `/domain-driven-design` review over that surface, then record provenance with `node scripts/domain-score.mjs --record=<rows|all>`. Or accept that the row reports as carried (stale) on the PR. An edit to the prose of `docs/domain-review.json` changes no digest and re-establishes nothing.

Foreign-import containment is a shrink-only ledger in `docs/domain-review.json`: the modules where a foreign package type may legitimately be spoken (the anti-corruption layer, the extension registration surface, the terminal views) are named as adapters, and any other module importing a foreign type is recorded debt that must shrink, never grow. Spelled-once containment lives in `scripts/domain-spelled-once.mjs`, which pins each shipped consolidation's concept to its one home.
