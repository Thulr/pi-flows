# Checkout ledger migration requirements

- Customer-visible write downtime must remain zero.
- Dual-write may run for at most 24 hours.
- Cutover requires release-manager approval after reconciliation is below 0.5% for three consecutive checks.
- Rollback must complete in under five minutes and must not replay payment side effects.
- The migration owner is Payments; Database Operations owns backfill throttling.
