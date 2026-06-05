# Agent instructions for pi-flows

Read this before editing the repo.

## Project shape

- Extension entrypoint: `extensions/pi-flows/index.ts`
- Bundled agent prompts: `agents/*.md`
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
- Keep `README.md`, `docs/flow-reference.md`, TypeBox params, and tests in sync when changing the `flow` contract.
- Keep `CHANGELOG.md` and `package.json` version aligned for release-facing changes.
- Do not package `audit-artifacts/`, `tests/`, `scripts/`, or local temp files.

## Generated/local artifacts

- `node_modules/` is ignored.
- `audit-artifacts/` is generated audit output and should not be packaged.

## Safe implementation path

1. Read the relevant docs and tests.
2. Make a small code/doc change.
3. Run the narrow check (`npm test` or `npm run typecheck`).
4. Run `npm run check` before final response.
5. Update the findings ledger only after the verification rule passes.
