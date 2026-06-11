// Privacy scan for PR safety. It blocks internal-only paths, obvious secrets,
// and high-signal PII before files reach a commit or CI.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const mode = process.argv.includes("--staged") ? "staged" : "all";
const allowMarker = "privacy-scan: allow";

const forbiddenPaths = [
  { pattern: /^docs\/research(?:\/|$)/, reason: "internal research notes must not be committed" },
  { pattern: /^audit-artifacts(?:\/|$)/, reason: "generated audit artifacts must not be committed" },
  { pattern: /^\.thulr(?:\/|$)/, reason: "local thulr run/event artifacts must not be committed" },
  { pattern: /^\.pi(?:\/|$)/, reason: "local pi state must not be committed" },
  { pattern: /^evals\/thulr-trace(?:\.dry-run)?\.jsonl$/, reason: "generated eval traces must not be committed" },
  { pattern: /^evals\/(?:baseline|compare)\.json$/, reason: "generated eval outputs must not be committed" },
  { pattern: /(?:^|\/)\.env(?:\..+)?$/, reason: "environment files must not be committed", allow: (file) => file === ".env.example" },
  { pattern: /\.log$/, reason: "logs must not be committed" },
];

const lineRules = [
  { id: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { id: "aws-access-key-id", pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "openai-api-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36,}\b/ },
  { id: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { id: "internal-marker", pattern: /\b(?:confidential|internal only|do not distribute|company confidential|customer data|employee data)\b/i }, // privacy-scan: allow detector pattern
];

const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const creditCardPattern = /\b(?:\d[ -]*?){13,19}\b/g;
const assignmentPattern = /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?([^"',;\s`]+)/i;

function git(args) {
  return execFileSync("git", args, { encoding: "buffer" }).toString("utf8");
}

function gitBuffer(args) {
  return execFileSync("git", args, { encoding: "buffer" });
}

function splitNul(output) {
  return output.split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
}

function filesToScan() {
  if (mode === "staged") return splitNul(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));
  const tracked = splitNul(git(["ls-files", "-z"]));
  const untracked = splitNul(git(["ls-files", "--others", "--exclude-standard", "-z"]));
  return [...new Set([...tracked, ...untracked])];
}

function isText(buffer) {
  return !buffer.includes(0);
}

function isPlaceholder(value) {
  const normalized = value.toLowerCase();
  return /^(?:example|placeholder|changeme|redacted|dummy|fake|test|todo|none|null|undefined)$/i.test(value)
    || normalized.includes("example")
    || normalized.includes("placeholder")
    || normalized.includes("redacted")
    || normalized.includes("do-not-leak")
    || normalized.includes("super-secret")
    || value.includes("...")
    || value.includes("<")
    || value.includes("${");
}

function hasEnoughSecretShape(value) {
  if (value.length < 16 || isPlaceholder(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[_+/=-]/].filter((rule) => rule.test(value)).length;
  return classes >= 3 || value.length >= 28;
}

function luhn(digits) {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function lineFailures(file, line, lineNumber) {
  if (line.includes(allowMarker)) return [];
  const failures = [];

  for (const rule of lineRules) {
    if (rule.pattern.test(line)) failures.push({ file, line: lineNumber, rule: rule.id });
  }

  for (const match of line.matchAll(emailPattern)) {
    const domain = match[1].toLowerCase();
    if (!["example.com", "example.org", "example.net", "localhost.test"].includes(domain)) {
      failures.push({ file, line: lineNumber, rule: "email-address" });
    }
  }

  for (const match of line.matchAll(creditCardPattern)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) {
      failures.push({ file, line: lineNumber, rule: "credit-card-number" });
    }
  }

  const assignment = line.match(assignmentPattern);
  if (assignment && hasEnoughSecretShape(assignment[1])) {
    failures.push({ file, line: lineNumber, rule: "secret-assignment" });
  }

  return failures;
}

const failures = [];
const files = filesToScan();

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(normalized) && !rule.allow?.(normalized)) {
      failures.push({ file: normalized, line: 1, rule: "forbidden-path", reason: rule.reason });
    }
  }

  let buffer;
  if (mode === "staged") {
    buffer = gitBuffer(["show", `:${file}`]);
  } else {
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    buffer = readFileSync(absolute);
  }
  if (!isText(buffer)) continue;
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    failures.push(...lineFailures(normalized, lines[index], index + 1));
  }
}

if (failures.length > 0) {
  console.error(`privacy scan failed (${failures.length} finding${failures.length === 1 ? "" : "s"}):`);
  for (const finding of failures) {
    const reason = finding.reason ? ` - ${finding.reason}` : "";
    console.error(`  ${finding.file}:${finding.line} ${finding.rule}${reason}`);
  }
  console.error(`Use "${allowMarker}" only for deliberate test fixtures or public placeholder examples.`);
  process.exit(1);
}

console.log(`privacy scan ok: ${files.length} ${mode === "staged" ? "staged" : "tracked/untracked"} file${files.length === 1 ? "" : "s"} checked`);
