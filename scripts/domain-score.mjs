// Domain-model score: the standing answer to "does this codebase still model the
// domain it claims to?", reported on every PR.
//
// The score has two halves and they are deliberately not mixed.
//
// STRUCTURE is checked here, every run, from the tree itself. Naming, module
// classification, subdomain import direction, and foreign-model containment are
// mechanical facts; a regression in one is a build failure, not an opinion.
//
// JUDGMENT is not. Whether an aggregate is the right size, whether the core model
// is rich or merely CRUD, whether the language holds together across docs, code,
// and tests — no grep settles those. Inventing a number for them would produce a
// metric that reads 10/10 while the model rots. So they are *carried* from the
// last recorded review in docs/domain-review.json. Row identity and required
// fields are fixed in scripts/domain-judgment.mjs; each row declares the surfaces
// whose changes invalidate it and stamps a content digest per surface at review
// time. A row whose surfaces moved is reported stale and drops out of the
// verified score rather than being repeated as fact — the same rule this codebase
// applies to an approval receipt whose digest no longer matches, and to trace
// health versus execution success. Stale is advisory; a missing or explicitly
// failed judgment is a failed score.
//
// Usage:
//   node scripts/domain-score.mjs                 # gate: fails on a structural finding or a failed/missing judgment
//   node scripts/domain-score.mjs --summary       # markdown for a PR comment, never fails
//   node scripts/domain-score.mjs --json          # machine-readable
//   node scripts/domain-score.mjs --record=<rows> # stamp review provenance for <rows> (comma-separated, or "all") against this tree
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SPELLED_ONCE } from "./domain-spelled-once.mjs";
import {
  ARCHITECTURE_FILE,
  JUDGMENT_ROWS,
  MODULE_ROOT,
  REVIEW_FILE,
  SUBDOMAINS,
  globToRe,
  judgmentRows,
  recordReview,
  validateJudgment,
} from "./domain-judgment.mjs";

