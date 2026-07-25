# Agent instructions for pi-flows

Read this before editing the repo.

## Project shape

- Extension entrypoint: `extensions/pi-flows/index.ts` (registers the `flow` tool and `/flows` command; re-exports the public API)
- Extension modules: `extensions/pi-flows/*.ts` — `types.ts` (constants, types, error codes), `sanitize.ts` (redaction, caps, injection scan), `validate.ts`, `parse.ts`, `agents.ts` (discovery), `runner.ts` (child-process core), `trace.ts`, `reflexion.ts`, `ui.ts`, `schema.ts` (TypeBox params)
- Mode handlers: `extensions/pi-flows/modes/*.ts`, one file per mode, registered in `modes/registry.ts` (`RUN_MODE_HANDLERS`). Add a new mode by writing a handler file, registering it, and extending `detectRunMode` + `schema.ts` — the dispatch core in `index.ts` does not change.
- Bundled agent prompts: `agents/*.md`
- Tests: `tests/pi-flows.test.ts` (offline contract) + `tests/integration.test.ts` (execution path against a stub `pi`)
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
