// Preflight: verify the `pi` host CLI is installed, on PATH, and new enough
// before trying to load the extension. pi-flows is a pi extension and cannot run
// without it, and `npm ci` / `npm run check` do not install pi — so a fresh
// machine can pass the repo checks yet still hit `pi: command not found`, or an
// old pi that loads the extension and then fails. This fails fast with an
// actionable message instead.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PI_PROJECT = "https://github.com/earendil-works/pi";

/** Extract the first `major.minor.patch[-prerelease]` triple from a string. For
 * `engines.pi` (`>=0.82.0`) that is the supported floor; for a `pi --version`
 * banner it is the reported version, whatever prose surrounds it. */
function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text ?? "");
  if (!match) return undefined;
  return {
    text: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

/** Semver precedence, narrowed to what a floor check needs: a prerelease sorts
 * below the release it precedes, so 0.82.0-rc.1 does not satisfy `>=0.82.0`. */
function compareVersions(a, b) {
  for (const part of ["major", "minor", "patch"]) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

// One source of truth for the floor: `engines.pi` in package.json. Restating the
// number here is exactly the drift this check exists to catch.
const enginesPi = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines?.pi;
const minimum = parseVersion(enginesPi);

if (!minimum) {
  console.error(`✗ package.json "engines.pi" has no version to compare against: ${JSON.stringify(enginesPi ?? null)}.`);
  console.error('  Set it to a floor such as ">=0.82.0", then re-run this check.');
  process.exit(1);
}

const result = spawnSync("pi", ["--version"], { encoding: "utf8" });

if (result.error?.code === "ENOENT") {
  console.error("✗ pi CLI not found on PATH.");
  console.error("");
  console.error(`  pi-flows is a pi extension — it needs the pi host CLI (>=${minimum.text}) to run.`);
  console.error("  The `pi` binary ships in @earendil-works/pi-coding-agent.");
  console.error(`  Install it from the pi project, then re-run this check: ${PI_PROJECT}`);
  console.error("  e.g.  npm i -g @earendil-works/pi-coding-agent");
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`✗ \`pi --version\` exited with code ${result.status}.`);
  const stderr = (result.stderr || "").trim();
  if (stderr) console.error(`  ${stderr}`);
  console.error(`  Verify your pi install (>=${minimum.text}): ${PI_PROJECT}`);
  process.exit(1);
}

// `pi --version` writes the version string to stderr, so check both channels.
const banner = (result.stdout || "").trim() || (result.stderr || "").trim();
const found = parseVersion(banner);

// A version we cannot read is not evidence of an unsupported one: pi answered,
// so the install works. Say what could not be checked rather than failing a
// setup that is probably fine.
if (!found) {
  console.warn(`⚠ pi is on PATH, but \`pi --version\` reported no readable version: ${banner || "(no output)"}`);
  console.warn(`  pi-flows needs pi >=${minimum.text} — confirm your version by hand: ${PI_PROJECT}`);
  process.exit(0);
}

if (compareVersions(found, minimum) < 0) {
  console.error(`✗ pi ${found.text} is older than the minimum supported version ${minimum.text}.`);
  console.error("");
  console.error(`  pi-flows is built and tested against pi >=${minimum.text}; older hosts are unsupported`);
  console.error("  and can fail when the extension loads. Upgrade the pi CLI, then re-run this check:");
  console.error("  e.g.  npm i -g @earendil-works/pi-coding-agent@latest");
  console.error(`  Details: ${PI_PROJECT}`);
  process.exit(1);
}

console.log(`✓ pi found on PATH: ${banner} (satisfies >=${minimum.text})`);
