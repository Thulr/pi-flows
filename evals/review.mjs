// Record (or list) a human SME review verdict for an eval case.
//
// A verdict lands in two places, because two things consume it. `thulr review`
// gets it for thulr's own judge-vs-human TPR/TNR, and an extended pi-flows review
// set gets it with the fields thulr's schema has no room for: which dimension was
// judged, whether the reviewer was blinded to the judge's verdict, and whether
// this verdict is an ordinary review or an adjudication settling a disagreement.
// The pi-flows calibration pass reads the extended set; see evals/README.md.
//
// Blinding is opt-in and NOT the default, deliberately. A reviewer who has
// already seen the judge's call is anchored by it, and the harness should record
// that rather than assume it away — only `--blinded` verdicts count as
// independent evidence.
//
//   npm run eval:review -- --list                                   # reviewed / unreviewed case ids
//   npm run eval:review -- --case route-classifies-bug-to-recon --verdict pass --blinded --reviewer justin
//   npm run eval:review -- --case single-answer-quality-judged --verdict fail --failure-mode final_answer.incomplete --note "missed the TTL bug"
//   npm run eval:review -- --case pattern-dossier-holdout-auth --verdict fail --dimension evidence_quality --blinded --reviewer ada
//   npm run eval:review -- --case vote-reaches-known-consensus --verdict pass --role adjudicator --reviewer barbara
//   npm run eval:review -- --trace evals/thulr-trace.jsonl --case x --verdict pass   # explicit trace
//
// Flags accept either `--name value` (as thulr's own CLI does) or `--name=value`.
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "./args.mjs";
import { recordReview, reviewSetPath, REVIEW_ROLES, REVIEW_VERDICTS } from "./review-agreement.mjs";
import * as thulr from "./thulr.mjs";

const opts = parseArgs(process.argv.slice(2));
const traceArg = opts.trace ?? "evals/thulr-trace.jsonl";
const trace = resolve(process.cwd(), traceArg);
const list = Boolean(opts.list);
const caseId = opts.case ?? null;
const verdict = opts.verdict ?? null;
const failureMode = opts["failure-mode"] ?? null;
const note = opts.note ?? null;
const reviewer = opts.reviewer ?? null;
const dimension = opts.dimension ?? "criterion";
const role = opts.role ?? "reviewer";
const blinded = Boolean(opts.blinded);

const usage = [
	"Record a verdict:  npm run eval:review -- --case <id> --verdict <pass|fail|unsure> [--dimension <name>] [--blinded] [--role <reviewer|adjudicator>] [--reviewer <name>] [--failure-mode <tag>] [--note <text>]",
	"List state:        npm run eval:review -- --list",
].join("\n");

const refuse = (message) => {
	console.error(`${message}\n\n${usage}`);
	process.exit(2);
};

if (!thulr.available()) {
	console.error("✗ `thulr` was not found on PATH.\n  Install it (e.g. `cargo install thulr`) — `thulr review` records the SME verdicts that calibration reads.");
	process.exit(2);
}
if (!existsSync(trace)) {
	console.error(`✗ Trace not found: ${traceArg}\n  Run \`npm run eval\` first to produce it, or pass --trace <path>.`);
	process.exit(2);
}
if (!list) {
	if (!caseId || !verdict) refuse("✗ Recording a verdict needs both --case and --verdict.");
	if (!REVIEW_VERDICTS.includes(verdict)) refuse(`✗ --verdict must be one of ${REVIEW_VERDICTS.join(" | ")}, got '${verdict}'.`);
	if (!REVIEW_ROLES.includes(role)) refuse(`✗ --role must be one of ${REVIEW_ROLES.join(" | ")}, got '${role}'.`);
	// An adjudication overrides other people's verdicts, so it has to be attributable.
	if (role === "adjudicator" && !reviewer) refuse("✗ --role adjudicator needs --reviewer <name>: an adjudicated label must say who adjudicated it.");
}

try {
	process.stdout.write(thulr.review({ trace, list, caseId, verdict, failureMode, note, reviewer }));
	if (list) process.exit(0);

	const setPath = reviewSetPath(trace);
	recordReview(setPath, {
		case_id: caseId,
		dimension,
		verdict,
		reviewer,
		role,
		blinded,
		note,
		reviewed_at: new Date().toISOString(),
	});
	console.log(`\n✓ Recorded. thulr calibration picks this up on the next \`npm run eval\` (judge-vs-human TPR/TNR).`);
	console.log(`  Extended verdict written to ${relative(process.cwd(), setPath)} — dimension ${dimension}, role ${role}, ${blinded ? "blinded" : "NOT blinded"}.`);
	if (!blinded) console.log("  Unblinded verdicts are recorded but do not count as independent ground truth. Pass --blinded when the judge's call was not in view.");
} catch (error) {
	console.error(`thulr review failed: ${error?.message ?? error}`);
	process.exit(1);
}
