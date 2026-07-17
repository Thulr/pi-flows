# Queue envelope migration

Keep the CommonJS APIs `createEnvelope` and `consumeEnvelope`.

`protocol.js` must export `LEGACY_VERSION = 1`, `CURRENT_VERSION = 2`, `encodeCurrent`, and `decodeAny`.

New writes use the exact v2 shape `{ version: 2, job: { id, attempt }, payload, traceId }`.
Reads accept exact v1 and v2 envelopes and normalize to `{ jobId, attempt, payload, traceId }`; v1 uses `traceId: null`.

Reject hybrid shapes, extra schema keys, unknown versions, empty ids, negative or non-integer attempts, non-record payloads, and empty v2 trace ids.
