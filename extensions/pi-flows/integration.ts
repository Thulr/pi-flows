import {
	compatibilityHandoff,
	createDelegationBudget,
	canonicalHandoff,
	prepareIntegrationHandoff,
	renderDelegationTask,
	typedHandoff,
	validateDelegationContract,
} from "./delegation.ts";
import { resultText } from "./sanitize.ts";
import { prepareResultHandoff } from "./handoff.ts";
import { artifactAttributes, handoffAttributes, type ArtifactSource } from "./trace-attributes.ts";
import { runAgentRef, type AgentFanoutItem, type AgentRunLimits } from "./runner.ts";
import type {
	ChildSpanScope,
	DelegationContract,
	DelegationHandoffEnvelope,
	DelegationReturnEnvelope,
	FlowAgentRefInput,
	FlowError,
	FlowMode,
	FlowRunResult,
	IncompleteHandoffPolicy,
	ModeDeps,
	PreparedHandoff,
	RecordEvent,
} from "./types.ts";
import { appendReturnContract, resolvedCwd } from "./validate.ts";

export interface IntegrationRunPlan extends AgentFanoutItem {
	contract?: DelegationContract;
	cwd: string;
}

function runLimits(contract?: DelegationContract): AgentRunLimits | undefined {
	if (!contract) return undefined;
	return {
		captureRawOutput: true,
		timeoutMs: contract.budget.timeoutMs,
		contractBudget: createDelegationBudget(contract),
		contract,
	};
}

export function integrationRunPlan(
	deps: ModeDeps,
	ref: FlowAgentRefInput,
	task: string,
	options: {
		fallbackContract?: DelegationContract;
		returnContract?: string;
		requireEvidence?: boolean;
		placeholderTask?: string;
		scope?: ChildSpanScope;
	} = {},
): { plan?: IntegrationRunPlan; error?: FlowError } {
	const contract = ref.contract ?? options.fallbackContract;
	const error = contract ? validateDelegationContract(contract, deps.policy) : null;
	if (error) return { error };
	const renderedTask = contract
		? renderDelegationTask(task, contract, options.returnContract, options.requireEvidence)
		: appendReturnContract(task, options.returnContract, options.requireEvidence);
	return {
		plan: {
			ref,
			task: renderedTask,
			placeholderTask: options.placeholderTask ?? task,
			limits: runLimits(contract),
			contract,
			cwd: resolvedCwd(deps.defaultCwd, ref.cwd),
			...(options.scope ? { scope: options.scope } : {}),
		},
	};
}

/**
 * Run a planned child. The plan already carries the ref, the rendered task, the
 * contract-derived limits, and the span scope, so callers pass the plan whole
 * instead of unpacking the same four fields at every dispatch site.
 */
export function runIntegrationPlan(deps: ModeDeps, plan: IntegrationRunPlan, mode: FlowMode, step: number | undefined, priorResults: FlowRunResult[]): Promise<FlowRunResult> {
	return runAgentRef(deps, plan.ref, plan.task, mode, step, priorResults, { limits: plan.limits, scope: plan.scope });
}

/**
 * Attribute one handoff boundary. The event records what crossed — filtering,
 * size, injection warnings, preserved constraint ids, acceptance status, and
 * artifact references — plus one artifact event per referenced file, so a
 * corrupted or unverifiable artifact is attributable to the hop that carried it
 * rather than to the synthesis that later used it.
 */
function recordArtifacts(record: RecordEvent, source: ArtifactSource, paths: string[], scope: ChildSpanScope | undefined, unit: string | undefined, policy: ModeDeps["policy"], verified: boolean): void {
	for (const [index, path] of paths.entries()) {
		record({
			kind: "artifact",
			name: verified ? "artifact.referenced" : "artifact.rejected",
			ok: verified,
			scope: scope && unit ? { stage: scope.stage, key: `${unit}.artifact-${index + 1}`, dependsOn: [`${unit}.handoff`] } : scope,
			attributes: artifactAttributes(source, path, policy, verified),
		});
	}
}

/**
 * Record a handoff boundary a mode validated itself.
 *
 * `chain` owns its own envelope validation and its own `{previous}` rendering,
 * so it never reaches `acceptIntegrationResult` — but an inter-agent handoff
 * still happens at every step, and without this the acceptance, the filtering,
 * and the injection warnings would be missing from the trace precisely where a
 * step's output becomes the next step's prompt.
 */
