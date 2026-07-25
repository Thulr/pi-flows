// Environment setup and preflight for the eval CLIs.
//
// Every eval CLI does the same two things before it spends a token: load the
// repo-local `.env` so child processes inherit provider keys, then verify the
// binaries it is about to shell out to. The checks themselves are shared; the
// wording is not (run.mjs speaks in ✓/✗ glyphs, compare.mjs in FAIL prefixes),
// so each CLI supplies its own message and composes the steps it needs:
//
//   const ok = runPreflight([
//     requireBinary("pi", "✗ `pi` was not found on PATH. …"),
//     requireHealthyThulr((why) => `✗ ${why}\n  …`),
//   ]);
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as thulr from "./thulr.mjs";

/**
 * Load a repo-local `.env` (provider keys) before any child inherits the env.
 * A malformed file is ignored rather than fatal — the harness may not need keys.
 *
 * @returns {boolean} whether an .env was found and applied
 */
export function loadDotenv(cwd = process.cwd()) {
	const dotenvPath = join(cwd, ".env");
	if (!existsSync(dotenvPath)) return false;
	try {
		process.loadEnvFile(dotenvPath);
		return true;
	} catch {
		return false;
	}
}

/** Whether `<bin> --version` resolves and exits cleanly. */
export function binaryOnPath(bin) {
	try {
		execFileSync(bin, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Turn a `thulr doctor` result into the one sentence that says what is wrong,
 * or null when the environment is healthy. Pure, so the three-way diagnosis
 * (missing binary / missing judge binary / unhealthy workspace) is unit-testable.
 *
 * @param {{ ok: boolean, report: object | null }} doc
 * @returns {string | null}
 */
export function thulrDoctorReason(doc) {
	if (doc?.ok) return null;
	if (!doc?.report) return "`thulr` was not found on PATH.";
	if (doc.report.judge_bin_found === false) {
		return `thulr is installed but its judge binary \`${doc.report.judge_bin}\` was not found on PATH.`;
	}
	return "`thulr doctor` reports an unhealthy environment.";
}

/** A preflight step asserting `bin` is on PATH, reporting `message` when it is not. */
export const requireBinary = (bin, message) => () => (binaryOnPath(bin) ? null : message);

/**
 * A preflight step asserting `thulr doctor` is green. `format` receives the
 * diagnosis sentence and returns the full message the CLI should print.
 */
export const requireHealthyThulr = (format) => () => {
	const reason = thulrDoctorReason(thulr.doctor());
	return reason ? format(reason) : null;
};

/**
 * Run preflight steps in order, stopping at the first failure. A step returns
 * null when it passes, or the message to print when it fails.
 *
 * @param {Array<() => string | null>} steps
 * @returns {boolean} true when every step passed
 */
export function runPreflight(steps, { log = console.error } = {}) {
	for (const step of steps) {
		const failure = step();
		if (failure) {
			log(failure);
			return false;
		}
	}
	return true;
}
