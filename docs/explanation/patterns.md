# Patterns

The pi-flows modes are not ad-hoc. Each mode is a named agent-design pattern with a track record. This page maps modes to patterns, shows which mode to select, and points at the sources.

The patterns come from a companion agent-design knowledge base (the **ai-wiki**) and the primary literature it distills: Anthropic's *Building Effective Agents* (Dec 2024), Andrew Ng's four core patterns, Augment Code's 2026 pattern catalog, the Reflexion paper (Shinn et al. 2023), and Google ADK's workflow agents.

## When a flow helps you

Use pi-flows when the next step makes your parent pi session noisy, expensive, or hard to trust:

| Your situation | What you ask pi | What pi-flows gives back |
|---|---|---|
| You need to understand a code path before you touch it. | "Have a read-only agent find the billing routes." | A compact, cited recon report from an agent that cannot mutate the repo or run shell commands. |
| You want one bounded review of a PR or branch. | "Review HEAD against main and issue #25 exactly once." | Two `overwatch` runs in named `standards` and `spec` roles, typed file coverage, and a harness-derived `CLEAN`, `FINDINGS`, or `PARTIAL` outcome. |
| You have several independent areas to inspect. | "Check frontend auth and backend auth in parallel." | Separate child runs with capped fan-out instead of one context stuffed with every file. |
| You want an implementation checked before you accept it. | "Add `/health` with a test, and accept it only after `npm test` passes." | A bounded generator-evaluator loop where a builder, critic, and optional command gate must pass. |
| You have a broad research task. | "Document how auth works across login, refresh, and sessions." | Decompose, fan out, synthesize, and optionally verify the merged answer. |
| A release or migration has named gates and an approval point. | "Analyze, plan, verify, then pause for approval before rollout." | Persisted phase state, deterministic gates, and a resumable human approval node. |
| Several independent writers need to land one gate-checked result. | "Fix frontend and backend in isolated worktrees, integrate them, then run tests." | Separate worker branches plus a durable, reviewed integration branch. |
| A consequential decision has credible opposing options. | "Have advocates test both queue designs against the constraints, then adjudicate." | Bounded rebuttal rounds and an independent decision record. |
| Several sources disagree or leave evidence gaps. | "Reconcile the runbook, deployed config, incident report, and ticket." | Source-specific extraction followed by cited synthesis that preserves conflicts and unknowns. |
| A transient condition must be captured before diagnosis. | "Poll health up to six times; on `DEGRADED`, hand the event to an analyst." | A bounded deterministic probe, typed trigger, and one reactor agent. |
| You care what the delegation cost. | "Run this with a $0.25 cap and save a trace." | Cumulative cost/token ceilings plus OpenInference-shaped JSONL traces and `/flows report`. |

Do not use pi-flows as the default path for small tasks. Simple answers, obvious
shell commands, tiny edits, and quick single-file lookups are usually cheaper and
clearer in the parent session.

## Why a harness, not a prompt folder

pi-flows is a small harness, not a folder of agent prompts. The distinction matters when you want delegation to be repeatable and auditable.

- **Native isolation over prompt promises.** `recon` and `analyst` run with read-only tools and no shell, so exploration cannot accidentally edit files. Concurrent write-capable agents cannot share one checkout unless you explicitly allow it.
- **Verification is a first-class mode.** `evaluate` runs the builder and the critic in separate child contexts. It can require `npm test` or another `checkCommand`, and it revises under a hard iteration cap. This is stronger than a request that one agent "double-check itself."
- **Multiple proven patterns share one interface.** From `single`, `parallel`, and `evaluate` through explicit `workflow`, isolated `worktree`, adjudicated `debate`, evidence `dossier`, and bounded `monitor`, every mode uses the same `flow` tool. Start with the least coordination the task needs.
- **Delegation is bounded.** The harness caps count, concurrency, timeout, nesting depth, total tokens, and total USD spend. A runaway fan-out returns `BUDGET_EXCEEDED` and does not quietly spend the rest of the task.
- **Handoffs are treated as an attack surface.** Content that goes from one child to another is capped, redacted, stripped of invisible/bidi characters, and scanned for instruction-override markers before reuse.
- **You can inspect what happened.** Structured errors include cause and fix fields, and traces are plain JSONL. `/flows report` separates execution success from verified outcome success. It also summarizes cost, token use, budget hits, route choices, and voting warnings.
- **It stays inside pi.** You install it as a pi package, use your existing pi provider setup, and talk to pi in plain English. The JSON in these docs is the internal tool interface. You do not write it for normal use.

