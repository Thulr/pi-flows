// Export each eval case's name + criterion as a machine-readable JSON manifest
// (evals/thulr-cases.json) for EXTERNAL evaluators such as thulr-evaluator, which
// cannot import this JavaScript module. Pure data — no model calls, no tokens.
//
//   node evals/export-cases.mjs        # regenerate the manifest
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES } from "./cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function exportCases(path = join(HERE, "thulr-cases.json")) {
	const manifest = CASES.map((c) => ({ name: c.name, criterion: c.criterion }));
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return path;
}

// Allow `node evals/export-cases.mjs` to regenerate the manifest standalone.
if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(`Wrote ${exportCases()}`);
}
