# thulr eval audit - 2026-06-11

## Context

thulr 0.1.2 adds richer trace inspection, failure labeling, calibration inputs,
eval-set overlays, and efficiency guardrails. The pi-flows eval harness was
updated to emit the new trace metadata and to run `inspect-trace` and
`label-failures` before paid judging.

## Verified

- The initial `npm run eval -- --dry-run` emitted a judge-grade trace with
  9 cases / 18 spans.
- `thulr inspect-trace --trace evals/thulr-trace.dry-run.jsonl --json` reports
  0 required issues, 0 warnings, and 100% coverage for criterion, final output,
  expected behavior, failure modes, prompt/config version, task input, subject
  model, cost, tokens, and trajectory steps.
- After the follow-up calibration fix, `npm run eval -- --dry-run` emits a
  judge-grade trace with 12 cases / 24 spans: 7 behavior, 2 hard score-tracked,
  and 3 calibration canaries.
- The follow-up dry-run trace inspection reports 0 required issues, 0 warnings,
  and 100% coverage across the 12-case trace.
- A follow-up full Anthropic run completed with the new canaries. Result:
  7/7 behavior cases passed, 2 hard cases score-tracked, thulr judged 12/12
  cases, and the three calibration canaries failed as expected
  (`0.00`, `0.25`, `0.00`). Calibration improved to `TPR=100.0%` and
  `TNR=100.0%`.
- Filtering the same candidate to `.thulr/runs/candidate.gate.json` makes the
  quality gate pass against the existing baseline: criterion pass-rate stayed
  `100.0% -> 100.0%` and score moved `0.97 -> 0.98` (`score_delta=+0.003`).
  With token efficiency enabled, the gate still fails at `--noise-band=0.05`
  and passes at `--noise-band=0.10`.
- A full fallback eval run completed with
  `npm run eval -- --judge-model=openai-codex/gpt-5.4-mini --efficiency-guardrail=cost_usd --efficiency-guardrail=tokens --junit=.thulr/runs/gate.junit.xml`.
  Result: 7/7 behavior cases passed, 2 hard cases score-tracked, thulr judged
  9/9 cases, and the gate returned WARN rather than FAIL.
- After Anthropic credits were restored, a full cross-vendor run completed with
  `npm run eval -- --judge-model=anthropic/claude-haiku-4-5 --timeout=300000 --efficiency-guardrail=cost_usd --efficiency-guardrail=tokens --write-baseline --junit=.thulr/runs/gate.junit.xml`.
  Result: 7/7 behavior cases passed, 2 hard cases score-tracked, thulr judged
  9/9 cases, and the gate returned WARN rather than FAIL against the old
  baseline. The run was promoted to `evals/thulr-baseline.json`.
- A post-promotion gate check against `.thulr/runs/candidate.json` returned PASS
  with efficiency deltas for `cost_usd`, `tokens`, `steps`, and `tool_errors`.

## Findings

- The first cross-vendor attempt failed before gating because
  `anthropic/claude-haiku-4-5` returned `out of extra usage`. That was resolved
  by adding Anthropic credits and rerunning.
- The old committed `evals/thulr-baseline.json` was produced before efficiency
  stamping, so the first full Anthropic rerun could only WARN on efficiency:
  `efficiency guardrails were requested but neither run carries per-case
  efficiency`. The promoted baseline now includes per-case `cost_usd`,
  `tokens_total`, `steps`, and `tool_errors`, so efficiency guardrails are armed.
- Calibration still reported `TPR=100.0%` and `TNR=0.0%` on the promoted
  Anthropic run because both hard review cases were intentionally partial on the
  deterministic objective axis (`deterministic_label:false`), while the judge
  returned PASS with high scores. That is useful calibration signal: the judge is
  lenient on incomplete hard-case answers, so hard cases should remain
  score-tracked rather than behavior-gated.
- The thulr MCP/CLI queue state showed no active queue entries after calibration,
  despite the latest calibration text saying `disagreements queued: 2`; treat the
  calibration report as the durable evidence until queue persistence is clarified.
- The first full canary run made a gate semantics issue obvious: expected-fail
  calibration rows improve TNR, but if they are included in the release
  pass-rate gate, the old 9-case baseline looks like a product regression
  (`100.0% -> 75.0%`). The harness now writes a filtered gate candidate that
  excludes canaries after calibration.
