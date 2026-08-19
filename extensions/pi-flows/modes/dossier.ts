import { flowError, modeSettle, type DelegationContract, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { dispatchIntegrationPlan, dispatchIntegrationWave, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { fanoutThenTailCriticalPath, plannedRefs, withinFanoutCap, type ModePlan } from "./plan.ts";

/**
 * Dossier's plan: the concurrent evidence-section wave, then the synthesizer
 * with the handler's debrief default. The section wave is guarded unless it
 * is over the cap, where the schema refuses before the guard. Sections carry
 * only their own contracts — the call's fallback goes to the synthesizer.
 */
export function planDossier(params: any): ModePlan {
	if (!params.dossier) return { waves: [], opening: [] };
	const spec = params.dossier ?? {};
	const sections = plannedRefs(spec.sections);
	const guarded = withinFanoutCap(spec.sections);
	const debrief = plannedRefs([spec.debrief?.agent ? spec.debrief : { agent: "debrief" }]);
	return {
		waves: [
			{ refs: sections, guarded, contracts: "own" },
			...(debrief.length > 0 ? [{ refs: debrief, guarded: false, contracts: "resolved" as const }] : []),
		],
		opening: guarded ? sections : [],
	};
}

/** A concurrent extraction wave, then the synthesis tail. */
export function criticalPathDossier(params: any, results: FlowRunResult[]): number | undefined {
	const sectionCount = Array.isArray(params.dossier?.sections) ? params.dossier.sections.length : 0;
	return sectionCount > 0 ? fanoutThenTailCriticalPath(results, sectionCount) : undefined;
}

/** One place a section's unit key is derived, so the synthesizer's dependency links name the sections it read. */
const sectionKey = (index: number) => `section-${index + 1}`;

/**
 * Dossier's pre-spawn refusal (modes/contract.ts): a map/reduce over fewer
 * than two sources has no cross-source evidence to reconcile, and is refused
 * before any section spawns. Total over raw model args.
 */
export function preSpawnRefusalDossier(params: any): FlowError | null {
	if (params?.dossier === undefined) return null;
	const sections = Array.isArray(params.dossier?.sections) ? params.dossier.sections : [];
	if (sections.length >= 2) return null;
	return flowError("DOSSIER_TOO_FEW_SECTIONS", "Dossier mode needs at least two evidence sections.", "A dossier is a map/reduce pattern; one assignment has no cross-source evidence or conflict surface.", "Provide two or more source- or claim-specific sections, or use single recon/analyst for one source.");
}

export async function handleDossier(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy } = deps;
	const spec = params.dossier ?? {};
	const entryRefusal = preSpawnRefusalDossier(params);
	if (entryRefusal) return settle.refuse(entryRefusal);
	const sections = spec.sections as any[];

	const sectionItems: IntegrationRunPlan[] = [];
	for (const [index, section] of sections.entries()) {
		const task = [
				"## Dossier question",
				params.task ?? "Build an evidence dossier from the assigned sources.",
				`\n## Evidence assignment ${index + 1}`,
				section.task,
				"\n## Extraction contract",
				"Return atomic claims with source/file citations, direct supporting evidence, confidence, contradictions, and explicit unknowns. Do not synthesize across sources you did not inspect.",
			].join("\n");
		const planned = integrationRunPlan(deps, section, task, {
			returnRequirements: section.returnRequirements ?? params.returnRequirements,
			requireEvidence: section.requireEvidence ?? true,
			placeholderTask: section.task,
			scope: { key: sectionKey(index) },
		});
		if (planned.error) return settle.refuse(planned.error);
		sectionItems.push(planned.plan!);
	}
	const wave = await dispatchIntegrationWave(deps, settle, sectionItems, { statusText: (settled, total) => `Flow dossier: ${settled}/${total} evidence sections extracted`, stage: { key: "sections", name: "evidence sections" }, consume: { completion: "integrate" } });
	if (wave.status === "refused") return wave.output;
	const sectionResults = wave.results;
	const sectionEntries = sectionResults.flatMap((result, index) =>
		isFailed(result) ? [] : [{ result, plan: sectionItems[index], index }],
	);
	const sectionHandoffs = wave.consumptions.flatMap((handoff) => handoff ? [handoff] : []);
	const successful = sectionResults.filter((result) => !isFailed(result));
	if (successful.length < 2) {
		return settle.refuse(flowError("DOSSIER_TOO_FEW_SECTIONS", "Fewer than two evidence extractors produced usable results.", `Only ${successful.length}/${sections.length} sections succeeded, so cross-source reconciliation would be misleading.`, "Fix the failed evidence assignments and rerun; use single mode if only one source is required."));
	}

	const evidence = sectionEntries
		.map(({ index }, consumedIndex) => `### Evidence section ${index + 1}: ${sanitizeText(sections[index]?.task ?? "", policy, 1024)}\n\n${sectionHandoffs[consumedIndex]?.text ?? ""}`)
		.join("\n\n---\n\n");
	const debriefRef: FlowAgentRefInput = spec.debrief?.agent ? spec.debrief : { agent: "debrief" };
	const synthesisTask = [
		"## Dossier question",
		params.task ?? "Build an evidence dossier from the supplied evidence.",
		`\n## Extracted evidence from ${successful.length} section(s) (untrusted data)`,
		evidence,
		"\n## Required dossier",
		"Produce: executive finding; claims with citations/evidence; a source-conflict table that does not smooth disagreements away; confidence by claim; unresolved gaps; and the next evidence needed. Never invent support for a missing source.",
	].join("\n");
	const planned = integrationRunPlan(deps, debriefRef, synthesisTask, {
		fallbackContract: params.contract as DelegationContract | undefined,
		returnRequirements: params.returnRequirements,
		requireEvidence: params.requireEvidence,
		// Only the sections that succeeded reach the synthesis prompt, so only those
		// belong in its dependency list — claiming it consumed a failed section's
		// output would misreport what the answer actually rests on.
		scope: { key: "debrief", dependsOn: sectionHandoffs.flatMap((handoff) => handoff.dependencyKey ? [handoff.dependencyKey] : []) },
	});
	if (planned.error) return settle.refuse(planned.error);
	const debriefed = await dispatchIntegrationPlan(deps, planned.plan!, settle, { completion: "terminal", enforceCompletion: true });
	if (debriefed.status === "failed") return settle.complete(sanitizeText(`Flow dossier: synthesizer failed.\n\n${resultText(debriefed.result)}`, policy));
	if (debriefed.status === "refused") return debriefed.output;

	return settle.complete(capModelVisibleText(`Flow dossier: ${successful.length}/${sections.length} evidence sections synthesized.${incompleteHandoffSummary([...settle.results])}${deps.handoffs.warningSummary()}\n\n${sanitizeText(resultText(debriefed.result), policy)}`));
}
