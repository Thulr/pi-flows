// File-length lint: fail `npm run check` before any source file grows into an
// unreviewable monolith (the original single-file extension reached 3,547
// lines). Dependency-free by design, like the other scripts/ checks.
//
// Usage:
//   node scripts/check-file-length.mjs            # lint with the caps below
//   node scripts/check-file-length.mjs --max-lines=400   # override the default cap
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const SOURCE_DIRS = ["extensions", "scripts", "tests", "evals"];
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

// Default cap for extension/library source. Tests get more room: table-driven
// suites legitimately run longer, but they must still stay reviewable.
const DEFAULT_MAX_LINES = 500;
const DIR_OVERRIDES = { tests: 800 };

const flag = process.argv.find((arg) => arg.startsWith("--max-lines="));
const flagValue = flag ? Number(flag.split("=")[1]) : undefined;
if (flag && (!Number.isInteger(flagValue) || flagValue < 1)) {
  console.error(`✗ Invalid --max-lines value "${flag.split("=")[1]}": expected a positive integer, e.g. --max-lines=500.`);
  process.exit(2);
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      yield* sourceFiles(filePath);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield filePath;
    }
  }
}

const failures = [];
let checked = 0;
for (const dir of SOURCE_DIRS) {
  const absDir = path.join(root, dir);
  try {
    statSync(absDir);
  } catch {
    continue;
  }
  const maxLines = flagValue ?? DIR_OVERRIDES[dir] ?? DEFAULT_MAX_LINES;
  for (const filePath of sourceFiles(absDir)) {
    checked += 1;
    const lines = readFileSync(filePath, "utf8").split("\n").length;
    if (lines > maxLines) failures.push({ filePath: path.relative(root, filePath), lines, maxLines });
  }
}

if (failures.length > 0) {
  for (const { filePath, lines, maxLines } of failures) {
    console.error(`✗ ${filePath} is ${lines} lines, over the ${maxLines}-line cap. Split it into focused modules (see extensions/pi-flows/modes/ for the pattern) instead of raising the cap.`);
  }
  process.exit(1);
}

console.log(`file-length ok: ${checked} source files within their line caps`);
