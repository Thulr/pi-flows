# Current telemetry

- `checkout_ledger` has 8.4 million rows.
- A staging run saturated the primary at 2,000 rows/second. At 1,500 rows/second, replica lag stayed below 20 seconds.
- 0.3% of historical rows have a nullable `region`; the target schema requires a region.
- Reconciliation runs every ten minutes and reports row-count and amount mismatches.
