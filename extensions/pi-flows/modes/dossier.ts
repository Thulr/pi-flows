import { flowError, formatFlowError, type DelegationContract, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { HandoffWarnings, prepareResultHandoff } from "../handoff.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { validateSharedWriteCwd } from "../validate.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { acceptIntegrationResult, acceptIntegrationResults, integrationRunPlan, runIntegrationPlan, type IntegrationRunPlan } from "../integration.ts";

/** One place a section's unit key is derived, so the synthesizer's dependency links name the sections it read. */
const sectionKey = (index: number) => `section-${index + 1}`;

export async function handleDossier(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd } = deps;
	const spec = params.dossier ?? {};
	const sections = Array.isArray(spec.sections) ? spec.sections : [];
	if (sections.length < 2) {
		const error = flowError("DOSSIER_TOO_FEW_SECTIONS", "Dossier mode needs at least two evidence sections.", "A dossier is a map/reduce pattern; one assignment has no cross-source evidence or conflict surface.", "Provide two or more source- or claim-specific sections, or use single recon/analyst for one source.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("dossier")([], error) };
	}
	const { concurrency } = deps;
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, sections, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) return { content: [{ type: "text", text: formatFlowError(sharedWriteError) }], details: deps.makeDetails("dossier")([], sharedWriteError) };

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
			returnContract: section.returnContract ?? params.returnContract,
			requireEvidence: section.requireEvidence ?? true,
			placeholderTask: section.task,
			scope: { key: sectionKey(index) },
		});
		if (planned.error) return { content: [{ type: "text", text: formatFlowError(planned.error) }], details: deps.makeDetails("dossier")([], planned.error) };
		sectionItems.push(planned.plan!);
	}
	const results: FlowRunResult[] = await runAgentFanout(deps, "dossier", sectionItems, concurrency, [], (done, total) => `Flow dossier: ${done}/${total} evidence sections extracted`, { key: "sections", name: "evidence sections" });
	const sectionHandoffError = acceptIntegrationResults(deps, sectionItems, results);
	if (sectionHandoffError) return { content: [{ type: "text", text: formatFlowError(sectionHandoffError) }], details: deps.makeDetails("dossier")(results, sectionHandoffError) };
	const successful = results.filter((result) => !isFailed(result));
	if (successful.length < 2) {
		const error = flowError("DOSSIER_TOO_FEW_SECTIONS", "Fewer than two evidence extractors produced usable results.", `Only ${successful.length}/${sections.length} sections succeeded, so cross-source reconciliation would be misleading.`, "Fix the failed evidence assignments and rerun; use single mode if only one source is required.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("dossier")(results, error) };
	}

	const warnings = new HandoffWarnings();
	const evidence = results
		.map((result, index) => ({ result, index }))
		.filter(({ result }) => !isFailed(result))
		.map(({ result, index }) => {
			const prepared = warnings.addFrom(prepareResultHandoff(result, policy, undefined, deps.handoffGuard));
			return `### Evidence section ${index + 1}: ${sanitizeText(sections[index]?.task ?? "", policy, 1024)}\n\n${prepared.text}`;
		})
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
		returnContract: params.returnContract,
		requireEvidence: params.requireEvidence,
		// Only the sections that succeeded reach the synthesis prompt, so only those
		// belong in its dependency list — claiming it consumed a failed section's
		// output would misreport what the answer actually rests on.
		scope: { key: "debrief", dependsOn: results.flatMap((result, index) => isFailed(result) ? [] : [`${sectionKey(index)}.handoff`]) },
	});
	if (planned.error) return { content: [{ type: "text", text: formatFlowError(planned.error) }], details: deps.makeDetails("dossier")(results, planned.error) };
	const debriefed = await runIntegrationPlan(deps, planned.plan!, "dossier", results.length + 1, results);
	results.push(debriefed);
	if (isFailed(debriefed)) return { content: [{ type: "text", text: sanitizeText(`Flow dossier: synthesizer failed.\n\n${resultText(debriefed)}`, policy) }], details: deps.makeDetails("dossier")(results) };
	const debriefHandoffError = acceptIntegrationResult(deps, planned.plan!, debriefed, undefined, { consumed: false });
	if (debriefHandoffError) return { content: [{ type: "text", text: formatFlowError(debriefHandoffError) }], details: deps.makeDetails("dossier")(results, debriefHandoffError) };

	return {
		content: [{ type: "text", text: capModelVisibleText(`Flow dossier: ${successful.length}/${sections.length} evidence sections synthesized.${incompleteHandoffSummary(results)}${warnings.summary()}\n\n${sanitizeText(resultText(debriefed), policy)}`) }],
		details: deps.makeDetails("dossier")(results),
	};
}
