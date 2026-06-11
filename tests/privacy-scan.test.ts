import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = process.cwd();
const privacyScan = path.join(repoRoot, "scripts", "privacy-scan.mjs");

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("privacy scan --staged reads staged blobs, not the working tree", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "pi-flows-privacy-scan-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);

  const file = path.join(repo, "secret.txt");
  await writeFile(file, 'api_key = "abcDEF1234567890_abcdef"\n', "utf8"); // privacy-scan: allow deliberate staged-secret fixture; gitleaks:allow
  git(repo, ["add", "secret.txt"]);
  await writeFile(file, 'api_key = "redacted"\n', "utf8");

  const result = spawnSync(process.execPath, [privacyScan, "--staged"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(result.status, 0, "staged scan must fail on the indexed secret even when the worktree is clean");
  assert.match(result.stderr, /secret\.txt:1 secret-assignment/);
});
