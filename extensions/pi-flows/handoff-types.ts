import type { FlowError, HandoffPolicy } from "./types.ts";

export interface ResolvedHandoffPolicy {
	call: HandoffPolicy;
	mode?: HandoffPolicy;
	effective: HandoffPolicy;
}

export interface PreparedHandoff {
	text: string;
	warnings: string[];
	action: "allow" | "warn" | "quarantine" | "fail";
	error?: FlowError;
	compositional: boolean;
}

export interface HandoffGuard {
	readonly resolution: ResolvedHandoffPolicy;
	prepare(raw: string, cleaned: string, warnings: string[]): PreparedHandoff;
	readonly blockingError?: FlowError;
}
