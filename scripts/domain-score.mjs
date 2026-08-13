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
// last recorded review in docs/domain-review.json, and every carried row is
// labelled with when that review was taken. When a Core module was touched more
// recently than the review, the row is reported stale and drops out of the
// verified score rather than being repeated as fact — the same rule this codebase
// applies to an approval receipt whose digest no longer matches, and to trace
// health versus execution success.
//
// Usage:
//   node scripts/domain-score.mjs              # gate: fails on a NEW structural finding
//   node scripts/domain-score.mjs --summary    # markdown for a PR comment, never fails
//   node scripts/domain-score.mjs --json       # machine-readable
//
// Re-record the judgment rows by running the /domain-driven-design review and
// updating docs/domain-review.json. Staleness is measured from when that file was
// last touched relative to the Core modules, so editing it IS the re-recording —
// no commit id has to be maintained by hand.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SPELLED_ONCE } from "./domain-spelled-once.mjs";

const root = process.cwd();
const MODULE_ROOT = "extensions/pi-flows";
const REVIEW_FILE = "docs/domain-review.json";
const CONTEXT_FILE = "CONTEXT.md";
// The subdomain classes CONTEXT.md places every module into. The last two are
// structural roles rather than subdomains proper, but they are placements a
// module can hold, so they live in the same table.
const SUBDOMAINS = ["Core", "Supporting", "Generic", "Shared kernel", "Composition root"];
/** Evans' naming smells: a name that describes a technical role instead of a domain concept. */
const JARGON = /(Manager|Helper|Processor|Utils?|Impl|Coordinator|Wrapper)$/;
/**
 * Only the direction that actually carries meaning is constrained; anything not
 * listed here may import freely.
 *
 * Core reaching down into Generic plumbing is fine — commodity exists to be used,
 * and an adapter implementing a Core-defined seam (runner.ts over `runChild`)
 * depends on the domain rather than the reverse. Core reaching *sideways* into
 * Supporting is the real inversion: it makes the differentiator depend on the
 * recombinations of itself, and it is how a core model starts absorbing mode
 * special-cases and view concerns. The kernel is held to vocabulary only.
 */
const IMPORT_RULES = {
  Core: ["Core", "Generic", "Shared kernel"],
  "Shared kernel": ["Core", "Shared kernel"],
};
const FLAGS = new Set(["--summary", "--json"]);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!FLAGS.has(arg)) {
    console.error(`✗ Unknown option "${arg}": expected one of ${[...FLAGS].join(", ")}, or no option to run as a gate.`);
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
 * The classification comes from CONTEXT.md, not from a copy kept here: the
 * document a human reads and the rule the build enforces have to be the same
 * statement, or the classification drifts into decoration.
 */
function declaredSubdomains() {
  const context = readFileSync(path.join(root, CONTEXT_FILE), "utf8");
  const declared = new Map();
  for (const subdomain of SUBDOMAINS) {
    const heading = new RegExp(`\\*\\*${subdomain}[^*]*\\*\\*([\\s\\S]*?)(?=\\n\\*\\*|\\n## )`, "i");
    const section = context.match(heading)?.[1] ?? "";
    const modules = section.match(/_Modules_: (.+)/)?.[1] ?? "";
    declared.set(subdomain, [...modules.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  }
  return declared;
}

const globToRe = (pattern) => new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]*")}$`);

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

// ---------------------------------------------------------------- structural rows
const sources = moduleSources();
const subdomains = declaredSubdomains();
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
// exists is the same rot from the other side — and if it was Core, its deletion
// would otherwise never register as a Core change at all.
for (const [subdomain, patterns] of subdomains) {
  for (const pattern of patterns) {
    if (![...sources.keys()].some((file) => globToRe(pattern).test(file))) {
      flag("core-domain", `${CONTEXT_FILE} classifies \`${pattern}\` under ${subdomain}, but no such module exists — a deleted or renamed module has to leave the table too`);
    }
  }
}

// Row: every module is classified, exactly once. An unplaced module is the
// classification going stale — the failure mode that turns a subdomain split into
// decoration a year after it was written.
for (const [file, hits] of placement) {
  if (hits.length === 0) flag("core-domain", `${MODULE_ROOT}/${file} is in no ${CONTEXT_FILE} subdomain — classify it under one of: ${SUBDOMAINS.join(", ")}`);
  if (hits.length > 1) flag("core-domain", `${MODULE_ROOT}/${file} is classified under ${hits.length} subdomains (${hits.join(", ")}) — a module belongs to one`);
}

// Row: import direction between subdomains.
for (const [file, hits] of placement) {
  const from = hits.length === 1 ? hits[0] : undefined;
  const allowed = from ? IMPORT_RULES[from] : undefined;
  if (!allowed) continue;
  for (const [, specifier] of sources.get(file).matchAll(RELATIVE_IMPORT)) {
    const target = path.normalize(path.join(path.dirname(file), specifier));
    const to = placement.get(target);
    if (!to || to.length !== 1 || allowed.includes(to[0])) continue;
    flag("boundaries", `${MODULE_ROOT}/${file} (${from}) imports ${target} (${to[0]}) — a ${from} module may only import ${allowed.join(" or ")}`);
  }
}

// Row: anti-corruption layer. A foreign package type may be spoken only where the
// tree says a foreign protocol is spoken; `debt` is the shrink-only ledger of
// places that still leak one, and an entry that no longer leaks must be deleted.
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

const structural = [
  { row: "names", label: "Expert-readable names", pass: clean("names") },
  { row: "boundaries", label: "Explicit context boundaries (enforced import direction)", pass: clean("boundaries") },
  { row: "acl", label: "Anti-corruption layer at every external integration", pass: debt.size === 0 && clean("acl") },
  { row: "core-domain", label: "Core Domain identified (every module classified)", pass: subdomains.get("Core").length > 0 && clean("core-domain") },
  { row: "spelled-once", label: "Consolidated concepts stay spelled once", pass: clean("spelled-once") },
];

// ---------------------------------------------------------------- carried judgment rows
/**
 * Paths with uncommitted changes, including untracked files.
 *
 * Parsed without trimming the blob: porcelain puts a two-column status code
 * before each path, and an unstaged edit leads with a space (" M path"), so
 * trimming first shifts every path one character left and the set silently
 * matches nothing.
 */
function gitDirtyPaths() {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const filePath = line.slice(3);
      const renamedTo = filePath.indexOf(" -> ");
      return renamedTo === -1 ? filePath : filePath.slice(renamedTo + 4);
    });
}

