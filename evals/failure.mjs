// Privacy-safe production-failure lifecycle:
// import a validated/minimized case -> record held-out repetitions -> promote.
// Every state change is an append-only, hash-chained event.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createFlagReader } from "./cli-flags.mjs";
import {
	appendFailureEvent,
	buildFailureImport,
	buildHeldOutTrialEvents,
	buildPromotionDecision,
	evaluatedSystemDigest,
	failureLedgerIdentity,
	readFailureLedger,
} from "./failure-ledger.mjs";
import { validateProductionTrace } from "./failure-trace.mjs";
import { validateReleaseRuntimeTrace } from "./release-trace.mjs";
import { sha256File } from "./release-system.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [command, ...argv] = process.argv.slice(2);
const { flag } = createFlagReader(argv);
const ledgerPath = path.resolve(root, flag("ledger", ".thulr/failures/ledger.jsonl"));

function required(name) {
	const value = flag(name, null);
	if (!value) throw new Error(`--${name}=<value> is required`);
	return value;
}

function jsonFile(name) {
	const file = path.resolve(root, required(name));
	try {
		return { file, value: JSON.parse(readFileSync(file, "utf8")) };
	} catch (error) {
		throw new Error(`--${name} could not be read as JSON: ${error.message}`);
	}
}

async function importFailure() {
	const { file, value: input } = jsonFile("input");
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) throw new Error(`failure ledger is invalid: ${ledger.issues.join("; ")}`);
	if (ledger.events.some((event) => event.type === "failure.imported" && event.case?.id === input.case?.id)) {
		throw new Error(`failure ${input.case.id} is already imported`);
	}
	const traceValidation = validateProductionTrace(input.case?.traceLink, { baseDir: path.dirname(file) });
	const record = await appendFailureEvent(ledgerPath, buildFailureImport(input, { traceValidation }));
	console.log(`imported ${record.case.id} into capability suite`);
	return 0;
}

async function recordTrials() {
	const caseId = required("case");
	const { value: reliability } = jsonFile("reliability");
	const runtimeTracePath = path.resolve(root, required("runtime-trace"));
	const runtimeTraceValidation = validateReleaseRuntimeTrace(runtimeTracePath, reliability, { repoRoot: root });
	const systemDigest = evaluatedSystemDigest(reliability);
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) throw new Error(`failure ledger is invalid: ${ledger.issues.join("; ")}`);
	if (!ledger.events.some((event) => event.type === "failure.imported" && event.case?.id === caseId)) throw new Error(`failure ${caseId} has not been imported`);
	const ledgerIdentity = failureLedgerIdentity(ledger.events, sha256File(ledgerPath));
	const importedCase = ledgerIdentity.importedCases[caseId];
	const importBinding = { ...importedCase, ledgerSha256: ledgerIdentity.sha256, ledgerHeadHash: ledgerIdentity.headHash };
	const existing = new Set(ledger.events.filter((event) => event.type === "failure.held-out-trial" && event.caseId === caseId).map((event) => `${event.runId}:${event.trialId}`));
	const records = buildHeldOutTrialEvents({ caseId, reliability, systemDigest, runtimeTraceValidation, importBinding });
	const duplicates = records.filter((record) => existing.has(`${record.runId}:${record.trialId}`));
	if (duplicates.length) throw new Error(`held-out cohort trials already recorded: ${duplicates.map((record) => record.trialId).join(", ")}`);
	for (const record of records) await appendFailureEvent(ledgerPath, record);
	console.log(`recorded ${records.length} held-out trial(s) for ${caseId}`);
	return 0;
}

async function promoteFailure() {
	const caseId = required("case");
	const cohortId = required("cohort");
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) throw new Error(`failure ledger is invalid: ${ledger.issues.join("; ")}`);
	const decision = buildPromotionDecision(ledger.events, caseId, { cohortId });
	await appendFailureEvent(ledgerPath, decision);
	console.log(`${decision.decision}: ${caseId}${decision.toSuite ? ` -> ${decision.toSuite}` : ""}`);
	for (const reason of decision.reasons) console.log(`- ${reason}`);
	return decision.decision === "approved" ? 0 : 1;
}

async function inspectLedger() {
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) throw new Error(`failure ledger is invalid: ${ledger.issues.join("; ")}`);
	console.log(JSON.stringify({ path: ledgerPath, events: ledger.events }, null, 2));
	return 0;
}

async function main() {
	if (command === "import") return importFailure();
	if (command === "record") return recordTrials();
	if (command === "promote") return promoteFailure();
	if (command === "inspect") return inspectLedger();
	throw new Error("usage: failure.mjs <import|record|promote|inspect> [--name=value]");
}

main().then(
	(code) => { process.exitCode = code; },
	(error) => {
		console.error(`failure lifecycle failed: ${error.message}`);
		process.exitCode = 2;
	},
);