export function recordStepHandoff(deps: ModeDeps, options: {
	result: FlowRunResult;
	contract?: DelegationContract;
	envelope?: DelegationReturnEnvelope;
	/** The exact prepared value the downstream consumer receives. */
	prepared: PreparedHandoff;
	scope?: ChildSpanScope;
}): void {
	const record = deps.recordEvent;
	if (!record) return;
	const handoff = options.contract && options.envelope
		? typedHandoff(options.result, options.envelope, options.contract)
		: compatibilityHandoff(options.result, deps.policy);
	emitHandoff(
		record,
		deps,
		handoff,
		options.result,
		options.scope,
		options.prepared,
		options.contract,
		options.prepared.error,
	);
}

/**
 * A boundary whose producer is not a single child run — an aggregated critique,
 * for instance. It carries the same accounting as any other handoff, because the
 * question a reader asks of it is the same: how much crossed, and what did the
 * scan flag on the way?
 */
export function recordTextHandoff(deps: ModeDeps, options: {
	fromAgent: string;
	raw: string;
	prepared: PreparedHandoff;
	scope: ChildSpanScope;
}): void {
	const record = deps.recordEvent;
	if (!record) return;
	const rejection = options.prepared.error;
	record({
		kind: "handoff",
		name: rejection ? "handoff.rejected" : "handoff.accepted",
		ok: !rejection,
		scope: options.scope,
		attributes: handoffAttributes(
			{
				schemaVersion: "pi-flows.handoff-envelope.v1",
				contractId: null,
				compatibility: "legacy-prose",
				status: "completed",
				summary: "",
				evidence: [],
				artifactReferences: [],
				digests: [],
				changedState: [],
				unresolvedQuestions: [],
				retry: { retryable: false },
				data: null,
				provenance: { agent: options.fromAgent },
			},
			{
				accepted: !rejection,
				rejection,
				rawBytes: Buffer.byteLength(options.raw, "utf8"),
				carriedBytes: Buffer.byteLength(options.prepared.text, "utf8"),
				warnings: options.prepared.warnings,
				handoffPolicy: deps.handoffGuard.resolution.effective,
				policyAction: options.prepared.action,
				compositional: options.prepared.compositional,
				policy: deps.policy,
			},
		),
	});
}

/** The one place a handoff boundary becomes spans, so every mode records the same shape. */
function emitHandoff(
	record: RecordEvent,
	deps: ModeDeps,
	handoff: DelegationHandoffEnvelope,
	result: FlowRunResult,
	scope: ChildSpanScope | undefined,
	prepared: PreparedHandoff,
	contract: DelegationContract | undefined,
	rejection: FlowError | undefined,
): void {
	const unit = scope?.key;
	const handoffScope: ChildSpanScope | undefined = scope
		? { stage: scope.stage, ...(unit ? { key: `${unit}.handoff`, dependsOn: [unit] } : {}) }
		: undefined;
	// Uncapped on purpose: capping both sides would report equal raw and carried
	// bytes for a result that lost tens of kilobytes on the way across, and
	// `filtered:false` for the case that filtered the most.
	const raw = resultText(result);
	record({
		kind: "handoff",
		name: rejection ? "handoff.rejected" : "handoff.accepted",
		ok: !rejection,
		scope: handoffScope,
		attributes: handoffAttributes(handoff, {
			accepted: !rejection,
			rejection,
			rawBytes: Buffer.byteLength(raw, "utf8"),
			carriedBytes: Buffer.byteLength(prepared.text, "utf8"),
			warnings: prepared.warnings,
			handoffPolicy: deps.handoffGuard.resolution.effective,
			policyAction: prepared.action,
			compositional: prepared.compositional,
			contract,
			policy: deps.policy,
		}),
	});
	recordArtifacts(
		record,
		{ agent: handoff.provenance.agent, contractId: handoff.contractId, digests: handoff.digests },
		handoff.artifactReferences.map((reference) => reference.path),
		handoffScope,
		unit,
		deps.policy,
		!rejection,
	);
}

