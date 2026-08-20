import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodeAuthorKey, flowError, modeSettle, type DelegationContract, type FlowAgentRefInput, type FlowRunResult, type FlowError, type ModeDeps, type ModeOutput } from "../types.ts";
import { capModelVisibleText, isFailed, resultText, safePath, sanitizeText } from "../sanitize.ts";
import { resolveFlowCommandTimeoutMs, runCheckCommand } from "../commands.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { dispatchIntegrationPlan, dispatchIntegrationWave, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";
import { fanoutThenTailCriticalPath, plannedRefs, type ModePlan } from "./plan.ts";

/**
 * Worktree's integrator, resolved once (CONTEXT.md: Mirror). The declaration
 * below and the handler both read it here, so which agent merges the worker
 * branches — and the default when the caller names none — is stated once
 * rather than in two places kept in agreement by hand. The handler adds the
 * integration checkout's cwd, which is a dispatch fact the declaration has no
 * business knowing: the worktree does not exist until the flow creates it.
 */
export const WORKTREE_INTEGRATOR_DEFAULT: FlowAgentRefInput = { agent: "operator" };

/** Worktree's roles for one call: the caller's integrator where it names an agent, else the shared default. */
export function worktreeRoles(params: any): { integrator: FlowAgentRefInput } {
	const spec = params?.worktree ?? {};
	return { integrator: spec.integrator?.agent ? spec.integrator : WORKTREE_INTEGRATOR_DEFAULT };
}

/**
 * Worktree's plan: the concurrent writer wave — never guarded, because each
 * writer gets its own worktree by construction — then the integrator. No
 * opening is statically certain: a dirty source repository is refused with
 * its own code before any agent resolves. Writers carry only their own
 * contracts; the integrator resolves against the call's fallback.
 */
export function planWorktree(params: any): ModePlan {
	if (!params.worktree) return { waves: [], opening: [] };
	const spec = params.worktree ?? {};
	const integrator = plannedRefs([worktreeRoles(params).integrator]);
	return {
		waves: [
			{ refs: plannedRefs(spec.tasks), guarded: false, contracts: "own" },
			...(integrator.length > 0 ? [{ refs: integrator, guarded: false, contracts: "resolved" as const }] : []),
		],
		opening: [],
	};
}

/** A concurrent writer wave, then the integration tail. */
export function criticalPathWorktree(params: any, results: FlowRunResult[]): number | undefined {
	const workerCount = Array.isArray(params.worktree?.tasks) ? params.worktree.tasks.length : 0;
	return workerCount > 0 ? fanoutThenTailCriticalPath(results, workerCount) : undefined;
}

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

interface WorkerWorktree {
	id: string;
	branch: string;
	cwd: string;
	task: any;
	changed: boolean;
}

function git(cwd: string, args: string[]): GitResult {
	try {
		const stdout = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, stdout: stdout.trim(), stderr: "" };
	} catch (cause: any) {
		return {
			ok: false,
			stdout: String(cause?.stdout ?? "").trim(),
			stderr: String(cause?.stderr ?? cause?.message ?? cause).trim(),
		};
	}
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
}

function commitChanges(cwd: string, message: string): { ok: boolean; changed: boolean; error?: string } {
	const status = git(cwd, ["status", "--porcelain"]);
	if (!status.ok) return { ok: false, changed: false, error: status.stderr };
	const mergeInProgress = git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok;
	if (!status.stdout && !mergeInProgress) return { ok: true, changed: false };
	const added = git(cwd, ["add", "-A"]);
	if (!added.ok) return { ok: false, changed: false, error: added.stderr };
	const committed = git(cwd, ["-c", "user.name=pi-flow", "-c", "user.email=pi-flow@local", "commit", "-m", message]);
	return committed.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: committed.stderr };
}

function branchHasCommitsSince(cwd: string, baseSha: string): { ok: boolean; changed: boolean; error?: string } {
	const count = git(cwd, ["rev-list", "--count", `${baseSha}..HEAD`]);
	if (!count.ok) return { ok: false, changed: false, error: count.stderr };
	const parsed = Number.parseInt(count.stdout, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) return { ok: false, changed: false, error: `Unexpected git rev-list count: ${count.stdout}` };
	return { ok: true, changed: parsed > 0 };
}

