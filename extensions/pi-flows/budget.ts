import type { BudgetUsageState, FlowError, UsageStats } from "./types.ts";

export function budgetExceeded(budget: BudgetUsageState | undefined): boolean {
	if (activeBudgetExceeded(budget)) return true;
	return Boolean(budget?.maxTokens !== undefined && budget.spentTokens >= budget.maxTokens);
}

export function activeBudgetExceeded(budget: BudgetUsageState | undefined): boolean {
	if (!budget) return false;
	if (budget.maxCostUsd !== undefined && budget.spentCost >= budget.maxCostUsd) return true;
	return budget.maxGeneratedTokens !== undefined && budget.spentGeneratedTokens >= budget.maxGeneratedTokens;
}

export function chargeBudget(budget: BudgetUsageState | undefined, usage: UsageStats): void {
	if (!budget) return;
	budget.spentCost += usage.cost || 0;
	budget.spentTokens += (usage.input || 0) + (usage.output || 0);
	budget.spentGeneratedTokens += usage.output || 0;
}

export function budgetExceededError(budget: BudgetUsageState, authority: "flow" | "contract" = "flow"): FlowError {
	const costLimit = budget.maxCostUsd;
	const generatedLimit = budget.maxGeneratedTokens;
	const totalLimit = budget.maxTokens;
	const costExceeded = costLimit !== undefined && budget.spentCost >= costLimit;
	const generatedExceeded = generatedLimit !== undefined && budget.spentGeneratedTokens >= generatedLimit;
	const totalExceeded = totalLimit !== undefined && budget.spentTokens >= totalLimit;
	const spent = costExceeded
		? `$${budget.spentCost.toFixed(4)} of $${costLimit.toFixed(4)}`
		: generatedExceeded
			? `${budget.spentGeneratedTokens} of ${generatedLimit} generated tokens`
			: totalExceeded
				? `${budget.spentTokens} of ${totalLimit} total tokens`
				: "configured ceiling (usage unavailable)";
	const label = authority === "contract" ? "Contract budget" : "Flow budget";
	return {
		code: "BUDGET_EXCEEDED",
		message: `${label} exhausted (${spent}).`,
		cause: `${label} usage reached a configured cost or token ceiling, so the active child was stopped when enforceable and later children are refused.`,
		fix: authority === "contract"
			? "Do not automatically replay this flow. Preserve contract.budget unless the user explicitly approves changing it. Ask the user for direction, or make a material, visible change that stays within the ceiling: narrow the contracted task or reduce the runs needed to fulfill it."
			: "Do not automatically replay this flow. Preserve the flow budget unless the user explicitly approves changing it. Ask the user for direction, or make a material, visible change that stays within the ceiling: narrow the task or reduce fan-out (fewer voters/subtasks/iterations).",
		retryable: false,
		budgetCeiling: {
			authority,
			...(costExceeded
				? { maxCostUsd: costLimit }
				: generatedExceeded
					? { maxGeneratedTokens: generatedLimit }
					: totalExceeded
						? { maxTokens: totalLimit }
						: {
							...(costLimit !== undefined ? { maxCostUsd: costLimit } : {}),
							...(totalLimit !== undefined ? { maxTokens: totalLimit } : {}),
							...(generatedLimit !== undefined ? { maxGeneratedTokens: generatedLimit } : {}),
						}),
		},
	};
}

export function budgetUnobservableError(authority: "flow" | "contract" = "flow"): FlowError {
	const label = authority === "contract" ? "Contract cost budget" : "Flow cost budget";
	return {
		code: "BUDGET_UNOBSERVABLE",
		message: `${label} cannot be enforced because the provider omitted cost telemetry.`,
		cause: "The child completed a model response without a numeric usage.cost.total value, so treating its spend as zero would make maxCostUsd non-binding.",
		fix: authority === "contract"
			? "Use a provider/model that reports cost telemetry, or bind the delegation contract with maxTokens, maxGeneratedTokens, or timeoutMs instead."
			: "Use a provider/model that reports cost telemetry, or bind the flow with maxTokens, maxGeneratedTokens, or timeoutMs instead.",
		retryable: false,
	};
}