function recordHandoffEvidence(deps: ModeDeps, plan: IntegrationRunPlan, result: FlowRunResult, rejection?: FlowError, rejected?: DelegationReturnEnvelope): FlowError | undefined {
	const record = deps.recordEvent;
	const handoff = result.handoff;
	// The handoff is its own unit, not the child again: it nests in the same stage
	// and depends on the child that produced it. Reusing the child's key would
	// make both spans answer to one name, and whichever registered last would win
	// every dependency link pointed at that child.
	const unit = plan.scope?.key;
	const scope: ChildSpanScope | undefined = plan.scope
		? { stage: plan.scope.stage, ...(unit ? { key: `${unit}.handoff`, dependsOn: [unit] } : {}) }
		: undefined;
	if (!handoff) {
		record?.({
			kind: "validation",
			name: "handoff.rejected",
			ok: false,
			scope,
			attributes: {
				"flow.handoff.from_agent": result.agent,
				"flow.handoff.acceptance": `rejected:${rejection?.code ?? "unknown"}`,
				"flow.error_code": rejection?.code,
				"flow.handoff.retryable": rejection?.retryable ?? false,
				"flow.handoff.artifact_count": rejected?.artifactReferences.length ?? 0,
			},
		});
		// A rejected envelope's artifact claims are the evidence of the corruption,
		// so they are recorded — marked unverified, because the digest is exactly
		// what failed.
		if (rejected) {
			if (record) recordArtifacts(
				record,
				{ agent: result.agent, contractId: rejected.contractId ?? null, digests: rejected.digests },
				rejected.artifactReferences.map((reference) => reference.path),
				scope,
				unit,
				deps.policy,
				false,
			);
		}
		return rejection;
	}
	// Measured on the text the consumer is actually handed, not on the envelope
	// behind it: the compatibility envelope repeats the result in both `summary`
	// and `data`, so an ordinary large output would report far more bytes crossing
	// than the capped text the next prompt received.
	const prepared = prepareResultHandoff(result, deps.policy, undefined, deps.handoffGuard);
	if (record) emitHandoff(record, deps, handoff, result, plan.scope, prepared, plan.contract, prepared.error ?? rejection);
	return prepared.error ?? rejection;
}

/**
 * Validate a child's return and, when another agent will read it, record the
 * boundary it crossed.
 *
 * Validation always runs: an envelope that fails its contract, schema, or digest
 * checks must fail closed whether or not anything downstream consumes it. Only
 * the evidence is conditional, because a handoff event asserts that one agent's
 * output became another agent's input. `parallel` returns its outputs to the
 * caller and spawns nothing that reads them, so recording one there would invent
 * a boundary — and would measure it in `prepareResultHandoff` bytes the caller's
 * response never used.
 */
export function acceptIntegrationResult(
	deps: ModeDeps,
	plan: IntegrationRunPlan,
	result: FlowRunResult,
	incompletePolicy: IncompleteHandoffPolicy = deps.params.incompleteHandoffPolicy ?? "fail",
	options: { consumed?: boolean } = {},
): FlowError | null {
	const prepared = prepareIntegrationHandoff(result, {
		contract: plan.contract,
		cwd: plan.cwd,
		policy: deps.policy,
		incompletePolicy,
	});
	const policyError = options.consumed !== false ? recordHandoffEvidence(deps, plan, result, prepared.error, prepared.rejected) : undefined;
	return prepared.error ?? policyError ?? null;
}

/**
 * Record the boundary for a result already accepted with `consumed:false`.
 *
 * For consumers that only learn afterwards whether anything downstream will read
 * the output — an orchestrate verdict is a handoff when it sends the answer back
 * for revision, and the end of the run when it passes.
 */
export function recordIntegrationHandoff(deps: ModeDeps, plan: IntegrationRunPlan, result: FlowRunResult): FlowError | null {
	return recordHandoffEvidence(deps, plan, result) ?? null;
}

/** @see acceptIntegrationResult for what `consumed:false` withholds, and why. */
export function acceptIntegrationResults(
	deps: ModeDeps,
	plans: IntegrationRunPlan[],
	results: FlowRunResult[],
	incompletePolicy: IncompleteHandoffPolicy = deps.params.incompleteHandoffPolicy ?? "fail",
	options: { consumed?: boolean } = {},
): FlowError | null {
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		if (!result || result.error || result.exitCode !== 0) continue;
		const error = acceptIntegrationResult(deps, plans[index], result, incompletePolicy, options);
		if (error) return error;
	}
	return null;
}
