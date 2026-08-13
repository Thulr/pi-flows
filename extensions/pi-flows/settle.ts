import { capModelVisibleText } from "./sanitize.ts";
import { formatFlowError, type FlowDetails, type FlowError, type FlowMode, type FlowRunResult, type ModeOutput } from "./types.ts";

/**
 * The curried details builder a settle is constructed over — the shape
 * `ModeDeps.makeDetails(mode)` returns, already bound to one mode.
 */
export type SettleDetailsBuilder = (results: FlowRunResult[], error?: FlowError) => FlowDetails;

/**
 * The settle object for one mode invocation: the mode identity, the runs
 * accumulated so far, and the invariant that every output — refusal or
 * completion — carries them.
 *
 * The invariant used to live in a prose comment on the details constructor
 * ("error paths pass what already ran") and be re-satisfied by hand at every
 * return site, which is exactly where it broke: an error output built with an
 * empty results array makes a run that spent real tokens vanish from the flow
 * card, the ledger, and the lesson gate. Here the accumulated runs move only
 * through {@link track}, and both output shapes read them from the same place,
 * so an output that drops a tracked run is not constructible.
 *
 * Mode identity is fixed at construction. The one production constructor is
 * the mode registry (modes/registry.ts), which builds each handler's settle
 * from that handler's own table entry — so the mode a settled output reports
 * is the registry's, never a literal re-typed inside a handler body.
 * Constructed by {@link makeSettle}; tests build theirs through the same
 * factory so fakes cannot drift.
 */
export class Settle {
	readonly #tracked: FlowRunResult[] = [];
	readonly #buildDetails: SettleDetailsBuilder;
	#decorate: (details: FlowDetails) => FlowDetails = (details) => details;
	#footer: () => string = () => "";

	/** The mode this invocation settles under, fixed at construction. */
	readonly mode: FlowMode;

	constructor(mode: FlowMode, buildDetails: SettleDetailsBuilder) {
		this.mode = mode;
		this.#buildDetails = buildDetails;
	}

	/**
	 * The runs tracked so far, in step order. Read-only by type: handlers read
	 * prior results to build later tasks, but the accumulation itself moves only
	 * through {@link track} — a push site outside this object is the drift this
	 * module exists to end.
	 */
	get results(): readonly FlowRunResult[] {
		return this.#tracked;
	}

	/** The 1-based step the next dispatched run will hold — the one home of step arithmetic, so no dispatch site hand-computes `results.length + 1`. */
	get nextStep(): number {
		return this.#tracked.length + 1;
	}

	/**
	 * Append settled runs, returning the 1-based step of the last one. Track a
	 * run before any return path that could carry an output: a tracked run is
	 * what keeps its spend visible.
	 */
	track(...results: FlowRunResult[]): number {
		this.#tracked.push(...results);
		return this.#tracked.length;
	}

	/**
	 * The refusal shape every error return reduces to: the formatted error (plus
	 * an optional footer, e.g. worktree's recovery locations) over details that
	 * carry every tracked run and the error itself. The model-visible cap is
	 * applied here, over the formatted error and the per-call footer together —
	 * not at return sites, which is how two modes ended up hand-assembling the
	 * capped message and slicing the formatted prefix back off. The registered
	 * footer ({@link decorateFooter}) lands after the cap: it is the short
	 * recovery pointer a truncated refusal needs most, so truncation must not
	 * be able to swallow it.
	 */
	refuse(error: FlowError, options: { footer?: string } = {}): ModeOutput {
		return {
			content: [{ type: "text", text: `${capModelVisibleText(`${formatFlowError(error)}${options.footer ?? ""}`)}${this.#footer()}` }],
			details: this.details(error),
		};
	}

	/**
	 * A custom-prose output over the tracked runs, with no error in details.
	 * Covers both the success text and the failure paths that deliberately
	 * return sanitized prose without an error object (a failed run's text is the
	 * mode's own to word; the run itself stays visible through the results).
	 */
	complete(text: string): ModeOutput {
		return {
			content: [{ type: "text", text }],
			details: this.details(),
		};
	}

	/**
	 * Register a decoration applied to every subsequent output's details,
	 * refuse and complete alike — workflow's approval-receipt decoration, once,
	 * instead of a parallel details helper per return site. The latest
	 * registration wins; a decorator reads live state through its closure.
	 */
	decorateDetails(decorator: (details: FlowDetails) => FlowDetails): void {
		this.#decorate = decorator;
	}

	/**
	 * Register a footer appended to every subsequent refusal — worktree's
	 * integration-branch recovery pointer, once, after the branch exists —
	 * instead of a string literal re-written at every return site, which is how
	 * two refusals shipped telling users to inspect a branch they never named.
	 * Refusal vocabulary only: {@link complete}'s text is the mode's own. The
	 * latest registration wins; the footer reads live state through its closure.
	 */
	decorateFooter(footer: () => string): void {
		this.#footer = footer;
	}

	/** Details over a snapshot of the tracked runs, so later tracking cannot rewrite an output already returned. */
	private details(error?: FlowError): FlowDetails {
		return this.#decorate(this.#buildDetails([...this.#tracked], error));
	}
}

/**
 * The one construction path. The registry calls it per dispatch with the
 * contract entry's own mode (`makeSettle(contract.mode,
 * deps.makeDetails(contract.mode))`); test deps construct theirs the same way.
 */
export function makeSettle(mode: FlowMode, buildDetails: SettleDetailsBuilder): Settle {
	return new Settle(mode, buildDetails);
}

/**
 * The checked accessor for a handler's settle. Every dispatched handler has
 * one — the registry (modes/registry.ts) binds it before the handler runs —
 * and the field is optional on `ModeDeps` only because the aggregate supplies
 * deps ahead of that binding. Absence is therefore a wiring bug in a caller
 * that skipped the registry, and it fails loud here instead of surfacing as a
 * non-null assertion in every handler.
 */
export function modeSettle(deps: { settle?: Settle }): Settle {
	if (!deps.settle) {
		throw new Error("ModeDeps.settle is unset: handlers receive their settle from the mode registry (modes/registry.ts); test deps must construct one with makeSettle.");
	}
	return deps.settle;
}
