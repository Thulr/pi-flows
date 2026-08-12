import { capBytes, getFinalAssistantText, isFailed, type ChildMessage } from "./sanitize.ts";
import { MODEL_VISIBLE_OUTPUT_CAP, type DelegationHandoffEnvelope, type DelegationReturnEnvelope, type FlowError, type FlowRunResult } from "./types.ts";

/** The four states a run can be in, as every surface names them (CONTEXT.md: Run state). */
export type RunState = "queued" | "running" | "completed" | "failed";

/**
 * The fields a run's state is derived from. Structural over every shape one
 * run takes, and accepting two names for its error because those shapes
 * disagree: a live {@link FlowRunResult} and a current session entry carry
 * `error`, while an entry persisted before that field existed — and the
 * timeline's own slice — carry only `errorCode`.
 */
export interface RunStateFields {
	exitCode: number;
	stopReason?: string;
	error?: { code: string };
	errorCode?: string;
	/**
	 * `"unknown"` until the runner resolves the agent — the sentinel, not an
	 * absence, is what tells a queued run from a running one. Optional only
	 * because the timeline's slice does not carry the field at all, which is
	 * why an unsettled run reads as `running` there rather than `queued`.
	 */
	agentSource?: string;
}

/**
 * Has this run reached a terminal state (CONTEXT.md: Settled)? The one place
 * that knows an exit code of `-1` also means "no child has exited yet".
 */
export function runSettled(run: Pick<RunStateFields, "exitCode">): boolean {
	return run.exitCode !== -1;
}

/**
 * A run that settled without succeeding — safe on a live run, which
 * {@link isFailed} deliberately is not. An outstanding child has not failed,
 * it has not finished, so a two-verdict surface asks {@link runState} rather
 * than read "not failed" as success.
 */
export function runFailed(run: RunStateFields): boolean {
	return runSettled(run) && isFailed(run);
}

/** The one derivation of a run's state, so a run cannot read as failed in one view and complete in another. */
export function runState(run: RunStateFields): RunState {
	if (!runSettled(run)) return run.agentSource === "unknown" ? "queued" : "running";
	return isFailed(run) ? "failed" : "completed";
}

/**
 * One child executing one task (see CONTEXT.md: Run), owning the lifecycle of
 * its result. What used to be state *about* a result held beside it — the raw
 * envelope candidate the runner captured, the validated envelope the harness
 * formatter reads — lives inside the Run, and the transitions that attach an
 * envelope or a handoff to a result exist only here. A `FlowRunResult` stays
 * the plain read projection every view renders; nothing outside this module
 * writes its `envelope` or `handoff`.
 */
export class Run {
	static readonly #byResult = new WeakMap<FlowRunResult, Run>();

	/** The run a result belongs to. One result, one run — repeated lookups answer with the same object. */
	static of(result: FlowRunResult): Run {
		const existing = Run.#byResult.get(result);
		if (existing) return existing;
		const run = new Run(result);
		Run.#byResult.set(result, run);
		return run;
	}

	// ECMAScript-private: this state must be reachable only through the
	// transitions below, or it is a side-channel again by another name.
	readonly #result: FlowRunResult;
	#envelopeCandidate?: string;
	#validatedReturnEnvelope?: DelegationReturnEnvelope;
	#rejectedReturnEnvelope?: DelegationReturnEnvelope;

	private constructor(result: FlowRunResult) {
		this.#result = result;
	}

	/**
	 * Retain the message's final assistant text as the one bounded candidate for
	 * typed-envelope validation. A later assistant turn with text replaces it; a
	 * turn without text leaves it standing, exactly as the final answer works.
	 */
	captureEnvelopeCandidate(message: ChildMessage): void {
		const text = getFinalAssistantText([message]);
		if (text) this.#envelopeCandidate = capBytes(text, MODEL_VISIBLE_OUTPUT_CAP, "Envelope candidate");
	}

	/** Consume the candidate so it cannot leak through returned details or linger after validation. */
	takeEnvelopeCandidate(): string | undefined {
		const candidate = this.#envelopeCandidate;
		this.#envelopeCandidate = undefined;
		return candidate;
	}

	/** A failed run keeps no candidate: there is nothing its text could validly bind to. */
	discardEnvelopeCandidate(): void {
		this.#envelopeCandidate = undefined;
	}

	/**
	 * The one transition through which a validated return envelope reaches the
	 * result: the stored (capture-policy) form is attached for views, and the
	 * validated content is retained privately — cloned, so a caller's later
	 * mutation cannot drift what was validated — until a harness-owned formatter
	 * consumes it.
	 */
	acceptReturnEnvelope(validated: DelegationReturnEnvelope, stored: DelegationReturnEnvelope): void {
		this.#validatedReturnEnvelope = structuredClone(validated);
		this.#result.envelope = stored;
	}

	/** Consume the privately retained validated content, as an isolated clone. */
	takeValidatedReturnEnvelope(): DelegationReturnEnvelope | undefined {
		const envelope = this.#validatedReturnEnvelope;
		this.#validatedReturnEnvelope = undefined;
		return envelope === undefined ? undefined : structuredClone(envelope);
	}

	/** The one transition through which a prepared handoff reaches the result. */
	acceptHandoff(handoff: DelegationHandoffEnvelope): void {
		this.#result.handoff = handoff;
	}

	/**
	 * Revoke a budget wrap-up's provisional success. The budget settles a run
	 * graceful on notice *delivery* — before anyone has seen whether the child
	 * actually returned the contracted envelope. Delivery is not compliance
	 * (issue #112): when validation then rejects the response, the run must stop
	 * rendering as a success beside the flow error it caused. The stopReason
	 * stays `budget_wrap_up` — the budget did stop this child mid-wrap-up; what
	 * changes is that the wrap-up was not honored.
	 *
	 * Returns whether a settlement was actually revoked. The child span was
	 * already exported (`status: OK`) from the runner's finally block, and an
	 * exported span is immutable — so the caller records the revocation on its
	 * rejection event, which links to the child span, as the correction a trace
	 * consumer applies.
	 */
	refuseWrapUpSettlement(error: FlowError): boolean {
		if (this.#result.stopReason !== "budget_wrap_up" || this.#result.error) return false;
		this.#result.exitCode = 1;
		this.#result.error = error;
		this.#result.errorMessage = error.message;
		return true;
	}

	/**
	 * Retain, in its stored (capture-policy) form, a rejected envelope whose
	 * claims may still be surfaced. It never reaches `result.envelope` — that field
	 * means "validated" — but the child's own claims are the evidence of what
	 * the spend produced, and a harness formatter may surface them as
	 * Unvalidated claims rather than zeroing out the run (issue #104).
	 *
	 * Eligibility is the caller's to decide, not this object's — see the
	 * Unvalidated claims entry in CONTEXT.md for which rejection qualifies and
	 * why. Retaining anything else would put claims in front of the parent that
	 * the glossary promises are never shown.
	 */
	retainRejectedEnvelope(stored: DelegationReturnEnvelope): void {
		this.#rejectedReturnEnvelope = structuredClone(stored);
	}

	/** Consume the retained rejected envelope, as an isolated clone. */
	takeRejectedReturnEnvelope(): DelegationReturnEnvelope | undefined {
		const envelope = this.#rejectedReturnEnvelope;
		this.#rejectedReturnEnvelope = undefined;
		return envelope === undefined ? undefined : structuredClone(envelope);
	}
}
