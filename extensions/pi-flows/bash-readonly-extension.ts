/**
 * The standalone bash-ro enforcer: a minimal pi extension entry the runner
 * loads explicitly (`-e <this file>`) into every bash-ro child, so enforcement
 * never depends on pi-flows being discoverable in the child — a checkout
 * parent (`pi -e ./extensions/pi-flows/index.ts`) spawns children that re-run
 * the pi entrypoint without the parent's `-e` flags. Loading this alongside a
 * discovered pi-flows registers the guard twice; both handlers block the same
 * commands, so the duplication is harmless.
 *
 * Typed structurally instead of importing the pi extension types: this module
 * must stay off the foreign-import ledger, and the guard only needs `on`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASH_READONLY_ENV, bashReadonlyEnabled, bashReadonlyRefusal } from "./bash-readonly.ts";

function enforcerPath(): string {
	return fileURLToPath(import.meta.url);
}

/**
 * The argv that loads this enforcer into a bash-ro child. `-e` extensions
 * survive `--no-extensions` (pi only drops discovered ones), so this is the
 * enforcement layer even when child extension discovery is disabled.
 */
export function bashReadonlyEnforcerArgs(): string[] {
	return ["-e", enforcerPath()];
}

/** Whether the enforcer file exists to be loaded — false only in exotic bundles without source on disk. */
export function bashReadonlyEnforcerAvailable(): boolean {
	return existsSync(enforcerPath());
}

type BlockResult = { block: true; reason: string } | undefined;

// The host's `on` is overloaded per event; requiring only that it accept this
// call keeps the module structurally typed without importing the pi types.
export function registerBashReadonlyGuard(pi: { on?: (event: "tool_call", handler: (event: any) => BlockResult) => void }): void {
	if (!bashReadonlyEnabled(process.env[BASH_READONLY_ENV])) return;
	pi.on?.("tool_call", (event: { toolName?: unknown; input?: { command?: unknown } }) => {
		if (event?.toolName !== "bash") return undefined;
		const reason = bashReadonlyRefusal(typeof event.input?.command === "string" ? event.input.command : "");
		return reason ? { block: true, reason } : undefined;
	});
}

export default registerBashReadonlyGuard;
