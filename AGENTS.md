# Agent instructions for pi-flows

Read this before editing the repo.

## Project shape

- Extension entrypoint: `extensions/pi-flows/index.ts` (registers the `flow` tool and `/flows` command; re-exports the public API)
- Extension modules: `extensions/pi-flows/*.ts` — `types.ts` (constants, types, error codes, `ModeDeps` incl. the `runChild` seam), `sanitize.ts` (redaction, caps, injection scan), `validate.ts`, `parse.ts`, `agents.ts` (discovery), `runner.ts` (child-run adapter) over `dispatch.ts` (fan-out/single-role plumbing), `jsonl-child.mjs` (child-process JSONL protocol, shared with evals), `delegation.ts` (typed contracts, return envelopes, handoff attestations), `integration.ts` (per-mode dispatch adapter), `approval.ts` (durable single-use approval receipts), `trace.ts` (facade) over `trace-scope.ts` (span/event/health vocabulary), `trace-sink.ts` (span export), `trace-attributes.ts` (identity + handoff attributes), `trace-structure.ts` (span-record accessors + is-this-a-span-tree validation), `trace-report.ts` (parse/rollup/format), `reflexion.ts`, `ui.ts`, `schema.ts` (TypeBox params)
- Mode handlers: `extensions/pi-flows/modes/*.ts`, one file per mode. `modes/contract.ts` is the single mode table (activation, requested agents, label, handler, param hint). Add a new mode by writing a handler file, adding its entry to `CONTRACTS` in `modes/contract.ts`, its name to `RUN_MODE_NAMES` in `types.ts`, and its params field in `schema.ts` — `modes/registry.ts` and the dispatch core in `index.ts` derive from the table and do not change. A missing or extra contract entry is a compile error.
- Bundled agent prompts: `agents/*.md`
- Tests: `tests/*.test.ts` — `pi-flows.test.ts` (offline contract) and `integration.test.ts` (execution path against a stub `pi`) are full; add new coverage in a new file (the 800-line cap is enforced)
- Trace tests: `tests/trace-topology.test.ts` (span roles, stage nesting, dependency links), `tests/trace-evidence.test.ts` (identity attributes, capture policy, handoff accounting, budget authority), `tests/trace-gate.test.ts` (reading a trace back: structural validation and the strict gate)
- Fault injection: `tests/fault-adapter.ts` (deterministic, model-free faults over the `runChild` seam) + `tests/fault-scenarios.ts` (the scenario manifest and its four check families) + `tests/fault-portfolio.ts` (containment/false-containment rates over the attack- and control-opportunity denominators) + `tests/fault-injection.test.ts`. Add a coordination fault as a manifest entry, not as a bespoke test
- Eval calibration: `evals/calibration.mjs` (report assembly + gate rules) over `calibration-key.mjs` (validity key), `calibration-coverage.mjs` (splits, per-dimension coverage), `calibration-stats.mjs` (confusion matrices, rates, bounds), `review-agreement.mjs` (blinded human labels, adjudication, agreement)
- User docs: `README.md`, `docs/*.md`, `examples/README.md`

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
npm run validate:agents
npm run pack:dry-run
```

## Invariants

- Never run project-local `.pi/flow-agents` in headless (non-UI) contexts unless `confirmProjectAgents:false` is explicit and the repo has been reviewed.
- Do not pass raw user task text in child process argv.
- Redact secret-shaped content and home paths from returned content/details by default.
- Do not commit internal research notes or generated audit/eval artifacts (`docs/research/`, `audit-artifacts/`, `.thulr/`, generated eval traces).
- Keep `README.md`, `docs/flow-reference.md`, TypeBox params, and tests in sync when changing the `flow` contract.
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
