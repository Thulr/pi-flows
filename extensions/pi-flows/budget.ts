import type { FlowError, UsageStats } from "./types.ts";

/** Which budget a ceiling belongs to. See CONTEXT.md — a refusal must never be attributed to a budget the run never had. */
export type BudgetAuthority = "flow" | "contract";

/**
 * One configured cost/token ceiling, paired with the authority that owns it, for
 * disclosure in compact UI surfaces. Not `BudgetCeilings` below, which is the
 * unlabelled *set* of ceilings a budget is constructed with and enforces.
 */
export interface BudgetCeiling {
	authority: BudgetAuthority;
	maxCostUsd?: number;
	maxTokens?: number;
	maxGeneratedTokens?: number;
}

/**
 * The fraction of a mid-stream-enforceable ceiling at which a live child is
 * asked to wrap up: stop working and emit its return envelope while there is
 * still headroom to pay for the envelope turn. Sized so the remaining fifth of
 * the ceiling covers the final turn(s) of a read-heavy child; a ceiling small
 * enough that one turn jumps from below the threshold past the ceiling itself
 * gets no wrap-up, because there was never a moment it could have been asked.
 */
export const WRAP_UP_FRACTION = 0.8;

/**
 * First line of every wrap-up notice. A steered notice re-enters the child's
 * event stream as a user message, and the runner recognizes that echo by this
 * marker — the proof the notice actually reached the child session, without
 * which an exhaustion may not settle gracefully.
 */
export const WRAP_UP_NOTICE_MARKER = "[pi-flows budget notice]";

/**
 * The spend ceilings a budget is constructed with. An absent ceiling is uncapped
 * on that dimension. Distinct from `BudgetCeiling`, which is one ceiling paired
 * with its authority for disclosure; this is the set a budget enforces.
 */
export interface BudgetCeilings {
	maxCostUsd?: number;
	maxTokens?: number;
	maxGeneratedTokens?: number;
}

/**
 * A budget's ceilings and spend as plain data, for traces and live views.
 *
 * Readers get a snapshot rather than the budget because a view must not be able
 * to move a ceiling or a spend total, and because a trace attribute is a fact
 * about one moment — the budget it came from keeps burning down afterwards.
 */
export interface BudgetSnapshot extends BudgetCeilings {
	authority: BudgetAuthority;
	spentCost: number;
	spentTokens: number;
	spentGeneratedTokens: number;
}

/**
 * A machine-enforced cost/token ceiling and the spend against it.
 *
 * The ceiling is fixed at construction and the spend is private: the only way
 * to move a budget is `charge`, and the only way to ask whether it binds is
 * `refusesSpawn` / `stopsLiveRun`. Before this was an object, callers held a
 * mutable record and the invariant was spelled "remember to charge it, and
 * remember which of the two exhaustion checks applies here" — enforcement by
 * convention across three modules.
 *
 * `authority` (see CONTEXT.md) travels with the budget because "which ceiling
 * refused this run" is a property of the budget itself. Deriving it at the call
 * site by comparing object identity against the contract budget put the same
 * conditional in six places, each able to get it backwards and report a
 * contract refusal as a flow-budget one.
 */
export class Budget {
	private spentCost = 0;
	private spentTokens = 0;
	private spentGeneratedTokens = 0;

	private constructor(
		readonly authority: BudgetAuthority,
		private readonly maxCostUsd: number | undefined,
		private readonly maxTokens: number | undefined,
		private readonly maxGeneratedTokens: number | undefined,
	) {}

	private static from(authority: BudgetAuthority, ceilings: BudgetCeilings | undefined): Budget | undefined {
		if (ceilings?.maxCostUsd === undefined && ceilings?.maxTokens === undefined && ceilings?.maxGeneratedTokens === undefined) return undefined;
		return new Budget(authority, ceilings.maxCostUsd, ceilings.maxTokens, ceilings.maxGeneratedTokens);
	}

	/** The cumulative ceiling shared by every run in one flow, or undefined when the call set none. */
	static forFlow(ceilings: BudgetCeilings | undefined): Budget | undefined {
		return Budget.from("flow", ceilings);
	}

