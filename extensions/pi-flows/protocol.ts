import { escapeRegExp } from "./sanitize.ts";
import type { IntegrationControl } from "./delegation.ts";

function readIntegrationControl(value: unknown): { data: unknown; legacy: boolean } {
	if (value && typeof value === "object") {
		const control = value as Partial<IntegrationControl>;
		if (control.source === "contract" && Object.hasOwn(control, "data")) return { data: control.data, legacy: false };
		if (control.source === "legacy" && typeof control.text === "string") return { data: control.text, legacy: true };
	}
	return { data: value, legacy: typeof value === "string" };
}

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

export function verdictProtocolInstruction(reviseGuidance = "specific, actionable critique the next agent can act on", contracted = false): string {
	return contracted
		? `Set the return envelope's data.verdict to "pass" or "revise". If revise, include ${reviseGuidance} in a schema-permitted data field.`
		: `Begin your reply with a line \"VERDICT: PASS\" or \"VERDICT: REVISE\". If REVISE, follow with ${reviseGuidance}.`;
}

export function loopProtocolInstruction(contracted = false): string {
	return contracted ? 'Set the return envelope\'s data.loop to "done" or "continue".' : 'Start with "LOOP: DONE" if the goal is complete, or "LOOP: CONTINUE" if another iteration is needed.';
}

export function routeProtocolInstruction(contracted = false): string {
	return contracted ? 'Set the return envelope\'s data.route to one candidate name exactly, or "none".' : 'Reply with a line "ROUTE: <agent>" using one of the candidate names exactly. Use "ROUTE: none" when no candidate fits.';
}

export function scoreProtocolInstruction(contracted = false): string {
	return contracted ? "Set the return envelope's data.score to a number from 0 through 100; include terse justification and risks in schema-permitted data fields." : 'Start with "SCORE: <number>" where the number is 0..100, then give terse justification and risks.';
}

export function subtasksJsonProtocolInstruction(maxSubtasks: number, contracted = false): string {
	if (contracted) return `Break this goal into at most ${maxSubtasks} independent subtasks and set the return envelope's data to their JSON string array.`;
	return [
		`Break this goal into independent subtasks that can run in parallel without depending on each other's output. Return a JSON array of subtask strings (max ${maxSubtasks}), e.g.`,
		'```json\n["Investigate X", "Investigate Y"]\n```',
		"Return only the JSON array.",
	].join("\n");
}

/**
 * Read schema-checked `data.verdict`, or the legacy prose/JSON protocol when
 * explicitly uncontracted, and default to "revise".
 */
export function parseVerdict(value: unknown): "pass" | "revise" {
	return parsedVerdict(value) ?? "revise";
}

/**
 * The verdict the value explicitly states, or null when {@link parseVerdict}
 * would fall back to its "revise" default. One derivation for both readers, so
 * a recorder saying "the parse fell back" cannot drift from the parse itself.
 */
export function parsedVerdict(value: unknown): "pass" | "revise" | null {
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const verdict = (control.data as any)?.verdict;
		if (verdict === "pass" || verdict === "revise") return verdict;
		return null;
	}
	const text = control.data as string;
	const markerMatch = text.match(/VERDICT\s*[:=]\s*([A-Za-z]+)/i);
	if (markerMatch) return isPassWord(markerMatch[1]) ? "pass" : "revise";
	const json = extractLastJsonBlock(text);
	if (json && typeof json.verdict === "string") return isPassWord(json.verdict) ? "pass" : "revise";
	return null;
}

export function parseLoopStatus(value: unknown): "done" | "continue" {
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const loop = (control.data as any)?.loop;
		if (loop === "done" || loop === "continue") return loop;
		return "continue";
	}
	const text = control.data as string;
	const markerMatch = text.match(/LOOP\s*[:=]\s*([A-Za-z]+)/i);
	if (markerMatch) return /^(done|pass|stop|complete|completed)$/i.test(markerMatch[1]) ? "done" : "continue";
	const json = extractLastJsonBlock(text);
	if (json && typeof json.loop === "string") return /^(done|pass|stop|complete|completed)$/i.test(json.loop) ? "done" : "continue";
	if (json && typeof json.done === "boolean") return json.done ? "done" : "continue";
	return "continue";
}

export function parseScore(value: unknown): number | null {
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const score = (control.data as any)?.score;
		return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100 ? score : null;
	}
	const text = control.data as string;
	const markerMatch = text.match(/SCORE\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
	const raw = markerMatch ? Number(markerMatch[1]) : Number(extractLastJsonBlock(text)?.score);
	if (!Number.isFinite(raw)) return null;
	return Math.max(0, Math.min(100, raw));
}

/**
 * Read a routing decision constrained to `candidates`: structured data first,
 * then legacy marker/JSON/whole-word prose. Returns null if none match.
 */
export function parseRoute(value: unknown, candidates: string[]): string | null {
	const allowed = new Set(candidates);
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const route = (control.data as any)?.route;
		return typeof route === "string" ? (route === "none" ? null : allowed.has(route) ? route : null) : null;
	}
	const text = control.data as string;
	const marker = text.match(/ROUTE\s*[:=]\s*([A-Za-z0-9_.-]+)/i);
	if (marker) {
		if (marker[1].toLowerCase() === "none") return null;
		if (allowed.has(marker[1])) return marker[1];
	}
	const json = extractLastJsonBlock(text);
	if (json && typeof json.route === "string" && allowed.has(json.route)) return json.route;
	const mentioned = candidates.filter((candidate) => new RegExp(`\\b${escapeRegExp(candidate)}\\b`).test(text));
	return mentioned.length === 1 ? mentioned[0] : null;
}

/** Parse structured or JSON-text subtasks into strings, capped to `max`. */
export function parseSubtasks(value: unknown, max: number): string[] | null {
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		if (!Array.isArray(control.data) || control.data.length === 0 || !control.data.every((item) => typeof item === "string" && item.trim())) return null;
		return control.data.map((item) => item.trim()).slice(0, Math.max(1, max));
	}
	const json = extractLastJsonBlock(control.data as string);
	if (!Array.isArray(json)) return null;
	const tasks = json
		.map((item) => (typeof item === "string" ? item : item && typeof item === "object" && typeof item.task === "string" ? item.task : null))
		.filter((task): task is string => Boolean(task && task.trim()))
		.map((task) => task.trim());
	if (tasks.length === 0) return null;
	return tasks.slice(0, Math.max(1, max));
}
