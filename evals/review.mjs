// Record (or list) a human SME review verdict for an eval case. The verdict set is
// folded into thulr's calibration on the next `npm run eval` as judge-vs-human
// ground truth (TPR/TNR) on top of the deterministic-label axis. Thin wrapper over
// `thulr review` that defaults the trace to evals/thulr-trace.jsonl, so the verdict
// lands at the path the main harness auto-discovers.
//
//   npm run eval:review -- --list                                   # reviewed / unreviewed case ids
//   npm run eval:review -- --case route-classifies-bug-to-recon --verdict pass
//   npm run eval:review -- --case single-answer-quality-judged --verdict fail --failure-mode final_answer.incomplete --note "missed the TTL bug"
//   npm run eval:review -- --case vote-reaches-known-consensus --verdict unsure --reviewer justin
//   npm run eval:review -- --trace evals/thulr-trace.jsonl --case x --verdict pass   # explicit trace
//
// Flags accept either `--name value` (as thulr's own CLI does) or `--name=value`.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "./args.mjs";
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

const usage = "Record a verdict:  npm run eval:review -- --case <id> --verdict <pass|fail|unsure> [--failure-mode <tag>] [--note <text>] [--reviewer <name>]\nList state:        npm run eval:review -- --list";

if (!thulr.available()) {
	console.error("✗ `thulr` was not found on PATH.\n  Install it (e.g. `cargo install thulr`) — `thulr review` records the SME verdicts that calibration reads.");
	process.exit(2);
}
if (!existsSync(trace)) {
	console.error(`✗ Trace not found: ${traceArg}\n  Run \`npm run eval\` first to produce it, or pass --trace <path>.`);
	process.exit(2);
}
if (!list) {
	if (!caseId || !verdict) {
		console.error(usage);
		process.exit(2);
	}
	if (!["pass", "fail", "unsure"].includes(verdict)) {
		console.error(`✗ --verdict must be one of pass | fail | unsure, got '${verdict}'.\n\n${usage}`);
		process.exit(2);
	}
}

try {
	process.stdout.write(thulr.review({ trace, list, caseId, verdict, failureMode, note, reviewer }));
	if (!list) console.log("\n✓ Recorded. The next `npm run eval` folds this into calibration (judge-vs-human TPR/TNR).");
} catch (error) {
	console.error(`thulr review failed: ${error?.message ?? error}`);
	process.exit(1);
}
