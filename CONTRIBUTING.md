# Contributing

Thanks for improving pi-flows. The goal is a small, safe, testable delegation extension.

## Setup

```bash
node --version  # >=24
npm --version   # >=11
npm ci
npm run check
```

## Local development loop

```bash
npm run typecheck
npm run lint:length
npm run score:domain
npm run scan:privacy
npm test
npm run validate:agents
```

`lint:length` fails when a source file exceeds its line cap (500 for
extension/script/eval code, 800 for tests). When it fires, split the file into
focused modules — `extensions/pi-flows/modes/` is the pattern — rather than
raising the cap.

`score:domain` fails on a structural finding and on a missing or explicitly
failed judgment row. Stale judgment rows are advisory: the score carries them,
shows them separately, and does not count them as verified. See the review
policy in [`docs/reference/architecture.md`](docs/reference/architecture.md).

`scan:privacy` blocks obvious secrets, high-signal PII, generated local artifacts,
and internal-only paths. Keep research notes under `docs/research/`; that directory
is intentionally ignored and must not be force-added to a PR. The Husky pre-commit
hook runs the staged variant automatically after `npm ci` / `npm install`.

Load locally:

```bash
pi -e ./extensions/pi-flows/index.ts
```

Smoke inside pi:

```text
/flows status
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

## Commit messages

pi-flows uses [Conventional Commits](https://www.conventionalcommits.org/). Write
each commit subject as `type(optional-scope): summary` in the imperative mood:

```text
feat(flow): add route-mode fallback agent
fix(safety): redact home paths in trace spans
docs(readme): document npm install
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`,
`perf`. Mark a breaking change with `!` after the type/scope or a
`BREAKING CHANGE:` footer — e.g. `feat(flow)!: rename evaluate.redteam to critics`.
This keeps history readable and lets release notes be grouped by type.

## PR evidence

Include:

- What changed and why.
- `npm run check` output summary.
- Any changed `flow` parameter/result/error contract.
- Docs/examples/changelog impact.
- For project-agent or privacy changes, the trust/redaction behavior verified.

## Tests

Tests must not require a live model/provider. Use fake/no-run paths for contract checks. Any new child-process behavior should be covered by an offline test seam or a no-model smoke.

`tests/integration.test.ts` covers the spawn/orchestrate path end to end by pointing pi-flows at a stub `pi` (`tests/fixtures/stub-pi.mjs`) instead of a live model: the stub replies from a per-agent plan and logs every child invocation, so tests assert the wiring and handoffs (chain `{previous}`, the evaluate loop, vote ballots, route dispatch, orchestrate fan-out) offline. Add cases there when you change how children are spawned, sequenced, or how their output flows between agents.

## Release changes

If a user-visible behavior changes, update:

- `CHANGELOG.md`
- `docs/reference/flow-reference.md`
- `docs/how-to/troubleshooting.md` if an error changes
- `examples/README.md` if an invocation shape changes

See [docs/how-to/release.md](./docs/how-to/release.md).

## Review expectations

For small changes, expect review within one business day. Security/privacy/trust-boundary changes require explicit maintainer review.