If you only want a single custom prompt, a long-lived autonomous swarm, or peer-to-peer agents that talk to each other, you do **not** need pi-flows. pi-flows deliberately uses a star topology: the parent delegates bounded work, the children return compact results, and the parent decides.

## Mode → pattern

| Mode | Pattern | Canonical source |
|---|---|---|
| `single` | Tool Use / single child | Ng pattern 2; wiki `sub-agent-pattern` |
| `parallel` | Parallelization (sectioning) + Orchestrator-Workers fan-out | Anthropic patterns 3 & 8 |
| `chain` | Prompt Chaining | Anthropic pattern 1 |
| `evaluate` | Evaluator-Optimizer / Generator-Evaluator | Anthropic pattern 5; wiki `generator-evaluator-harness` |
| `vote` | Parallelization (voting) / self-consistency | Anthropic pattern 3; vendor-diverse voting |
| `route` | Routing | Anthropic pattern 2 |
| `orchestrate` | Orchestrator-Workers + synthesis | Anthropic pattern 8; wiki `sub-agent-pattern`; Deep Research |
| `graph` | Static DAG / workflow graph | Google ADK graph workflows |
| `loop` | Generic bounded loop workflow | Google ADK loop agents |
| `search` | Tree/search over candidate paths | Tree of Thoughts; bounded beam search |

## Choosing a mode (least machinery that works)

The central discipline of the wiki: add the **minimum** coordination that solves the observed problem. Each added agent costs latency, tokens, and debuggability. Adopt a pattern in response to a real failure, not before one.

1. One LLM call plus tools resolves the task → **`single`**.
2. Independent sub-tasks with no ordering → **`parallel`**. A fixed pipeline where each step feeds the next → **`chain`**.
3. Output quality must be verified against criteria a separate critic can check → **`evaluate`**.
4. A high-stakes answer where non-deterministic errors matter → **`vote`** (use different models to break correlated blind spots).
5. A heterogeneous request that must go to exactly one agent → **`route`**.
6. One large task that splits into independent parts that need a merged answer → **`orchestrate`**.
7. Explicit dependencies or conditional handoffs across several steps → **`graph`**.
8. Repeat-until-stop work that is more than generator/evaluator → **`loop`**.
9. Several plausible plans or artifacts must be generated, scored, and refined → **`search`**.

Select the first mode that fits. If `single` works, do not `orchestrate`.

## What each mode bakes in

- **`evaluate`** — The generator and the critic get separate contexts. The evaluator judges the *artifact, not the generator's reasoning trace*. The loop has a hard iteration cap and critique-not-binary feedback. An unparseable verdict fails **safe** to REVISE, so a flaky critic cannot false-pass. The wiki adds three more levers. First, an optional **`checkCommand`** deterministic gate: level-1 *code assertions* that must exit 0, with the verification guaranteed by the harness and not requested in the prompt (`code-assertions-vs-llm-as-judge`, Stripe minions in `generator-evaluator-harness`). Second, **`redteam` as a panel** of per-dimension critics, where PASS requires all of them (`god-metric-vs-decomposed-evaluators`). Third, on REVISE the generator sees its prior artifact again, so it revises in place and does not rebuild (durable hand-off). (`generator-evaluator-harness`)
- **`vote`** — Independent voters suppress non-deterministic errors. *Different models* also break correlated blind spots, and pi-flows **warns when every voter shares one model**. Same-agent and same-model voters receive complementary stances (solver, skeptic, evidence checker, and more), so same-model voting is not an identical prompt replay. An aggregator agent reconciles free-text answers, because exact-match majority is meaningless for prose. (`effective-agent-patterns` §Parallelization)
- **`route`** — The router sees the description of each candidate, and its choice is validated against the candidate set. A `fallback` handles the wiki's "misclassification" failure mode. An ambiguous mention is never guessed. (`effective-agent-patterns` §Routing)
- **`orchestrate`** — Star topology, one-way dispatch, compact worker summaries, capped fan-out: the deep-research shape. Workers see the overall goal or delegation contract plus their assigned subtask, so terse decomposition stays aimed at the final answer. An optional **`review`** critic judges the Decomposition before any worker spawns, a budget projection refuses one that cannot fit the remaining ceilings, and one bounded mid-flow replan can replace remaining work that a failure stranded. An optional **`verify`** critic judges the merged answer against the goal in the same call. This composes orchestrator-workers with evaluator-optimizer. `verifyPolicy:"note"` keeps the verdict advisory. `"fail"` turns `REVISE` into a structured gate failure. `"revise"` feeds the verifier critique back into `debrief` for bounded synthesize→verify repair. (`sub-agent-pattern`, `generator-evaluator-harness`)
- **`graph`** — An explicit static DAG: node ids, dependencies, wave-by-wave execution, `{node.id}` handoffs, and optional synthesis. It stays bounded (16 nodes) and inherits the existing write-collision and budget guards.
- **`loop`** — A generic loop with a hard iteration cap. Without a judge, the body must emit `LOOP: DONE`. With a judge, `VERDICT: PASS` stops the loop. This covers ADK-style loop agents and does not open unbounded recursion.
- **`search`** — Bounded beam search: generate candidates, score each with `SCORE: 0..100`, keep a beam, refine for capped rounds, and synthesize the winner.

