/**
 * The wrap-up channel between a parent metering a budget and the child it may
 * need to steer (see CONTEXT.md: Wrap-up notice). pi's print mode reads nothing
 * from stdin once running, so the channel is a file: the runner passes each
 * child its own wrap-up file path in the environment, and the pi-flows
 * extension loaded inside the child watches for that file, steering its
 * content into the live session the moment it appears.
 *
 * Typed structurally instead of importing the pi extension types, like the
 * bash-ro enforcer beside it: the watcher only needs `sendUserMessage`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Environment variable naming the child's wrap-up file. Always set explicitly
 * by the runner — to the child's own path, or to "" when the child runs under
 * no budget — so a parent's channel never leaks into grandchildren.
 */
export const WRAPUP_FILE_ENV = "PI_FLOWS_WRAPUP_FILE";

/** How often a child looks for a wrap-up request. Coarse on purpose: turns take seconds, and the notice queues as a steer anyway. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * Parent side: land the wrap-up notice for the child to find. Written beside
 * the target and renamed into place so the watcher can never read half a
 * notice; failures are swallowed because the child (and its temp directory)
 * may already be gone by the time the budget asks for a wrap-up.
 */
export function requestWrapUp(file: string, notice: string): void {
	try {
		writeFileSync(`${file}.tmp`, notice, { encoding: "utf8", mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	} catch {
		// The wrap-up is best-effort by design: if it cannot land, the hard stop still bounds the spend.
	}
}

/**
 * Child side: when this pi process was spawned with a wrap-up file path, poll
 * for it and steer its content into the live session exactly once. Returns the
 * watcher timer (for tests), or null when this process has no wrap-up channel.
 */
export function registerWrapUpSteering(
	pi: { sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void },
	env: Record<string, string | undefined> = process.env,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): NodeJS.Timeout | null {
	const file = env[WRAPUP_FILE_ENV]?.trim();
	// A host without sendUserMessage cannot steer, so watching would only ever observe.
	if (!file || typeof pi.sendUserMessage !== "function") return null;
	const timer = setInterval(() => {
		let notice: string;
		try {
			if (!existsSync(file)) return;
			notice = readFileSync(file, "utf8");
		} catch {
			return;
		}
		clearInterval(timer);
		if (notice.trim()) pi.sendUserMessage?.(notice, { deliverAs: "steer" });
	}, pollIntervalMs);
	timer.unref?.();
	return timer;
}
