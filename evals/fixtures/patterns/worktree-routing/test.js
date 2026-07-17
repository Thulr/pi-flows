const assert = require("node:assert/strict");
const { clampWindow } = require("./src/window.js");
const { chooseRegion } = require("./src/routing.js");

assert.equal(clampWindow(7, 10, 0), 7);
assert.equal(clampWindow(-2, 10, 0), 0);
assert.equal(clampWindow(20, 10, 0), 10);
assert.equal(clampWindow(Number.NaN, 0, 10), 0);
assert.equal(chooseRegion([{ name: "a", latencyMs: 10, healthy: false }, { name: "b", latencyMs: 30, healthy: true }]), "b");
assert.equal(chooseRegion([{ name: "west", latencyMs: 20, healthy: true }, { name: "east", latencyMs: 20, healthy: true }]), "east");
assert.equal(chooseRegion([{ name: "a", latencyMs: 10, healthy: false }]), null);
console.log("PASS");
