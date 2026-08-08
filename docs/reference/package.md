# Package reference

What ships in the `pi-flows` npm package, how pi discovers it, and every way to install it.

## The pi manifest

pi-flows is a [pi package](https://pi.dev/docs/latest/packages): an ordinary npm package whose `package.json` carries a `pi` key declaring its resources, plus the `pi-package` keyword that lists it in the [pi.dev gallery](https://pi.dev/packages).

```json
{
  "keywords": ["pi-package", "pi-extension", "agent-delegation", "flows"],
  "pi": {
    "extensions": ["./extensions/pi-flows/index.ts"]
  }
}
```

`pi.extensions` names the entrypoint pi loads — it registers the `flow` tool and the `/flows` command. Version floors are declared in `engines`: Node.js `>=24`, npm `>=11`, and pi `>=0.82.0`.

## Tarball contents

| Path | What it is |
|---|---|
| `extensions/pi-flows/` | The extension runtime (TypeScript, loaded directly by pi). |
| `agents/*.md` | The nine bundled agents: `recon`, `strategist`, `overwatch`, `operator`, `analyst`, `redteam`, `controller`, `commander`, `debrief`. |
| `presets/*.md` | The three bundled workflow presets: `scout`, `map-codebase`, `code-review`. |
| `docs/` | This documentation tree (tutorials, how-to, reference, explanation). |
| `examples/` | The copy-paste examples cookbook. |
| `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md` | Standard package surfaces. |
| `AGENTS.md`, `CONTEXT.md` | Agent instructions and the domain glossary. They ship because coding agents read them at runtime — docs link into the glossary's term definitions. |

Agents and presets are runtime inputs, not documentation: discovery reads `agents/*.md` and `presets/*.md` from the installed package, so moving or renaming them changes behavior.

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

To hack on pi-flows or try unreleased `main`, work from a checkout:

```bash
git clone https://github.com/Thulr/pi-flows
cd pi-flows
npm ci
npm run preflight   # verify the pi CLI is on PATH and meets the version floor
pi -e ./extensions/pi-flows/index.ts   # load the local extension in pi
```

Or install your working copy as a package with `pi install -l ..` — project-local package paths are resolved from `.pi/`, so `..` names the checkout root.

### Verify an install

Inside pi, no model call required:

```text
/flows version
/flows help
/flows status
Use flow with {"list":true}
Use flow with {"showConfig":true}
```

Success looks like all nine bundled agents in the `flow list` output. If `pi` itself is missing, see [Troubleshooting → `pi: command not found`](../how-to/troubleshooting.md#pi-command-not-found).

## Gallery metadata

The `pi.image` URL in `package.json` is the preview asset shown on the package's [pi.dev gallery](https://pi.dev/packages) card. It points at a demo GIF served from this repository (`docs/images/`), so the gallery shows the live flow card rather than a static logo. Gallery entries update on each npm publish.
