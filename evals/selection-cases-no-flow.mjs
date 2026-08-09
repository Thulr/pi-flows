// The negative half of the tool-selection corpus: tasks the parent must answer
// itself. Easy negatives say so outright; the hard negatives below carry no
// such hint and measure whether the model decides that on its own. Assembled
// with the positive half by selection-cases.mjs; the portfolio metadata every
// case carries is registered in case-contract.mjs, so these are plain literals.
export const NO_FLOW_SELECTION_CASES = [
	{
		name: "trivial-answer-no-flow",
		task: "What is 2+2? Answer with only the number.",
		expectFlow: false,
		answerPattern: "\\b4\\b",
		mock: { flowCalls: 0, answer: "4" },
	},
	{
		name: "small-repo-lookup-no-flow",
		task: "In package.json, what is the package name? Answer with only the package name.",
		expectFlow: false,
		answerPattern: "\\bpi-flows\\b",
		mock: { flowCalls: 0, answer: "pi-flows" },
		sourceExpectation: {
			path: "package.json",
			jsonPath: ["name"],
			expectedPath: ["mock", "answer"],
			patternPath: ["answerPattern"],
		},
	},
	{
		name: "package-version-no-flow",
		task: "In package.json, what is the current package version? Answer with only the version string.",
		expectFlow: false,
		answerPattern: "\\b0\\.7\\.1\\b",
		mock: { flowCalls: 0, answer: "0.7.1" },
		sourceExpectation: {
			path: "package.json",
			jsonPath: ["version"],
			expectedPath: ["mock", "answer"],
			patternPath: ["answerPattern"],
		},
	},
	{
		name: "tiny-transform-no-flow",
		task: "Rewrite the phrase 'delegate responsibly' in title case. Answer with only the rewritten phrase.",
		expectFlow: false,
		answerPattern: "^\\s*Delegate Responsibly\\s*$",
		mock: { flowCalls: 0, answer: "Delegate Responsibly" },
	},
	{
		name: "short-explanation-no-flow",
		task: "In one sentence, explain what `npm ci` does.",
		expectFlow: false,
		answerPattern: "install",
		mock: { flowCalls: 0, answer: "`npm ci` installs dependencies from package-lock.json in a clean, reproducible way." },
	},
	{
		name: "quick-comparison-no-debate",
		task: "In one sentence, say whether JSON or YAML is easier for machines to parse. Do not delegate this quick opinion.",
		expectFlow: false,
		answerPattern: "JSON|YAML",
		mock: { flowCalls: 0, answer: "JSON is generally easier for machines to parse because its grammar is smaller and less ambiguous." },
	},
	{
		name: "unrequested-constrained-decision-no-debate",
		task: "Choose deployment A or B directly. The hard p99 limit is 100ms. A measures 90ms and costs $5k; B measures 110ms and costs $4k. State the choice and decisive constraint in one sentence.",
		expectFlow: false,
		answerPattern: "A|90ms|100ms|latency",
		mock: { flowCalls: 0, answer: "Choose A because its 90ms p99 meets the hard 100ms limit while B's 110ms does not." },
	},
	{
		name: "single-file-summary-no-dossier",
		task: "Summarize the description field in package.json in one sentence. This is one local lookup, not a research dossier.",
		expectFlow: false,
		answerPattern: "flow|agent|pi",
		mock: { flowCalls: 0, answer: "The package delegates Pi work to isolated, budgeted children." },
		sourceExpectation: {
			path: "package.json",
			jsonPath: ["description"],
			patternPath: ["answerPattern"],
			patterns: ["budgeted", "children", "pi"],
		},
	},
	{
		name: "one-command-status-no-monitor",
		task: "Run git status once and tell me whether the worktree is clean. Do not set up monitoring.",
		expectFlow: false,
		answerPattern: "clean|changes|modified|branch",
		mock: { flowCalls: 0, answer: "The worktree is clean." },
	},
	{
		name: "small-edit-no-workflow",
		task: "Correct only the typo in this README sentence and return the corrected sentence: 'Pi Flows delgate tasks safely.' This tiny one-line edit does not need a phase-gated workflow.",
		expectFlow: false,
		answerPattern: "Pi Flows delegate tasks safely\\.",
		mock: { flowCalls: 0, answer: "Pi Flows delegate tasks safely." },
	},
	{
		name: "branch-name-no-worktree-flow",
		task: "Report the current git branch name. Do not create branches or worktrees.",
		expectFlow: false,
		answerPattern: "main|codex|branch",
		mock: { flowCalls: 0, answer: "The current branch is main." },
	},
	// Hard negatives: plausible-sounding tasks with NO explicit "do not delegate"
	// hint. These mirror the observed overuse pattern — tasks that pattern-match a
	// flow mode (investigation, review, verification, fan-out) but fit comfortably
	// in the parent context. The easy negatives above tell the model not to
	// delegate; these measure whether it decides that on its own.
	{
		name: "plausible-two-file-explain-no-flow",
		task: "Explain in one short paragraph how extensions/pi-flows/parse.ts and extensions/pi-flows/protocol.ts work together to enforce child output protocols like VERDICT lines.",
		expectFlow: false,
		answerPattern: "VERDICT|protocol|parse",
		mock: { flowCalls: 0, answer: "protocol.ts defines the instructions that ask children for typed lines like VERDICT: PASS, and parse.ts extracts and validates those lines from child output." },
		sourceExpectations: [
			{ format: "text", path: "extensions/pi-flows/parse.ts", patterns: ["extractLastJsonBlock", "protocol\\.ts"] },
			{ format: "text", path: "extensions/pi-flows/protocol.ts", patterns: ["function extractLastJsonBlock", "VERDICT: PASS"] },
		],
	},
	{
		name: "plausible-refactor-scoping-no-flow",
		task: "Which files import extractLastJsonBlock from extensions/pi-flows/parse.ts? List the file paths.",
		expectFlow: false,
		answerPattern: "index\\.ts",
		mock: { flowCalls: 0, answer: "extensions/pi-flows/index.ts imports extractLastJsonBlock from parse.ts (parse.ts re-exports it from protocol.ts, where it is defined)." },
		sourceExpectation: {
			format: "text",
			path: "extensions/pi-flows/index.ts",
			patterns: ["import \\{[^\\n]*extractLastJsonBlock[^\\n]*\\} from \"\\.\\/parse\\.ts\""],
		},
	},
	{
		name: "plausible-investigation-no-flow",
		task: "Why does the flow tool refuse to run project-local flow agents in headless runs by default? Answer in two sentences.",
		expectFlow: false,
		answerPattern: "repo|trust|headless|approval|confirmProjectAgents",
		mock: { flowCalls: 0, answer: "Project-local agents are repo-controlled prompts, so running them without interactive approval would let a repository inject instructions. Headless runs therefore fail closed unless confirmProjectAgents:false is passed for a reviewed repo." },
		sourceExpectation: {
			format: "text",
			path: "extensions/pi-flows/index.ts",
			patterns: ["confirmProjectAgents", "if \\(!ctx\\.hasUI\\)", "PROJECT_AGENT_APPROVAL_REQUIRED"],
		},
	},
	{
		name: "plausible-release-summary-no-flow",
		task: "Summarize what changed in the Unreleased section of CHANGELOG.md in two bullets or fewer.",
		expectFlow: false,
		answerPattern: "nothing|unreleased|0\\.5\\.0",
		// The mock stands in for a model answer on the dry-run path, so it is written
		// to the shape a correct summary takes rather than to whatever Unreleased
		// currently says — otherwise it goes stale the next time anyone edits it.
		mock: { flowCalls: 0, answer: "- The Unreleased section lists the changes staged for the next version, grouped under Keep a Changelog headings.\n- Reading CHANGELOG.md answers this directly, so no delegation is warranted." },
		sourceExpectation: {
			format: "text",
			// Anchored on section structure, not on Unreleased content. Pinning the
			// content made every changelog entry fail preflight, and the only remedy
			// was rewriting a frozen mock — churn that produced no signal about
			// whether this case still discriminates flow from no-flow.
			path: "CHANGELOG.md",
			patterns: ["## Unreleased[\\s\\S]*## 0\\.5\\.0[\\s\\S]*flow card[\\s\\S]*## 0\\.4\\.2"],
		},
	},
	{
		name: "plausible-verification-no-flow",
		task: "Run npm run validate:agents once and report whether the bundled agents pass validation.",
		expectFlow: false,
		answerPattern: "ok|pass|valid",
		mock: { flowCalls: 0, answer: "agents ok: 9 bundled agents — validation passes." },
		sourceExpectation: {
			format: "node-script",
			path: "scripts/validate-agents.mjs",
			patterns: ["agents ok: 9 bundled agents"],
		},
	},
	{
		name: "plausible-deps-audit-no-flow",
		task: "Check package.json and report whether any package appears in both dependencies and devDependencies.",
		expectFlow: false,
		answerPattern: "\\bno\\b|\\bnone\\b|does not|doesn't|no overlap",
		mock: { flowCalls: 0, answer: "No package appears in both lists." },
		sourceExpectation: {
			path: "package.json",
			relation: "disjoint-keys",
			jsonPaths: [["dependencies"], ["devDependencies"]],
		},
	},
];
