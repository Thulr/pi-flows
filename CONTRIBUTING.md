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
npm test
npm run validate:agents
```

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

## Release changes

If a user-visible behavior changes, update:

- `CHANGELOG.md`
- `docs/flow-reference.md`
- `docs/troubleshooting.md` if an error changes
- `examples/README.md` if an invocation shape changes

See [docs/release.md](./docs/release.md).

## Review expectations

For small changes, expect review within one business day. Security/privacy/trust-boundary changes require explicit maintainer review.
