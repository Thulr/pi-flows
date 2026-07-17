import { DEFAULT_CONCURRENCY, flowError, formatFlowError, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { HandoffWarnings, prepareResultHandoff } from "../handoff.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { appendReturnContract, validateConcurrency, validateSharedWriteCwd } from "../validate.ts";
import { toolErrorDetails } from "../agent-catalog.ts";

export async function handleDossier(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd } = deps;
	const spec = params.dossier ?? {};
	const sections = Array.isArray(spec.sections) ? spec.sections : [];
	if (sections.length < 2) {
		const error = flowError("DOSSIER_TOO_FEW_SECTIONS", "Dossier mode needs at least two evidence sections.", "A dossier is a map/reduce pattern; one assignment has no cross-source evidence or conflict surface.", "Provide two or more source- or claim-specific sections, or use single recon/analyst for one source.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: toolErrorDetails(discovery, "dossier", agentScope, error) };
	}
	const concurrencyError = validateConcurrency(params.concurrency);
	if (concurrencyError) return { content: [{ type: "text", text: formatFlowError(concurrencyError) }], details: toolErrorDetails(discovery, "dossier", agentScope, concurrencyError) };
	const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, sections, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) return { content: [{ type: "text", text: formatFlowError(sharedWriteError) }], details: toolErrorDetails(discovery, "dossier", agentScope, sharedWriteError) };

	const sectionItems = sections.map((section: any, index: number) => ({
		ref: section,
		placeholderTask: section.task,
		task: appendReturnContract(
			[
				"## Dossier question",
				params.task ?? "Build an evidence dossier from the assigned sources.",
				`\n## Evidence assignment ${index + 1}`,
				section.task,
				"\n## Extraction contract",
				"Return atomic claims with source/file citations, direct supporting evidence, confidence, contradictions, and explicit unknowns. Do not synthesize across sources you did not inspect.",
			].join("\n"),
			section.returnContract ?? params.returnContract,
			section.requireEvidence ?? true,
		),
	}));
	const results: FlowRunResult[] = await runAgentFanout(deps, "dossier", sectionItems, concurrency, [], (done, total) => `Flow dossier: ${done}/${total} evidence sections extracted`);
	const successful = results.filter((result) => !isFailed(result));
	if (successful.length < 2) {
		const error = flowError("DOSSIER_TOO_FEW_SECTIONS", "Fewer than two evidence extractors produced usable results.", `Only ${successful.length}/${sections.length} sections succeeded, so cross-source reconciliation would be misleading.`, "Fix the failed evidence assignments and rerun; use single mode if only one source is required.");
		const details = deps.makeDetails("dossier")(results);
		details.error = error;
		return { content: [{ type: "text", text: formatFlowError(error) }], details };
	}

	const warnings = new HandoffWarnings();
	const evidence = results
		.map((result, index) => ({ result, index }))
		.filter(({ result }) => !isFailed(result))
		.map(({ result, index }) => {
			const prepared = warnings.addFrom(prepareResultHandoff(result, policy));
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
	const debriefed = await runAgentRef(deps, debriefRef, synthesisTask, "dossier", results.length + 1, results);
	results.push(debriefed);
	if (isFailed(debriefed)) return { content: [{ type: "text", text: sanitizeText(`Flow dossier: synthesizer failed.\n\n${resultText(debriefed)}`, policy) }], details: deps.makeDetails("dossier")(results) };

	return {
		content: [{ type: "text", text: capModelVisibleText(`Flow dossier: ${successful.length}/${sections.length} evidence sections synthesized.${warnings.summary()}\n\n${sanitizeText(resultText(debriefed), policy)}`) }],
		details: deps.makeDetails("dossier")(results),
	};
}
