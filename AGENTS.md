# Agent instructions for pi-flows

Read this before editing the repo.

## Project shape

- Extension entrypoint: `extensions/pi-flows/index.ts` (registers the `flow` tool and `/flows` command; re-exports the public API)
- Extension modules: `extensions/pi-flows/*.ts` — `types.ts` (constants, types, error codes, `ModeDeps` incl. the `runChild` seam), `flow.ts` (the `Flow` aggregate root: the ordered admission gates, the single-use dispatch capability, and the settle sequence), `run.ts` (the `Run` object owning a child result's lifecycle: envelope candidate, validated envelope, envelope/handoff attachment), `budget.ts` (the `Budget` object: ceilings, spend, authority, and the refusals they produce), `sanitize.ts` (redaction, caps, injection scan), `validate.ts` (facade) over `validate-workflow.ts` (workflow phase predicates shared with the eval seam), `parse.ts`, `agents.ts` (discovery), `runner.ts` (child-run adapter) over `child-model.ts` (per-child model/level resolution) and `dispatch.ts` (fan-out/single-role plumbing), `jsonl-child.mjs` (child-process JSONL protocol, shared with evals), `delegation.ts` (typed contracts, return envelopes, handoff attestations), `integration.ts` (validated child-run plans), `handoff-consumption.ts` (flow-scoped validation, preparation, policy, evidence, and warning aggregation), `approval.ts` (durable single-use approval receipts), `trace.ts` (facade) over `trace-scope.ts` (span/event/health vocabulary), `trace-sink.ts` (span export), `trace-attributes.ts` (identity + handoff attributes), `trace-structure.ts` (span-record accessors + is-this-a-span-tree validation), `trace-report.ts` (parse/rollup/format), `reflexion.ts`, `ui.ts` (shared board progress text, transient UI clearing, checkpoint approvals, `/flows` parsing), `ui-style.ts` (the shared visual vocabulary: state icons/colors, meters, per-run state bars, badges, tree guides, box frames), `ui-gantt.ts` (the settled card's concurrency-timeline chart, rasterized for image-capable terminals) over `png.ts` (dependency-free raster primitives + RGBA→PNG encoder), `ui-live-row.ts` (live tool-row board), `ui-flow-card.ts` (durable `pi-flows.run` entry card), `inspector.ts` (live-flow registry + single-child viewer), `schema.ts` (TypeBox params)
- Mode handlers: `extensions/pi-flows/modes/*.ts`, one file per mode. `modes/contract.ts` is the single mode table (activation, label, handler, param hint, plan, critical path, mode pre-spawn refusal). Add a new mode by writing a handler file that exports its handler, its `plan` (declared pre-spawn waves — `modes/plan.ts` is the vocabulary), its `criticalPath`, and its `preSpawnRefusal` (what it refuses before its first child spawns; `noPreSpawnRefusal` is the declared answer for a mode that refuses nothing), adding its entry to `CONTRACTS` in `modes/contract.ts`, its name to `RUN_MODE_NAMES` in `types.ts`, and its params field in `schema.ts` (plus a `modeHandoffPolicy` key there if the mode can carry a policy floor — this and the params field are the two edits nothing compiles against, so treat `schema.ts` as part of the contract, not an afterthought). The handler must reach its refusals through the same functions the declaration does — its own `preSpawnRefusal`, or the shared predicate that declaration composes (workflow's handler calls `workflowPhasesRefusal`, because the approval half turns on a UI the declaration is told about rather than reads) — never rebuilding the refusal inline; `tests/mode-prespawn-refusal.test.ts` pins it for the modes whose handler calls the declaration whole. `modes/registry.ts`, requested agents, the shared-write admissibility mirror, the mode pre-spawn refusal resolver the selection eval reads, budget disclosure, the critical-path resolver, the `Flow` aggregate in `flow.ts`, and the composition root in `index.ts` all derive from the table and do not change. A missing or extra contract entry (including a missing `plan`, `criticalPath`, or `preSpawnRefusal`) is a compile error. One consequence does not compile against anything: the selection eval resolves every mode's declaration automatically, but only *scores* the codes named in `SCORED_PRE_SPAWN_CODES` (`evals/select-admissibility.mjs`) — a new mode whose refusal should count against selection needs its code added there, or it scores silently admissible. Handlers settle through `deps.settle` (`settle.ts`) and dispatch through `dispatchIntegrationPlan`/`runWave` — a refusal that drops already-spent runs, a fan-out that skips the shared-write gate, or a hand-computed step number should not be writable.
- Bundled agent prompts: `agents/*.md`
- Tests: `tests/*.test.ts` — `pi-flows.test.ts` (offline contract) and `integration.test.ts` (execution path against a stub `pi`) are full; add new coverage in a new file (the 800-line cap is enforced)
- Trace tests: `tests/trace-topology.test.ts` (span roles, stage nesting, dependency links), `tests/trace-evidence.test.ts` (identity attributes, capture policy, handoff accounting, budget authority), `tests/trace-gate.test.ts` (reading a trace back: structural validation and the strict gate)
- Fault injection: `tests/fault-adapter.ts` (deterministic, model-free faults over the `runChild` seam) + `tests/fault-scenarios.ts` (the scenario manifest and its four check families) + `tests/fault-portfolio.ts` (containment/false-containment rates over the attack- and control-opportunity denominators) + `tests/fault-injection.test.ts`. Add a coordination fault as a manifest entry, not as a bespoke test
- Eval calibration: `evals/calibration.mjs` (report assembly + gate rules) over `calibration-key.mjs` (validity key), `calibration-coverage.mjs` (splits, per-dimension coverage), `calibration-stats.mjs` (confusion matrices, rates, bounds), `review-agreement.mjs` (blinded human labels, adjudication, agreement)
- User docs: `README.md`, `docs/README.md` (the Diátaxis index) plus `docs/{tutorials,how-to,reference,explanation}/*.md`, `examples/README.md`

## Required checks

Run before handing off code changes:

```bash
npm ci
npm run check
```

For smaller loops:

```bash
npm run typecheck
npm test
npm run score:domain
npm run validate:agents
npm run pack:dry-run
```

## Invariants

- Never run project-local `.pi/flow-agents` in headless (non-UI) contexts unless `confirmProjectAgents:false` is explicit and the repo has been reviewed.
- Do not pass raw user task text in child process argv.
- Redact secret-shaped content and home paths from returned content/details by default.
- Do not commit internal research notes or generated audit/eval artifacts (`docs/research/`, `audit-artifacts/`, `.thulr/`, generated eval traces).
- Keep `README.md`, `docs/reference/flow-reference.md`, TypeBox params, and tests in sync when changing the `flow` contract.
- Keep `CHANGELOG.md`, `package.json`, `PI_FLOWS_VERSION` in `extensions/pi-flows/types.ts`, and the release tag in agreement for release-facing changes — the publish workflow fails when the `vX.Y.Z` tag does not match `package.json`.
- Do not package `audit-artifacts/`, `tests/`, `scripts/`, or local temp files.
- Write commits as [Conventional Commits](./CONTRIBUTING.md#commit-messages) (`type(scope): summary`).

## Generated/local artifacts

- `node_modules/` is ignored.
- `audit-artifacts/` is generated audit output and should not be packaged.

## Safe implementation path

1. Read the relevant docs and tests.
2. Make a small code/doc change.
3. Run the narrow check (`npm test` or `npm run typecheck`).
4. Run `npm run check` before final response.
5. Update the findings ledger only after the verification rule passes.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

`CONTEXT.md` opens with the subdomain split (Core / Supporting / Generic / shared kernel / composition root) and every module is classified there. `npm run score:domain` enforces the structural half of the domain-model score — module classification, subdomain import direction, naming, and foreign-import containment — and is part of `npm run check`; CI posts the full score on every PR. The rows no check can settle (aggregate design, behavior-rich objects, language consistency) are carried from `docs/domain-review.json` and go stale when a Core module changes without the review being re-recorded. Adding a module means classifying it; changing a Core module means either re-running `/domain-driven-design` and updating that file, or accepting a stale score on the PR.
