// Generate one immutable release decision record. Two modes:
//
//   --run    Run the release evaluation and decide from it, in one command.
//            This is the mode a release uses. The harness attestation key is
//            a token generated here, handed to the child run, and thrown away
//            — so an artifact only verifies if it came from the evaluation
//            this invocation just launched. There is no operator-managed
//            secret, and a hand-written reliability artifact cannot pass.
//
//   default  Decide from already-produced artifacts. No models run. The
//            attestation key comes from PI_FLOWS_EVAL_ATTESTATION_KEY, which
//            exists for tests and for re-deciding a run you still hold the
//            token for; a release should use --run.
//
// Either way the decision fails closed when a required artifact, catastrophic
// safety check, trace, calibration, or promoted regression is missing.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createFlagReader } from "./cli-flags.mjs";
import { buildReleaseManifest } from "./release-manifest.mjs";
import { deriveEvidence } from "./release-evidence.mjs";
import { captureReleaseSystem } from "./release-system.mjs";
import { validateReleaseRuntimeTrace } from "./release-trace.mjs";
import { failureLedgerIdentity, promotedRegressionCaseIds, readFailureLedger } from "./failure-ledger.mjs";
import { readJsonSnapshot } from "./evaluation-artifacts.mjs";

const moduleRoot = path.resolve(import.meta.dirname, "..");
const { flag, bool } = createFlagReader(process.argv.slice(2));
const root = path.resolve(moduleRoot, flag("repo-root", moduleRoot));
const selfRun = bool("run");
// In --run mode the key is ephemeral: generated here, never written down, and
// only ever seen by the child evaluation this command starts.
const attestationKey = selfRun ? randomBytes(32).toString("hex") : process.env.PI_FLOWS_EVAL_ATTESTATION_KEY ?? null;
delete process.env.PI_FLOWS_EVAL_ATTESTATION_KEY;

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

/** Where a `--run` release keeps the artifacts it produces. `.thulr/` is generated evidence and is never committed or packaged. */
function evalArtifactPaths(runId) {
	const dir = path.resolve(root, ".thulr/runs");
	return {
		reliability: path.join(dir, `${runId}.reliability.json`),
		calibration: path.join(dir, `${runId}.calibration.json`),
		runtimeTrace: path.join(dir, `${runId}.runtime.jsonl`),
		ledger: path.join(dir, `${runId}.failures.jsonl`),
		out: path.join(dir, `${runId}.release.json`),
	};
}

/**
 * Run the release suite as a child, handing it this invocation's ephemeral
 * attestation token. The token never leaves this process tree, so the
 * artifacts it signs can only have come from the run started here.
 */
function runReleaseEvaluation(runId, paths) {
	mkdirSync(path.dirname(paths.reliability), { recursive: true });
	// An empty ledger is the documented shape for "no production failures
	// imported yet" — required, so that its absence is a decision rather than
	// an omission.
	if (!existsSync(paths.ledger)) writeFileSync(paths.ledger, "", { encoding: "utf8", mode: 0o600 });
	const result = spawnSync(process.execPath, [
		"--import", "tsx", path.join(moduleRoot, "evals/run.mjs"),
		"--release-suite",
		`--trials=${flag("trials", "5")}`,
		"--strict-trace",
		`--run-id=${runId}`,
		`--failure-ledger=${paths.ledger}`,
		`--runtime-trace=${paths.runtimeTrace}`,
		`--reliability-out=${paths.reliability}`,
		`--calibration-out=${paths.calibration}`,
	], { cwd: root, stdio: "inherit", env: { ...process.env, PI_FLOWS_EVAL_ATTESTATION_KEY: attestationKey } });
	if (result.error) throw new Error(`release evaluation could not start: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`release evaluation failed (exit ${result.status ?? "signal"}); no decision recorded`);
}

async function main() {
	const runId = flag("run-id", null);
	if (selfRun && !runId) throw new Error("--run requires --run-id=<id>");
	const auto = selfRun ? evalArtifactPaths(runId) : null;
	if (selfRun) runReleaseEvaluation(runId, auto);

	const reliabilityPath = selfRun ? auto.reliability : requiredPath("reliability");
	const calibrationPath = selfRun ? auto.calibration : requiredPath("calibration");
	const runtimeTracePath = selfRun ? auto.runtimeTrace : requiredPath("runtime-trace");
	const ledgerPath = selfRun && !flag("failure-ledger", null) ? auto.ledger : requiredPath("failure-ledger");
	const out = selfRun && !flag("out", null) ? auto.out : requiredPath("out");
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) throw new Error(`failure ledger is invalid: ${ledger.issues.join("; ")}`);
	const regressionCaseIds = promotedRegressionCaseIds(ledger.events);
	const ledgerIdentity = failureLedgerIdentity(ledger.events, ledger.sha256);
	const reliabilitySnapshot = readJsonSnapshot(reliabilityPath, "reliability artifact");
	const calibrationSnapshot = readJsonSnapshot(calibrationPath, "calibration artifact");
	if (!reliabilitySnapshot.value || !calibrationSnapshot.value) throw new Error("release artifacts could not be read");
	const runtimeTraceValidation = validateReleaseRuntimeTrace(runtimeTracePath, reliabilitySnapshot.value, { repoRoot: root });
	const inputs = {
		evidence: selfRun
			? deriveEvidence(reliabilitySnapshot.value, bool("attest-hard-blockers"))
			: readJson(requiredPath("evidence"), "release evidence"),
		reliability: reliabilitySnapshot.value,
		calibration: calibrationSnapshot.value,
		system: captureReleaseSystem(root),
		artifactHashes: {
			reliability: reliabilitySnapshot.sha256,
			calibration: calibrationSnapshot.sha256,
			runtimeTrace: runtimeTraceValidation.sha256,
			failureLedger: ledger.sha256,
		},
		regressionCaseIds,
		ledgerIdentity,
		attestationKey,
		runtimeTraceValidation,
	};
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
