# Evals

Model-in-the-loop evaluations of pi-flows' actual delegation **behaviour** — does
routing pick the right agent, does retrieval find the answer, does the evaluate
loop run to completion, does a judge-able answer hold up. This complements the
offline unit/integration tests (`npm test`), which prove the *plumbing* against a
stub `pi` but never call a model.

Every case is scored on **two independent axes**:

1. a **deterministic objective check** (known answer, chosen route, passing gate) —
   this gates *behaviour*, and doubles as the `objectiveScore` **label**;
2. **thulr's calibrated LLM judge**, which grades each answer against the primary
   `criterion` plus named `thulr.criteria.<dimension>` rubrics and **gates quality
   regressions** against a baseline.

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
npm run eval -- --filter=pattern-  # new-mode workflow/worktree/debate/dossier/monitor cases
npm run eval -- --include-controls # include simple threshold/control cases in the default set
npm run eval -- --model=openai-codex/gpt-5.5   # explicit subject provider/model
npm run eval -- --judge-model=anthropic/claude-opus-4-8   # thulr judge model (default: anthropic/claude-haiku-4-5)
npm run eval -- --judge-bin=/path/to/judge-wrapper   # override thulr's judge command
npm run eval -- --samples=3        # judge each case 3×: majority verdict, mean score, flake warnings (3× judge spend)
npm run eval -- --trials=5         # run the stochastic subject case 5× in isolated workspaces
npm run eval -- --trials=20 --reliability-out=.thulr/runs/reliability.json
npm run eval -- --eval-set=.thulr/eval-sets/release.json   # overlay promoted criteria / guardrail authority
npm run eval -- --reviews=.thulr/reviews/thulr-trace.reviews.json   # fold human SME verdicts into calibration (judge-vs-human TPR/TNR)
npm run eval -- --efficiency-guardrail=cost_usd --efficiency-guardrail=tokens   # fail on spend/token regressions
npm run eval -- --noise-band=0.10  # regression tolerance for score/pass-rate/efficiency guardrails (default 0.05)
npm run eval -- --cap=1.00         # per-case USD ceiling on flow delegations (default 0.50)
npm run eval -- --arm-timeout=30000 # smoke/debug only; every row is excluded from quality verdicts
npm run eval -- --write-baseline   # promote this run to evals/thulr-baseline.json (the gate baseline)
npm run eval -- --compare-baseline=evals/thulr-baseline.json   # gate against a specific baseline
npm run eval -- --junit=.thulr/runs/gate.junit.xml   # also write the gate verdict as JUnit XML (CI test ingestion)
npm run eval -- --trace-only --trace-out=/tmp/t.jsonl   # run flows + emit the trace, no judge/gate (see Experiments)
npm run eval -- --run-id=release-123 --runtime-trace=/tmp/runtime.jsonl # stable eval/runtime linkage
npm run eval -- --dry-run          # framework smoke: canned results, no model, no thulr calls
npm run eval:select                # tool-selection eval: should the parent model call flow at all?
```

`--trials=N` measures **subject reliability** and is independent of
`--samples=N`, which repeats only the judge to estimate **judge noise**. Every
subject trial gets a stable base case id plus a unique `::trial-NNN` id and a
fresh equivalent workspace. The reliability artifact retains raw per-trial
answers, objective and judge outcomes, cost, tokens, duration, exclusions, and
infrastructure failures. Its per-case and aggregate summaries report empirical
pass@1, pass@k, pass^k, Wilson 95% intervals for binary pass rates, and p50/p95
latency and cost when enough valid trials exist. A separate sensitivity view
counts infrastructure-invalid trials as failures. Subject trials are capped at
50 because each one can spend the case's full token and cost budget.

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
   `criterion` and any `thulr.criteria.<dimension>` rubrics → an EvalRun. thulr
   reads everything from the trace — no separate cases-manifest or labels files.
   With `--samples=N` each case is judged N times and aggregated (majority
   verdict, ties fail safe; mean score) — the EvalRun's `score_stddev` then
   reports **judge noise** instead of cross-case spread, and thulr warns when
   cases flip verdicts across samples. Use it when a gate verdict looks flaky
   before believing (or rebaselining over) the result.
5. `thulr calibrate --labels .thulr/runs/candidate.labels.json` prints **TPR/TNR**
   — how well the judge's verdicts track the inline deterministic labels, with
   failure labels included in the report. (An uncalibrated judge can silently
   certify regressions; this is the calibration the old single-judge setup lacked.)
   Record human SME verdicts with `npm run eval:review` and the harness folds them
   in as a second ground-truth axis (`--reviews`; judge-vs-human TPR/TNR) — see
   [Human review & failure triage](#human-review--failure-triage). thulr also
   queues every judge/ground-truth disagreement onto `thulr queue` and feeds this
   calibration into the gate: a judge blind in either direction (TPR or TNR 0% over
   labeled cases) downgrades a clean PASS to WARN with the dimension named.
6. Before gating, pi-flows writes `.thulr/runs/candidate.gate.json`, which is the
   judged EvalRun with calibration canaries filtered out and summaries
   recomputed. `thulr gate` compares that gate candidate to
   `evals/thulr-baseline.json` with a 0.05 noise band by default (`--noise-band`
   overrides it) and **fails the run on a regression** (it exits `10`). It guards
   criterion pass rate and mean score by default; named score dimensions are opt-in
   with `--score-guardrail=<dimension>` once the baseline contains them. Older
   baselines that only have `criterion` still gate `criterion`; new named dimensions
   are reported as waiting for a refreshed baseline. Add repeatable
   `--efficiency-guardrail=<metric>` for thulr's
   efficiency axes (`cost_usd`, `tokens`, `steps`, `tool_errors`) once the
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
`thulr.failure_modes`, named `thulr.criteria.<dimension>` rubrics, optional
`thulr.label.<dimension>` ground truth, optional `thulr.judge_only.<dimension>`
flags, and its objective `thulr.deterministic_label` (a boolean) carried
**inline** in the span attributes (plus numeric timing fields). So the harness
emits a compact **case root span plus final-answer span**: the final span carries
the canonical answer (the same text the objective scorer graded) alongside its
criterion and labels, while the root span gives thulr enough trajectory shape for
inspect/label workflows — no separate cases or labels files. The spans also carry
the contract's optional context/repro attributes: the task text as
`input.value` and `thulr.task.input` (judge context), `thulr.cost_usd` and
`llm.token_count.total` on the final-answer span (per-case spend, summed into the
EvalRun), `thulr.prompt_version` stamped
`pi-flows@<package version>` because the agent prompts ship with the package, and
`thulr.config_version` stamped with the eval subject configuration. Product
spans also carry `pi_flows.eval_run_id`, the exact runtime trace file/trace/root
span, trace health, and separate execution, verified-outcome, and policy-
compliance score-family evidence. A missing runtime trace is recorded as
`pi_flows.runtime_trace.health:"missing"` and a failed trace-health score; it
does not rewrite the agent's execution or outcome score.

`thulr
query-traces --prompt-version` / `--config-version` can slice traces by either
stamp. Sanity-check a trace for free with `thulr inspect-trace --trace
evals/thulr-trace.jsonl`. Final-answer grading still uses the compact
self-contained eval trace—the latest runtime child may be a critic or voter—but
each graded case now references its richer OpenInference runtime trace and exact
root span for diagnosis. The two artifacts remain separate so trajectory capture
cannot change which final answer is graded. Runtime content follows the flow
call's existing `recordContent` and `redactSecrets` controls.

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
need the provider prefix). The single-arm harness also accepts `--model=agent`;
paired comparison requires one explicit model shared by both arms. Cases that
can't complete (auth, credits, network, timeout) are
flagged `⚠`, excluded from judging, and reported separately from real eval failures.
If installed user pi extensions break child-agent startup, run evals with
`PI_FLOWS_CHILD_NO_EXTENSIONS=1`; do not use that isolation when your selected
subject model itself comes from a pi extension provider.

The harness preflights the gate's environment with `thulr doctor --json` (version,
workspace, store, judge binary) and reports thulr's own diagnosis on failure. If
`thulr` is missing, install it and put it on PATH, or smoke-test the harness
offline with `npm run eval -- --dry-run`.

By default the harness lets thulr use its embedded `pi` judge runtime. Pass
`--judge-bin=/path/to/judge-wrapper` or set `THULR_JUDGE_BIN` only when you need
an external judge command. The committed `scripts/thulr-judge-pi.sh` wrapper is
still available for local providers such as `llama-cpp/...` that require pi
extensions during judging; it removes `--no-extensions` from the judge invocation
and tolerates a post-verdict `pi` teardown crash as long as stdout already
contains `VERDICT:`.

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
| `pattern-workflow-*` | train/holdout migration runbooks preserve source constraints, measurable gates, rollback, ownership, approval, and persisted artifacts |
| `pattern-worktree-*` | two isolated writers fix independent modules, integrate their commits, and pass a deterministic test on the integration branch |
| `pattern-debate-*` | advocates and an adjudicator choose one architecture against binding constraints, exact measurements, mitigations, and reversal gates |
| `pattern-dossier-*` | source-specific extractors reconcile documented, deployed, incident, and telemetry evidence without smoothing conflicts or inventing provenance |
| `pattern-monitor-*` | a bounded probe captures the first transient trigger and a reactor connects that exact event to logs, safe runbook actions, and verification gates |

Plus: **every** case above is independently graded by thulr's cross-model judge
(default `anthropic/claude-haiku-4-5`, override with `--judge-model` /
`PI_FLOWS_JUDGE_MODEL`) against a primary `criterion` and named dimensions such as
`exactness`, `completeness`, `contract_adherence`, and `evidence_quality`. The
table's objective checks gate *behaviour* and label the run; thulr's judge gates
*answer quality*; a case passes only when both agree. Pointing the judge at a
different vendor than `--model` is what keeps it from grading its own model family.

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

The pattern cases are hard, source-grounded train/holdout pairs. They are intended
to measure mode-specific headroom, not to imply that every release note, code edit,
comparison, research question, or status check should activate a flow.

## Pi Flows vs a direct baseline (A/B)

Does orchestration improve the same model's result? `npm run eval:compare` runs
every case through two arms, writes one thulr trace per arm, judges both with the
same calibrated cross-model judge, and runs `thulr compare` with the direct arm as
the baseline and Pi Flows as the candidate:

- **flows** -- the case's flow params, specialist roles, and orchestration.
- **Codex baseline (default)** -- one direct `codex exec` run with the same
  `openai-codex/<model>`, task, and isolated workspace, without Pi Flows.
- **plain Pi baseline (optional)** -- `--baseline=pi` uses one headless
  `pi --no-extensions` call instead, for comparison with the parent runtime.

```bash
npm run eval:compare -- --trials=5 --constraint=deadline:600000 # repeated pairs under one wall-clock constraint
npm run eval:compare -- --baseline=pi --constraint=cost:2 --non-inferiority-margin=0.02 # cost-bound non-inferiority
npm run eval:compare -- --baseline=pi --constraint=generated_tokens:20000 --improvement-margin=0.03 # token-bound improvement
npm run eval:compare -- --filter=pattern- # only workflow/worktree/debate/dossier/monitor A/B cases
npm run eval:compare -- --baseline=pi   # compare against plain headless Pi instead of direct Codex
npm run eval:compare -- --include-controls # also run simple threshold/control cases
npm run eval:compare -- --duel          # add native thulr head-to-head quality judging
npm run eval:compare -- --filter=vote   # scope to keep cost down (runs both arms per case)
npm run eval:compare -- --arms=no-verifier,full --filter=evaluate # attribute verifier lift
npm run eval:compare -- --arms=sequential,parallel --filter=vote  # isolate parallelism
npm run eval:compare -- --arms=random-routing,oracle-routing --filter=route # routing headroom
npm run eval:compare -- --infra-retries=1 --infra-retry-delay=15000 # retry zero-token startup infra only
npm run eval:compare -- --write=evals/compare.json
npm run eval:compare -- --run-id=ab-123 --runtime-trace=/tmp/ab-runtime.jsonl
npm run eval:compare -- --dry-run       # wiring smoke, no model

