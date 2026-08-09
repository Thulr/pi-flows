import { resolveDelegationContract } from "./contract-resolution.ts";
import { activeRunModes, planForMode } from "./modes/contract.ts";
import { formatTokens } from "./trace.ts";
import type { BudgetCeiling, DelegationContract, FlowError, RunMode } from "./types.ts";

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

function delegationContract(value: unknown): DelegationContract | undefined {
	return isRecord(value) ? value as unknown as DelegationContract : undefined;
}

/**
 * The contracts hanging off the mode's planned refs — each wave declares
 * whether its runs carry their own contracts only ("own"), resolve against
 * the call's fallback ("resolved"), or dispatch with no contract limits at
 * all (no marker), so a mode that never enforces a contract budget never
 * advertises one (modes/plan.ts). What used to be a hand-maintained
 * per-mode switch here now reads the same declaration the handlers plan by;
 * the missing-entry compile error moved to the table's `plan` member.
 */
function plannedContracts(params: RecordValue, mode: RunMode): DelegationContract[] {
	const fallback = delegationContract(params.contract);
	const contracts: DelegationContract[] = [];
	for (const wave of planForMode(mode, params).waves) {
		if (!wave.contracts) continue;
		for (const ref of wave.refs) {
			const contract = wave.contracts === "own"
				? delegationContract(ref.contract)
				: resolveDelegationContract({ contract: delegationContract(ref.contract) }, fallback);
			if (contract) contracts.push(contract);
		}
	}
	return contracts;
}

/**
 * Extract the cost/token ceilings a generated tool call will enforce. Contract
 * ceilings follow the selected mode's resolved child plans, so an overridden
 * fallback or an inactive contract-shaped field is never advertised as an
 * enforcement boundary. Identical ceilings collapse into one compact line.
 */
export function collectBudgetCeilings(params: unknown): BudgetCeiling[] {
	if (!isRecord(params)) return [];
	const modes = activeRunModes(params);
	if (modes.length !== 1) return [];
	const ceilings: BudgetCeiling[] = [];
	const keys = new Set<string>();
	const add = (ceiling: BudgetCeiling | undefined) => {
		if (!ceiling) return;
		const key = ceilingKey(ceiling);
		if (keys.has(key)) return;
		keys.add(key);
		ceilings.push(ceiling);
	};

	add(ceilingFrom("flow", params));
	for (const contract of plannedContracts(params, modes[0])) add(ceilingFrom("contract", contract.budget));
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
