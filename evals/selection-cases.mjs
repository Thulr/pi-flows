// Flow-selection eval cases. These grade the PARENT model's decision, scored on
// two axes (see `category`):
//
//   • "no-flow"   — the job does not warrant a flow. The parent should answer
//                   directly; opening a flow here is pure overhead. Guards against
//                   over-delegation on small/trivial/conceptual tasks.
//   • "best-flow" — the job warrants a flow AND a specific mode is the best fit.
//                   The parent must both choose `flow` and pick the right mode.
//                   The "discriminates" field names an adjacent mode that is the
//                   tempting-but-wrong choice, so these test discrimination, not
//                   just "did it delegate".
//
// Scoring lives in select.mjs (scoreSelection / flowCallMatchesExpectation):
//   expectFlow            — must the parent call `flow`?
//   expectedFlowCall.mode(s) — accepted mode(s); a wrong mode fails the case
//   expectedFlowCall.agent(s)/minTasks/taskPattern — argument-shape checks
//   answerPattern         — checked when the parent answers (no-flow cases, and
//                           dry-run of flow cases via `mock.answer`)
//   mock                  — canned result for `--dry-run` (no model, no tokens)
//
// Note: primaryAgents() only extracts agents for single/parallel/evaluate/
// orchestrate, so vote/route/chain cases assert on mode + taskPattern only.
export const SELECTION_CASES = [
	// --- no-flow: the job does not call for a flow --------------------------------
	{
		name: "trivial-answer-no-flow",
		category: "no-flow",
		why: "Arithmetic answerable in one token; a flow is pure overhead.",
		task: "What is 2+2? Answer with only the number.",
		expectFlow: false,
		answerPattern: "\\b4\\b",
		mock: { flowCalls: 0, answer: "4" },
	},
	{
		name: "small-repo-lookup-no-flow",
		category: "no-flow",
		why: "A single-field read from one file — no delegation needed.",
		task: "In package.json, what is the package name? Answer with only the package name.",
		expectFlow: false,
		answerPattern: "\\bpi-flows\\b",
		mock: { flowCalls: 0, answer: "pi-flows" },
	},
	{
		name: "package-version-no-flow",
		category: "no-flow",
		why: "One-line lookup in a file already on disk.",
		task: "In package.json, what is the current package version? Answer with only the version string.",
		expectFlow: false,
		answerPattern: "\\b0\\.1\\.1\\b",
		mock: { flowCalls: 0, answer: "0.1.1" },
	},
	{
		name: "tiny-transform-no-flow",
		category: "no-flow",
		why: "A mechanical string transform; nothing to delegate.",
		task: "Rewrite the phrase 'delegate responsibly' in title case. Answer with only the rewritten phrase.",
		expectFlow: false,
		answerPattern: "^\\s*Delegate Responsibly\\s*$",
		mock: { flowCalls: 0, answer: "Delegate Responsibly" },
	},
	{
		name: "short-explanation-no-flow",
		category: "no-flow",
		why: "A conceptual one-liner answered from knowledge, not repo work.",
		task: "In one sentence, explain what `npm ci` does.",
		expectFlow: false,
		answerPattern: "install",
		mock: { flowCalls: 0, answer: "`npm ci` installs dependencies from package-lock.json in a clean, reproducible way." },
	},
	{
		name: "scripts-list-no-flow",
		category: "no-flow",
		why: "Listing keys from one JSON file is a flat lookup — it sounds repo-wide but a flow would just add overhead.",
		task: "In package.json, list the npm script names defined under \"scripts\". Answer as a comma-separated list.",
		expectFlow: false,
		answerPattern: "typecheck",
		mock: { flowCalls: 0, answer: "prepare, typecheck, test, preflight, check, lint:length, scan:privacy, smoke, pack:dry-run, validate:agents, eval, eval:compare, eval:select, trace:report" },
	},
	{
		name: "node-version-no-flow",
		category: "no-flow",
		why: "Reading a three-byte file; delegating here is textbook over-use.",
		task: "What Node.js major version does this repo's .nvmrc pin? Answer with only the number.",
		expectFlow: false,
		answerPattern: "\\b24\\b",
		mock: { flowCalls: 0, answer: "24" },
	},
	{
		name: "when-to-delegate-qa-no-flow",
		category: "no-flow",
		why: "A meta question about when to use flows is itself answered directly — there is no task to delegate.",
		task: "In two sentences, when is it worth reaching for a multi-agent flow instead of just doing the task directly?",
		expectFlow: false,
		answerPattern: "when|independent|parallel|verify|complex|large",
		mock: { flowCalls: 0, answer: "Reach for a flow when the work is large enough to split across agents or benefits from independent verification of a risky result. For a quick single-step task, doing it directly is faster and cheaper." },
	},

	// --- best-flow: delegate, and pick the right mode -----------------------------
	{
		name: "explicit-flow-list-uses-flow",
		category: "best-flow",
		why: "The user explicitly asks to list flow agents — a direct list-mode call.",
		task: "Use flow with {\"list\":true}.",
		expectFlow: true,
		expectedFlowCall: { mode: "list" },
		answerPattern: "flow agents|recon|strategist",
		mock: { flowCalls: 1, flowCallArgs: [{ list: true }], answer: "Available flow agents: recon, strategist" },
	},
	{
		name: "explicit-delegation-uses-flow",
		category: "best-flow",
		why: "An explicit 'ask recon to…' request maps to single-agent delegation.",
		task: "Use flow to ask recon to inspect this repository and report the package name. Do not call list or showConfig first.",
		expectFlow: true,
		expectedFlowCall: { mode: "single", agent: "recon", taskPattern: "package name|repository" },
		answerPattern: "pi-flows|flow",
		mock: { flowCalls: 1, flowCallArgs: [{ agent: "recon", task: "Inspect this repository and report the package name." }], answer: "Flow recon found package name pi-flows." },
	},
	{
		name: "implicit-readonly-agent-uses-recon",
		category: "best-flow",
		why: "A single read-only investigation is one recon/analyst agent — single mode.",
		task: "Have a read-only agent find where this extension registers the `flow` tool. Return the file path and symbol.",
		expectFlow: true,
		expectedFlowCall: { mode: "single", agents: ["recon", "analyst"], taskPattern: "registers.*flow|flow tool" },
		answerPattern: "extensions/pi-flows/index\\.ts|registerTool|flow",
		mock: { flowCalls: 1, flowCallArgs: [{ agent: "recon", task: "Find where this extension registers the `flow` tool." }], answer: "extensions/pi-flows/index.ts registers the flow tool with registerTool." },
	},
	{
		name: "implicit-parallel-doc-check-uses-parallel",
		category: "best-flow",
		why: "Two independent doc inspections merged into one answer — parallel fan-out.",
		discriminates: "single",
		task: "Have separate read-only agents inspect README.md and docs/flow-reference.md in parallel for human checkpoint behavior, then merge one compact answer.",
		expectFlow: true,
		expectedFlowCall: { mode: "parallel", agents: ["recon", "analyst"], minTasks: 2, taskPattern: "README|flow-reference|checkpoint" },
		answerPattern: "checkpoint|approval|headless",
		mock: {
			flowCalls: 1,
			flowCallArgs: [{
				tasks: [
					{ agent: "recon", task: "Inspect README.md for human checkpoint behavior." },
					{ agent: "recon", task: "Inspect docs/flow-reference.md for human checkpoint behavior." },
				],
			}],
			answer: "Human checkpoints ask for approval and fail closed in headless contexts.",
		},
	},
	{
		name: "implicit-plan-critic-uses-evaluate",
		category: "best-flow",
		why: "Draft-then-verify with a separate critic is the evaluate (operator→critic) loop.",
		discriminates: "single",
		task: "Draft a three-bullet release checklist for install, safety, and evals, and have a separate critic verify the checklist before finalizing. Do not edit files.",
		expectFlow: true,
		expectedFlowCall: { mode: "evaluate", agent: "operator", taskPattern: "release checklist|critic|install|safety|eval" },
		answerPattern: "install|safety|eval",
		mock: { flowCalls: 1, flowCallArgs: [{ task: "Draft a release checklist and have a critic verify it.", evaluate: {} }], answer: "Install, safety, and eval checks are covered." },
	},
	{
		name: "implicit-broad-map-uses-orchestrate",
		category: "best-flow",
		why: "An open-ended 'map the whole thing' needs decomposition + synthesis — orchestrate (or parallel).",
		discriminates: "single",
		task: "Delegate a broad codebase map: split investigation across the pi-flows extension modules to explain how agent discovery, schema validation, and child process running fit together. Return a compact synthesis.",
		expectFlow: true,
		expectedFlowCall: { modes: ["orchestrate", "parallel"], agents: ["recon", "analyst"], taskPattern: "agent discovery|schema|child process|runner" },
		answerPattern: "agents|schema|runner|child",
		mock: { flowCalls: 1, flowCallArgs: [{ task: "Map agent discovery, schema validation, and child process running.", orchestrate: {} }], answer: "agents.ts handles discovery, schema.ts validates params, and runner.ts starts child pi processes." },
	},

	// --- best-flow discrimination: right mode over a tempting neighbor ------------
	{
		name: "risk-call-uses-vote",
		category: "best-flow",
		why: "One high-stakes yes/no wanting several INDEPENDENT judgments of the SAME question reconciled into one verdict — that's vote (N voters + debrief), not evaluate (produce→critique) or parallel (different subtasks).",
		discriminates: "evaluate",
		task: "I have to decide whether to run a destructive, irreversible database migration on production tonight. Don't give me one opinion — get several independent risk assessments of the same question, then reconcile them into a single go/no-go recommendation.",
		expectFlow: true,
		expectedFlowCall: { mode: "vote", taskPattern: "migration|go/no-go|go / no-go|risk" },
		answerPattern: "go|no-go|risk|migration",
		mock: { flowCalls: 1, flowCallArgs: [{ task: "Assess the risk of running the destructive production migration tonight and give a go/no-go call.", vote: { agent: "overwatch", count: 3, debrief: { agent: "debrief" } } }], answer: "Reconciled recommendation: no-go on the migration tonight — the rollback path is unproven." },
	},
	{
		name: "build-then-attack-uses-evaluate",
		category: "best-flow",
		why: "Produce an artifact, then have an ADVERSARIAL critic try to break it and revise until it holds — operator + redteam loop = evaluate, not a single unchecked agent.",
		discriminates: "single",
		task: "Write a function that validates RFC 5322 email addresses, then have an independent adversarial reviewer try to break it with edge cases and revise until it holds up. I don't want an unchecked first draft.",
		expectFlow: true,
		// Mode is the discriminating signal (evaluate vs a single unchecked agent);
		// the operator agent name is left free since the model may inline its own.
		expectedFlowCall: { mode: "evaluate", taskPattern: "email|RFC|validat" },
		answerPattern: "email|valid",
		mock: { flowCalls: 1, flowCallArgs: [{ task: "Write and adversarially harden an RFC 5322 email-validation function.", evaluate: {} }], answer: "Delivered an email-address validator that survived the red-team edge cases." },
	},
	{
		name: "triage-ambiguous-uses-route",
		category: "best-flow",
		// Mode is the whole signal here (route vs fanning out via parallel/orchestrate).
		// route candidates are bare agent names with no nested task, and the harness
		// kills pi at the flow call before the top-level task is captured — so assert
		// mode only, not task content (which would test capture timing, not selection).
		why: "A vague report of unknown type should be CLASSIFIED and handed to exactly one specialist — that's route (controller classifies → one candidate), not fanning out every angle at once.",
		discriminates: "parallel",
		task: "A user filed this: 'the app is broken and slow and I also can't log in.' Classify what kind of problem this actually is and dispatch it to the single most appropriate specialist. Don't work every angle at once.",
		expectFlow: true,
		expectedFlowCall: { mode: "route" },
		answerPattern: "classif|route|specialist|auth|bug|perf",
		mock: { flowCalls: 1, flowCallArgs: [{ task: "Classify this ambiguous bug report and route it to the right specialist.", route: { candidates: ["recon", "analyst", "operator"] } }], answer: "Classified as an authentication failure; routed to the auth specialist." },
	},
	{
		name: "ordered-dependency-uses-chain",
		category: "best-flow",
		why: "Two dependent steps where step 2 consumes step 1's output must run IN ORDER via separate agents — that's chain, not parallel (which assumes independence). The prompt cues delegation so this tests chain-vs-parallel, not flow-vs-no-flow.",
		discriminates: "parallel",
		task: "Delegate this as two dependent steps to separate agents. Step 1: an agent surveys extensions/pi-flows/modes/registry.ts and returns the exact list of RunMode names it registers. Step 2: a second agent takes that list and checks each mode is documented in docs/flow-reference.md, flagging any that are missing. Step 2 needs step 1's output, so the two steps cannot run in parallel.",
		expectFlow: true,
		expectedFlowCall: { mode: "chain", taskPattern: "RunMode|registry|document|flow-reference|mode" },
		answerPattern: "mode|document|registry|flow-reference",
		mock: { flowCalls: 1, flowCallArgs: [{ chain: [{ agent: "recon", task: "Survey extensions/pi-flows/modes/registry.ts and list the exact RunMode names it registers." }, { agent: "analyst", task: "Using {previous}, check each RunMode is documented in docs/flow-reference.md and flag gaps." }] }], answer: "All registered modes are documented in docs/flow-reference.md." },
	},
	{
		name: "independent-files-uses-parallel",
		category: "best-flow",
		why: "Three KNOWN, independent targets checked the same way then merged — parallel (fixed fan-out), not orchestrate (open-ended decomposition of an unknown space).",
		discriminates: "orchestrate",
		task: "Independently check three specific files — extensions/pi-flows/sanitize.ts, validate.ts, and parse.ts — each for missing input validation, then merge the findings into one list. The three checks don't depend on each other.",
		expectFlow: true,
		expectedFlowCall: { mode: "parallel", agents: ["recon", "analyst"], minTasks: 3, taskPattern: "sanitize|validate|parse|input validation" },
		answerPattern: "sanitize|validate|parse|finding",
		mock: { flowCalls: 1, flowCallArgs: [{ tasks: [{ agent: "recon", task: "Check sanitize.ts for missing input validation." }, { agent: "recon", task: "Check validate.ts for missing input validation." }, { agent: "recon", task: "Check parse.ts for missing input validation." }] }], answer: "Merged findings across sanitize.ts, validate.ts, and parse.ts." },
	},
	{
		name: "small-lookup-uses-single-not-orchestrate",
		category: "best-flow",
		why: "A single read-only lookup deserves the SMALLEST sufficient flow — one recon agent — not orchestrate/parallel. Picking the best flow includes not over-reaching.",
		discriminates: "orchestrate",
		task: "Use a single read-only agent to find which file defines the constant DEFAULT_EVAL_MODEL and report the file path and its value. Just that one lookup — don't spin up a whole investigation.",
		expectFlow: true,
		expectedFlowCall: { mode: "single", agents: ["recon", "analyst"], taskPattern: "DEFAULT_EVAL_MODEL|defines|value" },
		answerPattern: "DEFAULT_EVAL_MODEL|lib\\.mjs|model",
		mock: { flowCalls: 1, flowCallArgs: [{ agent: "recon", task: "Find which file defines DEFAULT_EVAL_MODEL and report the path and value." }], answer: "evals/lib.mjs defines DEFAULT_EVAL_MODEL as openai-codex/gpt-5.4-mini." },
	},
];