## Bundled agents → roles

| Agent | Role | Used by |
|---|---|---|
| `recon` | Fast read-only reconnaissance (`fast` tier) | `single`, `parallel`, default `orchestrate` fan-out |
| `analyst` | Deep read-only investigation, compact cited summary | `orchestrate` fan-out (deeper than `recon`) |
| `strategist` | High-level implementation planning | `chain`, `route` |
| `operator` | Implementation; produces a verifiable artifact | default `evaluate` builder |
| `overwatch` | Code/diff review with tool-backed evidence | `route` |
| `redteam` | Adversarial critic; emits `VERDICT: PASS/REVISE` | default `evaluate` critic |
| `controller` | Classifier; emits `ROUTE: <agent>` | default `route` classifier |
| `commander` | Decomposer; emits subtask strings, or subtask objects with dependency edges | default `orchestrate` decomposer |
| `debrief` | Merges multiple outputs into one answer | default `orchestrate` + `vote` merge |

## Anti-patterns (avoided by design)

The wiki names seven anti-patterns. Four are structural, and pi-flows guards against them:

- **The God Prompt** — one prompt that does everything. Decompose with `chain` or `orchestrate`.
- **Over-agentification** — agents used where deterministic code or `single` is enough. The decision ladder above prevents this.
- **Uncontrolled recursion** — loops or fan-out without bounds. Every running mode is capped on **count** (`maxIterations`, `maxParallelTasks`, `concurrency`, `maxSubtasks`, `reviewMaxIterations`, `verifyMaxIterations`, exactly one mid-flow replan), **time** (`timeoutMs` per child), **depth** (`MAX_FLOW_DEPTH`), and **cost** (`maxCostUsd` / `maxTokens` / `maxGeneratedTokens` across every child in the flow). The wiki names cost as a dimension that iteration and time caps miss.
- **Output-only guardrails** — a gate only on the final output, not on intermediate steps. pi-flows scans every inter-agent **handoff** (chain `{previous}`, evaluate artifact, vote ballots, orchestrate findings) for injected instructions, not only the boundary in and out.

## Harness guarantees

The harness enforces these guarantees regardless of what an agent does. They are the bounded-execution and guardrail primitives that the wiki calls the baseline:

