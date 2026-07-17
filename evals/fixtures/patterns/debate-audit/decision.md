# Audit architecture decision

Choose one:

- **A, transactional outbox:** atomic with the business write. Load tests add 8% write latency. The primary currently has 11% capacity headroom.
- **B, log scraping:** adds under 1% application overhead and can ship in one week, but request logs can contain bearer credentials and a crash between commit and logging loses the audit event.

Binding constraints:

- Audit capture must be atomic with the regulated transaction.
- Credentials may not enter the log pipeline.
- p99 write latency must remain below 180ms. Current p99 is 151ms.
- Reverse the rollout if p99 exceeds 180ms for 15 continuous minutes.
