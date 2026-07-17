const assert = require("node:assert/strict");
const { withAuth } = require("./src/auth");
const { withIdempotency } = require("./src/idempotency");
const { createPipeline } = require("./src/pipeline");

const resolveToken = (token) => ({ "good-a": "tenant-a", "good-b": "tenant-b" })[token] || null;

function authTests() {
  let calls = 0;
  const next = (request) => { calls += 1; return { status: 200, context: request.context }; };
  const auth = withAuth({ resolveToken })(next);
  assert.deepEqual(auth({ token: "bad", context: { requestId: "r0" } }), { status: 401 });
  assert.equal(calls, 0);
  assert.deepEqual(auth({ token: "good-a", context: { requestId: "r1" } }), {
    status: 200, context: { requestId: "r1", tenantId: "tenant-a" },
  });
  assert.match(createPipeline.toString(), /withAuth/);
}

function idempotencyTests() {
  const cache = new Map();
  let calls = 0;
  const next = (request) => { calls += 1; return { status: request.status || 200, call: calls }; };
  const idem = withIdempotency({ cache })(next);
  const base = { context: { tenantId: "tenant-a" }, idempotencyKey: "same" };
  assert.deepEqual(idem(base), { status: 200, call: 1 });
  assert.deepEqual(idem(base), { status: 200, call: 1 });
  assert.deepEqual(idem({ ...base, context: { tenantId: "tenant-b" } }), { status: 200, call: 2 });
  idem({ context: { tenantId: "tenant-a" } });
  idem({ context: { tenantId: "tenant-a" } });
  assert.equal(calls, 4);
  const failure = { context: { tenantId: "tenant-a" }, idempotencyKey: "failure", status: 500 };
  idem(failure);
  idem(failure);
  assert.equal(calls, 6);
  assert.match(createPipeline.toString(), /withIdempotency/);
}

function integrationTests() {
  const cache = new Map();
  let calls = 0;
  const handler = (request) => { calls += 1; return { status: request.forceStatus || 200, tenant: request.context.tenantId, call: calls }; };
  const pipeline = createPipeline({ handler, resolveToken, cache });
  assert.deepEqual(pipeline({ token: "bad", idempotencyKey: "k" }), { status: 401 });
  assert.equal(calls, 0);
  assert.deepEqual(pipeline({ token: "good-a", idempotencyKey: "k", context: { requestId: "r1" } }), { status: 200, tenant: "tenant-a", call: 1 });
  assert.deepEqual(pipeline({ token: "good-a", idempotencyKey: "k", context: { requestId: "r2" } }), { status: 200, tenant: "tenant-a", call: 1 });
  assert.deepEqual(pipeline({ token: "good-b", idempotencyKey: "k" }), { status: 200, tenant: "tenant-b", call: 2 });
  pipeline({ token: "good-a", idempotencyKey: "bad-status", forceStatus: 500 });
  pipeline({ token: "good-a", idempotencyKey: "bad-status", forceStatus: 500 });
  assert.equal(calls, 4);
}

const mode = process.argv[2] || "all";
if (mode === "auth" || mode === "all") authTests();
if (mode === "idempotency" || mode === "all") idempotencyTests();
if (mode === "integration" || mode === "all") integrationTests();
console.log(`PASS ${mode}`);
