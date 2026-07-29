import { CALIBRATION_CASES, CASES } from "./cases.mjs";
import { PATTERN_CALIBRATION_CASES, PATTERN_CASES } from "./pattern-cases.mjs";
import { SELECTION_CASES } from "./selection-cases.mjs";
import { failureCasesFromLedger, readFailureLedger } from "./failure-ledger.mjs";

export { CALIBRATION_CASES, CASES, PATTERN_CALIBRATION_CASES, PATTERN_CASES, SELECTION_CASES };

export const EVAL_CORPUS = {
	measurement: CASES,
	calibration: CALIBRATION_CASES,
	selection: SELECTION_CASES,
	sourceSnapshots: [
		{
			id: "eval-fixtures",
			path: "evals/fixtures",
			sha256: "24e75a9d2e2b8ae7f101fe849322d142a2494ded359385d44f00318504b1657e",
		},
	],
};

export async function corpusWithFailureLedger(corpus, ledgerPath) {
	if (!ledgerPath) return { corpus, issues: [] };
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) return { corpus, issues: ledger.issues.map((issue) => `failure ledger: ${issue}`) };
	const imported = failureCasesFromLedger(ledger.events);
	return { corpus: { ...corpus, measurement: [...corpus.measurement, ...imported] }, issues: [] };
}