- The same full run failed the `tokens` efficiency guardrail even after filtering
  canaries: live compared cases used `226432` tokens vs baseline `210192`
  (`+7.7%`, beyond the default `0.05` noise band). Behavior and criterion scores
  did not regress (`score_delta=+0.003` on the filtered gate candidate), so this
  looks like either normal model verbosity variance or an overly tight token
  guardrail for this suite. Keep it visible rather than auto-promoting over it.
- A later quality-focused rerun completed the live flow phase but could not run
  the Anthropic judge: `anthropic/claude-haiku-4-5` returned `out of extra usage`,
  causing 12/12 judge infra failures. The live flow result was 7/7 behavior
  cases passed, 2 hard cases score-tracked, 3 calibration canaries emitted, and
  a judge-grade trace with 0 warnings. Treat this as provider quota blocking the
  cross-vendor judge, not a pi-flows behavior regression.

## Operator Impression

thulr is useful as a regression gate and trace-contract enforcer. The strongest
part of the workflow was `inspect-trace`: it immediately exposed missing
`expected_behavior`, `failure_modes`, `config_version`, zero-valued efficiency
metrics, and thin trajectory coverage. That turned a vague "eval trace looks
okay" question into a concrete checklist. The promoted EvalRun also now carries
enough repro and efficiency metadata to compare cost/token/step changes instead
of only answer quality.

The weak spot is the experience the user noticed: the result still reads like
"everything passed." That is partly thulr's gate framing and partly our eval
design. thulr does preserve numeric scores (`0.80`, `0.95`, score mean/stddev,
score guardrails), but the harness and terminal summary lead with pass/fail
glyphs and behavior pass counts. More importantly, most current criteria are
binary and easy: once the answer clears the literal criterion, there is little
visible headroom. The hard cases are intended to create headroom, but calibration
showed the Anthropic judge still marked incomplete hard-case outputs as PASS with
high scores. So the gate can be green while the suite is still telling us "this
judge/suite is too lenient."

My read: thulr is doing the right kind of regression bookkeeping, but our suite
is not yet shaped like an optimization target. It is better at answering "did we
break a known behavior?" than "did we get materially better?" To get useful
improvement signal, we should add scored dimensions with room between pass and
excellent:

- Split broad criteria into dimensions such as correctness, completeness,
  evidence quality, contract adherence, and efficiency.
- Report numeric score deltas prominently in the harness summary, not only
  PASS/FAIL and gate status.
- Keep behavior cases as guardrails, but add "north-star" hard cases where the
  expected outcome is a score distribution, not a binary pass.
- Add explicit negative/partial-answer cases so calibration has true negatives
  and the judge cannot pass every plausible-looking answer.
- Treat hard-case judge PASS on deterministic partial answers as a calibration
  warning to tune the criterion, judge prompt, or case shape before relying on
  that dimension for promotion.

Follow-up: that assessment was legitimate. The suite weakness was mostly our
setup, not a thulr limitation: thulr already had score deltas and JUnit aggregate
properties, but the harness was leading with glyphs and the suite had too few
known negatives. The harness now adds fixed calibration canaries to the trace,
keeps them in the full judged EvalRun for calibration, filters them out of the
release gate candidate, and prints the numeric `thulr gate --json` score,
pass-rate, and efficiency deltas before the human gate report.

## Responsibility Split

thulr should own the eval-loop mechanics around efficiency and comparison:

- Measuring token/runtime/cost deltas.
- Showing per-case efficiency regressions, not just aggregate.
- Letting us separate calibration canaries from release-gate cases cleanly.
- Running champion/challenger experiments to answer "same quality, fewer tokens?"
- Guarding against efficiency regressions in eval/CI, with explicit noise bands.

pi-flows should avoid unnecessary work in the product path, but not by imposing
hard product token caps. Token and runtime caps belong in eval budgets,
guardrails, and user-configurable limits; product optimizations should remove
redundant model calls, verbose handoffs, and repeated evidence gathering without
kneecapping hard real-world tasks.

## Fixed During Audit

- The eval trace now emits a case root span plus final-answer span per case,
  eliminating thulr's prior trajectory coverage warning.
