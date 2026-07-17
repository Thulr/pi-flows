# Queue migration decision

Choose one:

- **A, application dual-write:** estimated four weeks and changes to four services. A pilot showed 1.2% source/target divergence during retries. Expected propagation lag is under five seconds.
- **B, database CDC:** estimated 12 days and no application changes. The load test measured p99 propagation lag at 75 seconds. Schema drift can stop the connector unless compatibility checks run before deploy.

Binding constraints:

- Application code is frozen for the first 14 days of the 21-day migration window.
- The target may lag source by at most two minutes.
- Roll back if lag exceeds two minutes for ten continuous minutes.
- No loss or duplicate billing events is acceptable.
