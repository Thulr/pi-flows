# Quickstart

This quickstart verifies pi-flows without requiring a model call.

## Prerequisites

- Node.js `>=24`, npm `>=11`
- pi CLI `>=0.82.0` on your `PATH` — pi-flows runs **inside** the pi host, so
  step 2 fails without it. If you don't have `pi`, install it from the
  [pi project](https://github.com/earendil-works/pi) (the binary ships in
  `@earendil-works/pi-coding-agent`); see the
  [README Install section](../../README.md#install) for details.

## 1. Install dependencies

```bash
npm ci
npm run check       # build + test this package (does not require pi)
npm run preflight   # verify the pi CLI is on PATH and meets the version floor
```

## 2. Load the extension locally

```bash
pi -e ./extensions/pi-flows/index.ts
```

If this fails with `pi: command not found`, see
[Troubleshooting → `pi: command not found`](../how-to/troubleshooting.md#pi-command-not-found).

## 3. Run no-model smoke checks in pi

These are exact tool invocations, handy for smoke-testing without a model call. In normal use you don't write JSON — you just talk to pi (step 4).

```text
/flows help
/flows status
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

Expected output includes these bundled agents:

- `recon`
- `strategist`
- `overwatch`
- `operator`
- `analyst`
- `redteam`
- `controller`
- `commander`
- `debrief`

## 4. Run a delegated task

Just ask pi in plain English. You don't have to name an agent or write JSON — pi reads your intent and picks the right one:

```text
Scout the codebase and find the extension entrypoint.
```

pi delegates this to `recon` (a read-only scout) and hands back the findings. Want to be explicit instead? Name the agent — *"use recon to find the extension entrypoint"* — or pass the exact call `{"agent":"recon","task":"...","why":"..."}` (`why` is the required one-sentence delegation justification).

If your provider credentials are not configured, use the no-model checks above first and then see [Troubleshooting](../how-to/troubleshooting.md).
