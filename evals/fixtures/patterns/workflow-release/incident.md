# Prior migration incident

On April 9, a rollback replayed dual-write messages and duplicated 43 payment ledger entries. The safe rollback is to disable target reads, stop the backfill, and keep the existing source as authority; do not replay payment messages. The incident commander also noted that backfill above 2,000 rows/second caused 74 seconds of replica lag.
