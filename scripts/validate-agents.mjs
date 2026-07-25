import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const agentsDir = path.join(process.cwd(), "agents");
const files = readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
assert.ok(files.length > 0, "expected bundled agent files");

const names = new Set();
for (const file of files) {
  const content = readFileSync(path.join(agentsDir, file), "utf8");
  assert.match(content, /^---\n[\s\S]*?\n---\n/, `${file} must have YAML frontmatter`);
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const tier = frontmatter.match(/^tier:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(name, `${file} missing name`);
  assert.ok(description, `${file} missing description`);
  if (tier !== undefined) {
    assert.ok(
      ["fast", "capable", "deep"].includes(tier),
      `${file} has invalid tier "${tier}"; expected one of fast, capable, deep`,
    );
  }
  assert.ok(!names.has(name), `duplicate agent name: ${name}`);
  names.add(name);
}

console.log(`agents ok: ${files.length} bundled agents`);