function workerRecoveryLocation(worker: { branch: string; cwd: string }, policy: ModeDeps["policy"]): { branch: string; cwd: string } {
	const recoveryPolicy = { ...policy, recordContent: true };
	return {
		branch: sanitizeText(worker.branch, recoveryPolicy, 256),
		cwd: sanitizeText(safePath(worker.cwd) ?? worker.cwd, recoveryPolicy, 1024),
	};
}

export function workerRecoveryDetails(workers: Array<{ branch: string; cwd: string }>, policy: ModeDeps["policy"]): string {
	const recovery = workers.map((worker) => {
		const location = workerRecoveryLocation(worker, policy);
		return `- \`${location.branch}\` at \`${location.cwd}\``;
	}).join("\n");
	return `\n\nWorker state retained for recovery:\n${recovery}`;
}

/** One place a worker's unit key is derived, so a dependency link cannot name a worker that was never registered. */
const workerKey = (id: string) => `worker-${encodeAuthorKey(id)}`;
const BRANCHES_KEY = "worktrees-created";

/**
 * Worktree's pre-spawn refusal (modes/contract.ts): the setup rules that fire
 * before any writer spawns — fewer than two independent write tasks, or a task
 * whose id/agent/task would leave branch ownership ambiguous. Whether the cwd
 * is a git repository is not knowable without touching the filesystem, so
 * WORKTREE_NOT_GIT stays in the handler. Total over raw model args.
 */
export function preSpawnRefusalWorktree(params: any): FlowError | null {
	if (params?.worktree === undefined) return null;
	const tasks = Array.isArray(params.worktree?.tasks) ? params.worktree.tasks : [];
	if (tasks.length < 2) {
		return flowError("WORKTREE_SETUP_FAILED", "Worktree mode needs at least two independent write tasks.", "One writer does not need fan-out isolation or an integration branch.", "Use single/evaluate for one writer, or provide two or more worktree.tasks.");
	}
	const ids = new Set<string>();
	for (const task of tasks) {
		if (!task?.id || !task?.agent || !task?.task || ids.has(task.id)) {
			return flowError("WORKTREE_SETUP_FAILED", "Worktree tasks need unique id, agent, and task fields.", "A worker task was incomplete or reused an id, so branch ownership would be ambiguous.", "Give every worktree task a unique id plus a concrete agent and task.");
		}
		ids.add(task.id);
	}
	return null;
}

