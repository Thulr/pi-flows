import { CALIBRATION_CASES, CASES } from "./cases.mjs";
import { PATTERN_CALIBRATION_CASES, PATTERN_CASES } from "./pattern-cases.mjs";
import { SELECTION_CASES } from "./selection-cases.mjs";

export { CALIBRATION_CASES, CASES, PATTERN_CALIBRATION_CASES, PATTERN_CASES, SELECTION_CASES };

export const EVAL_CORPUS = {
	measurement: CASES,
	calibration: CALIBRATION_CASES,
	selection: SELECTION_CASES,
};
