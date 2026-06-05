import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredFiles = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "docs/quickstart.md",
  "docs/flow-reference.md",
  "docs/patterns.md",
  "docs/troubleshooting.md",
  "docs/privacy-telemetry.md",
  "examples/README.md",
];

for (const file of requiredFiles) {
  assert.ok(existsSync(path.join(root, file)), `missing required DX file: ${file}`);
}

const readme = readFileSync(path.join(root, "README.md"), "utf8");
for (const term of ["flow list", "showConfig", "Privacy", "CONTRIBUTING", "AGENTS.md"]) {
  assert.match(readme, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `README should mention ${term}`);
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(packageJson.version, "0.0.1");
assert.ok(packageJson.files?.some((entry) => entry.includes("extensions/pi-flows/index.ts")), "package files should include extension entrypoint");

console.log("smoke ok: required docs/package metadata are present");