	/** The ceiling scoped to the runs fulfilling one delegation contract, enforced independently of the flow's. */
	static forContract(ceilings: BudgetCeilings | undefined): Budget | undefined {
		return Budget.from("contract", ceilings);
	}

	/** Charge settled usage. Callers that meter per turn charge each turn; a caller holding only a run total charges it once — the accumulation is the same either way. */
	charge(usage: UsageStats): void {
		this.spentCost += usage.cost || 0;
		this.spentTokens += (usage.input || 0) + (usage.output || 0);
		this.spentGeneratedTokens += usage.output || 0;
	}

	/** Any ceiling reached: no further run may spawn under this budget. */
	refusesSpawn(): boolean {
		return this.costReached() || this.generatedReached() || this.totalReached();
	}

	/**
	 * A ceiling reached that is enforceable mid-stream, so the live run must be
	 * stopped rather than allowed to settle.
	 *
	 * A flow's total-token ceiling is deliberately excluded and stays a
	 * between-run spawn gate: it counts input tokens the parent never chose to
	 * spend turn by turn, so tripping it mid-run would kill work that the ceiling
	 * was never meant to interrupt. A contract budget does stop mid-run on total
	 * tokens — it bounds the runs fulfilling one contract, so letting the current
	 * one finish would overspend exactly the thing being bounded.
	 */
	stopsLiveRun(): boolean {
		return this.costReached() || this.generatedReached() || (this.authority === "contract" && this.totalReached());
	}

	/**
	 * Spend has crossed the wrap-up fraction of a ceiling this budget would stop
	 * the live run for. Deliberately the same ceiling set as `stopsLiveRun`, at
	 * `WRAP_UP_FRACTION` instead of 1: a ceiling that only gates the next spawn
	 * (a flow's total-token ceiling) never asks a live run to wrap up, because
	 * the run it would interrupt is not the thing it bounds.
	 */
	nearsLiveStop(): boolean {
		return this.costReached(WRAP_UP_FRACTION) || this.generatedReached(WRAP_UP_FRACTION) || (this.authority === "contract" && this.totalReached(WRAP_UP_FRACTION));
	}

	/**
	 * The steer delivered into a child nearing a ceiling: stop now and emit the
	 * return envelope, using the envelope schema's own graceful-degradation
	 * vocabulary (`partial`, skipped coverage, `unresolvedQuestions`). Owned by
	 * the budget for the same reason its refusals are — the sentence must name
	 * the authority and spend of the ceiling that is actually about to bind.
	 */
	wrapUpNotice(): string {
		return [
			`${WRAP_UP_NOTICE_MARKER} ${this.authorityLabel} budget is nearly exhausted (${this.crossed(WRAP_UP_FRACTION)?.spend ?? "approaching a configured ceiling"}).`,
			"Stop working now and return your final answer in this turn; do not start new tool calls.",
			'If this task requires a pi-flows.return-envelope.v1 JSON object, emit it now with status "partial":',
			"record work you did not finish as skipped coverage entries and unresolvedQuestions instead of continuing past the budget.",
		].join(" ");
	}

	/** Whether this budget makes provider cost telemetry mandatory: a cost ceiling cannot be enforced without it. */
	get enforcesCost(): boolean {
		return this.maxCostUsd !== undefined;
	}

	snapshot(): BudgetSnapshot {
		return {
			authority: this.authority,
			...(this.maxCostUsd !== undefined ? { maxCostUsd: this.maxCostUsd } : {}),
			...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
			...(this.maxGeneratedTokens !== undefined ? { maxGeneratedTokens: this.maxGeneratedTokens } : {}),
			spentCost: this.spentCost,
			spentTokens: this.spentTokens,
			spentGeneratedTokens: this.spentGeneratedTokens,
		};
	}

	/** `fraction` scales the ceiling being tested: 1 is the hard stop, WRAP_UP_FRACTION the soft one. */
	private costReached(fraction = 1): boolean {
		return this.maxCostUsd !== undefined && this.spentCost >= this.maxCostUsd * fraction;
	}

