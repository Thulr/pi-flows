// Tiny argv parser for the eval CLI wrappers (review.mjs, pareto.mjs). Accepts both
// `--name value` (the style thulr's own CLI uses) and `--name=value` (the style the
// rest of the harness uses), plus bare boolean flags (`--list`, `--json`). Returns a
// plain object keyed by flag name. A token that itself starts with `--` is never
// consumed as a value, so a bare flag immediately before another flag stays boolean.
// Repeated flags keep the last value; positionals are ignored.
export function parseArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const eq = a.indexOf("=");
		if (eq !== -1) {
			opts[a.slice(2, eq)] = a.slice(eq + 1);
			continue;
		}
		const name = a.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			opts[name] = next;
			i += 1;
		} else {
			opts[name] = true;
		}
	}
	return opts;
}
