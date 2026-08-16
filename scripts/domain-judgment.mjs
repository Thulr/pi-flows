// The judgment half of the domain-model score: the rows no grep settles.
//
// Row identity is fixed HERE, not in the ledger. The ledger records evidence
// for each row (verdict, note, declared surfaces, and review provenance);
// deleting or renaming a row in the ledger cannot shrink the denominator — it
// reads as a missing judgment, which is a failed score.
//
// Staleness is provenance, not git archaeology. Each row declares the surfaces
// (code, mode, shared-kernel, documentation, test files) whose changes would
// invalidate the judgment, and a recorded review stamps a content digest per
// surface as it stood in the reviewed tree. A row is stale when any declared
// surface's current digest differs from the stamped one. Content digests need
// no history, so a dirty tree, a merge of divergent branches, and a shallow
// clone all answer the same question the same way: does the tree the review
// vouched for still exist? Editing the ledger's prose changes no digest, so a
// ledger-only edit cannot mark a row fresh — only `--record`, which stamps the
// current tree, re-establishes one.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const MODULE_ROOT = "extensions/pi-flows";
export const REVIEW_FILE = "docs/domain-review.json";
export const ARCHITECTURE_FILE = "docs/reference/architecture.md";
// The subdomain classes the architecture ledger places every module into. The
// last two are structural roles rather than subdomains proper, but they are
// placements a module can hold, so they live in the same table.
export const SUBDOMAINS = ["Core", "Supporting", "Generic", "Shared kernel", "Composition root"];

/**
 * The fixed judgment rows. Adding or retiring one is a deliberate change to
 * this list, reviewed like any code change — never a quiet ledger edit.
 */
export const JUDGMENT_ROWS = [
  "small-aggregates",
  "behavior-rich",
  "domain-events",
  "depth-rich-core",
  "depth-invariants-in-aggregates",
  "depth-language-consistency",
];

const SURFACE_TOKEN = /^subdomain:(.+)$/;
const REVIEWED_AT = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST = /^[0-9a-f]{16}$/;
const SKIP_DIRS = new Set([".git", "node_modules", "audit-artifacts", ".thulr"]);

// Every regex metacharacter except `*` is escaped: a path with a `+` or `(` in
// it must match itself, not silently match nothing and read as a deleted file.
export const globToRe = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

/** Every regular file in the repo, as sorted repo-relative paths. Symlinks are skipped: a surface names its file directly. */
export function repoFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  walk("");
  return files.sort();
}

/**
 * The paths a declared surface covers right now.
 *
 * A plain entry is a repo-relative glob. A `subdomain:<Name>` entry expands to
 * that subdomain's currently classified modules PLUS the architecture ledger
 * itself — so reclassifying a module changes the surface's content even when
 * every file it used to cover is untouched, and a deleted module changes it
 * even after the classification stops naming it (the ledger edit is part of
 * the surface). An entry matching nothing is not an error here: a surface
 * whose files were deleted must keep reading as changed, not as invalid.
 */
export function expandSurface(entry, files, subdomains) {
  const subdomainRef = entry.match(SURFACE_TOKEN);
  if (!subdomainRef) {
    const pattern = globToRe(entry);
    return files.filter((file) => pattern.test(file));
  }
  const patterns = (subdomains.get(subdomainRef[1]) ?? []).map((pattern) => globToRe(`${MODULE_ROOT}/${pattern}`));
  const matched = files.filter((file) => patterns.some((pattern) => pattern.test(file)));
  if (files.includes(ARCHITECTURE_FILE)) matched.unshift(ARCHITECTURE_FILE);
  return matched;
}

/**
 * Digest of a row's declared surface list, order-insensitive. Stamped at
 * record time and re-checked on every run, so trimming a changed surface out
 * of a row's declaration cannot make the row read fresh: the trim invalidates
 * the stamp, and the only sanctioned way to a new stamp is `--record`, which
 * is recorded review provenance for the current tree.
 */
export function declaredDigest(surfaces) {
  const hash = createHash("sha256");
  for (const surface of [...surfaces].sort()) {
    hash.update(surface);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Content digest of a surface: the covered paths and their bytes, in one stable order. */
export function surfaceDigest(root, covered) {
  const hash = createHash("sha256");
  for (const file of [...covered].sort()) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, file)));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 16);
}

const isText = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * Schema findings for the ledger's judgment section. Fail closed: a row the
 * fixed set expects but the ledger lacks, a row the fixed set does not know,
 * and a row missing a required field are all findings — each one is a way a
 * judgment could otherwise vanish from the score without anyone deciding that.
 */
