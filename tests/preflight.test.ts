import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const repoRoot = process.cwd();
const checkPi = path.join(repoRoot, "scripts", "check-pi.mjs");

type Version = { major: number; minor: number; patch: number };

/** The floor the script enforces comes from package.json, so the fixtures below
 * are derived from it too — a floor bump must not silently invalidate them. */
async function supportedFloor(): Promise<Version> {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(manifest.engines?.pi ?? "");
  assert.ok(match, 'package.json "engines.pi" must declare a version floor');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function render(version: Version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function justBelow(version: Version) {
  if (version.patch > 0) return render({ ...version, patch: version.patch - 1 });
  if (version.minor > 0) return render({ ...version, minor: version.minor - 1, patch: 0 });
  return render({ major: version.major - 1, minor: 0, patch: 0 });
}

/** A directory holding a fake `pi`, used as the whole PATH so the script under
 * test cannot reach the real CLI. `banner` is written to stderr, where pi
 * reports its version. An omitted banner means "no pi on PATH at all". */
async function withFakePi(banner?: string, exitCode = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-flows-preflight-"));
  if (banner !== undefined) {
    const bin = path.join(dir, "pi");
    await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(banner)} >&2\nexit ${exitCode}\n`, "utf8");
    await chmod(bin, 0o755);
  }
  return spawnSync(process.execPath, [checkPi], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: dir },
  });
}

test("preflight accepts a pi at or above the declared floor", async () => {
  const floor = await supportedFloor();

  const exact = await withFakePi(render(floor));
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, new RegExp(`✓ pi found on PATH: ${render(floor)} \\(satisfies >=${render(floor)}\\)`));

  const newer = await withFakePi(`pi ${floor.major}.${floor.minor}.${floor.patch + 1} (darwin-arm64)`);
  assert.equal(newer.status, 0, newer.stderr);
  assert.match(newer.stdout, /^✓ pi found on PATH:/);
});

test("preflight rejects a pi below the declared floor and names both versions", async () => {
  const floor = await supportedFloor();
  const stale = justBelow(floor);

  const result = await withFakePi(stale);
  assert.equal(result.status, 1, "an unsupported host must fail the check, not warn");
  assert.match(result.stderr, new RegExp(`✗ pi ${stale} is older than the minimum supported version ${render(floor)}\\.`));
  assert.match(result.stderr, /npm i -g @earendil-works\/pi-coding-agent@latest/);
});

test("preflight treats a prerelease as below the release it precedes", async () => {
  const floor = await supportedFloor();

  const result = await withFakePi(`${render(floor)}-rc.1`);
  assert.equal(result.status, 1, "0.x.y-rc.1 does not satisfy >=0.x.y");
  assert.match(result.stderr, new RegExp(`older than the minimum supported version ${render(floor)}`));
});

test("preflight warns instead of failing when the version cannot be read", async () => {
  const result = await withFakePi("pi (development build)");
  assert.equal(result.status, 0, "an unreadable banner is not evidence of an unsupported host");
  assert.match(result.stderr, /⚠ pi is on PATH, but `pi --version` reported no readable version: pi \(development build\)/);
});

test("preflight fails when pi is missing or cannot report a version", async () => {
  const missing = await withFakePi(undefined);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /✗ pi CLI not found on PATH\./);

  const broken = await withFakePi("boom", 3);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /✗ `pi --version` exited with code 3\./);
});
