# Patterns

pi-flows' modes are not ad-hoc — each is a named agent-design pattern with a track record. This page maps modes to patterns, says which to reach for, and points at the sources.

The patterns come from a companion agent-design knowledge base (the **ai-wiki**) and the primary literature it distills: Anthropic's *Building Effective Agents* (Dec 2024), Andrew Ng's four core patterns, Augment Code's 2026 pattern catalog, the Reflexion paper (Shinn et al. 2023), and Google ADK's workflow agents.

## Mode → pattern

| Mode | Pattern | Canonical source |
|---|---|---|
| `single` | Tool Use / single sub-agent | Ng pattern 2; wiki `sub-agent-pattern` |
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

The wiki's central discipline: add the **minimum** coordination that solves the observed problem. Every added agent costs latency, tokens, and debuggability, so adopt patterns reactively (in response to a real failure) rather than speculatively.

1. One LLM call plus tools resolves the task → **`single`**.
2. Independent sub-tasks with no ordering → **`parallel`**; a fixed pipeline where each step feeds the next → **`chain`**.
3. Output quality must be verified against criteria a separate critic can check → **`evaluate`**.
4. A high-stakes answer where non-deterministic errors matter → **`vote`** (use different models to break correlated blind spots).
5. A heterogeneous request that should go to one specialist → **`route`**.
6. One large task that splits into independent parts needing a merged answer → **`orchestrate`**.
7. Explicit dependencies or conditional handoffs across several steps → **`graph`**.
8. Repeat-until-done work that is not just generator/evaluator → **`loop`**.
9. Several plausible plans/artifacts should be generated, scored, and refined → **`search`**.

Reach for the first mode that fits. If `single` works, do not `orchestrate`.

## What each mode bakes in

- **`evaluate`** — separate contexts for generator and critic; the evaluator judges the *artifact, not the generator's reasoning trace*; a hard iteration cap; critique-not-binary feedback; an unparseable verdict fails **safe** to REVISE so a flaky critic cannot false-pass. Three further levers from the wiki: an optional **`checkCommand`** deterministic gate (level-1 *code assertions* that must exit 0 — verification guaranteed by the harness, not requested in the prompt; `code-assertions-vs-llm-as-judge`, Stripe minions in `generator-evaluator-harness`); **`redteam` as a panel** of per-dimension critics where PASS requires all of them (`god-metric-vs-decomposed-evaluators`); and on REVISE the generator is re-shown its prior artifact so it revises in place rather than rebuilding (durable hand-off). (`generator-evaluator-harness`)
- **`vote`** — independent voters suppress non-deterministic errors; *different models* additionally break correlated blind spots, and pi-flows **warns when every voter shares one model**. Same-agent/model voters receive complementary stances (solver, skeptic, evidence checker, etc.) so same-model voting is less of an identical prompt replay; free-text answers are reconciled by an aggregator agent, since exact-match majority is meaningless for prose. (`effective-agent-patterns` §Parallelization)
- **`route`** — the router sees each candidate's description, its choice is validated against the candidate set, and a `fallback` handles the wiki's "misclassification" failure mode; an ambiguous mention is never guessed. (`effective-agent-patterns` §Routing)
- **`orchestrate`** — star topology, one-way dispatch, workers return compact summaries, fan-out is capped; the deep-research shape. Workers see the overall goal/contract plus their assigned subtask, so terse decomposition still stays aimed at the final answer. An optional **`verify`** critic checks the merged answer against the goal in the same call, composing orchestrator-workers with evaluator-optimizer. `verifyPolicy:"note"` keeps the verdict advisory, `"fail"` turns `REVISE` into a structured gate failure, and `"revise"` feeds the verifier critique back into `debrief` for bounded synthesize→verify repair. (`sub-agent-pattern`, `generator-evaluator-harness`)
- **`graph`** — explicit static DAG: node ids, dependencies, wave-by-wave execution, `{node.id}` handoffs, and optional synthesis. It stays bounded (16 nodes) and inherits the existing write-collision and budget guards.
- **`loop`** — generic loop with a hard iteration cap. Without a judge, the body must emit `LOOP: DONE`; with a judge, `VERDICT: PASS` stops the loop. This covers ADK-style loop agents without opening unbounded recursion.
- **`search`** — bounded beam search: generate candidates, score each with `SCORE: 0..100`, keep a beam, refine for capped rounds, and synthesize the winner.

## Bundled agents → roles

| Agent | Role | Used by |
|---|---|---|
| `recon` | Fast read-only reconnaissance (Haiku) | `single`, `parallel`, default `orchestrate` fan-out |
| `analyst` | Deep read-only investigation, compact cited summary | `orchestrate` fan-out (deeper than `recon`) |
| `strategist` | High-level implementation planning | `chain`, `route` |
| `operator` | Implementation; produces a verifiable artifact | default `evaluate` builder |
| `overwatch` | Code/diff review with tool-backed evidence | `route` |
| `redteam` | Adversarial critic; emits `VERDICT: PASS/REVISE` | default `evaluate` critic |
| `controller` | Classifier; emits `ROUTE: <agent>` | default `route` classifier |
| `commander` | Decomposer; emits a JSON subtask array | default `orchestrate` decomposer |
| `debrief` | Merges multiple outputs into one answer | default `orchestrate` + `vote` merge |

## Anti-patterns (avoided by design)

The wiki names seven anti-patterns; three are structural and pi-flows guards against them:

- **The God Prompt** — one prompt doing everything. Decompose with `chain` or `orchestrate`.
- **Over-agentification** — using agents where deterministic code or `single` would do. The decision ladder above pushes back on this.
- **Uncontrolled recursion** — loops or fan-out without bounds. Every running mode is capped on **count** (`maxIterations`, `maxParallelTasks`, `concurrency`, `maxSubtasks`), **time** (`timeoutMs` per child), **depth** (`MAX_FLOW_DEPTH`), and now **cost** (`maxCostUsd` / `maxTokens` / `maxGeneratedTokens` across the whole tree) — the wiki names cost as a dimension iteration/time caps miss.
- **Output-only guardrails** — checking only the final output, not intermediate steps. pi-flows scans every inter-agent **handoff** (chain `{previous}`, evaluate artifact, vote ballots, orchestrate findings) for injected instructions, not just the boundary in and out.

## Harness guarantees

What the harness enforces regardless of what an agent does — the bounded-execution and guardrail primitives the wiki calls table stakes:

- **Bounded execution.** Every running mode has hard caps on count, time, and depth (above). Nothing loops or fans out without a ceiling.
- **Cost ceiling.** `maxCostUsd` / `maxTokens` / `maxGeneratedTokens` accumulate across every child in the tree. Cost and generated-output ceilings stop the active child at a completed model-response boundary; the legacy total-token ceiling preserves that response. All three refuse subsequent child spawns once hit (`BUDGET_EXCEEDED`). Bounds the cost dimension that count/time caps do not. (`agentic-design-patterns` "Uncontrolled Recursion")
- **Nested-delegation depth cap.** Children are spawned with an incremented `PI_FLOWS_DEPTH`; a flow call at or beyond `MAX_FLOW_DEPTH` is refused (`FLOW_DEPTH_EXCEEDED`). This bounds flow-within-flow recursion that the per-mode caps alone don't cover.
- **Per-child timeout.** `timeoutMs` kills a stalled child (SIGTERM, then SIGKILL).
- **Fail-closed project agents.** Repo-controlled `.pi/flow-agents` prompts are refused in headless runs unless explicitly trusted.
- **Redaction + output caps.** Secret-shaped strings and home paths are redacted, and model-visible output is byte-capped, before anything returns to the parent.
- **Return contracts.** `returnContract` / `requireEvidence` append explicit output and evidence requirements to delegated prompts, reducing summary loss at handoff boundaries.
- **Shared-write isolation.** Concurrent write-capable fan-out is refused when multiple writers share one `cwd` (`SHARED_WRITE_CWD`) unless explicitly overridden, nudging write work into separate worktrees.
- **Handoff injection scanning.** Child output reused as another child's prompt is stripped of invisible/bidi characters and flagged for instruction-override markers before reuse — indirect prompt injection at the inter-agent boundary (`prompt-injection-defense`).
- **Native read-only agents.** `recon` and `analyst` ship without a shell, so their read-only boundary is enforced by the toolset, not prompt instructions (`native-enforcement-vs-prompt-enforcement`).
- **Deterministic verification available.** `evaluate.checkCommand` makes verification a harness-run command (level-1 code assertions), not a property the critic is merely asked to check.
- **Trace export + reports.** `traceFile` / `PI_FLOWS_TRACE_FILE` emit OpenInference-shaped JSONL spans per child; `/flows report` and `npm run trace:report` summarize success rate, cost, TPSO, budget hits, and routing/voting warnings by mode and trace label (`llm-observability`).
- **Human checkpoints.** `checkpoint.before:"spawn"` or `"finalize"` asks for explicit UI approval and fails closed in headless runs.
- **Opt-in Reflexion lessons.** `reflexion.enabled:true` reads/appends redacted local lessons in `.pi/flow-reflections.jsonl`; it is disabled by default.
- **Star topology.** One-way dispatch with a compact return — no agent-to-agent chatter, so there is no coordination surface to runaway.

Verification of a returned artifact is **not** automatic for most modes — that is what `evaluate` (with an optional `checkCommand` gate) and `orchestrate.verify` are for. Reach for them when a handoff must be checked rather than trusted.

## Intentionally not built (yet)

Honest gaps, with rationale:

- **Mesh / peer-to-peer (pi-to-pi).** pi-flows is deliberately star-topology only — one-way dispatch with a compact summary return, no agent-to-agent chatter. The wiki rates mesh topologies experimental and higher-overhead, and the star/sub-agent shape is the one it rates most reliable. Peer-to-peer is a separate tool's job.
- **Automatic Reflexion memory.** pi-flows has opt-in local lessons (`reflexion.enabled:true`) but does not persist lessons automatically. The open problem is still summarizing/consolidating old episodes so they do not bloat context or smuggle stale guidance into future runs.
- **Programmatic majority voting.** `vote` returns free-text answers, so consensus is decided by an aggregator agent rather than exact-match majority (the runtime does warn when voters share one model). A discrete-answer weighted/majority tally for classification-style tasks could be added later.
- **Structured-output decoding for control tokens.** Verdict/route/subtask decisions are parsed from the child's free text with marker-first, fail-safe parsers. Constrained decoding (`structured-generation`) would make them airtight, but that needs host-side support in `pi`; the fail-safe fallbacks (unparseable verdict → REVISE, bad route → fallback) are the mitigation until then.

## Sources

- Companion **ai-wiki** concept pages: `agentic-design-patterns`, `effective-agent-patterns`, `multi-agent-orchestration`, `sub-agent-pattern`, `generator-evaluator-harness`, `reflexion`, `ralph-loops`, `agent-harness`.
- Anthropic, *Building Effective Agents* (December 2024).
- Augment Code, *Agentic Design Patterns* catalog (2026).
- Shinn et al., *Reflexion: Language Agents with Verbal Reinforcement Learning* (2023).
- Google Cloud Tech, *AI Agent Design Patterns* (ADK workflow agents).

See [Flow reference](./flow-reference.md) for the exact tool contract of each mode.