export function validateJudgment(judgment, subdomains) {
  const findings = [];
  const flag = (row, message) => findings.push({ row, message });
  for (const row of Object.keys(judgment ?? {})) {
    if (!JUDGMENT_ROWS.includes(row)) flag(row, `${REVIEW_FILE} records judgment row \`${row}\`, which is not in the fixed set — add it to JUDGMENT_ROWS in scripts/domain-judgment.mjs deliberately, or remove it`);
  }
  for (const row of JUDGMENT_ROWS) {
    const entry = judgment?.[row];
    if (!entry) {
      flag(row, `${REVIEW_FILE} is missing judgment row \`${row}\` — a missing judgment is a failed row, never a smaller denominator`);
      continue;
    }
    if (!isText(entry.label)) flag(row, `judgment row \`${row}\` has no label`);
    if (entry.verdict !== "pass" && entry.verdict !== "fail") flag(row, `judgment row \`${row}\` has verdict "${entry.verdict}" — expected "pass" or "fail"`);
    if (!isText(entry.note)) flag(row, `judgment row \`${row}\` has no note — a verdict without recorded reasoning is not evidence`);
    if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0 || !entry.surfaces.every(isText)) {
      flag(row, `judgment row \`${row}\` declares no surfaces — every judgment must name the code, mode, shared-kernel, documentation, or test surfaces whose changes make it stale`);
      continue;
    }
    for (const surface of entry.surfaces) {
      const subdomainRef = surface.match(SURFACE_TOKEN);
      if (subdomainRef && !subdomains.has(subdomainRef[1])) flag(row, `judgment row \`${row}\` surface \`${surface}\` names an unknown subdomain — expected one of: ${[...subdomains.keys()].join(", ")}`);
    }
    if (!entry.reviewed) {
      flag(row, `judgment row \`${row}\` has no recorded review provenance — run \`node scripts/domain-score.mjs --record=${row}\` after actually reviewing it`);
      continue;
    }
    if (!REVIEWED_AT.test(entry.reviewed.at ?? "")) flag(row, `judgment row \`${row}\` review date "${entry.reviewed.at}" is not YYYY-MM-DD`);
    if (entry.reviewed.declared !== declaredDigest(entry.surfaces)) {
      flag(row, `judgment row \`${row}\` changed its declared surfaces after the recorded review — trimming a surface is not re-reviewing it; re-run \`node scripts/domain-score.mjs --record=${row}\``);
    }
    const stamped = Object.keys(entry.reviewed.surfaces ?? {});
    const declared = entry.surfaces;
    if (stamped.length !== declared.length || !declared.every((surface) => DIGEST.test(entry.reviewed.surfaces?.[surface] ?? ""))) {
      flag(row, `judgment row \`${row}\` review provenance does not stamp exactly its declared surfaces — re-run \`node scripts/domain-score.mjs --record=${row}\``);
    }
  }
  return findings;
}

/**
 * The judgment rows as the score reports them. Rows with schema findings are
 * failed; valid rows carry their verdict plus staleness, with the changed
 * surfaces named so the report is actionable.
 */
export function judgmentRows(root, judgment, subdomains, invalidRows) {
  const files = repoFiles(root);
  return JUDGMENT_ROWS.map((row) => {
    const entry = judgment?.[row];
    if (!entry || invalidRows.has(row)) {
      return { row, label: entry?.label ?? row, pass: false, stale: false, staleBecause: [], reviewedAt: entry?.reviewed?.at, note: entry?.note ?? "missing from the ledger" };
    }
    const staleBecause = entry.surfaces.filter((surface) => surfaceDigest(root, expandSurface(surface, files, subdomains)) !== entry.reviewed.surfaces[surface]);
    return { row, label: entry.label, pass: entry.verdict === "pass", stale: staleBecause.length > 0, staleBecause, reviewedAt: entry.reviewed.at, note: entry.note };
  });
}

/**
 * Stamp review provenance for the named rows against the current tree. This
 * IS the re-recording: it asserts a human ran the review on this tree for
 * exactly these rows. Refuses a surface that covers no files — an empty
 * surface stamps clean forever, which is how a typo becomes a blind spot.
 */
export function recordReview(root, review, rows, today, subdomains) {
  const findings = [];
  const files = repoFiles(root);
  for (const row of rows) {
    const entry = review.judgment?.[row];
    if (!JUDGMENT_ROWS.includes(row) || !entry) {
      findings.push({ row, message: `cannot record \`${row}\`: not a judgment row of the fixed set with a ledger entry` });
      continue;
    }
    if (!Array.isArray(entry.surfaces) || !entry.surfaces.length) {
      findings.push({ row, message: `cannot record \`${row}\`: it declares no surfaces` });
      continue;
    }
    const stamped = {};
    for (const surface of entry.surfaces) {
      const covered = expandSurface(surface, files, subdomains);
      if (!covered.length) {
        findings.push({ row, message: `cannot record \`${row}\`: surface \`${surface}\` covers no files — fix the entry rather than stamping an empty digest` });
        continue;
      }
      stamped[surface] = surfaceDigest(root, covered);
    }
    if (Object.keys(stamped).length === entry.surfaces.length) entry.reviewed = { at: today, declared: declaredDigest(entry.surfaces), surfaces: stamped };
  }
  return findings;
}
