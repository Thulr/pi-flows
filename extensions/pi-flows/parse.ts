import { escapeRegExp } from "./sanitize.ts";

export function renderTaskTemplate(template: string, task: string | undefined, previous: string): string {
	return template.replace(/\{task\}/g, task ?? "").replace(/\{previous\}/g, previous);
}

/** Extract the last fenced ```json block (or a trailing object) and JSON-parse it. Returns null on failure. */
export function extractLastJsonBlock(text: string): any | null {
	const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
	let match: RegExpExecArray | null;
	let last: string | null = null;
	while ((match = fenceRe.exec(text)) !== null) last = match[1];
	const candidate = (last ?? text).trim();
	try {
		return JSON.parse(candidate);
	} catch {
		const objMatch = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
		if (objMatch) {
			try {
				return JSON.parse(objMatch[0]);
			} catch {
				return null;
			}
		}
		return null;
	}
}

export function isPassWord(word: string): boolean {
	const value = word.trim().toLowerCase();
	return value.startsWith("pass") || value.startsWith("approve") || value.startsWith("accept");
}

/**
 * Read an evaluator verdict from its output. Prefers an explicit `VERDICT: PASS|REVISE`
 * line, falls back to a JSON `{verdict}` field, and defaults to "revise" (fail-safe:
 * an unparseable verdict keeps iterating under the cap rather than falsely passing).
 */
export function parseVerdict(text: string): "pass" | "revise" {
	const markerMatch = text.match(/VERDICT\s*[:=]\s*([A-Za-z]+)/i);
	if (markerMatch) return isPassWord(markerMatch[1]) ? "pass" : "revise";
	const json = extractLastJsonBlock(text);
	if (json && typeof json.verdict === "string") return isPassWord(json.verdict) ? "pass" : "revise";
	return "revise";
}

export function parseLoopStatus(text: string): "done" | "continue" {
	const markerMatch = text.match(/LOOP\s*[:=]\s*([A-Za-z]+)/i);
	if (markerMatch) return /^(done|pass|stop|complete|completed)$/i.test(markerMatch[1]) ? "done" : "continue";
	const json = extractLastJsonBlock(text);
	if (json && typeof json.loop === "string") return /^(done|pass|stop|complete|completed)$/i.test(json.loop) ? "done" : "continue";
	if (json && typeof json.done === "boolean") return json.done ? "done" : "continue";
	return "continue";
}

export function parseScore(text: string): number | null {
	const markerMatch = text.match(/SCORE\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
	const raw = markerMatch ? Number(markerMatch[1]) : Number(extractLastJsonBlock(text)?.score);
	if (!Number.isFinite(raw)) return null;
	return Math.max(0, Math.min(100, raw));
}

/**
 * Read a routing decision from the router's output, constrained to `candidates`.
 * Prefers a `ROUTE: <agent>` line, then a JSON `{route}` field, then the first
 * candidate name that appears as a whole word. Returns null if none match.
 */
export function parseRoute(text: string, candidates: string[]): string | null {
	const allowed = new Set(candidates);
	const marker = text.match(/ROUTE\s*[:=]\s*([A-Za-z0-9_.-]+)/i);
	if (marker) {
		if (marker[1].toLowerCase() === "none") return null;
		if (allowed.has(marker[1])) return marker[1];
	}
	const json = extractLastJsonBlock(text);
	if (json && typeof json.route === "string" && allowed.has(json.route)) return json.route;
	// Last resort: accept a bare mention only when exactly one candidate appears (unambiguous).
	const mentioned = candidates.filter((candidate) => new RegExp(`\\b${escapeRegExp(candidate)}\\b`).test(text));
	return mentioned.length === 1 ? mentioned[0] : null;
}

/** Parse a decomposition into subtasks: a JSON array of strings or `{task}` objects, capped to `max`. */
export function parseSubtasks(text: string, max: number): string[] | null {
	const json = extractLastJsonBlock(text);
	if (!Array.isArray(json)) return null;
	const tasks = json
		.map((item) => (typeof item === "string" ? item : item && typeof item === "object" && typeof item.task === "string" ? item.task : null))
		.filter((task): task is string => Boolean(task && task.trim()))
		.map((task) => task.trim());
	if (tasks.length === 0) return null;
	return tasks.slice(0, Math.max(1, max));
}
