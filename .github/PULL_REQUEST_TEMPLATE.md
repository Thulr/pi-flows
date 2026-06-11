## Summary

-

## Verification

- [ ] `npm run check`
- [ ] Local extension smoke: `/flows status`
- [ ] Local extension smoke: `flow {"list":true}`
- [ ] Docs/examples updated when contracts changed
- [ ] Changelog updated for user-visible behavior
- [ ] `npm run scan:privacy`
- [ ] Commits follow Conventional Commits (`type(scope): summary`)

## Trust/privacy impact

- [ ] No project-local agent safety regression
- [ ] No raw secret/task leakage in content/details/argv
- [ ] No internal docs/research artifacts committed (`docs/research/`, `audit-artifacts/`, generated eval traces)
- [ ] Package dry-run excludes generated/local artifacts
