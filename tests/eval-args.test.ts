import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../evals/args.mjs";

// The eval CLI wrappers (review.mjs, pareto.mjs) accept both `--name value` (the
// style thulr's own CLI uses) and `--name=value` (the harness style), plus bare
// boolean flags. A regression here silently drops a documented flag.
test("parseArgs accepts space-separated and =-separated flags and bare booleans", () => {
	assert.deepEqual(
		parseArgs(["--case", "route-x", "--verdict=fail", "--note", "missed the TTL bug", "--list"]),
		{ case: "route-x", verdict: "fail", note: "missed the TTL bug", list: true },
	);
});

// A bare flag immediately before another flag must stay boolean, not swallow it.
test("parseArgs treats a flag followed by another flag as boolean", () => {
	assert.deepEqual(parseArgs(["--list", "--json"]), { list: true, json: true });
});

// Positionals are ignored; a repeated flag keeps the last value.
test("parseArgs ignores positionals and keeps the last value for repeats", () => {
	assert.deepEqual(parseArgs(["pos", "--by", "prompt-version", "--by", "config-version"]), { by: "config-version" });
});
