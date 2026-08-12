import type { ModelRoster, ProviderFailure, ProviderFailureCategory } from "./types.ts";

const LABELS: Record<ProviderFailureCategory, string> = {
	context_window: "context window",
	rate_limit: "rate limit",
	authentication: "authentication",
	capacity: "provider capacity",
	unknown: "unknown provider failure",
};
const GUIDANCE: Record<ProviderFailureCategory, string> = {
	context_window: "Reduce input or choose a larger-context model; retry only explicitly within remaining budget.",
	rate_limit: "Wait or reduce concurrency; retry explicitly within remaining budget.",
	authentication: "Repair credentials/model access before retry; do not replay unchanged.",
	capacity: "Wait or change model/provider; retry within remaining budget.",
	unknown: "Inspect details, provider status, and credentials before explicit retry; never auto-replay.",
};
const PATTERNS: Array<[ProviderFailureCategory, RegExp]> = [
	["authentication", /\b(?:401|403)\b|unauthori[sz]ed|forbidden|auth(?:entication|orization)?\b|invalid\s+(?:api[ _-]?)?key|credential|permission denied/i],
	["rate_limit", /\b429\b|rate[ _-]?limit|too many requests|requests? per (?:minute|second|day)|quota (?:exceeded|exhausted)/i],
	["context_window", /context[ _-]?(?:window|length)|maximum context|prompt (?:is )?too long|input (?:is )?(?:too long|too large)|too many input tokens|context_length_exceeded/i],
	["capacity", /\b503\b|overload(?:ed)?|at capacity|capacity (?:exceeded|unavailable)|service unavailable|temporarily unavailable|no available (?:model|provider)/i],
];

export function classifyProviderDiagnostic(diagnostic: string): ProviderFailureCategory {
	return PATTERNS.find(([, pattern]) => pattern.test(diagnostic))?.[0] ?? "unknown";
}

export const providerFailureGuidance = (category: ProviderFailureCategory): string => GUIDANCE[category];

export function providerFailureRetryable(category: ProviderFailureCategory): boolean {
	return category === "rate_limit" || category === "capacity";
}

export function modelContextWindow(roster: ModelRoster | undefined, model: string | undefined): number | undefined {
	if (!roster || !model) return undefined;
	const exact = roster.available.find((candidate) => candidate.reference === model);
	if (exact) return exact.contextWindow;
	const byId = roster.available.filter((candidate) => candidate.id === model);
	return byId.length === 1 ? byId[0]?.contextWindow : undefined;
}

export function describeProviderFailure(diagnostic: string, termination: ProviderFailure["termination"], contextTokens: number | undefined, contextWindow: number | undefined, thinkingVerified: boolean): ProviderFailure {
	return { category: classifyProviderDiagnostic(diagnostic), diagnostic, termination, contextTokens, contextWindow, thinkingVerified };
}

function shortDiagnostic(diagnostic: string, maxLength = 160): string {
	const oneLine = diagnostic.replace(/\s+/g, " ").trim() || "No provider diagnostic.";
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

export function providerFailureReason(failure: ProviderFailure): string {
	return `${LABELS[failure.category]} · ${shortDiagnostic(failure.diagnostic)}`;
}
