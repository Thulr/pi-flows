const protocol = require("./protocol");

function consumeEnvelope(envelope) {
  if (envelope.version !== protocol.CURRENT_VERSION) throw new Error("version");
  return { jobId: envelope.jobId, attempt: envelope.attempt, payload: envelope.payload, traceId: null };
}

module.exports = { consumeEnvelope };
