// Preflight: verify the `pi` host CLI is installed and on PATH before trying to
// load the extension. pi-flows is a pi extension and cannot run without it, and
// `npm ci` / `npm run check` do not install pi — so a fresh machine can pass the
// repo checks yet still hit `pi: command not found`. This fails fast with an
// actionable message instead.
import { spawnSync } from "node:child_process";

const PI_PROJECT = "https://github.com/earendil-works/pi";
const MIN_VERSION = "0.78.0";

const result = spawnSync("pi", ["--version"], { encoding: "utf8" });

if (result.error?.code === "ENOENT") {
  console.error("✗ pi CLI not found on PATH.");
  console.error("");
  console.error(`  pi-flows is a pi extension — it needs the pi host CLI (>=${MIN_VERSION}) to run.`);
  console.error("  The `pi` binary ships in @earendil-works/pi-coding-agent.");
  console.error(`  Install it from the pi project, then re-run this check: ${PI_PROJECT}`);
  console.error("  e.g.  npm i -g @earendil-works/pi-coding-agent");
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`✗ \`pi --version\` exited with code ${result.status}.`);
  const stderr = (result.stderr || "").trim();
  if (stderr) console.error(`  ${stderr}`);
  console.error(`  Verify your pi install (>=${MIN_VERSION}): ${PI_PROJECT}`);
  process.exit(1);
}

// `pi --version` writes the version string to stderr, so check both channels.
const version = ((result.stdout || "").trim() || (result.stderr || "").trim()) || "(version not reported)";
console.log(`✓ pi found on PATH: ${version}`);
