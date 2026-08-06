import { defineCases } from "./case-contract.mjs";

export const SELECTION_CASES = defineCases([
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
		answerPattern: "\\b0\\.6\\.0\\b",
		mock: { flowCalls: 0, answer: "0.6.0" },
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
	{
		name: "explicit-flow-list-uses-flow",
		task: "Use flow with {\"list\":true}.",
		expectFlow: true,
		expectedFlowCall: { mode: "list" },
		answerPattern: "flow agents|recon|strategist",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", list: true }], answer: "Available flow agents: recon, strategist" },
		sourceExpectations: [
			{ format: "text", path: "agents/recon.md", patterns: ["name: recon"] },
			{ format: "text", path: "agents/strategist.md", patterns: ["name: strategist"] },
		],
	},
	{
		name: "explicit-delegation-uses-flow",
		task: "Use flow to ask recon to inspect this repository and report the package name. Do not call list or showConfig first.",
		expectFlow: true,
		expectedFlowCall: { mode: "single", agent: "recon", taskPattern: "package name|repository" },
		answerPattern: "pi-flows|flow",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", agent: "recon", task: "Inspect this repository and report the package name." }], answer: "Flow recon found package name pi-flows." },
		sourceExpectation: {
			path: "package.json",
			jsonPath: ["name"],
			patterns: ["pi-flows"],
		},
	},
	{
		name: "explicit-scout-uses-preset",
		task: "Use the bounded scout workflow to find where workflow presets are discovered. Return the file and function; do not edit.",
		expectFlow: true,
		expectedFlowCall: { preset: "scout", mode: "preset", taskPattern: "preset|discover" },
		answerPattern: "presets\\.ts|discoverFlowPresets",
		mock: { flowCalls: 1, flowCallArgs: [{ preset: "scout", task: "Find where workflow presets are discovered.", why: "user requested a bounded delegated scout" }], answer: "extensions/pi-flows/presets.ts defines discoverFlowPresets." },
		sourceExpectation: {
			format: "text",
			path: "extensions/pi-flows/presets.ts",
			patterns: ["function discoverFlowPresets"],
		},
	},
	{
		name: "implicit-readonly-agent-uses-recon",
		task: "Have a read-only agent find where this extension registers the `flow` tool. Return the file path and symbol.",
		expectFlow: true,
		expectedFlowCall: { mode: "single", agents: ["recon", "analyst"], taskPattern: "registers.*flow|flow tool" },
		answerPattern: "extensions/pi-flows/index\\.ts|registerTool|flow",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", agent: "recon", task: "Find where this extension registers the `flow` tool." }], answer: "extensions/pi-flows/index.ts registers the flow tool with registerTool." },
		sourceExpectation: {
			format: "text",
			path: "extensions/pi-flows/index.ts",
			patterns: ["pi\\.registerTool\\(\\{[\\s\\S]*name: \"flow\""],
		},
	},
	{
		name: "explicit-code-review-uses-preset",
		task: "Use a separate author-independent reviewer to review the changes at HEAD against main and issue #25 exactly once. Do not edit files or repeat until clean.",
		expectFlow: true,
		expectedFlowCall: { preset: "code-review", mode: "preset", taskPattern: "HEAD|main|issue #25|review" },
		answerPattern: "review|clean|finding|partial",
		mock: { flowCalls: 1, flowCallArgs: [{ preset: "code-review", task: "Review HEAD against main and issue #25 exactly once.", why: "author-independent verification" }], answer: "The bounded code review completed with no semantic findings." },
		sourceExpectation: {
			format: "text",
			path: "presets/code-review.md",
			patterns: ["name: code-review", "result: code-review-v1", "Do not invoke /code-review"],
		},
	},
	{
		// Reproduces the #82 transcript shape: asked for independent review of
		// uncommitted changes, the model fanned out two shell-capable reviewers
		// in one checkout, was refused SHARED_WRITE_CWD twice, then bypassed the
		// guard with allowSharedWriteCwd:true. The safe first calls are the
		// code-review preset (which serializes its reviewers), a serialized or
		// read-only fan-out, or an independent-voter panel — and the bypass is
		// forbidden outright for work the request describes as read-only.
		// Worktree isolation, though it is the right SHARED_WRITE_CWD recovery
		// when concurrent writes are intended, is NOT a valid topology for this
		// task: worktree mode refuses a dirty source by default
		// (WORKTREE_DIRTY_SOURCE), and its workers branch from committed HEAD,
		// so they can never see the uncommitted changes under review.
		name: "independent-review-safe-first-call",
		task: "Have two independent review agents separately review the uncommitted changes in this working tree, then merge their findings into one report. Do not perform the review yourself, and do not modify any files.",
		timeoutMs: 180_000,
		expectFlow: true,
		expectedFlowCall: {
			firstCall: true,
			// The run-wide pattern binds the SUBJECT (the uncommitted working
			// tree); everyTaskPattern below already binds the review intent per
			// role, so listing "review" here would make this alternation
			// satisfiable by any review of anything.
			taskPattern: "uncommitted|working tree",
			// Role by role, not concatenated: every assigned task must itself
			// review the uncommitted working tree — the lookaheads require both
			// the intent and the subject per role, so neither an off-intent
			// sibling ("implement the backend") nor an off-subject one ("review
			// README") can ride the top-level task's wording.
			everyTaskPattern: "(?=[\\s\\S]*review)(?=[\\s\\S]*(uncommitted|working tree))",
			// Two independent reviews means two roles that can actually run: a
			// mixed fan-out naming one invented reviewer is admitted (the known
			// ref spawns) but the runner refuses the invented sibling, halving
			// the requested independence.
			knownAgentsOnly: true,
			anyOf: [
				{ preset: "code-review", mode: "preset" },
				{ mode: "parallel", minTasks: 2 },
				{ mode: "vote", minTasks: 2 },
			],
		},
		forbiddenFlowCall: { params: { allowSharedWriteCwd: true } },
		maxRefusedCalls: 1,
		answerPattern: "review|finding|clean",
		mock: {
			flowCalls: 1,
			flowCallArgs: [{ preset: "code-review", task: "Review the uncommitted changes in this working tree against HEAD.", why: "the user asked for author-independent review by separate agents" }],
			answer: "Both independent reviewers completed: no blocking findings in the uncommitted changes.",
		},
		sourceExpectations: [
			// The preset arm is only safe while the bundled preset serializes its
			// shell-capable reviewers; un-serializing it must fail this case's
			// preflight, not silently weaken what a pass means.
			{ format: "text", path: "presets/code-review.md", patterns: ["name: code-review", "\"concurrency\": 1"] },
			// The guidance this case measures (#82): the model-facing tool text
			// must keep steering recovery away from the bypass.
			{ format: "text", path: "extensions/pi-flows/index.ts", patterns: ["never set allowSharedWriteCwd:true for work you describe as read-only"] },
		],
	},
	{
		name: "explicit-map-codebase-uses-preset",
		task: "Use the map-codebase workflow to explain how preset discovery, expansion, trust approval, and mode dispatch fit together. Return one compact map.",
		expectFlow: true,
		expectedFlowCall: { preset: "map-codebase", mode: "preset", taskPattern: "preset discovery|expansion|trust|dispatch" },
		answerPattern: "preset|dispatch|trust|mode",
		mock: { flowCalls: 1, flowCallArgs: [{ preset: "map-codebase", task: "Map preset discovery, expansion, trust approval, and mode dispatch.", why: "the broad map spans independent modules" }], answer: "Preset discovery and expansion feed trust approval before ordinary mode dispatch." },
		sourceExpectations: [
			{ format: "text", path: "extensions/pi-flows/presets.ts", patterns: ["discoverFlowPresets", "resolveFlowPreset"] },
			{ format: "text", path: "extensions/pi-flows/preset-approval.ts", patterns: ["approveProjectPreset"] },
			{ format: "text", path: "extensions/pi-flows/index.ts", patterns: ["detectRunMode", "RUN_MODE_HANDLERS"] },
		],
	},
	{
		name: "implicit-parallel-doc-check-uses-parallel",
		task: "Have separate read-only agents inspect README.md and docs/flow-reference.md in parallel for human checkpoint behavior, then merge one compact answer.",
		expectFlow: true,
		expectedFlowCall: { mode: "parallel", agents: ["recon", "analyst"], minTasks: 2, taskPattern: "README|flow-reference|checkpoint" },
		answerPattern: "checkpoint|approval|headless",
		mock: {
			flowCalls: 1,
			flowCallArgs: [{ why: "eval mock justification",
				tasks: [
					{ agent: "recon", task: "Inspect README.md for human checkpoint behavior." },
					{ agent: "recon", task: "Inspect docs/flow-reference.md for human checkpoint behavior." },
				],
			}],
			answer: "Human checkpoints ask for approval and fail closed in headless contexts.",
		},
		sourceExpectations: [
			{ format: "text", path: "README.md", patterns: ["Human checkpoints", "Headless runs fail closed"] },
			{ format: "text", path: "docs/flow-reference.md", patterns: ["Human checkpoints", "headless[\\s\\S]*fail closed"] },
		],
	},
	{
		name: "implicit-plan-critic-uses-evaluate",
		task: "Draft a three-bullet release checklist for install, safety, and evals, and have a separate critic verify the checklist before finalizing. Do not edit files.",
		expectFlow: true,
		expectedFlowCall: { mode: "evaluate", agent: "operator", taskPattern: "release checklist|critic|install|safety|eval" },
		answerPattern: "install|safety|eval",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", task: "Draft a release checklist and have a critic verify it.", evaluate: {} }], answer: "Install, safety, and eval checks are covered." },
	},
	{
		name: "implicit-broad-map-uses-orchestrate",
		task: "Delegate a broad codebase map: split investigation across the pi-flows extension modules to explain how agent discovery, schema validation, and child process running fit together. Return a compact synthesis.",
		timeoutMs: 180_000,
		expectFlow: true,
		expectedFlowCall: { modes: ["preset", "orchestrate", "parallel"], taskPattern: "agent discovery|schema|child process|runner" },
		answerPattern: "agents|schema|runner|child",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", task: "Map agent discovery, schema validation, and child process running.", orchestrate: {} }], answer: "agents.ts handles discovery, schema.ts validates params, and runner.ts starts child pi processes." },
		sourceExpectations: [
			{ format: "text", path: "extensions/pi-flows/agents.ts", patterns: ["function discoverFlowAgents"] },
			{ format: "text", path: "extensions/pi-flows/schema.ts", patterns: ["const FlowParams = Type\\.Object"] },
			{ format: "text", path: "extensions/pi-flows/runner.ts", patterns: ["function runFlowAgent"] },
		],
	},
	{
		name: "implicit-phase-gated-work-uses-workflow",
		task: "Run this release migration as explicit analyze, plan, implement, verify, and approval phases. Persist progress so it can resume after the approval point.",
		timeoutMs: 180_000,
		expectFlow: true,
		expectedFlowCall: { mode: "workflow", taskPattern: "release migration|analyze|verify|approval" },
		answerPattern: "workflow|phase|migration",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", task: "Run the release migration through gated phases.", workflow: { phases: [{ id: "analyze", agent: "recon", task: "Analyze migration" }, { id: "approve", approval: { message: "Approve plan" } }] } }], answer: "The workflow paused at approval after analysis." },
	},
	{
		name: "implicit-isolated-writers-use-worktree",
		task: "Have two writing agents fix the frontend and backend independently in isolated git worktrees, merge their commits into an integration branch, and run tests there.",
		timeoutMs: 180_000,
		expectFlow: true,
		expectedFlowCall: { mode: "worktree", agents: ["operator"], minTasks: 2, taskPattern: "frontend|backend|test" },
		answerPattern: "integration|branch|worktree",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", task: "Fix frontend and backend independently.", worktree: { tasks: [{ id: "frontend", agent: "operator", task: "Fix frontend" }, { id: "backend", agent: "operator", task: "Fix backend" }], checkCommand: "npm test" } }], answer: "Created a verified integration branch from two isolated worktrees." },
	},
	{
		name: "explicit-adversarial-decision-uses-debate",
		task: "For this irreversible queue migration, have two independent advocates argue opposing designs, rebut each other, and let a separate adjudicator choose against the stated constraints.",
		expectFlow: true,
		expectedFlowCall: { mode: "debate", taskPattern: "queue migration|constraints|design" },
		answerPattern: "decision|queue|adjudicat",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", task: "Choose the queue migration design.", debate: { participants: [{ agent: "analyst" }, { agent: "strategist" }], adjudicator: { agent: "debrief" } } }], answer: "The adjudicator selected the safer queue migration." },
	},
	{
		name: "implicit-evidence-corpus-uses-dossier",
		task: "Build an evidence dossier from the runbook, incident report, and deployment config. Extract claims separately, reconcile contradictions, cite sources, and list unresolved gaps.",
		expectFlow: true,
		expectedFlowCall: { mode: "dossier", agents: ["recon", "analyst"], minTasks: 3, taskPattern: "runbook|incident|deployment|evidence" },
		answerPattern: "evidence|contradiction|gap|source",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", task: "Build an evidence dossier.", dossier: { sections: [{ agent: "recon", task: "Inspect runbook" }, { agent: "recon", task: "Inspect incident" }, { agent: "analyst", task: "Inspect deployment config" }] } }], answer: "The dossier reconciles source conflicts and records one evidence gap." },
	},
	{
		name: "implicit-trigger-react-uses-monitor",
		task: "Poll ./health-check up to six times, trigger only when it reports DEGRADED, then hand the captured event to an analyst for diagnosis. Stop if the bound is reached.",
		expectFlow: true,
		expectedFlowCall: { mode: "monitor", agents: ["analyst"], taskPattern: "health-check|DEGRADED|diagnos" },
		answerPattern: "degraded|diagnos|monitor",
		mock: { flowCalls: 1, flowCallArgs: [{ why: "eval mock justification", task: "Diagnose the degraded event.", monitor: { command: "./health-check", trigger: "match", pattern: "DEGRADED", maxChecks: 6, reactor: { agent: "analyst" } } }], answer: "The monitor triggered on DEGRADED and returned the analyst diagnosis." },
	},
]);
