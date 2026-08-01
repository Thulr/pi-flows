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
  for (const [, specifier] of sources.get(file).matchAll(/from "(\.[^"]+)"/g)) {
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
for (const [file, source] of sources) {
  const foreign = /from "@earendil-works\//.test(source);
  if (foreign && !adapters.has(file) && !debt.has(file)) {
    flag("acl", `${MODULE_ROOT}/${file} imports a foreign package type but is neither a declared adapter nor recorded debt in ${REVIEW_FILE}`);
  }
  if (!foreign && debt.has(file)) {
    flag("acl", `${REVIEW_FILE} still records ${file} as foreign-import debt, but it no longer imports one — delete the entry and take the point`);
  }
}

const structural = [
  { row: "names", label: "Expert-readable names", pass: clean("names") },
  { row: "boundaries", label: "Explicit context boundaries (enforced import direction)", pass: clean("boundaries") },
  { row: "acl", label: "Anti-corruption layer at every external integration", pass: debt.size === 0 && clean("acl") },
  { row: "core-domain", label: "Core Domain identified (every module classified)", pass: subdomains.get("Core").length > 0 && clean("core-domain") },
];

// ---------------------------------------------------------------- carried judgment rows
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

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
function reviewDrift(coreFiles) {
  try {
    // A shallow clone grafts every path's history onto the same commit, so the
    // review file and the Core modules would report an identical "last touched"
    // and drift would read as fresh — silently vouching for rows nobody checked.
    // Unknown is the honest answer. CI checks out with fetch-depth: 0 for this.
    if (git("rev-parse", "--is-shallow-repository") === "true") return { known: false, stale: true, modules: [] };
    const dirty = new Set(gitDirtyPaths());
    const dirtyCore = coreFiles.filter((file) => dirty.has(file));
    // Re-reviewed in the same uncommitted change: fresh by construction.
    if (dirty.has(REVIEW_FILE)) return { known: true, stale: false, modules: [] };
    if (dirtyCore.length) return { known: true, stale: true, modules: dirtyCore, where: "in the working tree" };

    const reviewSha = git("log", "-1", "--format=%H", "--", REVIEW_FILE);
    const coreSha = git("log", "-1", "--format=%H", "--", ...coreFiles);
    if (!reviewSha || !coreSha || reviewSha === coreSha) return { known: true, stale: false, modules: [] };
    // Strictly older review = the core moved after it was taken.
    execFileSync("git", ["merge-base", "--is-ancestor", reviewSha, coreSha], { cwd: root, stdio: "ignore" });
    return {
      known: true,
      stale: true,
      modules: git("diff", "--name-only", `${reviewSha}..HEAD`, "--", ...coreFiles).split("\n").filter(Boolean),
      where: `after ${reviewSha.slice(0, 8)}`,
    };
  } catch (error) {
    // `merge-base --is-ancestor` exits 1 when the review is NOT older, which is
    // the fresh case; anything else (no git, unreadable history) is genuinely
    // unknown, and unknown is not "fresh" — say so rather than vouch for the rows.
    if (error?.status === 1) return { known: true, stale: false, modules: [] };
    return { known: false, stale: true, modules: [] };
  }
}

const coreFiles = [...placement].filter(([, hits]) => hits[0] === "Core").map(([file]) => `${MODULE_ROOT}/${file}`);
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
const staleReason = !drift.known
  ? "this checkout cannot be compared against the review (shallow clone, or no git)"
  : `${drift.modules.length} Core module(s) changed ${drift.where} without the review being re-recorded: ${drift.modules.join(", ")}`;

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
      lines.push(`- **Anti-corruption layer** — ${debt.size} accepted foreign-import debt: ${[...debt.values()].map((entry) => `\`${entry.module}\` (${entry.foreign})`).join(", ")}.`);
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
  for (const finding of findings) console.error(`✗ ${finding.message}`);
  if (findings.length) {
    console.error(`\n✗ domain model: ${findings.length} structural finding(s). These are mechanical rules — fix the code, or change the classification in ${CONTEXT_FILE} deliberately.`);
    process.exit(1);
  }
  console.log(`domain ok: ${structuralHeld} of ${structural.length} structural rows hold, none regressed`);
}
