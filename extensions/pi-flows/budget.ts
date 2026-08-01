import type { BudgetCeiling, FlowError, UsageStats } from "./types.ts";

/** Which budget a ceiling belongs to. See CONTEXT.md — a refusal must never be attributed to a budget the run never had. */
export type BudgetAuthority = "flow" | "contract";

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

	private costReached(): boolean {
		return this.maxCostUsd !== undefined && this.spentCost >= this.maxCostUsd;
	}

	private generatedReached(): boolean {
		return this.maxGeneratedTokens !== undefined && this.spentGeneratedTokens >= this.maxGeneratedTokens;
	}

	private totalReached(): boolean {
		return this.maxTokens !== undefined && this.spentTokens >= this.maxTokens;
	}

	/** "Flow" or "Contract", so every sentence about this budget names the right one from a single decision. */
	private get authorityLabel(): string {
		return this.authority === "contract" ? "Contract" : "Flow";
	}

	/**
	 * The one ceiling that actually bound, with the spend line describing it.
	 * Resolved together in a single cascade so an error's reported ceiling and its
	 * reported spend can never name different ceilings — as two independent
	 * cascades, they could drift apart the moment either was edited.
	 */
	private crossed(): { ceiling: BudgetCeilings; spend: string } | undefined {
		const { maxCostUsd, maxTokens, maxGeneratedTokens } = this;
		if (maxCostUsd !== undefined && this.costReached()) return { ceiling: { maxCostUsd }, spend: `$${this.spentCost.toFixed(4)} of $${maxCostUsd.toFixed(4)}` };
		if (maxGeneratedTokens !== undefined && this.generatedReached()) return { ceiling: { maxGeneratedTokens }, spend: `${this.spentGeneratedTokens} of ${maxGeneratedTokens} generated tokens` };
		if (maxTokens !== undefined && this.totalReached()) return { ceiling: { maxTokens }, spend: `${this.spentTokens} of ${maxTokens} total tokens` };
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
