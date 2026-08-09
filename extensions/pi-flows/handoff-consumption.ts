import { canonicalEnvelope, prepareIntegrationHandoff } from "./delegation.ts";
import { createHandoffGuard, HandoffWarnings, prepareResultHandoff, prepareTextHandoff, resolveHandoffPolicy, withInjectionNotice } from "./handoff.ts";
import { artifactAttributes, handoffAttributes, type ArtifactSource } from "./trace-attributes.ts";
import { resultText } from "./sanitize.ts";
import type {
	CapturePolicy,
	ChildSpanScope,
	CoordinationEvent,
	FlowError,
	FlowMode,
	FlowRunResult,
	IncompleteHandoffPolicy,
	PreparedHandoff,
	RecordEvent,
	ResolvedHandoffPolicy,
} from "./types.ts";

export interface HandoffConsumerOptions {
	params: any;
	mode: FlowMode;
	policy: CapturePolicy;
	defaultCwd: string;
	recordEvent?: RecordEvent;
}

export interface ConsumeResultOptions {
	result: FlowRunResult;
	plan?: {
		contract?: Parameters<typeof prepareIntegrationHandoff>[1]["contract"];
		cwd: string;
		scope?: ChildSpanScope;
	};
	contract?: Parameters<typeof prepareIntegrationHandoff>[1]["contract"];
	cwd?: string;
	incompletePolicy?: IncompleteHandoffPolicy;
	/**
	 * Whether another role consumes this result. `"integrate"` (the default) is
	 * the role boundary: the injection guard is enforced, warnings aggregate,
	 * a dependency key is minted, and the evidence is a handoff event. A
	 * `"terminal"` report crosses to the parent, not to a role — none of that
	 * applies — but its contract validation still happened, so it is recorded
	 * under the validation vocabulary (`envelope.validated` / `envelope.rejected`)
	 * instead of `handoff.*`. Recording is unconditional either way: a rejected
	 * envelope is trace evidence of what the spend produced (CONTEXT.md).
	 */
	completion?: "integrate" | "terminal";
	/**
	 * Status eligibility override, forwarded to `prepareIntegrationHandoff`.
	 * Defaults by completion: an integrating consumption refuses partial and
	 * blocked envelopes; a terminal report validates without that eligibility.
	 * The modes' final contracted outputs still fail closed on incomplete
	 * envelopes — that refusal is their documented contract — so those call
	 * sites pass `true` even though the consumption is terminal.
	 */
	enforceCompletion?: boolean;
	scope?: ChildSpanScope;
	noticeLabel?: string;
	/**
	 * Preserve the producer's original representation for consumers whose
	 * protocol is defined over that representation. Other consumers receive the
	 * normalized Handoff envelope.
	 */
	payload?: "handoff" | "source";
}

export interface ConsumeTextOptions {
	fromAgent: string;
	text: string;
	scope: ChildSpanScope;
	noticeLabel?: string;
}

export interface HandoffConsumption {
	text: string;
	warnings: string[];
	action: PreparedHandoff["action"];
	dependencyKey?: string;
	error?: FlowError;
}

export interface HandoffConsumptions {
	items: HandoffConsumption[];
	error?: FlowError;
}

export class HandoffConsumer {
	private readonly guard;
	private readonly warnings = new HandoffWarnings();
	private readonly validatedResults = new WeakMap<FlowRunResult, object>();

	constructor(private readonly options: HandoffConsumerOptions) {
		this.guard = createHandoffGuard(resolveHandoffPolicy(options.params, options.mode));
	}

	get resolution(): ResolvedHandoffPolicy {
		return this.guard.resolution;
	}

	get blockingError(): FlowError | undefined {
		return this.guard.blockingError;
	}

	warningSummary(scope?: string): string {
		return this.warnings.summary(scope);
	}

	consumeResult(options: ConsumeResultOptions): HandoffConsumption {
		const contract = options.contract ?? options.plan?.contract;
		const scope = options.scope ?? options.plan?.scope;
		const payload = options.payload ?? "handoff";
		const cwd = options.cwd ?? options.plan?.cwd ?? this.options.defaultCwd;
		const terminal = options.completion === "terminal";
		const accepted = prepareIntegrationHandoff(options.result, {
			contract,
			cwd,
			policy: this.options.policy,
			incompletePolicy: options.incompletePolicy ?? this.options.params.incompleteHandoffPolicy ?? "fail",
			attach: payload === "handoff",
			enforceCompletion: options.enforceCompletion ?? !terminal,
			validation: this.validatedResults.get(options.result),
		});
		if (accepted.error) {
			this.recordRejected({ ...options, contract, scope }, accepted.error, accepted.rejected);
			return { text: "", warnings: [], action: "fail", error: accepted.error };
		}
		if (accepted.validation) this.validatedResults.set(options.result, accepted.validation);
		if (terminal) {
			// No role boundary: prepare without guard enforcement or warning
			// aggregation, and mint no dependency key. The contract validation
			// that just succeeded is still attested — only contract-bearing
			// reports carry one; plain prose has nothing to attest.
			if (contract) this.recordValidated(accepted.handoff!, scope);
			const prepared = this.prepareResult(options.result, contract, payload);
			const text = options.noticeLabel ? withInjectionNotice(prepared, options.noticeLabel) : prepared.text;
			return { text, warnings: prepared.warnings, action: prepared.action };
		}

		const prepared = this.warnings.addFrom(
			this.prepareResult(options.result, contract, payload, true),
		);
		const carried: PreparedHandoff = options.noticeLabel
			? { ...prepared, text: withInjectionNotice(prepared, options.noticeLabel) }
			: prepared;
		this.recordResult(options.result, accepted.handoff!, carried, scope, contract);
		const dependencyKey = scope?.key ? `${scope.key}.handoff` : undefined;
		return {
			text: carried.text,
			warnings: carried.warnings,
			action: carried.action,
			...(dependencyKey ? { dependencyKey } : {}),
			...(carried.error ? { error: carried.error } : {}),
		};
	}