- The trace now carries `thulr.expected_behavior`, `thulr.failure_modes`,
  `thulr.config_version`, `thulr.task.input`, and zero-valued cost/token metrics.
- The harness now passes `scripts/thulr-judge-pi.sh` to thulr by default when
  present, while still allowing `--judge-bin` / `THULR_JUDGE_BIN` override.
- The eval infra-error detector no longer classifies normal security-review text
  mentioning API keys as a provider/auth failure.
- The eval infra-error detector now also avoids classifying ordinary
  security-review findings about missing authentication/API-key checks as
  provider failures; provider-shaped auth errors are still detected.
- The `recon-retrieves-known-value` criterion now accepts the exact terse answer
  `xyzzy-42`, matching the task's instruction to report exactly that value; the
  prior sentence-shaped criterion caused Anthropic to fail a correct terse answer.
- The `recon-retrieves-known-value` fixture now uses
  `SAMPLE_IDENTIFIER=xyzzy-42` instead of token-shaped wording, so the case tests
  ordinary repo retrieval instead of accidentally provoking secret-extraction
  refusal behavior.
- Added three fixed calibration canaries:
  `calibration-known-value-wrong`, `calibration-webhook-partial-review`, and
  `calibration-consensus-wrong-answer`.
- Calibration canaries are now excluded from `.thulr/runs/candidate.gate.json`
  before release gating/baseline promotion, preserving their TNR value without
  counting expected FAIL verdicts as product pass-rate regressions.
- The thulr terminal summary now leads gate comparison with numeric score,
  pass-rate, and efficiency deltas from `thulr gate --json`; JUnit still carries
  the same aggregate properties, including `thulr.aggregate.score_delta`.
- Added `--noise-band=<n>` to make score/pass-rate/efficiency guardrail
  tolerance explicit; the default remains `0.05`.

## Codex Local Run

Command:

```bash
npm run eval -- --model=openai-codex/gpt-5.4-mini:low --judge-model=openai-codex/gpt-5.5:xhigh --timeout=300000 --junit=.thulr/runs/gate.junit.xml
```

This used local Codex OAuth for both execution and judging: cheap execution on
`openai-codex/gpt-5.4-mini:low`, high-capability judging on
`openai-codex/gpt-5.5:xhigh`. The run was intentionally not promoted as a new
baseline because it changes judge family/scale from the current baseline.

Result: `6/7` behavior cases passed, both hard review cases scored `1.00`, and
all three calibration canaries behaved as intended. The release gate failed
against `evals/thulr-baseline.json` because `recon-retrieves-known-value`
regressed from pass to fail. thulr reported:

- Criterion score: `0.972 -> 0.889` (`-0.083`)
- Release pass-rate: `100.0% -> 88.9%` (`-11.1pp`)
- Cost: `$0.5927 -> $0.2889` (`-51.3%`)
- Tokens: `210192 -> 162126` (`-22.9%`)
- Steps/tool errors: unchanged (`18` steps, `0` tool errors)

The failure appears to be an eval-fixture issue, not a flow-routing failure. The
case asked the executor to find `MAGIC_TOKEN`; `gpt-5.4-mini:low` refused to
extract or reveal a secret-shaped token value from the repo instead of returning
the fixture value `xyzzy-42`. We changed the fixture and criteria to
`SAMPLE_IDENTIFIER=xyzzy-42` so this remains an ordinary known-value retrieval
case. If we intentionally want to measure secret-handling behavior, that should
become a separate negative or safety-refusal case rather than a release-gate
behavior case.

Follow-up after fixing the fixture and the infra-error false positive:

```bash
npm run eval -- --model=openai-codex/gpt-5.4-mini:low --judge-model=openai-codex/gpt-5.5:xhigh --timeout=300000 --junit=.thulr/runs/gate.junit.xml
```

Result: PASS. The run judged all 12 cases, with `7/7` behavior checks passing,
both hard cases graded `1.00`, and all three calibration canaries preserving
`TPR=100.0%` and `TNR=100.0%`. thulr reported criterion score
`0.972 -> 1.000` (`+0.028`), pass-rate `100.0% -> 100.0%`, cost
`$0.5927 -> $0.3091` (`-47.8%`), and tokens `210192 -> 125615` (`-40.2%`).