# Diagnose WHY either arm scored as it did. The flows arm records its full child
# tree; direct/plain baselines receive a process-root runtime span in the same file.
npm run eval:compare -- --duel --runtime-trace=/tmp/ab-runtime.jsonl --write=evals/compare.json
npm run trace:report -- /tmp/ab-runtime.jsonl
```

`--arms=<reference>,<candidate>` selects two named arms without copying case
definitions. The default remains `direct,full`. Supported controls are:

- `compute-matched-self-review`, `deterministic-workflow`, and
  `no-communication-ensemble` for extra-compute, fixed-workflow, and ensemble
  alternatives;
- `random-routing` and label-defined `oracle-routing` for routing value;
- `no-integrator`, `no-verifier`, and `minimal-context` for component/context
  ablations;
- `sequential` and `parallel` for execution-order comparisons.

Each arm inherits the declared binding constraint. The artifact records its
topology and configuration identity, attributes measured lift to the ablated
component, retains bounded per-case answer/objective evidence, and links both
arms of every repeated trial to stable run/case/trial/arm identities plus the
exact runtime trace/root span. An arm that
does not apply to a case is excluded as `inapplicable` with a durable reason,
never silently scored. For statically predictable topologies,
`compute-matched-self-review` uses one repeated agent profile with the full
case topology's planned model-call count and the same binding allocation; both
the call count and binding are recorded in its configuration identity.
Data-dependent topologies (early-stopping loops, generated fan-out, gates, and
conditional synthesis) are explicitly inapplicable because their realized call
count cannot be matched before execution.

The fair A/B contract is enforced rather than inferred:

- Both arms get the same underlying subject model. A reported model mismatch marks
  the pair as infra/inconclusive instead of allowing a cross-model comparison.
- Every case/trial creates one immutable workspace snapshot, clones it into
  independently mutable arm directories, and gives both arms the exact same
  top-level `params.task`, model, snapshot id, and trial index. Flow-only
  coordination parameters may change how that task is executed, never what the
  direct arm is asked to do.
- Arm order is deterministically counterbalanced across case/trial pairs so
  provider load, quota, and cache drift are not perfectly confounded with treatment.
- Unrelated user extensions are disabled. Artifact-producing cases expose only
  explicitly bounded workspace files to the judge, so the final answer and the
  tested artifact are graded together without leaking arbitrary repo state.
- Exactly one resource is binding. `--constraint=deadline:<ms>` enforces the same
  wall-clock deadline on both arms. With `--baseline=pi`, `cost:<USD>` and
  `generated_tokens:<count>` stop each arm at the first completed model-response
  accounting boundary that reaches its ceiling. The Codex CLI cannot enforce
  those two resource ceilings mid-execution, so they fail preflight unless the
  plain Pi baseline is selected. An arm with unknown or over-limit usage, or
  whose runtime stops at the exact budget ceiling, makes its pair inconclusive.
  With no flag, the declared constraint defaults to `deadline:<--timeout>`.
  Legacy `--cap=<USD>` and `--arm-timeout=<ms>` are aliases for cost and
  deadline declarations and cannot be combined with `--constraint`.
  Non-binding resources remain observed outcomes; `--timeout` is only a
  process-safety ceiling when cost or tokens is binding.
- Only pairs where both arms complete without exclusion enter thulr traces and
  quality-lift summaries. Timeout, provider/infra, constraint, and model-parity
  failures make the whole pair inconclusive; artifacts still retain quality,
  reliability, cost, generated and total tokens, end-to-end latency, accumulated
  worker time, attempts, and exclusion reasons. Resource deltas retain invalid
  pairs whenever both finite observations are available, preventing failed or
  budget-stopped executions from disappearing from efficiency results.
- The default infra retry applies only to zero-token, zero-cost startup failures.
  It does not retry timeouts or completed answers and therefore cannot cherry-pick
  a better response. Every attempt starts from a fresh clone of the immutable
  pair snapshot, and all attempts plus retry delays share one outer arm deadline.
  End-to-end latency includes failed attempts and delays; worker time includes
  every attempted execution.

`eval:compare` adds the same calibration canaries to both arm traces, filters them
out of the comparison artifacts, and prints per-dimension baseline -> flows deltas.
Its paired report first averages repeated trials within each case, then estimates
the across-case mean delta and 95% t interval so repeated trials do not masquerade
as independent cases. Reliability uses an exact sign test over case-level paired
pass-rate deltas, so repeated trials are not counted as independent binary pairs.
Every metric is repeated by portfolio suite and task family. `--write` preserves
the raw per-trial rows for independent reanalysis, including invalid pairs.
`--improvement-margin=<delta>` promotes only when the quality interval clears a
positive margin; `--non-inferiority-margin=<delta>` instead requires its lower
bound to clear the negative margin. These predeclared decisions are separate from
thulr's legacy aggregate `--noise-band`.
With `--duel`, thulr also runs an **order-controlled head-to-head** judge over
shared cases and reports flows wins, baseline wins, ties, position-bias flips, and
skipped one-sided cases. `--pairwise` remains an alias for `--duel`. The duel is
especially useful when absolute rubric scores are saturated, but it does not erase
the activation threshold: if the direct baseline already meets the criteria and
flows only ties at higher cost/latency, that task belongs on the **do not invoke
flow** side of `eval:select`.

Simple/single-answer cases are plumbing controls and threshold calibrators, not
evidence for automatic delegation. They are excluded from default `eval` /
`eval:compare` sets and run only when explicitly filtered or with
`--include-controls`. A few older objective checks are Pi-Flows-only by construction
(for example route dispatch or same-model vote warnings); read those as capability
checks, not baseline losses. Direct Codex does not report USD cost, so its cost is
estimated from its normalized token breakdown using the same model-price table as
Pi Flows. Both arms retain non-cached input, output, cache read/write, total tokens,
and estimated USD cost in the terminal summary and written A/B artifact. These are
model-price estimates for comparison, not provider invoices.

### Current pattern baseline

Local train/holdout runs on 2026-07-16 used the same subject in both arms
(`openai-codex/gpt-5.4-mini`), the same full per-case clock, and the same
cross-vendor judge (`anthropic/claude-haiku-4-5`). No row below came from an
`--arm-timeout` debug budget. Mean quality is the unweighted mean of the judged
criterion dimensions for the named case.

| Pattern | Direct Codex | Pi Flows | Held-out interpretation |
| --- | ---: | ---: | --- |
| Workflow | 0.825 | 0.988 | Clear lift on evidence and operational completeness; auto-select only when persisted phases, gates, or resumable approval are part of correctness. |
| Worktree | 0.963 | 0.975 | Small holdout lift after a 0.788 -> 0.975 train gain, but substantially higher latency; auto-select only when native isolation and shared-change reconciliation are required. |
| Debate | 1.000 | 0.975 | No stable lift: the order-controlled duel flipped and the direct answer was already saturated. Keep explicit-only. |
| Dossier | 0.975 | 0.988 | Small lift, with both duel orders choosing Pi Flows; select for real multi-source reconciliation, not one-file lookup. |
| Monitor | 0.838 | 0.975 | Clear lift on evidence quality; select for bounded poll-trigger-react work, not a one-shot status command. |

These are directional baselines over one hard train/holdout pair per new mode,
not population-level effect estimates. Add fixtures and repeat runs before
broadening an activation threshold. The selection suite is the complementary
guardrail: after targeted reruns, all 22 current cases selected the expected path,
including direct handling for simple controls. Runtime timeouts are counted as
infra exclusions, never as failed answers or evidence for/against a threshold.

### Current token-cost baseline

Token reruns on 2026-07-17 used the same `openai-codex/gpt-5.4-mini` subject in
both arms and full per-case budgets. Totals include non-cached input, output, and
cache reads/writes; estimated cost applies the same model price table to both arms.
The fallback same-model judge used to emit these artifacts is not quality evidence,
so routing decisions still use the cross-vendor quality baseline above.

| Pattern run | Direct tokens | Flows tokens | Token ratio | Direct est. | Flows est. | Cost ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Workflow holdout | 65,316 | 372,836 | 5.71x | $0.0270 | $0.1066 | 3.95x |
| Worktree train | 143,203 | 920,405 | 6.43x | $0.0527 | $0.2238 | 4.25x |
| Worktree holdout | 77,978 | 473,894 | 6.08x | $0.0242 | $0.1038 | 4.30x |
| Dossier holdout | 49,750 | 291,640 | 5.86x | $0.0227 | $0.1150 | 5.07x |
| Monitor holdout | 100,531 | 54,271 | 0.54x | $0.0280 | $0.0255 | 0.91x |
| Debate train | 30,787 | 509,967 | 16.56x | $0.0430 | $0.2829 | 6.58x |
| **Auto-routed holdouts** | **293,575** | **1,192,641** | **4.06x** | **$0.1019** | **$0.3510** | **3.45x** |

The aggregate hides substantial mode variance. Monitor was cheaper than direct in
this run; workflow, worktree, and dossier paid roughly 4-5x estimated cost for their
quality headroom; debate paid the largest premium without stable lift and remains
explicit-only. Treat these one-run ratios as threshold evidence, then repeat before
using them as budget forecasts.

## Human review & failure triage

Two free (no judge tokens) thulr workflows close the loop on judged runs.

**Record human verdicts** so calibration measures the judge against a person, not
only the deterministic labels:

```bash
npm run eval:review -- --list
npm run eval:review -- --case single-answer-quality-judged --verdict pass
npm run eval:review -- --case route-classifies-bug-to-recon --verdict fail \
  --failure-mode routing.wrong_agent --note "should have gone to recon"
