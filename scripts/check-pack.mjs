import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

const [pack] = JSON.parse(result.stdout);
const files = pack.files.map((file) => file.path);
const forbidden = [/^audit-artifacts\//, /^docs\/audits\//, /^docs\/research\//, /^node_modules\//, /^tests\//, /^scripts\//, /\.log$/];
for (const file of files) {
  for (const pattern of forbidden) assert.ok(!pattern.test(file), `pack includes forbidden file: ${file}`);
}

for (const required of ["extensions/pi-flows/index.ts", "README.md", "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md"]) {
  assert.ok(files.includes(required), `pack missing required file: ${required}`);
}

assert.ok(pack.unpackedSize < 300_000, `package unpacked size too large: ${pack.unpackedSize}`);
console.log(`pack ok: ${files.length} files, ${pack.unpackedSize} bytes unpacked`);
