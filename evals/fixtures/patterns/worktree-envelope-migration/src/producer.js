const protocol = require("./protocol");

function createEnvelope({ jobId, attempt, payload }) {
  return { version: protocol.CURRENT_VERSION, jobId, attempt, payload };
}

module.exports = { createEnvelope };
