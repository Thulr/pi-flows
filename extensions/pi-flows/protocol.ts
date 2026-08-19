import { escapeRegExp } from "./sanitize.ts";
import type { IntegrationControl } from "./delegation.ts";

/**
 * The coordination-control protocol vocabulary: one home for the marker keyword
 * and authority tokens each mode tells its Child to write, and that the parser
 * accepts back. Instruction text and accepted grammar both render from these
 * values, so the "tell it to write" and "read what it wrote" halves cannot
 * drift. The authoritative marker position is the Child's first non-empty line;
 * a token is authoritative only when that line is exactly `MARKER: TOKEN` — a
 * mention, quotation, negation, example, or a longer word that merely begins
 * with an allowed token stays ordinary prose and fails closed.
 */
const PROTOCOL = {
	verdict: { marker: "VERDICT", pass: "PASS", revise: "REVISE" },
	loop: { marker: "LOOP", done: "DONE", continue: "CONTINUE" },
	route: { marker: "ROUTE", none: "none", token: "[A-Za-z0-9_.-]+" },
	score: { marker: "SCORE", min: 0, max: 100, token: "-?\\d+(?:\\.\\d+)?" },
} as const;

/**
 * Split a control value into the two Integration emission paths: validated
 * envelope data (`legacy: false`) or the child's raw prose (`legacy: true`).
 * Exported for the readers that live outside this module — a second copy of
 * this split would let a parser accept prose as contracted data.
 */
export function readIntegrationControl(value: unknown): { data: unknown; legacy: boolean } {
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

/** The Child's first non-empty line, trimmed; null when the output has none. */
function firstNonEmptyLine(text: string): string | null {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line) return line;
	}
	return null;
}

/** Regex-source alternation for exactly one of the given literal tokens (escaped). */
const oneOf = (...tokens: readonly string[]) => tokens.map((token) => escapeRegExp(token)).join("|");

/**
 * Match the authoritative marker line: the first non-empty line must be exactly
 * `MARKER : TOKEN` (the keyword is case-insensitive, whitespace around the
 * separator is tolerated, nothing may follow the token). `tokenPattern` is a
 * regex-source fragment for the token — a {@link oneOf} literal alternation, or
 * a character/quantifier class. Returns the token text exactly as written, or
 * null when the first line is not this protocol's marker.
 */
function markerToken(text: string, marker: string, tokenPattern: string): string | null {
	const line = firstNonEmptyLine(text);
	if (line === null) return null;
	const match = line.match(new RegExp(`^${escapeRegExp(marker)}\\s*[:=]\\s*(${tokenPattern})\\s*$`, "i"));
	return match ? match[1] : null;
}

export function verdictProtocolInstruction(reviseGuidance = "specific, actionable critique the next agent can act on", contracted = false): string {
	const { marker, pass, revise } = PROTOCOL.verdict;
	return contracted
		? `Set the return envelope's data.verdict to "${pass.toLowerCase()}" or "${revise.toLowerCase()}". If revise, include ${reviseGuidance} in a schema-permitted data field.`
		: `Begin your reply with a line "${marker}: ${pass}" or "${marker}: ${revise}" and nothing else on that line. If ${revise}, follow with ${reviseGuidance}.`;
}

export function loopProtocolInstruction(contracted = false): string {
	const { marker, done, continue: cont } = PROTOCOL.loop;
	return contracted
		? `Set the return envelope's data.loop to "${done.toLowerCase()}" or "${cont.toLowerCase()}".`
		: `Start with a line "${marker}: ${done}" if the goal is complete, or "${marker}: ${cont}" if another iteration is needed — nothing else on that line.`;
}

export function routeProtocolInstruction(contracted = false): string {
	const { marker, none } = PROTOCOL.route;
	return contracted
		? `Set the return envelope's data.route to one candidate name exactly, or "${none}".`
		: `Reply with a line "${marker}: <agent>" using one of the candidate names exactly and nothing else on that line. Use "${marker}: ${none}" when no candidate fits.`;
}

export function scoreProtocolInstruction(contracted = false): string {
	const { marker, min, max } = PROTOCOL.score;
	return contracted
		? `Set the return envelope's data.score to a number from ${min} through ${max}; include terse justification and risks in schema-permitted data fields.`
		: `Start with a line "${marker}: <number>" where the number is ${min}..${max}, then give terse justification and risks.`;
}

/**
 * What a commander is told to write for a Decomposition (CONTEXT.md), in both
 * emission paths. The two accepted shapes are stated here exactly as
 * `parseDecomposition` (decomposition.ts) accepts them back: a flat JSON array
 * of subtask strings for genuinely independent work, or a JSON array of subtask
 * objects when one subtask needs another's output.
 *
 * The commander never writes a placeholder for a dependency's output. The
 * orchestrate handler injects each dependency's validated handoff into the
 * dependent worker's prompt, so a template the commander invents would reach
 * the worker unrendered.
 */