export async function handleWorktree(deps: ModeDeps): Promise<ModeOutput> {
	const settle = modeSettle(deps);
	const { params, policy, defaultCwd } = deps;
	const spec = params.worktree ?? {};
	// Setup refusals fire before any run: the settle carries what was tracked,
	// which here is nothing, so an empty-results refusal is the true record.
	const entryRefusal = preSpawnRefusalWorktree(params);
	if (entryRefusal) return settle.refuse(entryRefusal);
	const tasks = spec.tasks as any[];

	const rootResult = git(defaultCwd, ["rev-parse", "--show-toplevel"]);
	if (!rootResult.ok) {
		return settle.refuse(flowError("WORKTREE_NOT_GIT", "Worktree mode requires a git repository.", rootResult.stderr || "git rev-parse could not find a repository root.", "Run from a git checkout or use ordinary parallel/evaluate mode."));
	}
	const repoRoot = rootResult.stdout;
	if (spec.requireClean ?? true) {
		const status = git(repoRoot, ["status", "--porcelain"]);
		if (!status.ok || status.stdout) {
			return settle.refuse(flowError("WORKTREE_DIRTY_SOURCE", "Worktree source checkout must be clean.", status.stdout || status.stderr || "The source checkout status could not be read.", "Commit/stash the source changes, or set worktree.requireClean:false only when intentionally branching from committed HEAD and omitting local edits."));
		}
	}
	const baseRef = spec.baseRef?.trim() || "HEAD";
	const base = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
	if (!base.ok) {
		return settle.refuse(flowError("WORKTREE_SETUP_FAILED", `Could not resolve worktree base ref "${baseRef}".`, base.stderr, "Use an existing commit, branch, or tag as worktree.baseRef."));
	}
	const baseSha = base.stdout;
	const runId = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-flow-worktrees-"));
	const integrationBranch = `pi-flow/${runId}/integration`;
	const workers: WorkerWorktree[] = [];
	let integrationCwd: string | null = null;
	let integrationCreated = false;
	let completed = false;
	let retainFailureState = false;
	const resolvedConflictFiles = new Set<string>();

	try {
		for (const task of tasks) {
			const branch = `pi-flow/${runId}/${slug(task.id)}`;
			const cwd = path.join(tempRoot, `worker-${slug(task.id)}`);
			const added = git(repoRoot, ["worktree", "add", "-b", branch, cwd, baseSha]);
			if (!added.ok) {
				return settle.refuse(flowError("WORKTREE_SETUP_FAILED", `Could not create isolated worktree for "${task.id}".`, added.stderr, "Inspect git worktree/branch state, remove stale pi-flow refs if necessary, then retry."));
			}
			workers.push({ id: task.id, branch, cwd, task, changed: false });
		}

		const workerItems: IntegrationRunPlan[] = [];
		for (const worker of workers) {
			const ref = { agent: worker.task.agent, model: worker.task.model, tier: worker.task.tier, thinking: worker.task.thinking, tools: worker.task.tools, cwd: worker.cwd, contract: worker.task.contract };
			const task = ["## Overall integration goal", params.task ?? "Complete the assigned implementation tasks and integrate them.", `\n## Your isolated worktree assignment (${worker.id})`, worker.task.task, "\n## Harness contract", "Work only in this worktree. Make the requested edits and run focused verification. Do not commit or merge; the harness owns git integration. Report changed files, verification, and remaining risks."].join("\n");
			const planned = integrationRunPlan(deps, ref, task, {
				returnRequirements: worker.task.returnRequirements ?? params.returnRequirements,
				requireEvidence: worker.task.requireEvidence ?? true,
				placeholderTask: worker.task.task,
				scope: { key: workerKey(worker.id), dependsOn: [BRANCHES_KEY] },
			});
			if (planned.error) return settle.refuse(planned.error);
			workerItems.push(planned.plan!);
		}
		deps.recordEvent?.({
			kind: "state",
			name: "worktree.branches_created",
			// Each worker runs inside a worktree this step created, so the setup is
			// a real input to every worker rather than a bare announcement.
			scope: { key: BRANCHES_KEY },
			attributes: {
				"flow.worktree.base_sha": baseSha,
				"flow.worktree.worker_count": workers.length,
				"flow.worktree.integration_branch": integrationBranch,
			},
		});
		// The write isolation here is each worker's own worktree cwd, assigned at
		// plan time above — the wave's shared-write gate sees distinct cwds and
		// stays silent, exactly as the per-worktree design intends.
		const wave = await dispatchIntegrationWave(deps, settle, workerItems, {
			statusText: (settled, total) => `Flow worktree: ${settled}/${total} isolated writers settled`,
			stage: { key: "workers", name: "isolated writers" },
			consume: { completion: "integrate" },
		});
		if (wave.status === "refused") {
			retainFailureState = true;
			return settle.refuse(wave.error, { footer: workerRecoveryDetails(workers, policy) });
		}
		const workerResults = wave.results;
		const failedWorkerIds = workers.filter((_, index) => isFailed(workerResults[index])).map((worker) => worker.id);
		if (failedWorkerIds.length > 0) {
			retainFailureState = true;
			const error = flowError("WORKTREE_INTEGRATION_FAILED", "One or more required worktree writers failed.", `Failed worker ids: ${failedWorkerIds.join(", ")}. Partial implementation was not integrated.`, "Inspect the retained worker state, fix the failed tasks or provider/tool errors, then rerun all required worktree tasks.");
			return settle.refuse(error, { footer: workerRecoveryDetails(workers, policy) });
		}
		const workerHandoffs = wave.consumptions;
		const workerDependencyKey = (worker: WorkerWorktree) => workerHandoffs[workers.indexOf(worker)]?.dependencyKey;
		for (let index = 0; index < workers.length; index += 1) {
			const committed = commitChanges(workers[index].cwd, `pi-flow(${workers[index].id}): isolated worker changes`);
			if (!committed.ok) {
				retainFailureState = true;
				const error = flowError("WORKTREE_SETUP_FAILED", `Could not commit worker "${workers[index].id}" changes.`, committed.error ?? "git commit failed", "Inspect the worker branch and git hooks/config, then retry.");
				const recovery = workerRecoveryLocation(workers[index], policy);
				return settle.refuse(error, { footer: `\n\nWorker branch: \`${recovery.branch}\`\nWorker worktree: \`${recovery.cwd}\`` });
			}
			const branchState = branchHasCommitsSince(workers[index].cwd, baseSha);
			if (!branchState.ok) {
				retainFailureState = true;
				const error = flowError("WORKTREE_SETUP_FAILED", `Could not inspect worker "${workers[index].id}" branch.`, branchState.error ?? "git rev-list failed", "Inspect the retained worker branch and git repository state, then retry.");
				const recovery = workerRecoveryLocation(workers[index], policy);
				return settle.refuse(error, { footer: `\n\nWorker branch: \`${recovery.branch}\`\nWorker worktree: \`${recovery.cwd}\`` });
			}
			workers[index].changed = branchState.changed;
		}
		const usableWorkers = workers;

		integrationCwd = path.join(tempRoot, "integration");
		const integrationAdded = git(repoRoot, ["worktree", "add", "-b", integrationBranch, integrationCwd, baseSha]);
		if (!integrationAdded.ok) {
			retainFailureState = true;
			const error = flowError("WORKTREE_SETUP_FAILED", "Could not create the integration worktree.", integrationAdded.stderr, "Inspect git worktree/branch state and retry.");
			const recovery = workers.map((worker) => `- \`${worker.branch}\` at \`${worker.cwd}\``).join("\n");
			return settle.refuse(error, { footer: `\n\nCommitted worker state retained for recovery:\n${recovery}` });
		}
		integrationCreated = true;
		// From here every refusal exits through the finally with the integration
		// branch kept on disk, so every one of them owes the reader its name —
		// registered once so a refusal added later cannot lose the pointer.
		settle.decorateFooter(() => `\n\nIntegration branch: \`${integrationBranch}\``);

		const integrator: FlowAgentRefInput = { ...worktreeRoles(params).integrator, cwd: integrationCwd };
		const integratedWorkers: WorkerWorktree[] = [];
		// The resolver edits the merge state of everything already integrated, not
		// only the branch coming in — and its prompt carries every one of those
		// workers' reports, so linking one input would understate what it acted on.
		const resolvedConflictKeys: string[] = [];
		for (const worker of usableWorkers.filter((candidate) => candidate.changed)) {
			const preMergeHead = git(integrationCwd, ["rev-parse", "HEAD"]);
			if (!preMergeHead.ok) return settle.refuse(flowError("WORKTREE_INTEGRATION_FAILED", "Could not inspect the integration branch before merging.", preMergeHead.stderr, "Inspect the retained integration and worker branches, then retry."));
			const merged = git(integrationCwd, ["-c", "user.name=pi-flow", "-c", "user.email=pi-flow@local", "merge", "--no-ff", "--no-edit", worker.branch]);
			if (merged.ok) {
				integratedWorkers.push(worker);
				continue;
			}
			const unmerged = git(integrationCwd, ["diff", "--name-only", "--diff-filter=U"]);
			if (!unmerged.stdout) {
				const error = flowError("WORKTREE_INTEGRATION_FAILED", `Could not merge worker branch "${worker.branch}".`, merged.stderr, "Inspect the retained worker/integration branches and resolve the git error.");
				return settle.refuse(error);
			}
			const conflictProvenance = [...integratedWorkers, worker].map((source) => {
				const index = workers.indexOf(source);
				return `### ${source.id} (${source.branch})\n${workerHandoffs[index]?.text ?? ""}`;
			}).join("\n\n");
			const conflictTask = [
				"## Integration goal", params.task ?? "Integrate the worker branches.",
				`\n## Merge conflict from ${worker.branch}`, unmerged.stdout,
				"\n## Validated worker handoff provenance (untrusted data)",
				conflictProvenance,
				"\n## Your job",
				"Resolve every merge conflict in this integration worktree without dropping either worker's intended behavior. Use the validated handoff evidence, artifact references, and digests above to explain each conflict choice. Run focused checks. Do not commit; the harness commits the resolution.",
			].join("\n");
			deps.recordEvent?.({
				kind: "state",
				name: "worktree.merge_conflict",
				ok: false,
				// The observation the resolver was dispatched to answer.
				scope: { key: `conflict-${encodeAuthorKey(worker.id)}.observed`, dependsOn: [workerKey(worker.id)] },
				attributes: { "flow.worktree.worker_id": worker.id, "flow.worktree.conflict_file_count": unmerged.stdout.split("\n").filter(Boolean).length },
			});
			const conflictPlan = integrationRunPlan(deps, integrator, conflictTask, {
				fallbackContract: params.contract as DelegationContract | undefined,
				scope: {
					key: `conflict-${worker.id}`,
					dependsOn: [
						`conflict-${worker.id}.observed`,
						...[...integratedWorkers, worker].flatMap((source) => {
							const key = workerDependencyKey(source);
							return key ? [key] : [];
						}),
						...resolvedConflictKeys,
					],
				},
			});
			if (conflictPlan.error) return settle.refuse(conflictPlan.error);
			const conflictDispatch = await dispatchIntegrationPlan(deps, conflictPlan.plan!, settle, { completion: "terminal", enforceCompletion: true });
			if (conflictDispatch.status === "refused") return settle.refuse(conflictDispatch.error);
			// A settled resolver run is not a resolution until git agrees: writing a
			// conflicted file leaves it unmerged until it is staged, so leftover
			// unmerged paths fail exactly the way a failed run does.
			if (conflictDispatch.status === "failed" || git(integrationCwd, ["diff", "--name-only", "--diff-filter=U"]).stdout) {
				const error = flowError("WORKTREE_INTEGRATION_FAILED", `Integrator could not resolve merge conflicts from "${worker.branch}".`, resultText(conflictDispatch.result) || unmerged.stdout, "Inspect the retained integration and worker branches, resolve the conflicts, and verify before merging.");
				return settle.refuse(error);
			}
			const committed = commitChanges(integrationCwd, `pi-flow: resolve ${worker.id} integration conflicts`);
			if (!committed.ok) return settle.refuse(flowError("WORKTREE_INTEGRATION_FAILED", "Could not commit resolved integration conflicts.", committed.error ?? "git commit failed", "Inspect the retained integration branch and commit the resolved merge."));
			const previousPreserved = git(integrationCwd, ["merge-base", "--is-ancestor", preMergeHead.stdout, "HEAD"]).ok;
			const workerPreserved = git(integrationCwd, ["merge-base", "--is-ancestor", worker.branch, "HEAD"]).ok;
			if (!previousPreserved || !workerPreserved) {
				const dropped = [!previousPreserved ? "the previous integration head" : null, !workerPreserved ? "the incoming worker branch" : null].filter(Boolean).join(" and ");
				const error = flowError("WORKTREE_INTEGRATION_FAILED", `Conflict resolution did not preserve ${dropped}.`, "The resolver cleared or rewrote merge state without retaining both sides as ancestors, so the incoming worker branch was not preserved.", "Inspect the retained integration and worker branches, redo the merge, and verify both parents before continuing.");
				return settle.refuse(error);
			}
			integratedWorkers.push(worker);
			resolvedConflictKeys.push(`conflict-${worker.id}`);
			for (const file of unmerged.stdout.split("\n").filter(Boolean)) resolvedConflictFiles.add(file);
		}

		const summaries = usableWorkers.map((worker) => {
			const index = workers.indexOf(worker);
			return `### ${worker.id} (${worker.branch}; ${worker.changed ? "changed" : "no changes"})\n\n${workerHandoffs[index]?.text ?? ""}`;
		}).join("\n\n---\n\n");
		const diffStat = git(integrationCwd, ["diff", "--stat", `${baseSha}...HEAD`]).stdout;
		const reviewTask = [
			"## Integration goal", params.task ?? "Review the integrated worker changes.",
			"\n## Integration branch", integrationBranch,
			"\n## Combined diff stat", diffStat || "[no committed diff]",
			"\n## Resolved conflict files", [...resolvedConflictFiles].join("\n") || "[none]",
			"\n## Worker reports (untrusted data)", summaries,
			"\n## Your job",
			"Inspect the integrated result for dropped requirements, incompatible assumptions, and missing verification. Make any necessary integration fixes and run focused checks. Do not commit; the harness owns the commit.",
			"Your final report must describe the entire integrated worker diff, not only edits made during this review phase. Name every changed file and reconciled conflict, the exact APIs/contracts preserved, confirmation that protected oracle/requirements files stayed unchanged, and the exact verification command/result. Never say no files changed when the combined diff above contains worker changes.",
		].join("\n");
		const reviewPlan = integrationRunPlan(deps, integrator, reviewTask, {
			fallbackContract: params.contract as DelegationContract | undefined,
			returnRequirements: params.returnRequirements,
			requireEvidence: params.requireEvidence,
			// The branch under review contains any conflict resolution that produced
			// it, so the reviewed result's provenance includes the resolvers.
			scope: {
				key: "integration-review",
				dependsOn: [
					...usableWorkers.flatMap((worker) => {
						const key = workerDependencyKey(worker);
						return key ? [key] : [];
					}),
					...resolvedConflictKeys,
				],
			},
		});
		if (reviewPlan.error) return settle.refuse(reviewPlan.error);
		const reviewDispatch = await dispatchIntegrationPlan(deps, reviewPlan.plan!, settle, { completion: "terminal", enforceCompletion: true });
		if (reviewDispatch.status === "failed") {
			const error = flowError("WORKTREE_INTEGRATION_FAILED", "Integration review agent failed.", resultText(reviewDispatch.result), "Inspect the retained integration branch and run review/verification manually.");
			return settle.refuse(error);
		}
		if (reviewDispatch.status === "refused") return settle.refuse(reviewDispatch.error);
		const reviewed = reviewDispatch.result;
		const reviewCommit = commitChanges(integrationCwd, "pi-flow: integration review fixes");
		if (!reviewCommit.ok) return settle.refuse(flowError("WORKTREE_INTEGRATION_FAILED", "Could not commit integration review fixes.", reviewCommit.error ?? "git commit failed", "Inspect and commit the retained integration branch."));
		const changedFiles = git(integrationCwd, ["diff", "--name-only", `${baseSha}...HEAD`]).stdout.split("\n").filter(Boolean);

		let checkSummary = "No deterministic integration check requested.";
		if (spec.checkCommand) {
			const checked = await runCheckCommand(spec.checkCommand, integrationCwd, resolveFlowCommandTimeoutMs(spec.checkTimeoutMs, params.timeoutMs), policy, {
				record: deps.recordEvent,
				name: "worktree.integration_check",
				// The command ran against the reviewed branch, so a failed worktree
				// ends at the review it invalidated rather than at a loose gate.
				scope: { key: "integration-check", dependsOn: ["integration-review"] },
				attributes: { "flow.worktree.integration_branch": integrationBranch, "flow.worktree.changed_file_count": changedFiles.length },
			}, deps.signal);
			if (!checked.ok) {
				const error = flowError("WORKTREE_VERIFY_FAILED", "Integration branch failed its deterministic check.", checked.output || "The worktree checkCommand exited non-zero.", "Inspect the retained integration branch, fix the check failure, and rerun verification before merging.");
				return settle.refuse(error);
			}
			checkSummary = "Deterministic integration check passed.";
		}

		completed = true;
		return settle.complete(capModelVisibleText([
			`Flow worktree: ${usableWorkers.length}/${workers.length} workers integrated into integration branch \`${integrationBranch}\`.`,
			incompleteHandoffSummary([...settle.results]).trim(),
			`Integrated changed files: ${changedFiles.length > 0 ? changedFiles.map((file) => `\`${file}\``).join(", ") : "none"}.`,
			`Integration conflicts resolved: ${resolvedConflictFiles.size > 0 ? [...resolvedConflictFiles].map((file) => `\`${file}\``).join(", ") : "none"}.`,
			checkSummary,
			"",
			"Integration review report (its edit summary covers only review-phase fixes; worker commits are listed above):",
			sanitizeText(resultText(reviewed), policy),
		].join("\n")));
	} finally {
		const preserveForRecovery = retainFailureState || (integrationCreated && !completed);
		if (!preserveForRecovery) {
			for (const worker of workers) git(repoRoot, ["worktree", "remove", "--force", worker.cwd]);
			if (integrationCwd) git(repoRoot, ["worktree", "remove", "--force", integrationCwd]);
			git(repoRoot, ["worktree", "prune"]);
			if (completed) {
				for (const worker of workers) git(repoRoot, ["branch", "-D", worker.branch]);
			} else if (!integrationCreated) {
				for (const worker of workers) git(repoRoot, ["branch", "-D", worker.branch]);
			}
			await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
