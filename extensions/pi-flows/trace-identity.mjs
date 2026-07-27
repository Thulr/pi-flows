import { createHash } from "node:crypto";

/**
 * Derive the runtime trace and root-span ids from one canonical identity.
 * Runtime and eval code both import this function so their linkage cannot drift.
 *
 * @param {{runId:string,caseId:string,trialId:string,trialIndex?:number,arm?:string,attempt?:number}} context
 * @param {string} mode
 */
export function stableTraceIds(context, mode) {
	const identity = JSON.stringify({
		schemaVersion: "pi-flows.runtime-trace.v1",
		runId: context.runId,
		caseId: context.caseId,
		trialId: context.trialId,
		trialIndex: context.trialIndex ?? null,
		arm: context.arm ?? null,
		attempt: context.attempt ?? null,
		mode,
	});
	const traceId = createHash("sha256").update(identity).digest("hex").slice(0, 32);
	const rootSpanId = createHash("sha256").update(`${traceId}:root`).digest("hex").slice(0, 32);
	return { traceId, rootSpanId };
}
