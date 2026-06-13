# Evals

Model-in-the-loop evaluations of pi-flows' actual delegation **behaviour** — does
routing pick the right agent, does retrieval find the answer, does the evaluate
loop run to completion, does a judge-able answer hold up. This complements the
offline unit/integration tests (`npm test`), which prove the *plumbing* against a
stub `pi` but never call a model.

Every case is scored on **two independent axes**:

1. a **deterministic objective check** (known answer, chosen route, passing gate) —
   this gates *behaviour*, and doubles as the `objectiveScore` **label**;
2. **thulr's calibrated LLM judge**, which grades each answer against one literal
   `criterion` and **gates quality regressions** against a baseline.

The judge runs on a *different* vendor than the subject under test (default
`anthropic/claude-haiku-4-5`), so no model grades its own family. A case passes
only when both axes agree, and the run is gated only when thulr finds a regression.
The trace also includes fixed **calibration canaries**: known-wrong and partial
answers that are not live flow delegations. They give thulr true-negative and
mid-score examples so TNR is meaningful instead of every row collapsing into
"passed." The full judged EvalRun keeps them for calibration; the release gate
uses a filtered gate candidate so expected-fail canaries do not invert the
product pass-rate guardrail.

> These run **real** `flow` delegations through **real** `pi`, so they need the
> `pi` CLI on PATH and a configured model provider, and **they spend tokens**.
> They also need the [`thulr`](https://github.com/Thulr/thulr) CLI on PATH (the
> calibrated eval gate). They are intentionally not part of `npm run check` / CI.

## Run

```bash
npm run eval                       # all cases, on the default eval model (openai-codex/gpt-5.4-mini)
npm run eval -- --filter=route     # only matching cases
npm run eval -- --model=openai-codex/gpt-5.5   # explicit subject provider/model
npm run eval -- --judge-model=anthropic/claude-opus-4-8   # thulr judge model (default: anthropic/claude-haiku-4-5)
npm run eval -- --judge-bin=/path/to/judge-wrapper   # override thulr's judge command
npm run eval -- --samples=3        # judge each case 3×: majority verdict, mean score, flake warnings (3× judge spend)
npm run eval -- --eval-set=.thulr/eval-sets/release.json   # overlay promoted criteria / guardrail authority
npm run eval -- --efficiency-guardrail=cost_usd --efficiency-guardrail=tokens   # fail on spend/token regressions
npm run eval -- --noise-band=0.10  # regression tolerance for score/pass-rate/efficiency guardrails (default 0.05)
npm run eval -- --cap=1.00         # per-case USD ceiling on flow delegations (default 0.50)
npm run eval -- --write-baseline   # promote this run to evals/thulr-baseline.json (the gate baseline)
npm run eval -- --compare-baseline=evals/thulr-baseline.json   # gate against a specific baseline
npm run eval -- --junit=.thulr/runs/gate.junit.xml   # also write the gate verdict as JUnit XML (CI test ingestion)
npm run eval -- --trace-only --trace-out=/tmp/t.jsonl   # run flows + emit the trace, no judge/gate (see Experiments)
npm run eval -- --dry-run          # framework smoke: canned results, no model, no thulr calls
npm run eval:select                # tool-selection eval: should the parent model call flow at all?
```