	private generatedReached(fraction = 1): boolean {
		return this.maxGeneratedTokens !== undefined && this.spentGeneratedTokens >= this.maxGeneratedTokens * fraction;
	}

	private totalReached(fraction = 1): boolean {
		return this.maxTokens !== undefined && this.spentTokens >= this.maxTokens * fraction;
	}

	/** "Flow" or "Contract", so every sentence about this budget names the right one from a single decision. */
	private get authorityLabel(): string {
		return this.authority === "contract" ? "Contract" : "Flow";
	}

	/**
	 * The one ceiling that actually bound (or, at `WRAP_UP_FRACTION`, is about
	 * to), with the spend line describing it. Resolved together in a single
	 * cascade so an error's reported ceiling and its reported spend can never
	 * name different ceilings — as two independent cascades, they could drift
	 * apart the moment either was edited. The wrap-up notice reads the same
	 * cascade at its fraction, so the notice and a later exhaustion error
	 * describe the same ceiling in the same words.
	 */
	private crossed(fraction = 1): { ceiling: BudgetCeilings; spend: string } | undefined {
		const { maxCostUsd, maxTokens, maxGeneratedTokens } = this;
		if (maxCostUsd !== undefined && this.costReached(fraction)) return { ceiling: { maxCostUsd }, spend: `$${this.spentCost.toFixed(4)} of $${maxCostUsd.toFixed(4)}` };
		if (maxGeneratedTokens !== undefined && this.generatedReached(fraction)) return { ceiling: { maxGeneratedTokens }, spend: `${this.spentGeneratedTokens} of ${maxGeneratedTokens} generated tokens` };
		if (maxTokens !== undefined && this.totalReached(fraction)) return { ceiling: { maxTokens }, spend: `${this.spentTokens} of ${maxTokens} total tokens` };
		return undefined;
	}

	/** Every configured ceiling, for the case where none is individually reported as crossed. */
	private configured(): BudgetCeilings {
		return {
			...(this.maxCostUsd !== undefined ? { maxCostUsd: this.maxCostUsd } : {}),
			...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
			...(this.maxGeneratedTokens !== undefined ? { maxGeneratedTokens: this.maxGeneratedTokens } : {}),
		};
	}

	exhaustedError(): FlowError {
		const crossed = this.crossed();
		const budgetCeiling: BudgetCeiling = { authority: this.authority, ...(crossed?.ceiling ?? this.configured()) };
		return {
			code: "BUDGET_EXCEEDED",
			message: `${this.authorityLabel} budget exhausted (${crossed?.spend ?? "configured ceiling (usage unavailable)"}).`,
			cause: `${this.authorityLabel} budget usage reached a configured cost or token ceiling, so the active child was stopped when enforceable and later children are refused.`,
			fix: this.authority === "contract"
				? "Do not automatically replay this flow. Preserve contract.budget unless the user explicitly approves changing it. Ask the user for direction, or make a material, visible change that stays within the ceiling: narrow the contracted task or reduce the runs needed to fulfill it."
				: "Do not automatically replay this flow. Preserve the flow budget unless the user explicitly approves changing it. Ask the user for direction, or make a material, visible change that stays within the ceiling: narrow the task or reduce fan-out (fewer voters/subtasks/iterations).",
			retryable: false,
			budgetCeiling,
		};
	}

	unobservableError(): FlowError {
		return {
			code: "BUDGET_UNOBSERVABLE",
			message: `${this.authorityLabel} cost budget cannot be enforced because the provider omitted cost telemetry.`,
			cause: "The child completed a model response without a numeric usage.cost.total value, so treating its spend as zero would make maxCostUsd non-binding.",
			fix: this.authority === "contract"
				? "Use a provider/model that reports cost telemetry, or bind the delegation contract with maxTokens, maxGeneratedTokens, or timeoutMs instead."
				: "Use a provider/model that reports cost telemetry, or bind the flow with maxTokens, maxGeneratedTokens, or timeoutMs instead.",
			retryable: false,
		};
	}
}