/**
 * Judgment rows go stale when the Core Domain moved after the review was taken —
 * in the working tree, or in a commit later than the one that last touched the
 * review file.
 *
 * Anchored on when each file was last touched rather than on a recorded commit
 * id, because the recorded id cannot answer this question about itself: a review
 * file is *added* relative to the commit it names, so "was the review edited
 * since?" would read true forever and the rows would never go stale. Last-touched
 * also maintains itself — nobody has to bump a sha by hand, and a change that
 * edits Core and the review together is fresh by construction.
 */
/** True when `ancestor` is reachable from `descendant`. Exit 1 means "no", which is an answer, not a failure. */
function isAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root, stdio: "ignore" });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function reviewDrift(coreFiles) {
  try {
    // A shallow clone grafts every path's history onto the same commit, so the
    // review file and the Core modules would report an identical "last touched"
    // and drift would read as fresh — silently vouching for rows nobody checked.
    // Unknown is the honest answer. CI checks out with fetch-depth: 0 for this.
    if (git("rev-parse", "--is-shallow-repository") === "true") {
      return { known: false, stale: true, modules: [], why: "this is a shallow clone, so every path reports the same grafted commit and nothing can be ordered" };
    }
    const dirty = new Set(gitDirtyPaths());
    const dirtyCore = coreFiles.filter((file) => dirty.has(file));
    // Re-reviewed in the same uncommitted change: fresh by construction.
    if (dirty.has(REVIEW_FILE)) return { known: true, stale: false, modules: [] };
    if (dirtyCore.length) return { known: true, stale: true, modules: dirtyCore, where: "in the working tree" };

    const reviewSha = git("log", "-1", "--format=%H", "--", REVIEW_FILE);
    const coreSha = git("log", "-1", "--format=%H", "--", ...coreFiles);
    if (!reviewSha || !coreSha || reviewSha === coreSha) return { known: true, stale: false, modules: [] };
    // Three cases, and only one of them is fresh. Testing "is the review an
    // ancestor?" alone conflates the other two: a NOT-an-ancestor answer is
    // returned both when the review is newer (fresh) and when the two sit on
    // divergent branches of a merge, where neither is newer and the merged tree
    // can hold a Core change the review never saw. Order them explicitly.
    if (isAncestor(reviewSha, coreSha)) {
      return {
        known: true,
        stale: true,
        modules: git("diff", "--name-only", `${reviewSha}..HEAD`, "--", ...coreFiles).split("\n").filter(Boolean),
        where: `after ${reviewSha.slice(0, 8)}`,
      };
    }
    if (isAncestor(coreSha, reviewSha)) return { known: true, stale: false, modules: [] };
    return {
      known: false,
      stale: true,
      modules: [],
      why: `the review (${reviewSha.slice(0, 8)}) and the latest Core change (${coreSha.slice(0, 8)}) sit on divergent histories, so neither is newer and the merged tree may hold a Core change the review never saw`,
    };
  } catch {
    // No git, or history this checkout cannot read. Unknown is not "fresh" — say
    // so rather than vouch for rows nobody verified.
    return { known: false, stale: true, modules: [], why: "this checkout cannot be compared against the review (no git, or unreadable history)" };
  }
}

