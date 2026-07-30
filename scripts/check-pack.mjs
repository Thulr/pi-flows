import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

// npm <= 11 emits an array of pack reports; npm >= 12 emits an object keyed by
// package name. The publish workflow installs npm@latest, so handle both.
const parsed = JSON.parse(result.stdout);
const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
assert.ok(pack?.files, `unrecognized npm pack --json output shape: ${result.stdout.slice(0, 200)}`);
const files = pack.files.map((file) => file.path);
const forbidden = [/^audit-artifacts\//, /^docs\/audits\//, /^docs\/research\//, /^node_modules\//, /^tests\//, /^scripts\//, /\.log$/];
for (const file of files) {
  for (const pattern of forbidden) assert.ok(!pattern.test(file), `pack includes forbidden file: ${file}`);
}

for (const required of ["extensions/pi-flows/index.ts", "README.md", "LICENSE", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md"]) {
  assert.ok(files.includes(required), `pack missing required file: ${required}`);
}

// A packed source file that imports a relative module which is not itself
// packed ships a package that fails to load at runtime — the `files` globs are
// extension-suffix based, so a new file with an uncovered suffix slips through
// silently. Resolve every relative import in packed extension sources and
// require the target to be packed too.
const packedSet = new Set(files);
const relativeImportRe = /from\s+"(\.{1,2}\/[^"]+)"/g;
for (const file of files.filter((name) => name.startsWith("extensions/") && /\.(ts|mjs)$/.test(name))) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(relativeImportRe)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    assert.ok(packedSet.has(resolved), `pack missing ${resolved}, imported by ${file} — add it to package.json "files"`);
  }
}

// Typed integration handoffs, runtime/eval trace linkage, durable approval
// receipts, and coordination-boundary tracing each add public runtime modules
// and their reference documentation. The tracing work alone added five —
// trace-scope, trace-sink, trace-attributes, trace-report, and dispatch — plus
// the flow-reference and troubleshooting sections users need to read a trace and
// act on TRACE_INCOMPLETE. Retain explicit headroom without excluding that
// material. Raise this deliberately when a public surface grows, never to make an
// accidental inclusion fit — the forbidden-path and relative-import checks above
// are what catch those, and they are the reason a bump here is safe to make.
// Raised to 690_000 for the pi version-floor guidance in troubleshooting and its
// changelog entries; the previous 680_000 left under 200 bytes of headroom, so
// the next release note alone would have tripped it.
// Raised to 725_000 for the subagent UI surface: three new public runtime
// modules (ui-live-row, ui-run-card, fleet-panel), their flow-reference
// monitoring section, and changelog entries.
// Raised to 745_000 for CONTEXT.md: README and flow-reference now point at the
// glossary's term definitions instead of restating them, so the glossary has to
// ship or those links dangle in the tarball.
assert.ok(pack.unpackedSize < 745_000, `package unpacked size too large: ${pack.unpackedSize}`);
console.log(`pack ok: ${files.length} files, ${pack.unpackedSize} bytes unpacked`);