Exit code is `0` when every selected **behaviour** case passes (objective **and**
thulr's criterion) **and** thulr's gate reports no regression; `1` otherwise.
*Hard* cases (`hard: true`) are **score-tracked, not pass-gated** — a partial score
is expected and does not fail the run; only a regression in it (caught by the
score-guardrail below) does. Each case is bounded by the flow tool's own
`maxCostUsd`, so a runaway delegation is capped.

## How the thulr gate works

The harness no longer judges in-process. It emits **one self-contained trace** and
shells out to the `thulr` CLI for the `judge → calibrate → gate → baseline` pipeline:

| Artifact | What | Committed? |
| --- | --- | --- |
| `evals/thulr-trace.jsonl` | two spans per case — case context plus final answer, criterion, expected behavior, objective label, failure tags, version, and efficiency metrics all **inline** | no (regenerated) |
| `evals/thulr-baseline.json` | the baseline EvalRun thulr gates against | **yes** |
| `.thulr/runs/candidate.labels.json` | failure-label report from `thulr label-failures`, fed into calibration | no (regenerated) |

The pipeline, per `npm run eval` (preflighted by `thulr doctor --json`, which
verifies the binary, workspace, store, and that thulr's judge binary `pi` resolves):

1. Run every flow, compute the objective check, add calibration canaries → write
   the self-contained trace.
2. `thulr inspect-trace --json` checks the trace for judge-grade coverage before
   any judge tokens are spent. Required trace issues fail the run immediately.
3. `thulr label-failures --trace <file>` applies thulr's failure-mode ontology
   and writes labels for calibration/triage.
4. `thulr judge --trace <file>` grades each case's answer against its inline
   `criterion` → an EvalRun. thulr (0.1.2) reads everything from the trace — no
   separate cases-manifest or labels files. With `--samples=N` each case is judged
   N times and aggregated (majority verdict, ties fail safe; mean score) — the
   EvalRun's `score_stddev` then reports **judge noise** instead of cross-case
   spread, and thulr warns when cases flip verdicts across samples. Use it when a
   gate verdict looks flaky before believing (or rebaselining over) the result.
5. `thulr calibrate --labels .thulr/runs/candidate.labels.json` prints **TPR/TNR**
   — how well the judge's verdicts track the inline deterministic labels, with
   failure labels included in the report. (An uncalibrated judge can silently
   certify regressions; this is the calibration the old single-judge setup lacked.)
6. Before gating, pi-flows writes `.thulr/runs/candidate.gate.json`, which is the
   judged EvalRun with calibration canaries filtered out and summaries
   recomputed. `thulr gate` compares that gate candidate to
   `evals/thulr-baseline.json` with a 0.05 noise band by default (`--noise-band`
   overrides it) and **fails the run on a regression** (it exits `10`). It guards
   two axes on the `criterion` dimension: `--guardrail` (a **pass-rate** drop) and
   `--score-guardrail` (a **mean-score** drop that holds pass-rate — thulr's
   "Gap 1", catching quality drift like `1.00 → 0.85` that every verdict still
   passing would hide). Add repeatable `--efficiency-guardrail=<metric>` for
   thulr's efficiency axes (`cost_usd`, `tokens`, `steps`, `tool_errors`) once the
   baseline was produced from traces carrying those metrics. The first run has no
   baseline — seed one with `--write-baseline`. With `--junit=<path>` the same
   comparison is also written as a JUnit XML testsuite (one testcase per
   case×dimension) for CI ingestion.
   pi-flows also asks for the free `--json` gate report and prints the numeric
   score / pass-rate / efficiency deltas before the human gate report, so the
   terminal lead is the change in quality rather than only PASS/FAIL glyphs.
   Efficiency guardrails share the same noise band as quality; token counts can
   move with model verbosity even when answer quality improves, so prefer an
   explicit `--noise-band` and a rerun before rebaselining over a token-only
   failure.
7. `--write-baseline` promotes a passing run to `evals/thulr-baseline.json`.

Inspect what the gate machinery holds at any time — all free: `thulr list runs`
(stored EvalRuns and their store keys), `thulr inspect-trace --trace
evals/thulr-trace.jsonl` (judge-grade telemetry coverage per case), and
`thulr dashboard` (a local browser view over the stored event streams under
`.thulr/events/`, which every judge/gate run records by default).

### The trace contract (don't break this)

thulr ingests a **self-contained** JSONL trace (`docs/trace-contract.md` in the
thulr repo): it groups spans by `thulr.case_id` and grades the **latest span's
`output.value`**, with the case's `thulr.criterion`, `thulr.expected_behavior`,
`thulr.failure_modes`, and its objective `thulr.deterministic_label` (a boolean)
carried **inline** in the span attributes (plus numeric timing fields). So the
harness emits a compact **case root span plus final-answer span**: the final span
carries the canonical answer (the same text the objective scorer graded) alongside
its criterion and label, while the root span gives thulr enough trajectory shape
for inspect/label workflows — no separate cases or labels files. The spans also
carry the contract's optional context/repro attributes: the task text as
`input.value` and `thulr.task.input` (judge context), `thulr.cost_usd` and
`llm.token_count.total` on the final-answer span (per-case spend, summed into the
EvalRun), `thulr.prompt_version` stamped
`pi-flows@<package version>` because the agent prompts ship with the package, and
`thulr.config_version` stamped with the eval subject configuration. `thulr
query-traces --prompt-version` / `--config-version` can slice traces by either
stamp. Sanity-check a trace for free with `thulr inspect-trace --trace
evals/thulr-trace.jsonl`. This deliberately does **not** reuse a flow's internal multi-span
trace, where the latest child is often a critic or voter rather than the synthesized
answer. The `flow`-tool's richer OpenInference trace (`PI_FLOWS_TRACE_FILE` /
`/flows report`) is a separate, diagnostics-only path.

## Provider & auth (local dev)

With no `--model`, the harness uses its **standardized default** — `DEFAULT_EVAL_MODEL`
(`openai-codex/gpt-5.4-mini`, the cheapest model pi's codex provider exposes;
override with `--model=<provider/id>` or `PI_FLOWS_EVAL_MODEL`)
— so the baseline is reproducible and the flows-vs-plain A/B compares like-for-like.
Auth is pi's own (thulr also judges via `pi`):

- **Subscription / OAuth** — `pi`, then `/login` (stored in `~/.pi/agent/auth.json`). Nothing else to do.
- **API key** — drop it in a gitignored `.env` (see `.env.example`); `npm run eval` loads it:

  ```bash
  cp .env.example .env      # then add e.g. ANTHROPIC_API_KEY=sk-ant-…
  ```

Override the subject with `--model=<provider/id>` (OAuth providers like `openai-codex`
need the provider prefix), or `--model=agent` to run each agent on its own
frontmatter model. Cases that can't reach the model (auth, credits, network) are
flagged `⚠`, excluded from judging, and reported separately from real eval failures.

The harness preflights the gate's environment with `thulr doctor --json` (version,
workspace, store, judge binary) and reports thulr's own diagnosis on failure. If
`thulr` is missing, install it and put it on PATH, or smoke-test the harness
offline with `npm run eval -- --dry-run`.

