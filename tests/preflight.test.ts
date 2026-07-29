import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

/** A fake `pi` that reports `banner` on stderr, where the real CLI writes its
 * version. Returns the executable's path so tests can assert which one ran. */
async function writeFakePi(dir: string, banner: string, exitCode = 0) {
  await mkdir(dir, { recursive: true });
  const bin = path.join(dir, "pi");
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(banner)} >&2\nexit ${exitCode}\n`, "utf8");
  await chmod(bin, 0o755);
  return bin;
}

/** Run preflight with an exact PATH, so the real CLI cannot leak into a test. */
function runPreflight(pathEntries: string[]) {
  return spawnSync(process.execPath, [checkPi], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: pathEntries.join(path.delimiter) },
  });
}

async function withFakePi(banner?: string, exitCode = 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-flows-preflight-"));
  if (banner !== undefined) await writeFakePi(dir, banner, exitCode);
  return runPreflight([dir]);
}

test("preflight accepts a pi at or above the declared floor", async () => {
  const floor = await supportedFloor();

  const exact = await withFakePi(render(floor));
  assert.equal(exact.status, 0, exact.stderr);
  assert.match(exact.stdout, new RegExp(`✓ pi ${render(floor)} at .*/pi \\(satisfies >=${render(floor)}\\)`));

  const newer = await withFakePi(`pi ${floor.major}.${floor.minor}.${floor.patch + 1} (darwin-arm64)`);
  assert.equal(newer.status, 0, newer.stderr);
  assert.match(newer.stdout, /^✓ pi /);
});

test("preflight rejects a pi below the declared floor and names both versions", async () => {
  const floor = await supportedFloor();
  const stale = justBelow(floor);

  const result = await withFakePi(stale);
  assert.equal(result.status, 1, "an unsupported host must fail the check, not warn");
  assert.match(result.stderr, new RegExp(`✗ pi ${stale} is older than the minimum supported version ${render(floor)}`));
  assert.match(result.stderr, /npm i -g @earendil-works\/pi-coding-agent@latest/);
});

test("preflight treats a prerelease as below the release it precedes", async () => {
  const floor = await supportedFloor();

  const result = await withFakePi(`${render(floor)}-rc.1`);
  assert.equal(result.status, 1, "0.x.y-rc.1 does not satisfy >=0.x.y");
  assert.match(result.stderr, new RegExp(`older than the minimum supported version ${render(floor)}`));
});

// npm prepends `node_modules/.bin` while running a script, and pi-coding-agent is
// a peer dependency — so in a clone there is a `pi` there that the user's shell
// will never run. Checking it would green-light a host that the documented
// `pi -e ./extensions/pi-flows/index.ts` never touches.
test("preflight checks the shell's pi, not the copy npm injects from node_modules/.bin", async () => {
  const floor = await supportedFloor();
  const root = await mkdtemp(path.join(tmpdir(), "pi-flows-preflight-"));
  const shellPi = await writeFakePi(path.join(root, "bin"), justBelow(floor));
  const injectedDir = path.join(root, "node_modules", ".bin");
  await writeFakePi(injectedDir, render(floor));

  // npm puts its bin directory first, so a naive lookup finds the supported one.
  const result = runPreflight([injectedDir, path.dirname(shellPi)]);
  assert.equal(result.status, 1, "the extension is loaded by the shell's pi, so that is the one to validate");
  assert.match(result.stderr, new RegExp(`✗ pi ${justBelow(floor)} is older`));
  assert.ok(result.stderr.includes(shellPi), `failure should name the binary it checked: ${result.stderr}`);
});

test("preflight reports a pi that exists only under node_modules/.bin as missing", async () => {
  const floor = await supportedFloor();
  const root = await mkdtemp(path.join(tmpdir(), "pi-flows-preflight-"));
  const injected = await writeFakePi(path.join(root, "node_modules", ".bin"), render(floor));

  const result = runPreflight([path.dirname(injected)]);
  assert.equal(result.status, 1, "a pi only reachable inside npm scripts cannot host the documented workflow");
  assert.match(result.stderr, /✗ pi CLI not found on PATH\./);
  assert.ok(result.stderr.includes(`There is a local copy at ${injected}`), result.stderr);
});

test("preflight warns instead of failing when the version cannot be read", async () => {
  const result = await withFakePi("pi (development build)");
  assert.equal(result.status, 0, "an unreadable banner is not evidence of an unsupported host");
  assert.match(result.stderr, /⚠ pi is on PATH \(.*\), but `pi --version` reported no readable version: pi \(development build\)/);
});

test("preflight fails when pi is missing or cannot report a version", async () => {
  const missing = await withFakePi(undefined);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /✗ pi CLI not found on PATH\./);

  const broken = await withFakePi("boom", 3);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /✗ `pi --version` exited with code 3/);
});
