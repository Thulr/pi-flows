import { capBytes, getFinalAssistantText, type ChildMessage } from "./sanitize.ts";
import { MODEL_VISIBLE_OUTPUT_CAP, type DelegationHandoffEnvelope, type DelegationReturnEnvelope, type FlowRunResult } from "./types.ts";

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
	 * Retain a rejected envelope whose claims may still be surfaced, in stored
	 * (capture-policy) form. It never reaches `result.envelope` — that field
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