The harness passes the committed `scripts/thulr-judge-pi.sh` wrapper to thulr
when it is present (unless `--judge-bin` or `THULR_JUDGE_BIN` overrides it). The
wrapper removes thulr's default `--no-extensions` from the `pi` judge invocation,
which keeps extension-provided model providers available, and it tolerates a
post-verdict `pi` teardown crash as long as stdout already contains `VERDICT:`.
This matters for local providers such as `llama-cpp/...`, and for any provider
that is installed through pi extensions. Override it with
`npm run eval -- --judge-bin=/path/to/judge-wrapper` when you need a different
judge command.

> Reasoning / large-context models report a per-call cost (≈$0.09 for `gpt-5.5`)
> that the `maxCostUsd` cap counts even when a subscription covers the actual
> billing — so raise `--cap` (default `0.50`/case) for big fan-out runs if you hit
> `BUDGET_EXCEEDED`.

## What's covered

| Case | Scores |
| --- | --- |
| `route-classifies-bug-to-recon` | the controller routes a real webhook-500 bug to `recon`, which finds the undeclared-`ledger` root cause in the fixture |
| `recon-retrieves-known-value` | `recon` reads a fixture and reports a known value |
| `return-contract-preserves-evidence` | a delegated recon task keeps the requested value plus evidence under a return contract |
| `vote-reaches-known-consensus` | two voters + aggregator reach the correct answer |
| `vote-warns-on-same-model-voters` | same-agent voting surfaces the correlated-model warning |
| `evaluate-loop-completes-with-gate` | the operator builds `isPrime.js` against a real `node` gate (asserts 0/1/2/negative edge cases); the loop revises until it passes |
| `single-answer-quality-judged` | an answer is graded purely by the LLM judge |

Plus: **every** case above is independently graded by thulr's cross-model judge
(default `anthropic/claude-haiku-4-5`, override with `--judge-model` /
`PI_FLOWS_JUDGE_MODEL`) against a single literal `criterion`. The table's objective
checks gate *behaviour* and label the run; thulr's judge gates *answer quality*; a
case passes only when both agree. Pointing the judge at a different vendor than
`--model` is what keeps it from grading its own model family.

