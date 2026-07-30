import { DEFAULT_CHECK_COMMAND_TIMEOUT_MS, MAX_PARALLEL_TASKS, flowError, formatFlowError, type DelegationContract, type FlowAgentRefInput, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, clampIterations, normalizeTimeout, resolvedCwd, validateSharedWriteCwd } from "../validate.ts";
import { createDelegationBudget, renderDelegationTask, validateDelegationContract } from "../delegation.ts";
import { parseVerdict, verdictProtocolInstruction } from "../protocol.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { runCheckCommand } from "../commands.ts";

/** One place the generator's unit key is derived, so each critic's dependency link names the draft it judged. */
const generatorKey = (stageKey: string) => `${stageKey}.generator`;

export async function handleEvaluate(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd, signal, onUpdate, makeDetails } = deps;
	const spec = params.evaluate ?? {};
	const operatorWithTask = spec.operator as (FlowAgentRefInput & { task?: unknown; contract?: DelegationContract }) | undefined;
	const operatorTask = typeof operatorWithTask?.task === "string" ? operatorWithTask.task : undefined;
	const contract = (operatorWithTask?.contract ?? params.contract) as DelegationContract | undefined;
	const contractError = contract ? validateDelegationContract(contract, policy) : null;
	if (contractError) {
		return { content: [{ type: "text", text: formatFlowError(contractError) }], details: makeDetails("evaluate")([], contractError) };
	}
	const goal: string | undefined = params.task ?? operatorTask ?? contract?.objective;

	if (!goal || !goal.trim()) {
		const error = flowError(
			"INVALID_MODE",
			"Evaluate mode requires a task.",
			"evaluate mode needs a top-level `task` describing the goal, or a delegation contract whose objective the generator must satisfy and the evaluator must judge.",
			'Add a `task` string, e.g. { "task": "Add a /health endpoint with a test", "evaluate": {} }.',
		);
		return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("evaluate")([], error) };
	}
	const contractedGoal = contract
		? renderDelegationTask(goal, contract, params.returnContract, params.requireEvidence)
		: appendReturnRequirements(goal, params.returnContract, params.requireEvidence);

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
	const { concurrency } = deps;
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, evaluatorRefs, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) {
		return { content: [{ type: "text", text: formatFlowError(sharedWriteError) }], details: makeDetails("evaluate")([], sharedWriteError) };
	}
	const checkTimeoutMs = Math.min(normalizeTimeout(params.timeoutMs), DEFAULT_CHECK_COMMAND_TIMEOUT_MS);

	const results: FlowRunResult[] = [];
	const emitLive = (inFlight?: FlowRunResult) => {
		onUpdate?.({
			content: [{ type: "text", text: `Flow evaluate: ${results.length} step(s) settled` }],
			details: makeDetails("evaluate")([...results, ...(inFlight ? [inFlight] : [])]),
		});
	};

	let lastGenerator: FlowRunResult | null = null;
	let critique = "";
	let priorArtifact = "";
	let passed = false;
	let rounds = 0;
	let lastCheckOk: boolean | null = null;
	// What the next revision is answering: the critic panel that said REVISE, or
	// the gate that failed before the critics ever ran. Without it the trace shows
	// iteration 2 as independent of iteration 1, and a revision cannot be
	// attributed to the verdict that caused it.
	let feedbackKey: string | undefined;
	let priorArtifactKey: string | undefined;
	const contractBudget = contract ? createDelegationBudget(contract) : undefined;

	for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
		rounds = iteration;
		const stage = { key: `iteration-${iteration}`, name: `iteration ${iteration}` };
		// A revision round is a retry of the same goal with new feedback. Recording
		// it makes "how many attempts did this take, and why" answerable from the
		// trace instead of from the prose header.
		if (iteration > 1) {
			deps.recordEvent?.({
				kind: "retry",
				name: "evaluate.revise",
				// The retry is caused by the previous iteration's feedback, so it hangs
				// off that verdict rather than off the iteration boundary alone.
				scope: { stage, key: `${stage.key}.retry`, ...(feedbackKey ? { dependsOn: [feedbackKey] } : {}) },
				attributes: {
					"flow.retry.attempt": iteration,
					"flow.retry.max_attempts": maxIterations,
					"flow.retry.reason": lastCheckOk === false ? "check_command_failed" : "critic_revise",
				},
			});
		}

		// 1. Generator builds. Round 1 sees the goal; later rounds also see the prior
		// ARTIFACT plus the critique so the generator revises in place instead of
		// rebuilding from scratch (durable hand-off, per the harness design rules).
		const consumed = [priorArtifactKey, feedbackKey].filter((key): key is string => Boolean(key));
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
		const generated = await runAgentRef(
			deps,
			generatorRef,
			generatorTask,
			"evaluate",
			results.length + 1,
			results,
			{
				limits: contract ? { captureRawOutput: true, timeoutMs: contract.budget.timeoutMs, contractBudget, contract } : {},
				// A revision's prompt carries the prior artifact and the feedback that
				// sent it back. Both are declared: reachability through the panel is
				// not the same as saying what this prompt actually contains.
				scope: { stage, key: generatorKey(stage.key), ...(consumed.length ? { dependsOn: consumed } : {}) },
			},
		);
		results.push(generated);
		lastGenerator = generated;
		emitLive();
		if (isFailed(generated)) {
			return {
				content: [{ type: "text", text: sanitizeText(`Flow evaluate stopped: generator "${generatorRef.agent}" failed at iteration ${iteration}:\n\n${resultText(generated)}`, policy) }],
				details: makeDetails("evaluate")(results),
			};
		}
		const validatedArtifact = deps.handoffs.consumeResult({
			result: generated,
			contract,
			cwd: resolvedCwd(defaultCwd, generatorRef.cwd),
			scope: { stage, key: generatorKey(stage.key) },
			consumed: false,
			payload: "source",
		});
		if (validatedArtifact.error) return { content: [{ type: "text", text: formatFlowError(validatedArtifact.error) }], details: makeDetails("evaluate")(results, validatedArtifact.error) };
		let artifact = validatedArtifact.text;
		// The critics judge this text, not the generator's raw output: it has been
		// validated, capped, and injection-scanned on the way here. Emitted only
		// once a consumer is known — a failed check on the final iteration ends the
		// run, and nothing ever reads this artifact.
		const consumeArtifactHandoff = () => {
			const handoff = deps.handoffs.consumeResult({
				result: generated,
				contract,
				cwd: resolvedCwd(defaultCwd, generatorRef.cwd),
				scope: { stage, key: generatorKey(stage.key) },
				payload: "source",
			});
			artifact = handoff.text;
			priorArtifact = handoff.text;
			priorArtifactKey = handoff.dependencyKey;
			return handoff.error;
		};
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
				return { content: [{ type: "text", text: formatFlowError(error) }], details: makeDetails("evaluate")(results, error) };
			}
			lastCheckOk = check.ok;
			deps.recordEvent?.({
				kind: "validation",
				name: "evaluate.check_command",
				ok: check.ok,
				// The gate ran against this iteration's draft, so a revision driven by a
				// failed check can be traced back to the draft that failed it.
				scope: { stage, key: `${stage.key}.check`, dependsOn: [generatorKey(stage.key)] },
				attributes: { "flow.check.passed": check.ok, "flow.check.iteration": iteration },
			});
			if (!check.ok) {
				// The command's output crosses into the next generator's prompt, so it
				// gets the same treatment as any other feedback: capped, stripped of
				// invisible characters, and injection-scanned. A check that prints an
				// attacker-controlled file is no more trustworthy than an agent.
				const checkRaw = `## Automated check FAILED: \`${checkCommand}\`\n\n${check.output}\n\nFix the failing check before anything else — a separate critic will not run until it passes.`;
				feedbackKey = `${stage.key}.check`;
				// Only when a generator will actually read it: on the final iteration
				// the run ends here, and recording a boundary nothing crossed would
				// invent one. The same applies to the artifact that revision revises.
				if (iteration < maxIterations) {
					const artifactError = consumeArtifactHandoff();
					if (artifactError) return { content: [{ type: "text", text: formatFlowError(artifactError) }], details: makeDetails("evaluate")(results, artifactError) };
					const checkHandoff = deps.handoffs.consumeText({
						fromAgent: `checkCommand:${checkCommand}`,
						text: checkRaw,
						scope: { stage, key: `${stage.key}.check` },
					});
					if (checkHandoff.error) return { content: [{ type: "text", text: formatFlowError(checkHandoff.error) }], details: makeDetails("evaluate")(results, checkHandoff.error) };
					critique = checkHandoff.text;
					feedbackKey = checkHandoff.dependencyKey;
				} else {
					critique = deps.handoffs.prepareText(checkRaw).text;
				}
				emitLive();
				continue;
			}
		}

		// The critics below read the artifact, so the boundary is real from here on.
		const artifactError = consumeArtifactHandoff();
		if (artifactError) return { content: [{ type: "text", text: formatFlowError(artifactError) }], details: makeDetails("evaluate")(results, artifactError) };

		// 3. Critic panel (level-2 / LLM-as-judge) judges the ARTIFACT — not the
		// generator's reasoning trace. PASS requires every critic to pass.
		const checkContext = checkCommand ? `\n## Automated check (already passing)\nThe deterministic gate \`${checkCommand}\` exited 0. Judge quality and correctness beyond what that command covers.` : "";
		const evaluatorTask = [
			"## Goal / delegation contract",
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
			evaluatorRefs.map((ref, index) => ({ ref, task: evaluatorTask, scope: { key: `${stage.key}.critic-${index + 1}`, dependsOn: [priorArtifactKey!] } })),
			concurrency,
			results,
			(settled) => `Flow evaluate: ${results.length + settled} step(s) settled`,
			stage,
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
		deps.recordEvent?.({
			kind: "validation",
			name: "evaluate.panel_verdict",
			ok: allPass,
			// The verdict is the aggregate of these critics; without the links the
			// revision points at a panel that points at nothing, and the attribution
			// chain from revision back to judgement is broken in the middle.
			scope: { stage, key: `${stage.key}.panel`, dependsOn: critics.map((_unused, index) => `${stage.key}.critic-${index + 1}`) },
			attributes: {
				"flow.verdict.pass": allPass,
				"flow.verdict.critic_count": verdicts.length,
				"flow.verdict.revise_critics": verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.agent).join(","),
			},
		});
		if (allPass) {
			passed = true;
			break;
		}

		// Critique fed back = the REVISE critics' output (a handoff: clean + scan).
		const revising = verdicts.filter((verdict) => !verdict.pass);
		const critiqueRaw = revising.map((verdict, index) => `### Critic ${index + 1} (${verdict.agent})\n\n${verdict.text}`).join("\n\n---\n\n");
		// The next generator reads this combined critique, not the panel verdict:
		// the text was aggregated, capped, and injection-scanned on the way here.
		// A REVISE on the final iteration ends the run: the critique reaches the
		// caller, not another agent, so no boundary was crossed.
		if (iteration < maxIterations) {
			const critiqueHandoff = deps.handoffs.consumeText({
				fromAgent: revising.map((verdict) => verdict.agent).join(","),
				text: critiqueRaw,
				scope: { stage, key: `${stage.key}.feedback`, dependsOn: [`${stage.key}.panel`] },
			});
			if (critiqueHandoff.error) return { content: [{ type: "text", text: formatFlowError(critiqueHandoff.error) }], details: makeDetails("evaluate")(results, critiqueHandoff.error) };
			critique = critiqueHandoff.text;
			feedbackKey = critiqueHandoff.dependencyKey;
		} else {
			critique = deps.handoffs.prepareText(critiqueRaw).text;
		}
	}

	const finalArtifact = lastGenerator ? sanitizeText(resultText(lastGenerator), policy) : "(no generator output)";
	const criticLabel = evaluatorRefs.length === 1 ? evaluatorRefs[0].agent : `${evaluatorRefs.length} critics`;
	const gate = checkCommand ? ` (gate \`${checkCommand}\`: ${lastCheckOk === false ? "FAILED" : "passed"})` : "";
	const header = passed
		? `Flow evaluate: PASS after ${rounds} iteration${rounds === 1 ? "" : "s"} via ${criticLabel}${gate}.`
		: `Flow evaluate: did not pass within ${maxIterations} iteration${maxIterations === 1 ? "" : "s"}${gate} — returning the last attempt with the final critique.`;
	const warningNote = deps.handoffs.warningSummary();
	const body = passed ? finalArtifact : `## Last attempt\n\n${finalArtifact}\n\n## Final critique\n\n${critique}`;
	return {
		content: [{ type: "text", text: capModelVisibleText(`${header}${warningNote}\n\n${body}`) }],
		details: makeDetails("evaluate")(results),
	};
}