```

Verdicts land in `.thulr/reviews/thulr-trace.reviews.json`, which the next
`npm run eval` auto-discovers. `calibrate` then reports judge-vs-human TPR/TNR.
Point at an explicit set with `npm run eval -- --reviews=<path>`.

**Rank failure modes across every stored trace**:

```bash
npm run eval:pareto
npm run eval:pareto -- --by=config-version
npm run eval:pareto -- --limit=10
```

## Tool selection

`npm run eval:select` checks invocation discipline: it loads the extension into
headless pi, gives the parent model small no-flow prompts plus explicit and
implicit flow-positive controls, and scores actual `flow` tool calls from the JSON
stream. This is intentionally separate from `npm run eval`, because the main
harness invokes `flow` directly and cannot catch overuse on tiny tasks. Simple
prompts such as arithmetic, package metadata lookup, and tiny text transforms
must complete with zero `flow` calls; otherwise sub-agents were invoked when they
should not have been. Positive controls also assert the selected `flow` argument
shape — for example read-only scouting should become single-agent `recon` or
`analyst`, parallel document inspection should become `tasks`, critic loops should
become `evaluate`, and broad split/synthesize mapping should become `orchestrate`
or an equivalent parallel fan-out. The new mode thresholds are paired explicitly:
one typo is not `workflow`, one branch lookup or ordinary two-file fix is not
`worktree`, an unrequested constrained decision is not `debate`, one source is not
`dossier`, and one status command is not `monitor`; gated/resumable phases,
isolation-critical writers, explicitly requested opposition, multi-source
reconciliation, and bounded trigger/react prompts are the positive controls. For
positive cases the harness stops after the real `flow`
execution starts and captures the final streamed arguments. Child-agent output
quality belongs to the main flow evals; this suite gates whether and how the parent
delegates. A case-level `timeoutMs` takes precedence over the CLI fallback clock;
when that clock expires, the case is reported as `INCONCLUSIVE` and removed from
the pass-rate denominator instead of being scored as a wrong selection. A run
with zero comparable cases exits non-zero because it produced no selection
evidence, even though none of the excluded cases is counted as a wrong answer.

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

Append to `cases.mjs`, `pattern-cases.mjs`, or `selection-cases.mjs`, then register
the stable case id in `case-contract.mjs` with one portfolio suite
(`representative`, `capability`, `regression`, or `adversarial`), a task-family
label, and the structural fields for decomposability, dependency depth, shared
state, risk, and reversibility. All eval entrypoints run this corpus preflight
before checking model binaries or spending tokens. A missing/invalid declaration,
a duplicate id, or a stale source-backed expectation stops the run.

```js
{
  name: "my-case",
  params: { agent: "recon", task: "…" },   // the flow tool input
  cwd: "/optional/working/dir",
  criterion: "One strict, literal statement a correct answer must satisfy.",  // graded by thulr's judge
  criteria: {
    completeness: "Named dimension with score headroom.",
    evidence_quality: "Optional orthogonal dimension.",
  },
  judgeOnlyDimensions: ["evidence_quality"], // when no deterministic label exists
  score(result, ctx) {                       // objective, deterministic check
    const ok = /expected/.test(result.content[0].text);
    return { pass: ok, score: ok ? 1 : 0, notes: "…" };
  },
  mock: { content: [{ type: "text", text: "expected" }], details: { results: [] } },
}
```

When an expected answer comes from a workspace JSON value, bind the expectation
to that source instead of relying on a comment or fixture convention:

```js
sourceExpectation: {
  path: "package.json",
  jsonPath: ["version"],
  expectedPath: ["mock", "answer"],
  patternPath: ["answerPattern"],
}
```

The preflight verifies that both the mock answer and answer pattern accept the
current source value. Workspace-backed cases use case-local semantic assertions
(`format:"text"`, JSON relationships, or a deterministic Node validator) so
unrelated edits do not churn the corpus contract. `corpus.mjs` pins one digest for
the immutable `evals/fixtures` tree. A relevant source edit stops every entrypoint
until its expectations are reviewed. Terminal reports count selected cases and
exclusions by portfolio suite and task family, so a green aggregate cannot hide
which evidence families were absent.

Keep `score` **objective** (a known answer, the chosen route, a passing gate) — it
gates behaviour *and* becomes thulr's calibration label. Write `criterion` as the
primary literal statement of what a correct answer must say, then split useful
quality headroom into named `criteria` dimensions. If a named dimension is
orthogonal to the deterministic objective and you do not have a real
per-dimension label, put it in `judgeOnlyDimensions` so calibration does not treat
the case-level label as ground truth for that dimension. Always provide a `mock`
so `--dry-run` can exercise the runner — and the artifact emission — offline.

**Named criteria (`criteria`)** add multi-dimension judging: each
`{ dimension: "criterion text" }` entry is emitted as `thulr.criteria.<dimension>`
on the graded span and judged into **its own dimension** alongside the required
`criterion` — with its own pass-rate, score delta, and calibration. Use them for
*orthogonal* quality axes (e.g. `evidence_quality`, `impact_explanation`) so a
near-saturated case still produces a gradient. Dimension names must be non-empty,
whitespace-free, and not `criterion`. They are observed by default; gate one with
`--score-guardrail=<dimension>` once it looks stable.

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
	validation), so a sharper prompt has room to climb. Both also carry `criteria`
(`evidence_quality`, `impact_explanation`) so the judge grades *how well* each defect
is explained, not just whether all were found — extra headroom on cases that would
otherwise saturate at "found them all."

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
