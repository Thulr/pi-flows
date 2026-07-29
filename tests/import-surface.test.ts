import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * pi loads extensions through jiti with a hardcoded alias table
 * (pi-coding-agent dist/core/extensions/loader.js, getAliases()). Any bare
 * import outside that table is rewritten as <alias entry>/<subpath> and fails
 * at load time on a stock pi install — plain Node/tsx test runs never catch it
 * because they resolve through the package exports map instead. v0.4.0 shipped
 * `typebox/schema` this way and broke `pi` at startup for npm installs.
 *
 * Keep this list in lockstep with pi's alias table, not with what Node can
 * resolve.
 */
const PI_LOADER_SAFE_SPECIFIERS = new Set([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"typebox",
	"typebox/compile",
	"typebox/value",
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
		else if (/\.(ts|mjs)$/.test(entry)) files.push(full);
	}
	return files;
}

function bareImports(source: string): string[] {
	const specifiers: string[] = [];
	// Match real import syntax only — `from "..."` inside comments or template
	// strings must not count. Static import/export statements are matched per
	// line; dynamic import()/require() are matched anywhere.
	for (const line of source.split("\n")) {
		const statement = line.match(/^\s*(?:import|export)\b[^"]*\bfrom\s+"([^"]+)"/) ?? line.match(/^\s*import\s+"([^"]+)"/);
		if (statement) specifiers.push(statement[1]!);
	}
	for (const pattern of [/\bimport\s*\(\s*"([^"]+)"\s*\)/g, /\brequire\s*\(\s*"([^"]+)"\s*\)/g]) {
		for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
	}
	return specifiers.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"));
}

test("packaged extension code imports only specifiers pi's extension loader can alias", () => {
	const offenders: string[] = [];
	for (const file of sourceFiles(path.join(repoRoot, "extensions"))) {
		for (const specifier of bareImports(readFileSync(file, "utf8"))) {
			if (!PI_LOADER_SAFE_SPECIFIERS.has(specifier)) {
				offenders.push(`${path.relative(repoRoot, file)}: "${specifier}"`);
			}
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`These imports resolve under Node/tsx but break pi's jiti alias table at extension load time:\n${offenders.join("\n")}\nUse an aliased specifier (typebox, typebox/compile, typebox/value, @earendil-works/*) or a relative import instead.`,
	);
});
