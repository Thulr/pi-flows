const assert = require("node:assert/strict");
const { createEnvelope } = require("./src/producer");
const { consumeEnvelope } = require("./src/consumer");
const protocol = require("./src/protocol");

const validPayload = { kind: "email" };

function rejects(fn) {
  assert.throws(fn);
}

function producerTests() {
  assert.deepEqual(createEnvelope({ jobId: "j1", attempt: 2, payload: validPayload, traceId: "t1" }), {
    version: 2,
    job: { id: "j1", attempt: 2 },
    payload: validPayload,
    traceId: "t1",
  });
  for (const input of [
    { jobId: "", attempt: 0, payload: validPayload, traceId: "t1" },
    { jobId: "j1", attempt: -1, payload: validPayload, traceId: "t1" },
    { jobId: "j1", attempt: 1.5, payload: validPayload, traceId: "t1" },
    { jobId: "j1", attempt: 0, payload: [], traceId: "t1" },
    { jobId: "j1", attempt: 0, payload: validPayload, traceId: "" },
  ]) rejects(() => createEnvelope(input));
}

function consumerTests() {
  assert.deepEqual(consumeEnvelope({ version: 1, jobId: "old", attempt: 0, payload: validPayload }), {
    jobId: "old", attempt: 0, payload: validPayload, traceId: null,
  });
  assert.deepEqual(consumeEnvelope({ version: 2, job: { id: "new", attempt: 3 }, payload: validPayload, traceId: "t2" }), {
    jobId: "new", attempt: 3, payload: validPayload, traceId: "t2",
  });
  for (const envelope of [
    { version: 3, jobId: "x", attempt: 0, payload: validPayload },
    { version: 1, jobId: "x", attempt: 0, payload: validPayload, job: { id: "x", attempt: 0 } },
    { version: 2, job: { id: "x", attempt: 0 }, jobId: "x", payload: validPayload, traceId: "t" },
    { version: 2, job: { id: "x", attempt: 0 }, payload: validPayload, traceId: "t", extra: true },
    { version: 2, job: { id: "x", attempt: 0, extra: true }, payload: validPayload, traceId: "t" },
    { version: 2, job: { id: "", attempt: 0 }, payload: validPayload, traceId: "t" },
  ]) rejects(() => consumeEnvelope(envelope));
}

function integrationTests() {
  const input = { jobId: "roundtrip", attempt: 4, payload: { nested: true }, traceId: "trace-4" };
  assert.deepEqual(consumeEnvelope(createEnvelope(input)), input);
  assert.equal(protocol.LEGACY_VERSION, 1);
  assert.equal(protocol.CURRENT_VERSION, 2);
  assert.equal(typeof protocol.encodeCurrent, "function");
  assert.equal(typeof protocol.decodeAny, "function");
}

const mode = process.argv[2] || "all";
if (mode === "producer" || mode === "all") producerTests();
if (mode === "consumer" || mode === "all") consumerTests();
if (mode === "integration" || mode === "all") integrationTests();
console.log(`PASS ${mode}`);