	consumeResults(options: ConsumeResultOptions[]): HandoffConsumptions {
		const items: HandoffConsumption[] = [];
		for (const item of options) {
			const consumption = this.consumeResult(item);
			items.push(consumption);
			if (consumption.error) return { items, error: consumption.error };
		}
		return { items };
	}

	consumeText(options: ConsumeTextOptions): HandoffConsumption {
		const carried = this.prepareText(options.text, options.noticeLabel);
		const dependencyKey = options.scope.key ? `${options.scope.key}.handoff` : undefined;
		const scope = dependencyKey
			? {
					...(options.scope.stage ? { stage: options.scope.stage } : {}),
					key: dependencyKey,
					dependsOn: options.scope.dependsOn?.length ? options.scope.dependsOn : [options.scope.key!],
				}
			: options.scope;
		const rejection = carried.error;
		this.options.recordEvent?.({
			kind: "handoff",
			name: rejection ? "handoff.rejected" : "handoff.accepted",
			ok: !rejection,
			scope,
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
					rawBytes: Buffer.byteLength(options.text, "utf8"),
					carriedBytes: Buffer.byteLength(carried.text, "utf8"),
					warnings: carried.warnings,
					handoffPolicy: this.guard.resolution.effective,
					policyAction: carried.action,
					compositional: carried.compositional,
					policy: this.options.policy,
				},
			),
		});
		return {
			text: carried.text,
			warnings: carried.warnings,
			action: carried.action,
			...(dependencyKey ? { dependencyKey } : {}),
			...(rejection ? { error: rejection } : {}),
		};
	}

	prepareText(text: string, noticeLabel?: string): PreparedHandoff {
		const prepared = this.warnings.addFrom(
			prepareTextHandoff(text, this.options.policy, undefined, this.guard),
		);
		return noticeLabel ? { ...prepared, text: withInjectionNotice(prepared, noticeLabel) } : prepared;
	}

	private prepareResult(
		result: FlowRunResult,
		contract: ConsumeResultOptions["contract"],
		payload: NonNullable<ConsumeResultOptions["payload"]>,
		enforce = false,
	): PreparedHandoff {
		if (payload === "source") {
			const text = contract && result.envelope ? canonicalEnvelope(result.envelope) : resultText(result);
			return prepareTextHandoff(text, this.options.policy, undefined, enforce ? this.guard : undefined);
		}
		return prepareResultHandoff(result, this.options.policy, undefined, enforce ? this.guard : undefined);
	}

	private recordResult(
		result: FlowRunResult,
		handoff: NonNullable<ReturnType<typeof prepareIntegrationHandoff>["handoff"]>,
		prepared: PreparedHandoff,
		scope: ChildSpanScope | undefined,
		contract: ConsumeResultOptions["contract"],
	): void {
		if (!this.options.recordEvent) return;
		const handoffScope = scope?.key
			? { ...(scope.stage ? { stage: scope.stage } : {}), key: `${scope.key}.handoff`, dependsOn: [scope.key] }
			: scope;
		const rejection = prepared.error;
		const event: CoordinationEvent = {
			kind: "handoff",
			name: rejection ? "handoff.rejected" : "handoff.accepted",
			ok: !rejection,
			scope: handoffScope,
			attributes: handoffAttributes(handoff, {
				accepted: !rejection,
				rejection,
				rawBytes: Buffer.byteLength(resultText(result), "utf8"),
				carriedBytes: Buffer.byteLength(prepared.text, "utf8"),
				warnings: prepared.warnings,
				handoffPolicy: this.guard.resolution.effective,
				policyAction: prepared.action,
				compositional: prepared.compositional,
				// Attribute derivation reads contract DATA; the resolved object is the transition currency.
				contract: contract?.contract,
				policy: this.options.policy,
			}),
		};
		this.options.recordEvent(event);
		this.recordArtifacts(
			{
				agent: handoff.provenance.agent,
				contractId: handoff.contractId,
				digests: handoff.digests,
			},
			handoff.artifactReferences.map((reference) => reference.path),
			scope,
			true,
		);
	}

	/**
	 * A validated terminal report. Not a handoff — no role consumes it — so the
	 * evidence is the validation outcome itself, in the same span slot and with
	 * the same artifact events an integrating consumption would leave, under
	 * names that never claim a boundary was crossed.
	 */
	private recordValidated(
		handoff: NonNullable<ReturnType<typeof prepareIntegrationHandoff>["handoff"]>,
		scope: ChildSpanScope | undefined,
	): void {
		if (!this.options.recordEvent) return;
		// A validation-specific slot, not `<unit>.handoff`: a result inspected as
		// terminal may later cross a role boundary (evaluate validates before its
		// critics; orchestrate's revise loop re-consumes the verifier), and the
		// sink retains the first span registered per key — so sharing the handoff
		// slot would make the later handoff's dependency key resolve to this
		// attestation instead of the boundary that carried the content.
		const slot = scope?.key ? `${scope.key}.validation` : undefined;
		const eventScope = scope?.key && slot
			? { ...(scope.stage ? { stage: scope.stage } : {}), key: slot, dependsOn: [scope.key] }
			: scope;
		this.options.recordEvent({
			kind: "validation",
			name: "envelope.validated",
			ok: true,
			scope: eventScope,
			attributes: {
				"flow.handoff.from_agent": handoff.provenance.agent,
				"flow.handoff.contract_id": handoff.contractId ?? "(legacy)",
				"flow.handoff.status": handoff.status,
				"flow.handoff.artifact_count": handoff.artifactReferences.length,
				"flow.handoff.digest_count": handoff.digests.length,
			},
		});
		this.recordArtifacts(
			{
				agent: handoff.provenance.agent,
				contractId: handoff.contractId,
				digests: handoff.digests,
			},
			handoff.artifactReferences.map((reference) => reference.path),
			scope?.key && slot ? { ...scope, key: slot } : scope,
			true,
			slot,
		);
	}

	/**
	 * Recording is unconditional: a rejected envelope is retained as trace
	 * evidence of what the spend produced whether or not any role would have
	 * consumed it. Only the name follows the boundary — an integrating
	 * consumption rejected a handoff; a terminal report rejected an envelope.
	 */
	private recordRejected(
		options: ConsumeResultOptions,
		rejection: FlowError,
		rejected: ReturnType<typeof prepareIntegrationHandoff>["rejected"],
	): void {
		if (!this.options.recordEvent) return;
		// Terminal rejections live in the validation slot for the same reason
		// terminal attestations do; integrating rejections keep the handoff slot
		// the boundary they refused would have occupied.
		const terminal = options.completion === "terminal";
		const suffix = terminal ? "validation" : "handoff";
		const slot = options.scope?.key ? `${options.scope.key}.${suffix}` : undefined;
		const scope = options.scope?.key && slot
			? { ...(options.scope.stage ? { stage: options.scope.stage } : {}), key: slot, dependsOn: [options.scope.key] }
			: options.scope;
		this.options.recordEvent({
			kind: "validation",
			name: terminal ? "envelope.rejected" : "handoff.rejected",
			ok: false,
			scope,
			attributes: {
				"flow.handoff.from_agent": options.result.agent,
				"flow.handoff.acceptance": `rejected:${rejection.code}`,
				"flow.error_code": rejection.code,
				"flow.handoff.retryable": rejection.retryable,
				"flow.handoff.artifact_count": rejected?.artifactReferences.length ?? 0,
			},
		});
		if (!rejected) return;
		this.recordArtifacts(
			{
				agent: options.result.agent,
				contractId: rejected.contractId ?? null,
				digests: rejected.digests,
			},
			rejected.artifactReferences.map((reference) => reference.path),
			terminal && options.scope?.key && slot ? { ...options.scope, key: slot } : options.scope,
			false,
			terminal ? slot : undefined,
		);
	}

	/** `slot` names the evidence event the artifacts hang off — `<unit>.handoff` for a crossed boundary (the default), the validation slot for a terminal attestation. */
	private recordArtifacts(source: ArtifactSource, paths: string[], scope: ChildSpanScope | undefined, verified: boolean, slot?: string): void {
		if (!this.options.recordEvent) return;
		for (const [index, path] of paths.entries()) {
			const unit = scope?.key;
			this.options.recordEvent({
				kind: "artifact",
				name: verified ? "artifact.referenced" : "artifact.rejected",
				ok: verified,
				scope: scope && unit
					? { ...(scope.stage ? { stage: scope.stage } : {}), key: `${unit}.artifact-${index + 1}`, dependsOn: [slot ?? `${unit}.handoff`] }
					: scope,
				attributes: artifactAttributes(source, path, this.options.policy, verified),
			});
		}
	}
}

export function createHandoffConsumer(options: HandoffConsumerOptions): HandoffConsumer {
	return new HandoffConsumer(options);
}