- **Bounded execution.** Every running mode has hard caps on count, time, and depth (above). Nothing loops or fans out without a ceiling.
- **Cost ceiling.** `maxCostUsd` / `maxTokens` / `maxGeneratedTokens` accumulate across every child in one flow. They do not accumulate across a nested flow that a child starts. Only the ceilings of its own call cap a nested flow, and it is uncapped by default. Cost and generated-output ceilings stop the active child at a completed model-response boundary. A flow's total-token ceiling preserves that response; a delegation contract's total-token ceiling stops the live run. At 80% of a live-run ceiling, the harness asks the child to wrap up and emit a partial envelope. Once a ceiling is hit, all three refuse subsequent child spawns (`BUDGET_EXCEEDED`), and orchestrate refuses a Decomposition whose projected spend cannot fit (`BUDGET_HEADROOM_EXCEEDED`). This bounds the cost dimension that count and time caps do not. (`agentic-design-patterns` "Uncontrolled Recursion")
- **Nested-delegation depth cap.** Each child spawns with an incremented `PI_FLOWS_DEPTH`. A flow call at or beyond `MAX_FLOW_DEPTH` is refused (`FLOW_DEPTH_EXCEEDED`). This bounds flow-within-flow recursion that the per-mode caps alone do not cover.
- **Per-child timeout.** `timeoutMs` kills a stalled child (SIGTERM, then SIGKILL).
- **Fail-closed project agents.** Headless runs refuse repo-controlled `.pi/flow-agents` prompts unless you explicitly trust them.
- **Redaction + output caps.** Before anything returns to the parent, secret-shaped strings and home paths are redacted, and model-visible output is byte-capped.
- **Return requirements.** `returnRequirements` / `requireEvidence` append explicit output and evidence requirements to delegated tasks. This reduces summary loss at handoff boundaries. They are prompt-enforced, never machine-checked; a delegation `contract` is the machine-checked form.
- **Shared-write isolation.** When multiple writers share one `cwd`, concurrent write-capable fan-out is refused (`SHARED_WRITE_CWD`). This pushes write work toward serialized runs (`concurrency:1`) or separate worktrees. The explicit override is a last resort for intentionally shared writes.
- **Enforced handoff injection policy.** Child output reused as another child's prompt is stripped of invisible/bidi characters and scanned for instruction-override markers, including conjunctive attacks assembled across several boundaries. `handoffPolicy` selects compatible warning, payload quarantine, or fail-before-recipient-spawn. `modeHandoffPolicy` can set a stricter minimum (`prompt-injection-defense`).
- **Native read-only agents.** `recon` and `analyst` ship without a shell, so the toolset enforces their read-only boundary, not prompt instructions (`native-enforcement-vs-prompt-enforcement`).
- **Deterministic verification available.** `evaluate.checkCommand` makes verification a harness-run command (level-1 code assertions), not a property that the critic is only asked to judge.
- **Trace export + reports.** `traceFile` / `PI_FLOWS_TRACE_FILE` emit OpenInference-shaped JSONL spans per child. `/flows report` and `npm run trace:report` separate execution success from verified outcome success. They also summarize cost, TPSO, budget hits, and routing/voting warnings by mode and trace label (`llm-observability`).
- **Human checkpoints.** `checkpoint.before:"spawn"` or `"finalize"` asks for explicit UI approval and fails closed in headless runs.
- **Opt-in Reflexion lessons.** `reflexion.enabled:true` reads and appends redacted local lessons in `.pi/flow-reflections.jsonl`. It is disabled by default.
- **Star topology.** One-way dispatch with a compact return. There is no agent-to-agent chatter, so there is no runaway coordination surface.

For most modes, verification of a returned artifact is **not** automatic. That is the purpose of `evaluate` (with an optional `checkCommand` gate) and `orchestrate.verify`. Use them when an outcome must be verified rather than trusted. A delegation contract validates a Return's attribution, artifact integrity, and shape — it never verifies that the Return's claims are true.

## Intentionally not built (yet)

Honest gaps, with rationale:

- **Mesh / peer-to-peer (pi-to-pi).** pi-flows is deliberately star-topology only — one-way dispatch with a compact summary return, no agent-to-agent chatter. The wiki rates mesh topologies experimental and higher-overhead, and the parent-child shape is the one it rates most reliable. Peer-to-peer belongs in a separate tool.
- **Automatic Reflexion persistence.** pi-flows has opt-in local lessons (`reflexion.enabled:true`) but does not persist lessons automatically. The open problem remains how to summarize and consolidate old episodes, so they do not bloat context or smuggle stale guidance into future runs.
- **Programmatic majority voting.** `vote` returns free-text answers, so an aggregator agent decides consensus rather than an exact-match majority (the runtime does warn when voters share one model). A discrete-answer weighted or majority tally for classification-style tasks can come later.
- **Structured-output decoding for control tokens.** Anchored, fail-safe parsers read verdict/loop/route/subtask/score decisions from the child's free text. A control token is authoritative only on the child's first non-empty line, and only when it matches the exact documented grammar. Every unparseable form falls back safely (verdict → REVISE, loop → CONTINUE, route → unresolved, score → unscored). Constrained decoding (`structured-generation`) can make them airtight, but that needs host-side support in `pi`. Until then, the fail-safe fallbacks are the mitigation.

## Sources

- Companion **ai-wiki** concept pages: `agentic-design-patterns`, `effective-agent-patterns`, `multi-agent-orchestration`, `sub-agent-pattern`, `generator-evaluator-harness`, `reflexion`, `ralph-loops`, `agent-harness`.
- Anthropic, *Building Effective Agents* (December 2024).
- Augment Code, *Agentic Design Patterns* catalog (2026).
- Shinn et al., *Reflexion: Language Agents with Verbal Reinforcement Learning* (2023).
- Google Cloud Tech, *AI Agent Design Patterns* (ADK workflow agents).

See [Flow reference](../reference/flow-reference.md) for the exact tool interface of each mode.
