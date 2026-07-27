import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { sanitizeText } from "../extensions/pi-flows/sanitize.ts";
import { stableTraceIds } from "../extensions/pi-flows/trace-identity.mjs";

const traceIdentifier = (value) => sanitizeText(String(value), { recordContent: true, redactSecrets: true }, 256);

export function evalRunId(requested) {
	const value = requested?.trim();
	return traceIdentifier(value || randomUUID());
}

export function runtimeTraceContext(runId, { caseId, trialId, trialIndex, arm, attempt }) {
	return {
		runId: traceIdentifier(runId),
		caseId: traceIdentifier(caseId),
		trialId: traceIdentifier(trialId),
		...(trialIndex === undefined ? {} : { trialIndex }),
		...(arm ? { arm: traceIdentifier(arm) } : {}),
		...(attempt === undefined ? {} : { attempt }),
	};
}

export function runtimeTraceEvidence(result, traceFile, context) {
	const link = result?.details?.trace;
	if (link?.health === "recorded" && link.traceId && link.rootSpanId) {
		return { ...link, traceFile, context };
	}
	return {
		health: "missing",
		traceFile,
		traceId: link?.traceId ?? null,
		rootSpanId: link?.rootSpanId ?? null,
		context,
		...(link?.error ? { error: link.error } : {}),
	};
}

const POLICY_ERROR_CODES = new Set([
	"WHY_REQUIRED",
	"SHARED_WRITE_CWD",
	"PROJECT_AGENT_APPROVAL_REQUIRED",
	"PROJECT_AGENT_APPROVAL_DENIED",
	"CHECKPOINT_APPROVAL_REQUIRED",
	"CHECKPOINT_APPROVAL_DENIED",
	"INVALID_DELEGATION_CONTRACT",
	"RETURN_ENVELOPE_INVALID",
	"RETURN_CONTRACT_MISMATCH",
	"RETURN_ENVELOPE_INCOMPLETE",
	"RETURN_DIGEST_MISMATCH",
]);

function resultErrors(result) {
	return [
		result?.details?.error,
		...(result?.details?.results ?? []).map((child) => child?.error),
	].filter(Boolean);
}

export function runtimeScoreFamilies({ result, thrown, objective, trace }) {
	const errors = resultErrors(result);
	const childFailures = (result?.details?.results ?? []).some((child) =>
		child?.exitCode > 0 || ["error", "aborted", "timeout"].includes(child?.stopReason),
	);
	const executionPass = !thrown && Boolean(result) && !result?.details?.error && !childFailures;
	const outcomeAvailable = typeof objective?.pass === "boolean";
	const policyErrors = errors.filter((error) => POLICY_ERROR_CODES.has(error?.code));
	return {
		execution: {
			available: true,
			pass: executionPass,
			reason: thrown?.message ?? result?.details?.error?.code ?? (childFailures ? "child execution failed" : null),
		},
		verifiedOutcome: {
			available: outcomeAvailable,
			pass: outcomeAvailable ? objective.pass : null,
			score: Number.isFinite(objective?.score) ? objective.score : null,
		},
		policyCompliance: {
			available: Boolean(result?.details),
			pass: result?.details ? policyErrors.length === 0 : null,
			reasons: policyErrors.map((error) => error.code),
		},
		traceHealth: {
			available: true,
			pass: trace?.health === "recorded",
			status: trace?.health ?? "missing",
			reason: trace?.error ?? null,
		},
	};
}

export function appendProcessRuntimeTrace(traceFile, context, {
	mode,
	startMs,
	endMs,
	executionSuccess,
	attributes = {},
}) {
	const { traceId, rootSpanId } = stableTraceIds(context, mode);
	const span = {
		trace_id: traceId,
		span_id: rootSpanId,
		parent_span_id: null,
		name: `runtime.${mode}`,
		start_time_unix_ms: startMs,
		end_time_unix_ms: endMs,
		status: { code: executionSuccess ? "OK" : "ERROR" },
		attributes: {
			"openinference.span.kind": "CHAIN",
			"flow.run_id": context.runId,
			"flow.case_id": context.caseId,
			"flow.trial_id": context.trialId,
			"flow.trial_index": context.trialIndex,
			"flow.arm": context.arm,
			"flow.attempt": context.attempt,
			"flow.execution_success": executionSuccess,
			...attributes,
		},
	};
	try {
		appendFileSync(traceFile, `${JSON.stringify(span)}\n`, "utf8");
		return { health: "recorded", traceFile, traceId, rootSpanId, context };
	} catch (error) {
		return {
			health: "missing",
			traceFile,
			traceId,
			rootSpanId,
			context,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function measurementRuntimeEvidence({
	dryRun,
	runner,
	result,
	thrown,
	objective,
	traceFile,
	displayTraceFile,
	context,
	baselineMode,
	startMs,
	endMs,
	model,
}) {
	const runtimeTrace = dryRun
		? runtimeTraceEvidence(undefined, displayTraceFile, context)
		: runner === "flow"
			? runtimeTraceEvidence(result, displayTraceFile, context)
			: appendProcessRuntimeTrace(traceFile, context, {
					mode: baselineMode,
					startMs,
					endMs,
					executionSuccess: !thrown && Boolean(result),
					attributes: { "llm.model_name": model },
				});
	return {
		runtimeTrace,
		scoreFamilies: runtimeScoreFamilies({ result, thrown, objective, trace: runtimeTrace }),
	};
}
