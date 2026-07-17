# Tenant authentication and idempotency

Keep the CommonJS APIs `withAuth`, `withIdempotency`, and `createPipeline`.

`withAuth({ resolveToken })` maps `request.token` to `request.context.tenantId`, preserves existing context fields, and returns `{ status: 401 }` without calling `next` for invalid tokens.

`withIdempotency({ cache })` keys cached responses by `JSON.stringify([tenantId, idempotencyKey])`, bypasses requests with no idempotency key, and caches only responses with status 200 through 299.

`createPipeline({ handler, resolveToken, cache })` composes authentication before idempotency. Unauthorized requests and non-2xx responses must never be cached, and equal keys from different tenants must never collide.
