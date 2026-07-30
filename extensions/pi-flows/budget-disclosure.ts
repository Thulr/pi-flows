import { formatTokens } from "./trace.ts";
import type { BudgetCeiling, FlowError } from "./types.ts";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function limit(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function ceilingFrom(authority: BudgetCeiling["authority"], value: unknown): BudgetCeiling | undefined {
	if (!isRecord(value)) return undefined;
	const maxCostUsd = limit(value.maxCostUsd);
	const maxTokens = limit(value.maxTokens);
	const maxGeneratedTokens = limit(value.maxGeneratedTokens);
	if (maxCostUsd === undefined && maxTokens === undefined && maxGeneratedTokens === undefined) return undefined;
	return {
		authority,
		...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(maxGeneratedTokens !== undefined ? { maxGeneratedTokens } : {}),
	};
}

function ceilingKey(ceiling: BudgetCeiling): string {
	return [
		ceiling.authority,
		ceiling.maxCostUsd ?? "",
		ceiling.maxTokens ?? "",
		ceiling.maxGeneratedTokens ?? "",
	].join(":");
}

/**
 * Extract the cost/token ceilings a generated tool call will enforce. Contract
 * definitions occur at several mode-specific depths, so discovery walks the
 * validated parameter object and reads only properties explicitly named
 * `contract`; it never treats timeout-only contracts as BUDGET_EXCEEDED
 * ceilings. Identical contract ceilings collapse into one compact disclosure.
 */
export function collectBudgetCeilings(params: unknown): BudgetCeiling[] {
	if (!isRecord(params)) return [];
	const ceilings: BudgetCeiling[] = [];
	const keys = new Set<string>();
	const seen = new WeakSet<object>();
	const add = (ceiling: BudgetCeiling | undefined) => {
		if (!ceiling) return;
		const key = ceilingKey(ceiling);
		if (keys.has(key)) return;
		keys.add(key);
		ceilings.push(ceiling);
	};

	add(ceilingFrom("flow", params));

	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			if (key === "contract" && isRecord(child)) {
				add(ceilingFrom("contract", child.budget));
				continue;
			}
			visit(child);
		}
	};
	visit(params);
	return ceilings;
}

export function formatBudgetCeiling(ceiling: BudgetCeiling): string {
	const limits: string[] = [];
	if (ceiling.maxCostUsd !== undefined) limits.push(`$${ceiling.maxCostUsd}`);
	if (ceiling.maxTokens !== undefined) limits.push(`${formatTokens(ceiling.maxTokens)} total tok`);
	if (ceiling.maxGeneratedTokens !== undefined) limits.push(`${formatTokens(ceiling.maxGeneratedTokens)} generated tok`);
	return `${ceiling.authority} ceiling: ${limits.join(" · ")}`;
}

export function budgetDisclosureLines(ceilings: BudgetCeiling[] | undefined): string[] {
	return (ceilings ?? []).map((ceiling) => `budget · ${formatBudgetCeiling(ceiling)}`);
}

export function exhaustedBudgetText(error: FlowError | undefined): string | undefined {
	return error?.code === "BUDGET_EXCEEDED" && error.budgetCeiling
		? formatBudgetCeiling(error.budgetCeiling)
		: undefined;
}