// Declared paths, not present ones: a Core module deleted in this change is
// exactly the Core change the judgment rows must not be reported as surviving.
// git resolves these as pathspecs, so a glob and a deleted file both work.
const coreFiles = subdomains.get("Core").map((pattern) => `${MODULE_ROOT}/${pattern}`);
const drift = reviewDrift(coreFiles);
const stale = drift.stale;
const judgment = Object.entries(review.judgment).map(([row, entry]) => ({
  row,
  label: entry.label,
  pass: entry.verdict === "pass",
  stale,
  note: entry.note,
}));

const structuralHeld = structural.filter((entry) => entry.pass).length;
const verified = structuralHeld + judgment.filter((entry) => entry.pass && !entry.stale).length;
const carried = structuralHeld + judgment.filter((entry) => entry.pass).length;
const total = structural.length + judgment.length;
// Provenance for the Basis column: when the review was taken. The tree state it
// was taken against is the review file's own git history, which is also what
// drift is measured from — so there is no second copy to keep in step.
const reviewedOn = review.reviewedAt;
const staleReason = drift.known
  ? `${drift.modules.length} Core module(s) changed ${drift.where} without the review being re-recorded: ${drift.modules.join(", ")}`
  : drift.why;

// ---------------------------------------------------------------- output
const mark = (entry) => (entry.stale ? "◌" : entry.pass ? "✓" : "✗");

if (args.has("--json")) {
  console.log(JSON.stringify({ verified, carried, total, stale, reviewedOn, ...(stale ? { staleReason } : {}), structural, judgment, findings }, null, 2));
} else if (args.has("--summary")) {
  const lines = [
    "## Domain model score",
    "",
    `**${carried}/${total}**${stale ? ` — ${verified}/${total} verified now, the rest carried from a review that is out of date` : " — structural rows verified on this commit"}`,
    "",
    "| | Row | Basis |",
    "|---|---|---|",
    ...structural.map((entry) => `| ${mark(entry)} | ${entry.label} | checked on this commit |`),
    ...judgment.map((entry) => `| ${mark(entry)} | ${entry.label} | ${entry.stale ? "**stale**" : `reviewed ${reviewedOn}`} |`),
    "",
  ];
  if (findings.length) {
    lines.push("### Structural findings", "", ...findings.map((finding) => `- \`${finding.row}\` — ${finding.message}`), "");
  }
  // A scoreboard nobody can act on is a vanity metric. Every unmet row states what
  // is actually wrong, from the recorded review or from this run.
  const open = judgment.filter((entry) => !entry.pass);
  if (open.length || debt.size) {
    lines.push("### Open rows", "");
    if (debt.size) {
      lines.push(`- **Anti-corruption layer** — ${debt.size} accepted foreign-import debt: ${[...debt.values()].map((entry) => `\`${entry.module}\` (${(entry.imports ?? []).join(", ")})`).join(", ")}.`);
    }
    lines.push(...open.map((entry) => `- **${entry.label}** — ${entry.note}`), "");
  }
  if (stale) {
    lines.push(`> Judgment rows are unverified for this change: ${staleReason}.`, "> Re-run `/domain-driven-design` and update `docs/domain-review.json` to re-establish them.", "");
  }
  lines.push(`<sub>\`node scripts/domain-score.mjs\` · rows and scoring defined by the domain-driven-design review · judgment rows recorded in \`${REVIEW_FILE}\`</sub>`);
  console.log(lines.join("\n"));
} else {
  console.log(`domain model: ${carried}/${total}${stale ? ` (${verified}/${total} verified now)` : ""}`);
  for (const entry of [...structural, ...judgment]) console.log(`  ${mark(entry)} ${entry.label}`);
  if (stale) console.log(`  ◌ judgment rows unverified: ${staleReason}`);
  if (!baseline.known && debt.size) console.log(`  ◌ shrink-only ledger unverified: ${baseline.why}`);
  for (const finding of findings) console.error(`✗ ${finding.message}`);
  if (findings.length) {
    console.error(`\n✗ domain model: ${findings.length} structural finding(s). These are mechanical rules — fix the code, or change the classification in ${CONTEXT_FILE} deliberately.`);
    process.exit(1);
  }
  console.log(`domain ok: ${structuralHeld} of ${structural.length} structural rows hold, none regressed`);
}
