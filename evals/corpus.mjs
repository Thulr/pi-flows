import { CALIBRATION_CASES, CASES } from "./cases.mjs";
import { PATTERN_CALIBRATION_CASES, PATTERN_CASES } from "./pattern-cases.mjs";
import { SELECTION_CASES } from "./selection-cases.mjs";

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
		{
			id: "package-metadata",
			path: "package.json",
			sha256: "41ae66c7450fd7a5c67862fbd9f3a1f83aff896cc38ebf165fc28df6f0785ba6",
		},
		{
			id: "release-notes",
			path: "CHANGELOG.md",
			sha256: "5530d4302b6823b8f0dc6c39fe4d73522c1ce328eb9cd190c184c848600586db",
		},
		{
			id: "flow-readme",
			path: "README.md",
			sha256: "d2169f3c452adcd46c00d14b21a4368b4b68c14f6b8ec32bdc4d0f10b96973ea",
		},
		{
			id: "flow-reference",
			path: "docs/flow-reference.md",
			sha256: "a6fb9d175111b0379bc343447d6bc0f2b29a08e2e8fcf28a2dbda5f645360718",
		},
		{
			id: "flow-extension",
			path: "extensions/pi-flows",
			sha256: "2a7184dca32a7e65247cd4c759a79f63fec2e3275c31c21ed8c238fae751e597",
		},
		{
			id: "bundled-agents",
			path: "agents",
			sha256: "b555e284707788c28c5e7e59d85fb7aa623986645e54417b4d9abb4775dc8bb1",
		},
		{
			id: "agent-validator",
			path: "scripts/validate-agents.mjs",
			sha256: "bd5c05c254807eada7e0482a37bd46358b1201c0a509fa6f336de3c9167574c9",
		},
	],
};
