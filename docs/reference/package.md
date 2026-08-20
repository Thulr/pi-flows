# Package reference

This page lists what ships in the `pi-flows` npm package, how pi discovers it, and every install method.

## The pi manifest

pi-flows is a [pi package](https://pi.dev/docs/latest/packages): an ordinary npm package whose `package.json` carries a `pi` key that declares its resources. The `pi-package` keyword lists it in the [pi.dev gallery](https://pi.dev/packages).

```json
{
  "keywords": ["pi-package", "pi-extension", "agent-delegation", "flows"],
  "pi": {
    "extensions": ["./extensions/pi-flows/index.ts"]
  }
}
```

`pi.extensions` names the entrypoint that pi loads. The entrypoint registers the `flow` tool and the `/flows` command. The `engines` field declares the version floors: Node.js `>=24`, npm `>=11`, and pi `>=0.82.0`.

## Tarball contents

| Path | What it is |
|---|---|
| `extensions/pi-flows/` | The extension runtime (TypeScript, loaded directly by pi). |
| `agents/*.md` | The nine bundled agents: `recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, `debrief`. |
| `presets/*.md` | The three bundled workflow presets: `scout`, `map-codebase`, `code-review`. |
| `docs/` | This documentation tree (how-to, reference, explanation). |
| `examples/` | The copy-paste examples cookbook. |
| `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md` | Standard package surfaces. |
| `AGENTS.md`, `CONTEXT.md` | Agent instructions and the domain glossary. They ship because coding agents read them at runtime, and the docs link into the glossary's term definitions. |

Agents and presets are runtime inputs, not documentation. Discovery reads `agents/*.md` and `presets/*.md` from the installed package. If you move or rename them, behavior changes.

## Install methods

```bash
# From npm (recommended) — the published release
pi install npm:pi-flows

# Project-local install (recorded in .pi/settings.json)
pi install -l npm:pi-flows

# Track the latest main straight from GitHub, no clone required
pi install git:github.com/Thulr/pi-flows
```

`-l` scopes the install to the current project instead of your user configuration. After any install, reload pi with `/reload` (or restart it).

### Run from a clone (development)

To hack on pi-flows or try unreleased work, check out `develop`:

```bash
git clone -b develop https://github.com/Thulr/pi-flows
cd pi-flows
npm ci
npm run preflight   # verify the pi CLI is on PATH and meets the version floor
pi -e ./extensions/pi-flows/index.ts   # load the local extension in pi
```

Or install your working copy as a package with `pi install -l ..`. Project-local package paths resolve from `.pi/`, so `..` names the checkout root.

### Verify an install

Inside pi, these extension commands need no model call and no provider credentials:

```text
/flows version
/flows
/flows status
```

Success shows all nine bundled agents in the `/flows` listing. With a provider configured, you can also try the `flow` tool surface itself. pi turns these prompts into calls that answer without a child:

```text
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

If `pi` itself is missing, see [Troubleshooting → `pi: command not found`](../how-to/troubleshooting.md#pi-command-not-found).

## Gallery metadata

The `pi.image` URL in `package.json` is the preview asset shown on the package's [pi.dev gallery](https://pi.dev/packages) card. It points at a demo GIF served from this repository (`docs/images/`), so the gallery shows the live flow card rather than a static logo. Gallery entries update on each npm publish.
