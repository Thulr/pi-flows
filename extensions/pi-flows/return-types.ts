import type { UsageStats } from "./types.ts";

/**
 * Untrusted child output that is structurally a return envelope, offered for
 * contract validation (CONTEXT.md: Return candidate). Its contract identity may
 * be missing or stale — the candidate keeps it as parsed so a rejection stays
 * diagnosable — which is exactly why a candidate is never a Return envelope.
 */
export interface DelegationReturnCandidate {
	schemaVersion: "pi-flows.return-envelope.v1";
	contractId?: string;
	status: "completed" | "partial" | "blocked" | "failed";
	summary: string;
	evidence: Array<{ claim: string; source: string }>;
	artifactReferences: Array<{ path: string }>;
	digests: Array<{ artifact: string; algorithm: "sha256"; value: string }>;
	changedState: string[];
	unresolvedQuestions: string[];
	retry: { retryable: boolean; reason?: string; afterMs?: number };
	data: unknown;
}

/**
 * A validated Return envelope (CONTEXT.md: Return envelope). Only the
 * validation transition constructs one — after attribution, integrity, and
 * conformance pass — so it always carries the exact resolved delegation-contract
 * identity, plus the runtime usage the validator attaches.
 */
export interface DelegationReturnEnvelope extends DelegationReturnCandidate {
	contractId: string;
	usage?: UsageStats;
}
