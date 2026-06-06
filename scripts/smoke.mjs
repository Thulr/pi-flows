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

// The version must be valid semver and agree across the surfaces the release
// process keeps in sync (see CHANGELOG.md): package.json, PI_FLOWS_VERSION in the
// extension, and a matching CHANGELOG section. Staying version-agnostic keeps the
// publish workflow's `npm run check` from blocking bumped releases.
const version = packageJson.version;
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `package.json version must be semver, got "${version}"`);

const indexSource = readFileSync(path.join(root, "extensions/pi-flows/index.ts"), "utf8");
const indexVersion = indexSource.match(/PI_FLOWS_VERSION\s*=\s*"([^"]+)"/)?.[1];
assert.equal(indexVersion, version, `PI_FLOWS_VERSION (${indexVersion}) must match package.json version (${version})`);

const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const versionHeading = new RegExp(`^##\\s+${version.replace(/\./g, "\\.")}\\b`, "m");
assert.match(changelog, versionHeading, `CHANGELOG.md must document version ${version}`);
assert.ok(packageJson.files?.some((entry) => entry.includes("extensions/pi-flows/index.ts")), "package files should include extension entrypoint");

console.log("smoke ok: required docs/package metadata are present");
