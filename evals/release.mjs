// Generate one immutable release decision record from already-produced eval
// evidence. This command never runs models; it fails closed when any required
// artifact, catastrophic safety check, trace, calibration, or promoted
// regression is missing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFlagReader } from "./cli-flags.mjs";
import { buildReleaseManifest } from "./release-manifest.mjs";
import { captureReleaseSystem, sha256File } from "./release-system.mjs";
import { validateReleaseRuntimeTrace } from "./release-trace.mjs";
import { failureLedgerIdentity, promotedRegressionCaseIds, readFailureLedger } from "./failure-ledger.mjs";

const moduleRoot = path.resolve(import.meta.dirname, "..");
const { flag } = createFlagReader(process.argv.slice(2));
const root = path.resolve(moduleRoot, flag("repo-root", moduleRoot));

function requiredPath(name) {
	const value = flag(name, null);
	if (!value) throw new Error(`--${name}=<path> is required`);
	return path.resolve(root, value);
}

function readJson(file, label) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${label} could not be read as JSON: ${error.message}`);
	}
}

async function main() {
	const evidencePath = requiredPath("evidence");
	const reliabilityPath = requiredPath("reliability");
	const calibrationPath = requiredPath("calibration");
	const runtimeTracePath = requiredPath("runtime-trace");
	const out = requiredPath("out");
	const ledgerPath = requiredPath("failure-ledger");
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) throw new Error(`failure ledger is invalid: ${ledger.issues.join("; ")}`);
	const regressionCaseIds = promotedRegressionCaseIds(ledger.events);
	const ledgerIdentity = failureLedgerIdentity(ledger.events, sha256File(ledgerPath));
	const inputs = {
		evidence: readJson(evidencePath, "release evidence"),
		reliability: readJson(reliabilityPath, "reliability artifact"),
		calibration: readJson(calibrationPath, "calibration artifact"),
		system: captureReleaseSystem(root),
		artifactHashes: {
			reliability: sha256File(reliabilityPath),
			calibration: sha256File(calibrationPath),
			runtimeTrace: sha256File(runtimeTracePath),
			failureLedger: sha256File(ledgerPath),
		},
		regressionCaseIds,
		ledgerIdentity,
	};
	inputs.runtimeTraceValidation = validateReleaseRuntimeTrace(runtimeTracePath, inputs.reliability, { repoRoot: root });
	const manifest = buildReleaseManifest(inputs);
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	console.log(`release ${manifest.decision.status}: ${out}`);
	for (const blocker of manifest.decision.blockers) console.log(`- ${blocker}`);
	return manifest.decision.status === "approved" ? 0 : 1;
}

main().then(
	(code) => { process.exitCode = code; },
	(error) => {
		console.error(`release record failed: ${error.message}`);
		process.exitCode = 2;
	},
);