const root = process.cwd();
/** Evans' naming smells: a name that describes a technical role instead of a domain concept. */
const JARGON = /(Manager|Helper|Processor|Utils?|Impl|Coordinator|Wrapper)$/;
const FLAGS = new Set(["--summary", "--json"]);
const args = new Set(process.argv.slice(2));
let recordRows;
for (const arg of args) {
  if (arg.startsWith("--record=")) {
    const named = arg.slice("--record=".length);
    recordRows = named === "all" ? [...JUDGMENT_ROWS] : named.split(",").map((row) => row.trim()).filter(Boolean);
    args.delete(arg);
  } else if (!FLAGS.has(arg)) {
    console.error(`✗ Unknown option "${arg}": expected --summary, --json, --record=<rows|all>, or no option to run as a gate.`);
    process.exit(2);
  }
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const review = JSON.parse(readFileSync(path.join(root, REVIEW_FILE), "utf8"));

function moduleSources() {
  const sources = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|mjs)$/.test(entry.name)) sources.set(rel.slice(MODULE_ROOT.length + 1), readFileSync(path.join(root, rel), "utf8"));
    }
  };
  walk(MODULE_ROOT);
  return new Map([...sources].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The classification comes from the architecture ledger, not from a copy kept
 * here: the document a human reads and the rule the build enforces have to be
 * the same statement, or the classification drifts into decoration. The import
 * direction is read from the same ledger for the same reason — a second copy in
 * this script would be a mirror that has to be kept in agreement by hand.
 */
function declaredSubdomains() {
  const ledger = readFileSync(path.join(root, ARCHITECTURE_FILE), "utf8");
  const declared = new Map();
  for (const subdomain of SUBDOMAINS) {
    const heading = new RegExp(`\\*\\*${subdomain}[^*]*\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|\\n## )`, "i");
    const section = ledger.match(heading)?.[1] ?? "";
    const modules = section.match(/_Modules_: (.+)/)?.[1] ?? "";
    declared.set(subdomain, [...modules.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  }
  return declared;
}

/**
 * The import direction, parsed from the ledger's `## Import direction` section.
 * Each row is `- **From** → A, B, C`; a subdomain not listed may import freely.
 * A row naming a subdomain outside the classification is a gate failure rather
 * than a silently unconstrained import — fail closed on a typo.
 */
function declaredImportRules() {
  const ledger = readFileSync(path.join(root, ARCHITECTURE_FILE), "utf8");
  const section = ledger.match(/## Import direction([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
  const rules = new Map();
  for (const [, from, allowed] of section.matchAll(/^\s*-\s*\*\*([^*]+)\*\*\s*→\s*(.+)$/gm)) {
    const fromName = from.trim();
    if (!SUBDOMAINS.includes(fromName)) flag("boundaries", `${ARCHITECTURE_FILE} import-direction row names \`${fromName}\`, which is not one of: ${SUBDOMAINS.join(", ")}`);
    rules.set(fromName, allowed.split(/\s*,\s*/).map((name) => name.trim()));
  }
  return rules;
}

// One import matcher for every row that reads imports. Single quotes, double
// quotes and backticks are all valid specifiers, so accepting a subset would let
// a Core-to-Supporting import — or a foreign package — walk past the gate that
// exists to catch exactly those, just by changing how it is quoted.
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*["'`](\.[^"'`]+)["'`]/g;
const FOREIGN_IMPORT = /(?:from|import)\s*\(?\s*["'`](@earendil-works\/[^"'`/]+)["'`]/g;

/**
 * The debt ledger the change started from.
 *
 * "Shrink-only" is not a property of a list; it is a property of a list compared
 * against its predecessor. Without this, adding a foreign import and adding the
 * module to `debt` in the same change passes the gate — the leak gets recorded
 * instead of fixed, which is the one outcome the ledger exists to prevent.
 *
 * Returns `known: false` when there is nothing to compare against — no resolvable
 * base, or a base where the ledger did not exist yet (the change that introduces
 * it). Unverified is reported, not silently treated as a pass.
 */
function debtBaseline() {
  const baseRef = process.env.DOMAIN_SCORE_BASE?.trim() || "origin/main";
  let base;
  try {
    base = git("merge-base", "HEAD", baseRef);
  } catch {
    return { known: false, why: `no base revision to compare against (${baseRef} could not be resolved)` };
  }
  let recorded;
  try {
    // stderr ignored: "exists on disk, but not in <rev>" is the expected answer
    // for the change that introduces the ledger, not something to print.
    recorded = execFileSync("git", ["show", `${base}:${REVIEW_FILE}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { known: false, why: `the ledger did not exist at ${base.slice(0, 8)}, so this change introduces it` };
  }
  try {
    const entries = JSON.parse(recorded).foreignImports.debt;
    return { known: true, base, modules: new Map(entries.map((entry) => [entry.module, new Set(entry.imports ?? [])])) };
  } catch {
    return { known: false, why: `the ledger at ${base.slice(0, 8)} could not be parsed` };
  }
}

const findings = [];
const flag = (row, message) => findings.push({ row, message });
const clean = (row) => !findings.some((finding) => finding.row === row);

// ---------------------------------------------------------------- record mode
// Stamping provenance is a distinct act from scoring: it asserts a human ran
// the review on this tree for exactly the named rows, and it writes the ledger.
if (recordRows) {
  // The reviewer's local date, not UTC: an evening re-record must not stamp tomorrow.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const problems = recordReview(root, review, recordRows, today, declaredSubdomains());
  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem.message}`);
    process.exit(1);
  }
  writeFileSync(path.join(root, REVIEW_FILE), JSON.stringify(review, null, 2) + "\n");
  console.log(`recorded review provenance for ${recordRows.length} row(s) against the current tree: ${recordRows.join(", ")}`);
  process.exit(0);
}

// ---------------------------------------------------------------- structural rows
const sources = moduleSources();
const subdomains = declaredSubdomains();
const importRules = declaredImportRules();
const placement = new Map(
  [...sources.keys()].map((file) => [file, SUBDOMAINS.filter((subdomain) => subdomains.get(subdomain).some((pattern) => globToRe(pattern).test(file)))]),
);

// Row: expert-readable names.
for (const [file, source] of sources) {
  for (const [, name] of source.matchAll(/^export (?:default |abstract |async )*(?:class|interface|type|enum|function\*?|const|let) ([A-Za-z_$][\w$]*)/gm)) {
    if (JARGON.test(name)) flag("names", `${MODULE_ROOT}/${file}: exported \`${name}\` names a technical role, not a domain concept`);
  }
}

// Row: the classification names something real. A declared module that no longer
// exists is the same rot from the other side — and its judgment-row consequence
// is handled by the surface digests, which keep a deleted module's disappearance
// visible even after this table stops naming it.
for (const [subdomain, patterns] of subdomains) {
  for (const pattern of patterns) {
    if (![...sources.keys()].some((file) => globToRe(pattern).test(file))) {
      flag("core-domain", `${ARCHITECTURE_FILE} classifies \`${pattern}\` under ${subdomain}, but no such module exists — a deleted or renamed module has to leave the table too`);
    }
  }
}

// Row: every module is classified, exactly once. An unplaced module is the
// classification going stale — the failure mode that turns a subdomain split into
// decoration a year after it was written.
for (const [file, hits] of placement) {
  if (hits.length === 0) flag("core-domain", `${MODULE_ROOT}/${file} is in no ${ARCHITECTURE_FILE} subdomain — classify it under one of: ${SUBDOMAINS.join(", ")}`);
  if (hits.length > 1) flag("core-domain", `${MODULE_ROOT}/${file} is classified under ${hits.length} subdomains (${hits.join(", ")}) — a module belongs to one`);
}

// Row: import direction between subdomains.
for (const [file, hits] of placement) {
  const from = hits.length === 1 ? hits[0] : undefined;
  const allowed = from ? importRules.get(from) : undefined;
  if (!allowed) continue;
  for (const [, specifier] of sources.get(file).matchAll(RELATIVE_IMPORT)) {
    const target = path.normalize(path.join(path.dirname(file), specifier));
    const to = placement.get(target);
    if (!to || to.length !== 1 || allowed.includes(to[0])) continue;
    flag("boundaries", `${MODULE_ROOT}/${file} (${from}) imports ${target} (${to[0]}) — a ${from} module may only import ${allowed.join(" or ")}`);
  }
}

// Row: foreign-import containment. A foreign package type may be spoken only in
// a declared adapter; `debt` is the shrink-only ledger of places that still leak
// one, and an entry that no longer leaks must be deleted.
const adapters = new Set(review.foreignImports.adapters);
const debt = new Map(review.foreignImports.debt.map((entry) => [entry.module, entry]));
const foreignImportsOf = (source) => new Set([...source.matchAll(FOREIGN_IMPORT)].map((match) => match[1]));
for (const [file, source] of sources) {
  const actual = foreignImportsOf(source);
  if (actual.size && !adapters.has(file) && !debt.has(file)) {
    flag("acl", `${MODULE_ROOT}/${file} imports a foreign package type but is neither a declared adapter nor recorded debt in ${REVIEW_FILE}`);
  }
  const entry = debt.get(file);
  if (!entry) continue;
  if (!actual.size) {
    flag("acl", `${REVIEW_FILE} still records ${file} as foreign-import debt, but it no longer imports one — delete the entry and take the point`);
    continue;
  }
  // The declared set must be exactly what the module imports. Listing a module
  // is not a blanket exemption: without this, an entry already on the ledger
  // absorbs any further foreign package silently, and the ledger grows while
  // reporting the same two names.
  const declared = new Set(entry.imports ?? []);
  for (const specifier of actual) {
    if (!declared.has(specifier)) flag("acl", `${MODULE_ROOT}/${file} imports ${specifier}, which its ${REVIEW_FILE} debt entry does not declare — an existing entry does not exempt a module from new foreign imports`);
  }
  for (const specifier of declared) {
    if (!actual.has(specifier)) flag("acl", `${REVIEW_FILE} declares ${specifier} for ${file}, which no longer imports it — narrow the entry and take the ground back`);
  }
}

// The ledger may only shrink. A new entry means a foreign type reached a module
// that did not have one, and recording it is not the remedy.
const baseline = debtBaseline();
if (baseline.known) {
  for (const [module, entry] of debt) {
    const before = baseline.modules.get(module);
    if (!before) {
      flag("acl", `${REVIEW_FILE} adds \`${module}\` to the foreign-import debt ledger — the ledger is shrink-only, so a new leak has to be fixed rather than recorded`);
      continue;
    }
    for (const specifier of entry.imports ?? []) {
      if (!before.has(specifier)) flag("acl", `${REVIEW_FILE} widens \`${module}\` debt to include ${specifier} — an entry may narrow, never grow`);
    }
  }
}

// Row: consolidated concepts stay spelled once. The complement of the import
// rows: those hold subdomains apart, this holds a concept together — a shipped
// consolidation's "one home" is a fact about the whole tree, and nothing else
// re-checks it after the PR that established it merges.
for (const [file, source] of sources) {
  for (const entry of SPELLED_ONCE) {
    const count = [...source.matchAll(entry.pattern)].length;
    if (count > (entry.allowed[file] ?? 0)) {
      flag(
        "spelled-once",
        `${MODULE_ROOT}/${file} spells "${entry.concept}" ${count}× (allowance ${entry.allowed[file] ?? 0}) — the concept lives in ${entry.home}; reach it there rather than deriving it again`,
      );
    }
  }
}

// Labels state what the mechanical check actually proves — no more. "Foreign
// imports confined to declared adapters" is provable by grep; "an anti-corruption
// layer at every integration" is a judgment about translation quality, and lives
// with the other judgments if anyone wants to record it.
const structural = [
  { row: "names", label: "Expert-readable names", pass: clean("names") },
  { row: "boundaries", label: "Explicit context boundaries (enforced import direction)", pass: clean("boundaries") },
  { row: "acl", label: "Foreign imports confined to declared adapters (debt ledger empty)", pass: debt.size === 0 && clean("acl") },
  { row: "core-domain", label: "Every module classified exactly once, against a non-empty Core", pass: subdomains.get("Core").length > 0 && clean("core-domain") },
  { row: "spelled-once", label: "Consolidated concepts stay spelled once", pass: clean("spelled-once") },
];

// ---------------------------------------------------------------- judgment rows
const judgmentFindings = validateJudgment(review.judgment, subdomains);
const invalidRows = new Set(judgmentFindings.map((finding) => finding.row));
const judgment = judgmentRows(root, review.judgment, subdomains, invalidRows);

const structuralHeld = structural.filter((entry) => entry.pass).length;
const verified = structuralHeld + judgment.filter((entry) => entry.pass && !entry.stale).length;
const carried = judgment.filter((entry) => entry.pass && entry.stale).length;
const total = structural.length + judgment.length;
const failedJudgment = judgment.filter((entry) => !entry.pass);
const staleRows = judgment.filter((entry) => entry.stale);

// ---------------------------------------------------------------- output
const mark = (entry) => (!entry.pass ? "✗" : entry.stale ? "◌" : "✓");
const staleText = (entry) => `surfaces changed since the ${entry.reviewedAt} review: ${entry.staleBecause.join(", ")}`;
const recordHint = (rows) => `node scripts/domain-score.mjs --record=${rows.map((entry) => entry.row).join(",")}`;

if (args.has("--json")) {
  console.log(JSON.stringify({ verified, carried, total, structural, judgment, findings, judgmentFindings }, null, 2));
} else if (args.has("--summary")) {
  const lines = [
    "## Domain model score",
    "",
    `**${verified}/${total} verified** on this commit${carried ? ` · ${carried} carried from an out-of-date review, shown separately below` : ""}${failedJudgment.length ? ` · ${failedJudgment.length} judgment row(s) failed` : ""}`,
    "",
    "| | Row | Basis |",
    "|---|---|---|",
    ...structural.map((entry) => `| ${mark(entry)} | ${entry.label} | checked on this commit |`),
    ...judgment.filter((entry) => !entry.stale).map((entry) => `| ${mark(entry)} | ${entry.label} | ${entry.pass ? `reviewed ${entry.reviewedAt}, surfaces unchanged` : "failed or missing judgment"} |`),
    "",
  ];
  if (staleRows.length) {
    lines.push(
      "### Carried, not verified",
      "",
      "These judgments passed an earlier review, but their declared surfaces changed since. They are carried for context and count for nothing above.",
      "",
      ...staleRows.map((entry) => `- ◌ **${entry.label}** — ${staleText(entry)}`),
      "",
      `Re-run \`/domain-driven-design\` over the changed surfaces, then \`${recordHint(staleRows)}\`.`,
      "",
    );
  }
  if (findings.length) {
    lines.push("### Structural findings", "", ...findings.map((finding) => `- \`${finding.row}\` — ${finding.message}`), "");
  }
  if (judgmentFindings.length) {
    lines.push("### Judgment findings", "", ...judgmentFindings.map((finding) => `- \`${finding.row}\` — ${finding.message}`), "");
  }
  // A scoreboard nobody can act on is a vanity metric. Every unmet row states what
  // is actually wrong, from the recorded review or from this run.
  const open = failedJudgment.filter((entry) => !invalidRows.has(entry.row));
  if (open.length || debt.size) {
    lines.push("### Open rows", "");
    if (debt.size) {
      lines.push(`- **Foreign-import debt** — ${debt.size} accepted: ${[...debt.values()].map((entry) => `\`${entry.module}\` (${(entry.imports ?? []).join(", ")})`).join(", ")}.`);
    }
    lines.push(...open.map((entry) => `- **${entry.label}** — ${entry.note}`), "");
  }
  lines.push(`<sub>\`node scripts/domain-score.mjs\` · rows fixed in \`scripts/domain-judgment.mjs\` · judgment evidence recorded in \`${REVIEW_FILE}\`</sub>`);
  console.log(lines.join("\n"));
} else {
  console.log(`domain model: ${verified}/${total} verified${carried ? ` · ${carried} carried (stale)` : ""}`);
  for (const entry of structural) console.log(`  ${mark(entry)} ${entry.label}`);
  for (const entry of judgment) {
    const basis = !entry.pass ? entry.note : entry.stale ? `carried, not verified — ${staleText(entry)}` : `reviewed ${entry.reviewedAt}, surfaces unchanged`;
    console.log(`  ${mark(entry)} ${entry.label} — ${basis}`);
  }
  if (staleRows.length) console.log(`  ◌ ${staleRows.length} judgment row(s) carried, not verified (advisory): re-review, then \`${recordHint(staleRows)}\``);
  if (!baseline.known && debt.size) console.log(`  ◌ shrink-only ledger unverified: ${baseline.why}`);
  for (const finding of [...findings, ...judgmentFindings]) console.error(`✗ ${finding.message}`);
  if (findings.length || judgmentFindings.length) {
    console.error(`\n✗ domain model: ${findings.length} structural finding(s), ${judgmentFindings.length} judgment finding(s). Fix the code, change ${ARCHITECTURE_FILE} deliberately, or restore the ledger row.`);
    process.exit(1);
  }
  if (failedJudgment.length) {
    console.error(`✗ domain model: ${failedJudgment.length} judgment row(s) explicitly failed — a recorded failure is a failed score, not a smaller denominator.`);
    process.exit(1);
  }
  console.log(`domain ok: ${structuralHeld} of ${structural.length} structural rows hold and ${verified - structuralHeld} of ${judgment.length} judgment rows are verified for this tree`);
}