export function subtasksJsonProtocolInstruction(maxSubtasks: number, contracted = false): string {
	const shapes = [
		`Use one of two shapes for the JSON array, never both in one array (max ${maxSubtasks} subtasks).`,
		'Shape 1 (independent work): an array of subtask strings, e.g. ["Investigate X", "Investigate Y"]. Use this when no subtask needs another subtask\'s output.',
		'Shape 2 (dependent work): an array of subtask objects. Each object requires "id" and "objective". Each object accepts optional "dependsOn" (the ids of the subtasks whose output this subtask needs), "effortWeight", "scope", "nonGoals", "inputs", "expectedReturn", and "acceptanceEvidence".',
		'Write each "id" as one short token: start it with a letter or a digit, then use letters, digits, "_", "." and "-" only. An id with a space or a line break in it is refused.',
		'Set "effortWeight" (integer 1..5) when a subtask is clearly heavier than its siblings: 1 is an ordinary subtask and the default, 5 is the heaviest. It ranks relative effort for budget planning — it is not a token or cost figure. Any other shape is refused.',
		"Add a dependsOn edge only when the subtask cannot start without the named subtask's output. Independent subtasks run in parallel; dependent subtasks run in sequence, so an unnecessary edge makes the work slower.",
		"Do not name an agent for a subtask: every subtask runs the same worker role. Do not write a placeholder for another subtask's output: the orchestrator inserts it.",
	];
	if (contracted) return [`Break this goal into subtasks and set the return envelope's data to the JSON array of subtasks.`, ...shapes].join(" ");
	return [
		"Break this goal into subtasks.",
		...shapes,
		"Examples:",
		'```json\n["Investigate X", "Investigate Y"]\n```',
		'```json\n[{"id":"survey","objective":"List the auth entry points"},{"id":"trace","objective":"Trace token refresh from the entry points","dependsOn":["survey"]}]\n```',
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
	const { marker, pass, revise } = PROTOCOL.verdict;
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const verdict = (control.data as any)?.verdict;
		if (verdict === pass.toLowerCase() || verdict === revise.toLowerCase()) return verdict;
		return null;
	}
	const text = control.data as string;
	const token = markerToken(text, marker, oneOf(pass, revise));
	if (token !== null) return token.toLowerCase() === pass.toLowerCase() ? "pass" : "revise";
	const json = extractLastJsonBlock(text);
	if (json && (json.verdict === pass.toLowerCase() || json.verdict === revise.toLowerCase())) return json.verdict;
	return null;
}

export function parseLoopStatus(value: unknown): "done" | "continue" {
	const { marker, done, continue: cont } = PROTOCOL.loop;
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const loop = (control.data as any)?.loop;
		if (loop === done.toLowerCase() || loop === cont.toLowerCase()) return loop;
		return "continue";
	}
	const text = control.data as string;
	const token = markerToken(text, marker, oneOf(done, cont));
	if (token !== null) return token.toLowerCase() === done.toLowerCase() ? "done" : "continue";
	const json = extractLastJsonBlock(text);
	if (json && (json.loop === done.toLowerCase() || json.loop === cont.toLowerCase())) return json.loop;
	return "continue";
}

export function parseScore(value: unknown): number | null {
	const { marker, min, max, token: tokenPattern } = PROTOCOL.score;
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const score = (control.data as any)?.score;
		return typeof score === "number" && Number.isFinite(score) && score >= min && score <= max ? score : null;
	}
	const text = control.data as string;
	const token = markerToken(text, marker, tokenPattern);
	const json = extractLastJsonBlock(text);
	const raw = token !== null ? Number(token) : typeof json?.score === "number" && Number.isFinite(json.score) ? json.score : Number.NaN;
	return Number.isFinite(raw) && raw >= min && raw <= max ? raw : null;
}

/**
 * Read a routing decision constrained to `candidates`: structured data first,
 * then the legacy marker/JSON protocol. A candidate named anywhere except the
 * authoritative marker position is ordinary prose and returns null.
 */
export function parseRoute(value: unknown, candidates: string[]): string | null {
	const { marker, none, token: tokenPattern } = PROTOCOL.route;
	const allowed = new Set(candidates);
	const control = readIntegrationControl(value);
	if (!control.legacy) {
		const route = (control.data as any)?.route;
		return typeof route === "string" ? (route === none ? null : allowed.has(route) ? route : null) : null;
	}
	const text = control.data as string;
	const token = markerToken(text, marker, tokenPattern);
	if (token !== null) {
		if (token.toLowerCase() === none.toLowerCase()) return null;
		return allowed.has(token) ? token : null;
	}
	const json = extractLastJsonBlock(text);
	if (json && typeof json.route === "string") {
		if (json.route === none) return null;
		return allowed.has(json.route) ? json.route : null;
	}
	return null;
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
