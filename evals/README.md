# Evals

Model-in-the-loop evaluations of pi-flows' actual delegation **behaviour** — does
routing pick the right agent, does retrieval find the answer, does the evaluate
loop run to completion, does a judge-able answer hold up. This complements the
offline unit/integration tests (`npm test`), which prove the *plumbing* against a
stub `pi` but never call a model.

Every case is scored on **two independent axes**: a deterministic objective check
(known answer, chosen route, passing gate) **and** a cross-model LLM judge that
grades the answer against one literal criterion. The judge runs on a *different*
vendor than the subject under test (default `anthropic/claude-sonnet-4-6`), so no
model grades its own family. A case passes only when both agree.

> These run **real** `flow` delegations through **real** `pi`, so they need the
> `pi` CLI on PATH and a configured model provider, and **they spend tokens**.
> They are intentionally not part of `npm run check` / CI.

## Run

```bash
npm run eval                       # all cases, on your pi default model
npm run eval -- --filter=route     # only matching cases
npm run eval -- --model=openai-codex/gpt-5.5   # explicit subject provider/model
npm run eval -- --judge-model=anthropic/claude-opus-4-8   # judge model (default: anthropic/claude-sonnet-4-6)
npm run eval -- --cap=1.00         # per-case USD ceiling (default 0.50)
npm run eval -- --write-baseline=evals/baseline.json
npm run eval -- --compare-baseline=evals/baseline.json
npm run eval -- --dry-run          # framework smoke: canned results, no model
```

Exit code is `0` when every selected case passes, `1` otherwise. Each case is
bounded by the flow tool's own `maxCostUsd`, so a runaway delegation is capped.
Baseline comparison fails on pass→fail regressions and score drops greater than
`0.05`, giving release checks a stable "did this get worse?" gate without adding
the model evals to normal CI.

## Provider & auth (local dev)

With no `--model`, the harness uses **your pi default** — `defaultProvider/defaultModel`
from `~/.pi/agent/settings.json` (e.g. `openai-codex/gpt-5.5`) — so it runs on
whatever you already use pi with. Auth is pi's own:

- **Subscription / OAuth** — `pi`, then `/login` (stored in `~/.pi/agent/auth.json`). Nothing else to do.
- **API key** — drop it in a gitignored `.env` (see `.env.example`); `npm run eval` loads it:

  ```bash
  cp .env.example .env      # then add e.g. ANTHROPIC_API_KEY=sk-ant-…
  ```

Override with `--model=<provider/id>` (OAuth providers like `openai-codex` need the
provider prefix), or `--model=agent` to run each agent on its own frontmatter model.
Cases that can't reach the model (auth, credits, network) are flagged `⚠` and
reported separately from real eval failures.

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
| `single-answer-quality-judged` | an answer is graded purely by the LLM judge (`judge.mjs`) |

Plus: **every** case above is independently graded by the cross-model judge
(default `anthropic/claude-sonnet-4-6`, override with `--judge-model` /
`PI_FLOWS_JUDGE_MODEL`) against a single literal `criterion`. The table's objective
checks gate *behaviour*; the judge gates *answer quality*; a case passes only when
both agree. Pointing the judge at a different vendor than `--model` is what keeps it
from grading its own model family — the calibration gap the old single-judge setup
had.

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

Absolute judge scores cluster (0.7/0.8/0.9/1.0) and can't resolve small gaps, so a
±0.04 "lift" is within judge noise. **`--pairwise`** is the sensitive metric: it shows
the judge both answers at once and asks which is better — run twice with positions
swapped to cancel order bias, scored a win only when both orderings agree — and tells
the judge *not to reward length* (so flows' compact-summary style isn't penalized).
A few objective checks are pi-flows-only by construction (route dispatch, the
same-model vote warning); plain pi can't satisfy them, so read those as *capabilities
flows adds*, not plain losses. Give a case a `baselinePrompt` when its flow params
encode goal info outside `task` (e.g. a return contract) so the plain arm is graded on
the same goal.

## Add a case

Append to `cases.mjs`:

```js
{
  name: "my-case",
  params: { agent: "recon", task: "…" },   // the flow tool input
  cwd: "/optional/working/dir",
  criterion: "One strict, literal statement a correct answer must satisfy.",  // graded by the cross-model judge
  score(result, ctx) {                       // objective, deterministic check
    const ok = /expected/.test(result.content[0].text);
    return { pass: ok, score: ok ? 1 : 0, notes: "…" };
  },
  mock: { content: [{ type: "text", text: "expected" }], details: { results: [] } },
}
```

Keep `score` **objective** (a known answer, the chosen route, a passing gate) — it
gates behaviour. Write `criterion` as a single literal statement of what a correct
answer must say; the judge grades the answer text against it on a different vendor
than the subject, and the case passes only when both agree. Always provide a `mock`
so `--dry-run` can exercise the runner offline.
