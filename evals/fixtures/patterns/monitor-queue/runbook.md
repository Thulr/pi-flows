# Compactor lease response

Do not restart the primary. Drain the skewed worker, correct its clock, reacquire the compactor lease, and verify queue depth remains below 100 for two checks. Escalate if another worker loses the lease.
