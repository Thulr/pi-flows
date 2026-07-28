// Argv reader for the eval MEASUREMENT CLIs (run.mjs, compare.mjs, select.mjs).
//
// These three accept only `--name=value` plus bare `--name` booleans — never
// `--name value`. The thin thulr wrappers (review.mjs, pareto.mjs) accept both
// syntaxes and keep using evals/args.mjs; the two parsers are deliberately not
// merged, because making the measurement CLIs consume `--name value` would let
// `--dry-run --filter=x` silently swallow the next token as a value.
//
//   const { flag, has, bool, flags, positiveNumberFlag } = createFlagReader(process.argv.slice(2));
//   const model = flag("model", null);          // --model=openai-codex/gpt-5.5
//   const junit = has("junit");                 // --junit  OR  --junit=path
//   const dryRun = bool("dry-run");             // --dry-run only, never --dry-run=x
//   const guards = flags("efficiency-guardrail");  // repeatable + comma-separated
//   const armTimeoutMs = positiveNumberFlag("arm-timeout");  // null when absent
//   const cap = rateFlag("critical-miss-rate", 0.35);        // validated 0..1

// A malformed millisecond flag is a usage error, not a measurement result: print
// the offending flag and exit 2 (the harness's "bad invocation" code). Injectable
// so the parser can be unit-tested without tearing down the process.
const exitOnInvalid = (message) => {
	console.error(message);
	process.exit(2);
};

/**
 * Build the flag accessors for one CLI's argv.
 *
 * @param {string[]} argv argv WITHOUT the node/script prefix (`process.argv.slice(2)`)
 * @param {{ onInvalid?: (message: string) => never | null }} [options]
 */
export function createFlagReader(argv, { onInvalid = exitOnInvalid } = {}) {
	/** Last-wins string value of `--name=value`, or `fallback` when absent. */
	const flag = (name, fallback) => {
		const hit = argv.find((a) => a.startsWith(`--${name}=`));
		return hit ? hit.slice(name.length + 3) : fallback;
	};
	/** True for both the bare `--name` and the valued `--name=value` forms. */
	const has = (name) => argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`));
	/** True only for the bare `--name` form — for switches that take no value. */
	const bool = (name) => argv.includes(`--${name}`);
	/** Every value of a repeatable flag, comma-splitting each occurrence. */
	const flags = (name) => argv
		.filter((a) => a.startsWith(`--${name}=`))
		.flatMap((a) => a.slice(name.length + 3).split(",").map((x) => x.trim()).filter(Boolean));
	/**
	 * A rate flag in 0..1, or `fallback` when absent. A typo must never silently
	 * disable a guard: `Number("oops")` is NaN, and every `bound > NaN` comparison
	 * is false, so an unvalidated rate turns a release gate off without a word.
	 */
	const rateFlag = (name, fallback) => {
		if (!has(name)) return fallback;
		const raw = flag(name, "");
		const value = Number(raw);
		if (String(raw).trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
			return onInvalid(`--${name} must be a number from 0 to 1, got ${JSON.stringify(raw)}`);
		}
		return value;
	};
	/** Millisecond flag: null when absent, positive number when valid, `onInvalid` otherwise. */
	const positiveNumberFlag = (name) => {
		if (!has(name)) return null;
		const value = Number(flag(name, "0"));
		if (!Number.isFinite(value) || value <= 0) {
			return onInvalid(`--${name} must be a positive number of milliseconds`);
		}
		return value;
	};
	const positiveIntegerFlag = (name, fallback, maximum) => {
		if (!has(name)) return fallback;
		const value = Number(flag(name, "0"));
		if (!Number.isInteger(value) || value < 1 || value > maximum) {
			return onInvalid(`--${name} must be an integer from 1 to ${maximum}`);
		}
		return value;
	};
	return { argv, flag, has, bool, flags, rateFlag, positiveNumberFlag, positiveIntegerFlag };
}
