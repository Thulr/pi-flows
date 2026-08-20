import { DEFAULT_CHECK_COMMAND_TIMEOUT_MS, MAX_PARALLEL_TASKS, flowError, modeSettle, type DelegationContract, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { appendReturnRequirements, clampIterations, normalizeTimeout, validateSharedWriteCwd } from "../validate.ts";
import { ResolvedDelegationContract, canonicalEnvelope, integrationControl } from "../delegation.ts";
import { parseVerdict, verdictProtocolInstruction } from "../protocol.ts";
import { runCheckCommand } from "../commands.ts";
import { consumeIntegrationResult, dispatchIntegrationPlan, dispatchIntegrationWave, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { plannedRefs, sumRunDurations, withinFanoutCap, type ModePlan } from "./plan.ts";

/**
 * Evaluate's roles, resolved once (CONTEXT.md: Mirror). The declaration below
 * and the handler both read their refs here, so which agent generates and which
 * critics judge — and the defaults when the caller names none — are stated once
 * rather than in two places kept in agreement by hand.
 *
 * The critic list normalizes a single ref and a panel to one array, because
 * both readers then apply the same fan-out cap to it. What they do with a list
 * that names no usable critic still differs by design: the declaration answers
 * for arbitrary params and declares the wave it would guard, while the handler
 * substitutes the default so a call always has someone to judge it.
 */
export const EVALUATE_ROLE_DEFAULTS = {
	operator: Object.freeze({ agent: "operator" }),
	critic: Object.freeze({ agent: "redteam" }),
} as const satisfies Record<string, FlowAgentRefInput>;

/** Evaluate's roles for one call: the generator, and the critic panel normalized to a list. */
export function evaluateRoles(params: any): { operator: FlowAgentRefInput; critics: FlowAgentRefInput[] } {
	const spec = params?.evaluate ?? {};
	return {
		operator: spec.operator ?? EVALUATE_ROLE_DEFAULTS.operator,
		critics: Array.isArray(spec.redteam) ? spec.redteam : [spec.redteam ?? EVALUATE_ROLE_DEFAULTS.critic],
	};
}

/**
 * Evaluate's plan: the generator wave first (it spawns before any critic and
 * is never guard-checked), then the critic panel — normalized exactly as the
 * handler normalizes it, including the one-redteam default when the panel is
 * empty or unusable. An over-cap explicit panel is schema-refused before the
 * guard, so its wave stays declared but unguarded, listing every named critic.
 */
export function planEvaluate(params: any): ModePlan {
	if (!params.evaluate) return { waves: [], opening: [] };
	const spec = params.evaluate ?? {};
	const roles = evaluateRoles(params);
	const operator = plannedRefs([roles.operator]);
	const guarded = withinFanoutCap(spec.redteam);
	const panel = plannedRefs(roles.critics).slice(0, MAX_PARALLEL_TASKS);
	const critics = guarded ? (panel.length > 0 ? panel : [EVALUATE_ROLE_DEFAULTS.critic]) : plannedRefs(roles.critics);
	return {
		waves: [
			{ refs: operator, guarded: false, contracts: "resolved" },
			{ refs: critics, guarded, contracts: "own" },
		],
		opening: operator,
	};
}

/**
 * Sequential generator→critic iterations sum; a deterministic gate's own
 * runtime is unmeasured and a multi-critic panel overlaps, so both make the
 * path underivable.
 */
export function criticalPathEvaluate(params: any, results: FlowRunResult[]): number | undefined {
	if (typeof params.evaluate?.checkCommand === "string" && params.evaluate.checkCommand.trim()) return undefined;
	return !Array.isArray(params.evaluate?.redteam) || params.evaluate.redteam.length <= 1 ? sumRunDurations(results) : undefined;
}

/** One place the generator's unit key is derived, so each critic's dependency link names the draft it judged. */
const generatorKey = (stageKey: string) => `${stageKey}.generator`;

/**
 * Evaluate's pre-spawn refusal (modes/contract.ts): no goal for the generator
 * to satisfy is refused INVALID_MODE before it spawns. A call carrying a
 * delegation contract is left to the handler: the contract may supply the
 * objective, and an invalid one is refused by its own resolution first — so
 * claiming INVALID_MODE here would name the wrong refusal. Total over raw
 * model args.
 */
export function preSpawnRefusalEvaluate(params: any): FlowError | null {
	if (params?.evaluate === undefined) return null;
	const spec = params.evaluate ?? {};
	if (spec.operator?.contract ?? params.contract) return null;
	const operatorTask = typeof spec.operator?.task === "string" ? spec.operator.task : undefined;
	const goal = params.task ?? operatorTask;
	if (typeof goal === "string" && goal.trim()) return null;
	return flowError(
		"INVALID_MODE",
		"Evaluate mode requires a task.",
		"evaluate mode needs a top-level `task` describing the goal, or a delegation contract whose objective the generator must satisfy and the evaluator must judge.",
		'Add a `task` string, e.g. { "task": "Add a /health endpoint with a test", "evaluate": {} }.',
	);
}

export async function handleEvaluate(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, discovery, policy, defaultCwd, signal, onUpdate, makeDetails } = deps;
	const spec = params.evaluate ?? {};
	const operatorWithTask = spec.operator as (FlowAgentRefInput & { task?: unknown; contract?: DelegationContract }) | undefined;
	const operatorTask = typeof operatorWithTask?.task === "string" ? operatorWithTask.task : undefined;
	const rawContract = (operatorWithTask?.contract ?? params.contract) as DelegationContract | undefined;
	const resolution = rawContract ? ResolvedDelegationContract.resolve(rawContract, policy) : {};
	if (resolution.error) return settle.refuse(resolution.error);
	const contract = resolution.resolved;
	const goal: string | undefined = params.task ?? operatorTask ?? contract?.contract.objective;

	// The declaration answers for a contract-free call; a contracted one may take
	// its objective from the contract, which only exists once resolved above.
	const entryRefusal = preSpawnRefusalEvaluate(params);
	if (entryRefusal) return settle.refuse(entryRefusal);
	if (!goal || !goal.trim()) {
		return settle.refuse(flowError(
			"INVALID_MODE",
			"Evaluate mode requires a task.",
			"evaluate mode needs a top-level `task` describing the goal, or a delegation contract whose objective the generator must satisfy and the evaluator must judge.",
			'Add a `task` string, e.g. { "task": "Add a /health endpoint with a test", "evaluate": {} }.',
		));
	}
	const evaluationGoal = contract
		? contract.reviewContext(appendReturnRequirements(goal, params.returnRequirements, params.requireEvidence))
		: appendReturnRequirements(goal, params.returnRequirements, params.requireEvidence);

	const generatorRef: FlowAgentRefInput = evaluateRoles(params).operator;
	// The critic may be a single agent or a panel (god-metric → decomposed evaluators:
	// one critic per dimension, PASS only when every critic passes). Normalize to a list.
	const evaluatorRefs: FlowAgentRefInput[] = evaluateRoles(params).critics
		.filter((ref: any): ref is FlowAgentRefInput => ref && typeof ref.agent === "string")
		.slice(0, MAX_PARALLEL_TASKS);
	if (evaluatorRefs.length === 0) evaluatorRefs.push(EVALUATE_ROLE_DEFAULTS.critic);
	const maxIterations = clampIterations(spec.maxIterations);
	const passContract: string | undefined = spec.passContract;
	const checkCommand: string | undefined = typeof spec.checkCommand === "string" && spec.checkCommand.trim() ? spec.checkCommand.trim() : undefined;
	const { concurrency } = deps;
	// The critic panel's guard runs here, before the FIRST spawn of the flow —
	// the generator — which is earlier than the critic fan-out it protects, whose
	// runWave gate is the enforced backstop. Deleting this early check would let
	// a write-capable panel refuse only after the generator had spent.
	// planEvaluate declares the wave guarded pre-spawn, and
	// tests/admissibility-scoring.test.ts pins the mirror to this position.
	const sharedWriteError = validateSharedWriteCwd(discovery, defaultCwd, evaluatorRefs, params.allowSharedWriteCwd, concurrency);
	if (sharedWriteError) return settle.refuse(sharedWriteError);
	const checkTimeoutMs = Math.min(normalizeTimeout(params.timeoutMs), DEFAULT_CHECK_COMMAND_TIMEOUT_MS);

	const emitLive = (inFlight?: FlowRunResult) => {
		onUpdate?.({
			content: [{ type: "text", text: `Flow evaluate: ${settle.results.length} step(s) settled` }],
			details: makeDetails(settle.mode)([...settle.results, ...(inFlight ? [inFlight] : [])]),
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
				? goal
				: [
						goal,
						"\n## Your previous attempt (revise it in place; do not rebuild from scratch)",
						priorArtifact,
						"\n## Reviewer feedback on that attempt (address every point)",
						critique,
					].join("\n");
		const planned = integrationRunPlan(deps, generatorRef, generatorTask, {
			fallbackContract: params.contract,
			returnRequirements: params.returnRequirements,
			requireEvidence: params.requireEvidence,
			// A revision's prompt carries the prior artifact and the feedback that
			// sent it back. Both are declared: reachability through the panel is
			// not the same as saying what this prompt actually contains.
			scope: { stage, key: generatorKey(stage.key), ...(consumed.length ? { dependsOn: consumed } : {}) },
		});
		if (planned.error) return settle.refuse(planned.error);
		const dispatched = await dispatchIntegrationPlan(deps, planned.plan!, settle, {
			completion: "terminal",
			payload: "source",
			// Consume-time scope: the pre-validation event hangs off the generator's
			// own key, without the run scope's revision links — the run consumed the
			// prior artifact and feedback; its validation did not.
			scope: { stage, key: generatorKey(stage.key) },
		});
		emitLive();
		if (dispatched.status === "failed") {
			return settle.complete(sanitizeText(`Flow evaluate stopped: generator "${generatorRef.agent}" failed at iteration ${iteration}:\n\n${resultText(dispatched.result)}`, policy));
		}
		if (dispatched.status === "refused") return dispatched.output;
		const generated = dispatched.result;
		lastGenerator = generated;
		let artifact = dispatched.handoff.text;
		// The critics judge this text, not the generator's raw output: it has been
		// validated, capped, and injection-scanned on the way here. Emitted only
		// once a consumer is known — a failed check on the final iteration ends the
		// run, and nothing ever reads this artifact.
		const consumeArtifactHandoff = () => {
			const handoff = consumeIntegrationResult(deps, planned.plan!, generated, {
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
			const check = await runCheckCommand(checkCommand, generatorRef.cwd ?? defaultCwd, checkTimeoutMs, policy, {
				record: deps.recordEvent,
				name: "evaluate.check_command",
				// The gate ran against this iteration's draft, so a revision driven by a
				// failed check can be traced back to the draft that failed it.
				scope: { stage, key: `${stage.key}.check`, dependsOn: [generatorKey(stage.key)] },
				attributes: { "flow.check.iteration": iteration },
			}, signal);
			if (check.spawnFailed) {
				const error = flowError(
					"CHECK_COMMAND_FAILED",
					`Could not run evaluate checkCommand: ${checkCommand}.`,
					`The deterministic gate command could not be started: ${check.output}.`,
					"Verify the command exists and is runnable from the cwd. A non-runnable check is a config error, not a REVISE signal.",
				);
				return settle.refuse(error);
			}
			lastCheckOk = check.ok;
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
					if (artifactError) return settle.refuse(artifactError);
					const checkHandoff = deps.handoffs.consumeText({
						fromAgent: `checkCommand:${checkCommand}`,
						text: checkRaw,
						scope: { stage, key: `${stage.key}.check` },
					});
					if (checkHandoff.error) return settle.refuse(checkHandoff.error);
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
		if (artifactError) return settle.refuse(artifactError);

		// 3. Critic panel (level-2 / LLM-as-judge) judges the ARTIFACT — not the
		// generator's reasoning trace. PASS requires every critic to pass.
		const checkContext = checkCommand ? `\n## Automated check (already passing)\nThe deterministic gate \`${checkCommand}\` exited 0. Judge quality and correctness beyond what that command covers.` : "";
		const evaluatorTask = (contracted: boolean) => [
			"## Goal / delegation contract",
			evaluationGoal,
			passContract ? `\n## Explicit acceptance criteria\n${passContract}` : "",
			checkContext,
			"\n## Artifact to evaluate (the generator's output)",
			artifact,
			"\n## Your job",
			`Judge whether the artifact satisfies the goal and acceptance criteria. ${verdictProtocolInstruction("specific, actionable critique the generator can act on", contracted)} Judge only the artifact above, not how it was produced.`,
		]
			.filter(Boolean)
			.join("\n");

		const criticPlans: IntegrationRunPlan[] = [];
		for (const [index, ref] of evaluatorRefs.entries()) {
			const planned = integrationRunPlan(deps, ref, evaluatorTask(Boolean(ref.contract)), {
				scope: { key: `${stage.key}.critic-${index + 1}`, ...(priorArtifactKey ? { dependsOn: [priorArtifactKey] } : {}) },
			});
			if (planned.error) return settle.refuse(planned.error);
			criticPlans.push(planned.plan!);
		}
		const criticWave = await dispatchIntegrationWave(
			deps,
			settle,
			criticPlans,
			{ statusText: (settled) => `Flow evaluate: ${settle.results.length + settled} step(s) settled`, stage, consume: { completion: "terminal", enforceCompletion: true, payload: "source" } },
		);
		if (criticWave.status === "refused") return criticWave.output;
		const critics = criticWave.results;
		emitLive();
		const failedCritic = critics.find((critic) => isFailed(critic));
		if (failedCritic) {
			return settle.complete(sanitizeText(`Flow evaluate stopped: critic "${failedCritic.agent}" failed at iteration ${iteration}:\n\n${resultText(failedCritic)}`, policy));
		}

		const verdicts = critics.map((critic) => ({
			agent: critic.agent,
			pass: parseVerdict(integrationControl(critic)) === "pass",
			// Preserve the validated source until the actual feedback boundary below.
			// Preparing it during terminal validation would strip injection markers
			// before consumeText can attribute its own warning evidence.
			text: critic.envelope ? canonicalEnvelope(critic.envelope) : resultText(critic),
		}));
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
			if (critiqueHandoff.error) return settle.refuse(critiqueHandoff.error);
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
	return settle.complete(capModelVisibleText(`${header}${warningNote}\n\n${body}`));
}
