const assert = require("node:assert/strict");
const { normalizeEmail } = require("./src/normalize.js");
const { retryDelay } = require("./src/retry.js");

assert.equal(normalizeEmail("  ALICE@EXAMPLE.COM "), "alice@example.com");
assert.equal(normalizeEmail("not-an-email"), null);
assert.equal(normalizeEmail(null), null);
assert.equal(retryDelay(-3), 100);
assert.equal(retryDelay(0), 100);
assert.equal(retryDelay(1), 200);
assert.equal(retryDelay(3), 800);
assert.equal(retryDelay(8), 800);
console.log("PASS");
