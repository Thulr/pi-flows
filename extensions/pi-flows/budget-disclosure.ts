import { resolveDelegationContract } from "./contract-resolution.ts";
import { activeRunModes } from "./modes/contract.ts";
import { formatTokens } from "./trace.ts";
import type { BudgetCeiling, DelegationContract, FlowAgentRefInput, FlowError, RunMode } from "./types.ts";

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

function agentRef(value: unknown): FlowAgentRefInput | undefined {
	return isRecord(value) ? value as unknown as FlowAgentRefInput : undefined;
}

function ownContract(value: unknown): DelegationContract | undefined {
	return delegationContract(agentRef(value)?.contract);
}

function resolvedContract(value: unknown, fallback?: DelegationContract): DelegationContract | undefined {
	return resolveDelegationContract(agentRef(value), fallback);
}

function contractList(contract: DelegationContract | undefined): DelegationContract[] {
	return contract ? [contract] : [];
}

/**
 * Mirror the contracts each mode passes to a child budget. This intentionally
 * omits contract-shaped fields in modes that do not enforce contract budgets.
 */
function resolvedContracts(params: RecordValue, mode: RunMode): DelegationContract[] {
	const fallback = delegationContract(params.contract);
	switch (mode) {
		case "single":
			return fallback ? [fallback] : [];
		case "parallel":
			return (Array.isArray(params.tasks) ? params.tasks : []).flatMap((task) => resolvedContract(task, fallback) ?? []);
		case "chain":
			return (Array.isArray(params.chain) ? params.chain : []).flatMap((step) => resolvedContract(step, fallback) ?? []);
		case "evaluate": {
			const spec = isRecord(params.evaluate) ? params.evaluate : {};
			return contractList(resolvedContract(spec.operator, fallback));
		}
		case "vote": {
			const spec = isRecord(params.vote) ? params.vote : {};
			const voters = Array.isArray(spec.voters) && spec.voters.length > 0
				? spec.voters
				: typeof spec.agent === "string" ? [{ agent: spec.agent }] : [];
			return [
				...voters.flatMap((voter) => resolvedContract(voter, fallback) ?? []),
				...(agentRef(spec.debrief)?.agent ? contractList(resolvedContract(spec.debrief, fallback)) : []),
			];
		}
		case "orchestrate": {
			const spec = isRecord(params.orchestrate) ? params.orchestrate : {};
			return [
				...([spec.commander, spec.recon, spec.verify].flatMap((ref) => ownContract(ref) ?? [])),
				...contractList(resolvedContract(spec.debrief ?? { agent: "debrief" }, fallback)),
			];
		}
		case "graph": {
			const spec = isRecord(params.graph) ? params.graph : {};
			const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
			return [
				...nodes.flatMap((node) => ownContract(node) ?? []),
				...(agentRef(spec.debrief)?.agent ? contractList(resolvedContract(spec.debrief, fallback)) : []),
			];
		}
		case "workflow": {
			const spec = isRecord(params.workflow) ? params.workflow : {};
			const phases = Array.isArray(spec.phases) ? spec.phases : [];
			return [
				...phases.flatMap((phase) => ownContract(phase) ?? []),
				...(agentRef(spec.debrief)?.agent ? contractList(resolvedContract(spec.debrief, fallback)) : []),
			];
		}
		case "worktree": {
			const spec = isRecord(params.worktree) ? params.worktree : {};
			const tasks = Array.isArray(spec.tasks) ? spec.tasks : [];
			const integrator = spec.integrator ?? { agent: "operator" };
			return [
				...tasks.flatMap((task) => ownContract(task) ?? []),
				...contractList(resolvedContract(integrator, fallback)),
			];
		}
		case "debate": {
			const spec = isRecord(params.debate) ? params.debate : {};
			const participants = Array.isArray(spec.participants) ? spec.participants : [];
			const adjudicator = spec.adjudicator ?? { agent: "analyst" };
			return [
				...participants.flatMap((participant) => resolvedContract(participant, fallback) ?? []),
				...contractList(resolvedContract(adjudicator, fallback)),
			];
		}
		case "dossier": {
			const spec = isRecord(params.dossier) ? params.dossier : {};
			const sections = Array.isArray(spec.sections) ? spec.sections : [];
			const debrief = spec.debrief ?? { agent: "debrief" };
			return [
				...sections.flatMap((section) => ownContract(section) ?? []),
				...contractList(resolvedContract(debrief, fallback)),
			];
		}
		case "route":
		case "loop":
		case "search":
		case "monitor":
			return [];
	}
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
	for (const contract of resolvedContracts(params, modes[0])) add(ceilingFrom("contract", contract.budget));
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
