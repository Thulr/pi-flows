// FREE corpus-wide failure-mode ranking: which failure on which prompt/config
// version to fix first, joining deterministic labels, human reviews, and stored
// EvalRun scores. Thin wrapper over `thulr pareto` (no judge calls, no tokens).
// Reads the regenerated eval trace by default.
//
//   npm run eval:pareto                            # rank by prompt version over evals/thulr-trace.jsonl
//   npm run eval:pareto -- --by config-version     # split by config (subject model) instead
//   npm run eval:pareto -- --traces .thulr/traces  # scan a directory of traces recursively
//   npm run eval:pareto -- --limit 10              # show only the top N rows
//   npm run eval:pareto -- --json                  # machine-readable
//
// Flags accept either `--name value` (as thulr's own CLI does) or `--name=value`.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "./args.mjs";
import * as thulr from "./thulr.mjs";

const opts = parseArgs(process.argv.slice(2));
const tracesArg = opts.traces ?? "evals/thulr-trace.jsonl";
const traces = resolve(process.cwd(), tracesArg);
const by = opts.by ?? "prompt-version";
const limitOpt = opts.limit;
const json = Boolean(opts.json);

if (!thulr.available()) {
	console.error("✗ `thulr` was not found on PATH.\n  Install it (e.g. `cargo install thulr`) — `thulr pareto` ranks failure modes across stored traces.");
	process.exit(2);
}
if (!existsSync(traces)) {
	console.error(`✗ Traces path not found: ${tracesArg}\n  Run \`npm run eval\` first to produce evals/thulr-trace.jsonl, or pass --traces <dir|file>.`);
	process.exit(2);
}
if (!["prompt-version", "config-version"].includes(by)) {
	console.error(`✗ --by must be one of prompt-version | config-version, got '${by}'.`);
	process.exit(2);
}

try {
	const limit = limitOpt === undefined ? undefined : Number(limitOpt);
	const result = thulr.pareto({ traces, by, limit, json });
	process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : result);
} catch (error) {
	console.error(`thulr pareto failed: ${error?.message ?? error}`);
	process.exit(1);
}
