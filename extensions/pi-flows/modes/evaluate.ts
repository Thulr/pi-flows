import { DEFAULT_CHECK_COMMAND_TIMEOUT_MS, DEFAULT_CONCURRENCY, MAX_PARALLEL_TASKS, flowError, formatFlowError, type FlowAgentRefInput, type FlowDetails, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { HandoffWarnings, prepareResultHandoff, prepareTextHandoff } from "../handoff.ts";
import { appendReturnContract, clampIterations, normalizeTimeout, validateConcurrency, validateSharedWriteCwd } from "../validate.ts";
import { parseVerdict, verdictProtocolInstruction } from "../protocol.ts";
import { appendReflexion, withReflexion } from "../reflexion.ts";
import { toolErrorDetails } from "../agent-catalog.ts";
import { runAgentFanout, runFlowAgent } from "../runner.ts";
import { runCheckCommand } from "../commands.ts";

export async function handleEvaluate(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, signal, onUpdate, makeDetails } = deps;
	const spec = params.evaluate ?? {};
	const operatorWithTask = spec.operator as (FlowAgentRefInput & { task?: unknown }) | undefined;
	const operatorTask = typeof operatorWithTask?.task === "string" ? operatorWithTask.task : undefined;
	const goal: string | undefined = params.task ?? operatorTask;

	if (!goal || !goal.trim()) {
		const error = flowError(
			"INVALID_MODE",
			"Evaluate mode requires a task.",
			"evaluate mode needs a top-level `task` describing the goal/contract the generator must satisfy and the evaluator must judge.",
			'Add a `task` string, e.g. { "task": "Add a /health endpoint with a test", "evaluate": {} }.',
		);
		return { content: [{ type: "text", text: formatFlowError(error) }], details: toolErrorDetails(discovery, "evaluate", agentScope, error) };
	}
	const contractedGoal = withReflexion(defaultCwd, params, appendReturnContract(goal, params.returnContract, params.requireEvidence), policy);

	const generatorRef: FlowAgentRefInput = spec.operator ?? { agent: "operator" };
	// The critic may be a single agent or a panel (god-metric → decomposed evaluators:
	// one critic per dimension, PASS only when every critic passes). Normalize to a list.
	const evaluatorRefs: FlowAgentRefInput[] = (Array.isArray(spec.redteam) ? spec.redteam : [spec.redteam ?? { agent: "redteam" }])
		.filter((ref: any): ref is FlowAgentRefInput => ref && typeof ref.agent === "string")
		.slice(0, MAX_PARALLEL_TASKS);
	if (evaluatorRefs.length === 0) evaluatorRefs.push({ agent: "redteam" });
	const maxIterations = clampIterations(spec.maxIterations);
	const passContract: string | undefined = spec.passContract;
	const checkCommand: string | undefined = typeof spec.checkCommand === "string" && spec.checkCommand.trim() ? spec.checkCommand.trim() : undefined;
	const concurrencyError = validateConcurrency(params.concurrency);
	if (concurrencyError) {
		return { content: [{ type: "text", text: formatFlowError(concurrencyError) }], details: toolErrorDetails(discovery, "evaluate", agentScope, concurrencyError) };
	}
	const concurrency = params.concurrency ?? DEFAULT_CONCURRENCY;
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, evaluatorRefs, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) {
		return { content: [{ type: "text", text: formatFlowError(sharedWriteError) }], details: toolErrorDetails(discovery, "evaluate", agentScope, sharedWriteError) };
	}
	const checkTimeoutMs = Math.min(normalizeTimeout(params.timeoutMs), DEFAULT_CHECK_COMMAND_TIMEOUT_MS);

	const results: FlowRunResult[] = [];
	const handoffWarnings = new HandoffWarnings();
	const emitLive = (inFlight?: FlowRunResult) => {
		onUpdate?.({
			content: [{ type: "text", text: `Flow evaluate: ${results.length} step(s) done` }],
			details: makeDetails("evaluate")([...results, ...(inFlight ? [inFlight] : [])]),
		});
	};
	const stepUpdate = (partial: { content: any; details: FlowDetails }) => {
		const current = partial.details.results[0];
		onUpdate?.({ content: partial.content, details: makeDetails("evaluate")([...results, ...(current ? [current] : [])]) });
	};

	let lastGenerator: FlowRunResult | null = null;
	let critique = "";
	let priorArtifact = "";
	let passed = false;
	let rounds = 0;
	let lastCheckOk: boolean | null = null;

	for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
		rounds = iteration;

		// 1. Generator builds. Round 1 sees the goal; later rounds also see the prior
		// ARTIFACT plus the critique so the generator revises in place instead of
		// rebuilding from scratch (durable hand-off, per the harness design rules).
		const generatorTask =
			iteration === 1
				? contractedGoal
				: [
						contractedGoal,
						"\n## Your previous attempt (revise it in place; do not rebuild from scratch)",
						priorArtifact,
						"\n## Reviewer feedback on that attempt (address every point)",
						critique,
					].join("\n");
		const generated = await runFlowAgent({
			defaultCwd,
			agents: discovery.agents,
			agentName: generatorRef.agent,
			task: generatorTask,
			cwd: generatorRef.cwd,
			model: generatorRef.model ?? params.model,
			tier: generatorRef.tier ?? params.tier,
			tools: generatorRef.tools,
			timeoutMs: params.timeoutMs,
			recordContent: params.recordContent,
			redactSecrets: params.redactSecrets,
			step: results.length + 1,
			signal,
			budget: deps.budget,
			recordSpan: deps.recordSpan,
			onUpdate: stepUpdate,
			makeDetails: makeDetails("evaluate"),
		});
		results.push(generated);
		lastGenerator = generated;
		emitLive();
		if (isFailed(generated)) {
			return {
				content: [{ type: "text", text: sanitizeText(`Flow evaluate stopped: generator "${generatorRef.agent}" failed at iteration ${iteration}:\n\n${resultText(generated)}`, policy) }],
				details: makeDetails("evaluate")(results),
			};
		}

		// The artifact crosses a trust boundary into the critic prompt: strip
		// invisible characters and flag injection markers before reuse.
		const artifactPrep = handoffWarnings.addFrom(prepareResultHandoff(generated, policy));
		const artifact = artifactPrep.text;
		priorArtifact = artifact;

		// 2. Deterministic gate (level-1 / code assertions): a command that must exit 0.
		// A failing check is a forced REVISE; the critics are skipped that round to save
		// cost, and the command output becomes the critique the generator must fix.
		if (checkCommand) {
			const check = await runCheckCommand(checkCommand, generatorRef.cwd ?? defaultCwd, checkTimeoutMs, policy, signal);
			if (check.spawnFailed) {
				const error = flowError(
					"CHECK_COMMAND_FAILED",
					`Could not run evaluate checkCommand: ${checkCommand}.`,
					`The deterministic gate command could not be started: ${check.output}.`,
					"Verify the command exists and is runnable from the cwd. A non-runnable check is a config error, not a REVISE signal.",
				);
				return { content: [{ type: "text", text: formatFlowError(error) }], details: toolErrorDetails(discovery, "evaluate", agentScope, error) };
			}
			lastCheckOk = check.ok;
			if (!check.ok) {
				critique = `## Automated check FAILED: \`${checkCommand}\`\n\n${check.output}\n\nFix the failing check before anything else — a separate critic will not run until it passes.`;
				emitLive();
				continue;
			}
		}

		// 3. Critic panel (level-2 / LLM-as-judge) judges the ARTIFACT — not the
		// generator's reasoning trace. PASS requires every critic to pass.
		const checkContext = checkCommand ? `\n## Automated check (already passing)\nThe deterministic gate \`${checkCommand}\` exited 0. Judge quality and correctness beyond what that command covers.` : "";
		const evaluatorTask = [
			"## Goal / contract",
			contractedGoal,
			passContract ? `\n## Explicit acceptance criteria\n${passContract}` : "",
			checkContext,
			"\n## Artifact to evaluate (the generator's output)",
			artifact,
			"\n## Your job",
			`Judge whether the artifact satisfies the goal and acceptance criteria. ${verdictProtocolInstruction("specific, actionable critique the generator can act on")} Judge only the artifact above, not how it was produced.`,
		]
			.filter(Boolean)
			.join("\n");

		const critics = await runAgentFanout(
			deps,
			"evaluate",
			evaluatorRefs.map((ref) => ({ ref, task: evaluatorTask })),
			concurrency,
			results,
			(done) => `Flow evaluate: ${results.length + done} step(s) done`,
		);
		results.push(...critics);
		emitLive();
		const failedCritic = critics.find((critic) => isFailed(critic));
		if (failedCritic) {
			return {
				content: [{ type: "text", text: sanitizeText(`Flow evaluate stopped: critic "${failedCritic.agent}" failed at iteration ${iteration}:\n\n${resultText(failedCritic)}`, policy) }],
				details: makeDetails("evaluate")(results),
			};
		}

		const verdicts = critics.map((critic) => ({ agent: critic.agent, pass: parseVerdict(resultText(critic)) === "pass", text: resultText(critic) }));
		const allPass = verdicts.every((verdict) => verdict.pass);
		if (allPass) {
			passed = true;
			break;
		}

		// Critique fed back = the REVISE critics' output (a handoff: clean + scan).
		const revising = verdicts.filter((verdict) => !verdict.pass);
		const critiqueRaw = revising.map((verdict, index) => `### Critic ${index + 1} (${verdict.agent})\n\n${verdict.text}`).join("\n\n---\n\n");
		const critiquePrep = handoffWarnings.addFrom(prepareTextHandoff(critiqueRaw, policy));
		critique = critiquePrep.text;
	}

	const finalArtifact = lastGenerator ? sanitizeText(resultText(lastGenerator), policy) : "(no generator output)";
	const criticLabel = evaluatorRefs.length === 1 ? evaluatorRefs[0].agent : `${evaluatorRefs.length} critics`;
	const gate = checkCommand ? ` (gate \`${checkCommand}\`: ${lastCheckOk === false ? "FAILED" : "passed"})` : "";
	const header = passed
		? `Flow evaluate: PASS after ${rounds} iteration${rounds === 1 ? "" : "s"} via ${criticLabel}${gate}.`
		: `Flow evaluate: did not pass within ${maxIterations} iteration${maxIterations === 1 ? "" : "s"}${gate} — returning the last attempt with the final critique.`;
	const warningNote = handoffWarnings.summary();
	const body = passed ? finalArtifact : `## Last attempt\n\n${finalArtifact}\n\n## Final critique\n\n${critique}`;
	await appendReflexion(defaultCwd, params, "evaluate", passed ? `Evaluate passed for task "${goal}". Final artifact:\n${finalArtifact}` : `Evaluate did not pass for task "${goal}". Final critique:\n${critique}`, policy);
	return {
		content: [{ type: "text", text: capModelVisibleText(`${header}${warningNote}\n\n${body}`) }],
		details: makeDetails("evaluate")(results),
	};
}