The suite also appends three fixed calibration canaries to every thulr trace:

| Canary | Purpose |
| --- | --- |
| `calibration-known-value-wrong` | exact-value true negative for a near-miss SAMPLE_IDENTIFIER answer |
| `calibration-webhook-partial-review` | partial 2/4 code-review answer, giving the judge score headroom |
| `calibration-consensus-wrong-answer` | wrong YES/NO true negative for the ReDoS consensus case |

Canaries are judged and calibrated, but they are not live behavior cases and are
filtered out of the release gate candidate. They exist so `thulr calibrate` has
more than two negative labels and the terminal output can show known-fail and
partial-answer rows without treating expected FAIL verdicts as product
regressions.

## Flows vs plain pi (A/B)

Does pi-flows actually beat plain pi? `npm run eval:compare` runs every case through
**two arms on the same subject model** and grades both with the same objective scorer
and the same cross-model judge:

- **flows** — the case's flow params (specialist agents + orchestration)
- **plain** — one headless `pi --no-extensions` call with the raw task (no flows loaded,
  pi's default system prompt and tools)

```bash
npm run eval:compare                    # all cases, both arms
npm run eval:compare -- --pairwise      # add order-controlled pairwise judging (the sensitive metric)
npm run eval:compare -- --filter=vote   # scope to keep cost down (runs both arms per case)
npm run eval:compare -- --write=evals/compare.json
npm run eval:compare -- --dry-run       # wiring smoke, no model

# Diagnose WHY an arm scored as it did — capture per-child OpenInference spans for the
# flows arm (the flow tool honors the env var; plain pi has no spans):
PI_FLOWS_TRACE_FILE=/tmp/ab.jsonl npm run eval:compare -- --pairwise --write=evals/compare.json
npm run trace:report -- /tmp/ab.jsonl
```

`eval:compare` keeps its own **order-controlled pairwise** judge (run twice with
positions swapped, scored a win only when both orderings agree, told *not* to
reward length) — the sensitive head-to-head metric for small gaps that thulr's
absolute per-dimension scoring can't resolve. A few objective checks are
pi-flows-only by construction (route dispatch, the same-model vote warning); plain
pi can't satisfy them, so read those as *capabilities flows adds*, not plain losses.
Give a case a `baselinePrompt` when its flow params encode goal info outside `task`
(e.g. a return contract) so the plain arm is graded on the same goal.

## Tool selection

`npm run eval:select` checks invocation discipline: it loads the extension into
headless pi, gives the parent model small and explicit-flow prompts, and scores
actual `flow` tool calls from the JSON stream. This is intentionally separate
from `npm run eval`, because the main harness invokes `flow` directly and cannot
catch overuse on tiny tasks.

## Experiments: champion/challenger (and the optimizer)

The hard cases exist to give a better config **headroom to climb** — and thulr's
experiment loop is how a climb gets measured honestly instead of eyeballed.
`npm run eval -- --trace-only --trace-out={out}` is the harness's **re-run mode**:
it runs every flow and emits the self-contained trace, leaving judge/rank/select
to the driver. That makes the harness a drop-in command template for
`thulr run-experiment` / `thulr optimize` (exit code only says whether a judgeable
trace was emitted; objective misses travel as labels in the trace).

```bash
# 1. Seed a champion — any full run persists its EvalRun at .thulr/runs/candidate.json
npm run eval

# 2. Frame the experiment (deterministic 70/30 train/test split; guardrails block promotion)
thulr experiment new subject-model-bakeoff \
  --hypothesis "a cheaper local subject model matches codex on the hard review cases" \
  --champion .thulr/runs/candidate.json \
  --guardrail criterion --score-guardrail criterion

# 3. Let thulr drive: per candidate it runs the template, judges the emitted trace,
#    registers the challenger, ranks on the train split, and selects.
cat > /tmp/candidates.json <<'EOF'
[
  { "label": "qwen3-coder-30b", "params": { "model": "llama-cpp/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_XL" } },
  { "label": "gpt-5.5",         "params": { "model": "openai-codex/gpt-5.5" } }
]
EOF
thulr run-experiment .thulr/experiments/subject-model-bakeoff.json \
  --candidates /tmp/candidates.json \
  --template "node --import tsx evals/run.mjs --trace-only --trace-out={out} --model={param.model}" \
  --model anthropic/claude-haiku-4-5

# Or hands-off — grid axes, judged every round, held-out-validated, bounded budget:
thulr optimize .thulr/experiments/subject-model-bakeoff.json \
  --template "node --import tsx evals/run.mjs --trace-only --trace-out={out} --model={param.model}" \
  --grid "model=openai-codex/gpt-5.4-mini,openai-codex/gpt-5.5" \
  --max-rounds 3 --model anthropic/claude-haiku-4-5
```

Selection is overfit-guarded: a challenger must beat the champion on the **train**
split, clear every guardrail, **and** validate on the **held-out** split; within-band
margins are honest ties, and `experiment promote` writes an append-only audit
record. `thulr experiment show .thulr/experiments/<id>.json` prints the full state,
and `thulr dashboard` watches a run live. **Cost note:** every candidate is a full
suite run on the subject model plus a judge pass — scope with `--filter` in the
template or `--max-candidates` before launching a wide grid.

## Add a case

Append to `cases.mjs`:

```js
{
  name: "my-case",
  params: { agent: "recon", task: "…" },   // the flow tool input
  cwd: "/optional/working/dir",
  criterion: "One strict, literal statement a correct answer must satisfy.",  // graded by thulr's judge
  score(result, ctx) {                       // objective, deterministic check
    const ok = /expected/.test(result.content[0].text);
    return { pass: ok, score: ok ? 1 : 0, notes: "…" };
  },
  mock: { content: [{ type: "text", text: "expected" }], details: { results: [] } },
}
```

Keep `score` **objective** (a known answer, the chosen route, a passing gate) — it
gates behaviour *and* becomes thulr's calibration label. Write `criterion` as a
single literal statement of what a correct answer must say; thulr grades the answer
text against it on a different vendor than the subject. Always provide a `mock` so
`--dry-run` can exercise the runner — and the artifact emission — offline.

### Hard cases (`hard: true`)

For **score-tracked** cases — ones that intentionally land mid-scale so a better
prompt/config has room to climb (headroom for thulr's optimizer) — add `hard: true`
and a **multi-part `criterion`** a single pass usually only partly satisfies (e.g.
"names all FOUR defects"). Make `score` return a fraction (`hits / total`). Hard
cases feed the EvalRun and the `--score-guardrail`, but **don't have to pass** for
the run to be green — only a regression in their mean score blocks. Keep the `mock`
a *complete* answer so `--dry-run` stays green. See `review-finds-all-webhook-defects`
(4 defects) and `review-finds-session-cache-defects` (3 defects) — multi-defect code
reviews where a typical pass misses the subtler ones (signature verification, TTL
validation), so a sharper prompt has room to climb.

A *frontier* subject model exhausts these small fixtures (it finds every defect), so
the score pins at 1.0 with no headroom. Rather than pin a different model per case,
the whole suite runs on one cheaper/faster model — `DEFAULT_EVAL_MODEL`
(`openai-codex/gpt-5.4-mini`; override with `--model` or `PI_FLOWS_EVAL_MODEL`). A cheaper
model leaves real headroom on the harder cases *and* is where the flows-vs-plain A/B
(`npm run eval:compare`) shows the extension's lift — plain pi on a frontier model
already aces everything, which hides it.

### Calibration canaries

Add to `CALIBRATION_CASES` when the judge needs more calibration coverage rather
than another live flow delegation. A canary must include `task`, `answer`,
`criterion`, `expectedBehavior`, `failureModes`, and an `objective` with
`pass:false`. Prefer a mix of fully wrong answers and partial answers with
`0 < objective.score < 1`; the former improves TNR, and the latter keeps score
deltas from degenerating into pure pass/fail. Canaries are included in thulr
judge/calibration runs, then filtered out of `.thulr/runs/candidate.gate.json`
before the release gate. The harness reports them separately from behavior cases
and never counts them as behavior failures.
