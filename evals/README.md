# Evals

Model-in-the-loop evaluations of pi-flows' actual delegation **behaviour** — does
routing pick the right agent, does retrieval find the answer, does the evaluate
loop run to completion, does a judge-able answer hold up. This complements the
offline unit/integration tests (`npm test`), which prove the *plumbing* against a
stub `pi` but never call a model.

> These run **real** `flow` delegations through **real** `pi`, so they need the
> `pi` CLI on PATH and a configured model provider, and **they spend tokens**.
> They are intentionally not part of `npm run check` / CI.

## Run

```bash
npm run eval                       # all cases, on your pi default model
npm run eval -- --filter=route     # only matching cases
npm run eval -- --model=openai-codex/gpt-5.5   # explicit provider/model
npm run eval -- --cap=1.00         # per-case USD ceiling (default 0.50)
npm run eval -- --dry-run          # framework smoke: canned results, no model
```

Exit code is `0` when every selected case passes, `1` otherwise. Each case is
bounded by the flow tool's own `maxCostUsd`, so a runaway delegation is capped.

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
| `route-classifies-bug-to-recon` | the controller dispatches a clear bug to `recon` |
| `recon-retrieves-known-value` | `recon` reads a fixture and reports a known value |
| `vote-reaches-known-consensus` | two voters + aggregator reach the correct answer |
| `evaluate-loop-completes-with-gate` | the generator/critic loop runs with a passing gate |
| `single-answer-quality-judged` | an answer is graded by the LLM judge (`judge.mjs`) |

## Add a case

Append to `cases.mjs`:

```js
{
  name: "my-case",
  params: { agent: "recon", task: "…" },   // the flow tool input
  cwd: "/optional/working/dir",
  score(result, ctx) {                       // may be async (use the judge)
    const ok = /expected/.test(result.content[0].text);
    return { pass: ok, score: ok ? 1 : 0, notes: "…" };
  },
  mock: { content: [{ type: "text", text: "expected" }], details: { results: [] } },
}
```

Prefer **objective** scoring (a known answer, the chosen route, a passing gate).
Reach for the LLM judge (`judge(ctx, { criteria, answer })`) only for genuinely
subjective quality — it asks for one `0..1` score plus a `PASS`/`FAIL` verdict
against a single criterion. Always provide a `mock` so `--dry-run` can exercise
the case offline.
