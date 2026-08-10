import * as os from "node:os";
import { MODEL_VISIBLE_OUTPUT_CAP, STDERR_CAPTURE_CAP, emptyUsage, formatFlowError, type CapturePolicy, type FlowError, type FlowRunResult } from "./types.ts";

/**
 * One content block pi-flows retains from a child transcript message, owned by
 * the capture-policy module: the runner translates at the process boundary and
 * only fields the views read survive. Re-exported through types.ts.
 */
export interface ChildMessageBlock {
	type: string;
	/** Present on text blocks. */
	text?: string;
	/** Present on toolCall blocks. */
	name?: string;
	/** Present on toolCall blocks; already redacted per capture policy when stored. */
	arguments?: unknown;
}

/** One retained child transcript message, in pi-flows' own vocabulary. */
export interface ChildMessage {
	role: string;
	content: ChildMessageBlock[];
	/** Present on toolResult messages. */
	toolName?: string;
}

export function safePath(candidate: string | null | undefined): string | null {
	if (!candidate) return null;
	const home = os.homedir();
	if (home && candidate.startsWith(home)) return `~${candidate.slice(home.length)}`;
	return candidate;
}

/**
 * Inverse of {@link safePath}, for *local* addressing only: persisted paths
 * arrive in their redacted `~/…` form, and a `file://` URL built from that
 * form does not open. Returns the absolute path, or null when the input is
 * not absolute in either form — a caller with a null gets no link, never a
 * guessed path.
 */
export function expandSafePath(candidate: string | null | undefined): string | null {
	if (!candidate) return null;
	if (candidate.startsWith("/")) return candidate;
	if (candidate === "~" || candidate.startsWith("~/")) {
		const home = os.homedir();
		return home ? `${home}${candidate.slice(1)}` : null;
	}
	return null;
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(text: string): string {
	let next = text;
	const home = os.homedir();
	if (home) next = next.replace(new RegExp(escapeRegExp(home), "g"), "~");

	const replacements: Array<[RegExp, string]> = [
		[/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
		[/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_SECRET]"],
		[/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*['\"]?[^'\"\s,;]+/gi, "$1=[REDACTED_SECRET]"],
		[/Bearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi, "Bearer [REDACTED_SECRET]"],
		[/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
	];

	for (const [pattern, replacement] of replacements) next = next.replace(pattern, replacement);
	return next;
}

export function capBytes(text: string, cap: number, label = "Output"): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= cap) return text;

	let next = text.slice(0, cap);
	while (Buffer.byteLength(next, "utf8") > cap) next = next.slice(0, -1);
	const omitted = bytes - Buffer.byteLength(next, "utf8");
	return `${next}\n\n[${label} truncated: ${omitted} bytes omitted.]`;
}

export function sanitizeText(text: string, policy: CapturePolicy, cap = MODEL_VISIBLE_OUTPUT_CAP): string {
	const redacted = policy.redactSecrets ? redactText(text) : text;
	return capBytes(redacted, cap);
}

/**
 * Strip zero-width, bidi-control, and other invisible characters. Child output
 * crosses a trust boundary when it becomes another child's prompt (chain
 * {previous}, the evaluate artifact, vote ballots, orchestrate findings), and
 * invisible characters are a classic vector for hiding injected instructions —
 * the wiki's prompt-injection-defense page lists them explicitly. Always safe to
 * apply: it removes nothing a human or model needs to read.
 */
export function stripControlChars(text: string): string {
	// Keep tab/newline/carriage-return; drop other C0/C1 controls, zero-width
	// joiners/spaces, bidi overrides, and the BOM.
	return text.replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "");
}

/** High-signal indirect-injection patterns to flag when child output is reused as a prompt. Conservative by design — these warn, they do not block. */
export const INJECTION_PATTERNS: Array<[RegExp, string]> = [
	[/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|earlier|above|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?|context)\b/i, "instruction-override phrasing"],
	[/\byou are now\b|\bnew (system )?(prompt|instructions?|role)\b/i, "role/system reassignment"],
	[/\b(system|developer)\s*(prompt|message)\s*[:=]/i, "system-prompt assertion"],
	[/\b(reveal|print|repeat|exfiltrate|leak|send)\b[^.\n]{0,30}\b(system prompt|secret|credential|api[_-]?key|token|password|env)\b/i, "secret-exfiltration request"],
	[/<!--[\s\S]*?(instruction|ignore|system|prompt)[\s\S]*?-->/i, "hidden HTML-comment instruction"],
];

/**
 * Scan handoff text for high-signal injection markers. Returns the human-readable
 * labels of anything matched. Indirect injection — a worker that read a poisoned
 * file emitting text that hijacks the synthesizer or the next chain step — is the
 * threat the wiki's prompt-injection-defense page names for inter-agent handoffs.
 */
export function scanForInjection(text: string): string[] {
	const hits: string[] = [];
	if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/.test(text)) hits.push("invisible/bidi characters");
	for (const [pattern, label] of INJECTION_PATTERNS) if (pattern.test(text)) hits.push(label);
	return hits;
}

export function redactValue(value: unknown, policy: CapturePolicy): unknown {
	if (!policy.recordContent) {
		if (typeof value === "string") return "[content omitted: recordContent=false]";
	}
	if (typeof value === "string") return policy.redactSecrets ? redactText(value) : value;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, policy));
	if (!value || typeof value !== "object") return value;

	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (!policy.recordContent && (key === "text" || key === "content" || key === "input" || key === "output")) {
			result[key] = "[content omitted: recordContent=false]";
			continue;
		}
		result[key] = redactValue(nested, policy);
	}
	return result;
}

export function storeMessage(message: ChildMessage, policy: CapturePolicy): ChildMessage {
	return redactValue(message, policy) as ChildMessage;
}

export function appendCapped(existing: string, chunk: string, policy: CapturePolicy, cap = STDERR_CAPTURE_CAP): string {
	return capBytes(`${existing}${sanitizeText(chunk, policy, cap)}`, cap, "Captured stream");
}

export function getFinalAssistantText(messages: ChildMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text" && typeof part.text === "string") return part.text;
		}
	}
	return "";
}

export function isFailed(result: FlowRunResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "timeout";
}

export function resultText(result: FlowRunResult): string {
	if (result.error) return formatFlowError(result.error);
	if (isFailed(result)) {
		return result.errorMessage || result.stderr || getFinalAssistantText(result.messages) || "(no output)";
	}
	return getFinalAssistantText(result.messages) || "(no output)";
}

export function capModelVisibleText(text: string): string {
	return capBytes(text, MODEL_VISIBLE_OUTPUT_CAP);
}

export function makeEmptyRunResult(agent: string, task: string, policy: CapturePolicy, error?: FlowError): FlowRunResult {
	return {
		agent,
		agentSource: "unknown",
		task: sanitizeText(task, policy, 4 * 1024),
		exitCode: error ? 1 : -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		error,
		errorMessage: error?.message,
		stopReason: error ? "error" : undefined,
	};
}
