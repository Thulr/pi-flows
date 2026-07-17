# Pilot incident

The active-active pilot's duplicate side effects came from unfenced secondary writes; fencing reduces but does not eliminate that risk.
If A launches, disable secondary writes and return to single-primary when duplicates exceed 0.25% in two consecutive 15-minute windows, or write p99 is at least 175ms for 10 continuous minutes.
If B launches, abandon failover when standby CPU exceeds 90% for 10 minutes or lag exceeds 60 seconds for 5 minutes.
