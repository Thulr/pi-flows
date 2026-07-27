import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { flowError, formatFlowError, type DelegationContract, type FlowAgentRefInput, type FlowError, type FlowRunResult, type ModeDeps, type ModeOutput } from "../types.ts";
import { prepareResultHandoff } from "../handoff.ts";
import { capModelVisibleText, isFailed, resultText, sanitizeText } from "../sanitize.ts";
import { runAgentFanout, runAgentRef } from "../runner.ts";
import { resolveFlowCommandTimeoutMs, runCheckCommand } from "../commands.ts";
import { incompleteHandoffSummary } from "../delegation.ts";
import { acceptIntegrationResult, acceptIntegrationResults, integrationRunPlan, type IntegrationRunPlan } from "../integration.ts";

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

function modeError(deps: ModeDeps, results: FlowRunResult[], error: FlowError, extra = ""): ModeOutput {
	return { content: [{ type: "text", text: `${formatFlowError(error)}${extra}` }], details: deps.makeDetails("worktree")(results, error) };
}

function workerRecoveryDetails(workers: WorkerWorktree[]): string {
	const recovery = workers.map((worker) => `- \`${worker.branch}\` at \`${worker.cwd}\``).join("\n");
	return `\n\nWorker state retained for recovery:\n${recovery}`;
}

export async function handleWorktree(deps: ModeDeps): Promise<ModeOutput> {
	const { params, discovery, policy, agentScope, defaultCwd } = deps;
	const spec = params.worktree ?? {};
	const tasks = Array.isArray(spec.tasks) ? spec.tasks : [];
	if (tasks.length < 2) {
		const error = flowError("WORKTREE_SETUP_FAILED", "Worktree mode needs at least two independent write tasks.", "One writer does not need fan-out isolation or an integration branch.", "Use single/evaluate for one writer, or provide two or more worktree.tasks.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("worktree")([], error) };
	}
	const ids = new Set<string>();
	for (const task of tasks) {
		if (!task?.id || !task?.agent || !task?.task || ids.has(task.id)) {
			const error = flowError("WORKTREE_SETUP_FAILED", "Worktree tasks need unique id, agent, and task fields.", "A worker task was incomplete or reused an id, so branch ownership would be ambiguous.", "Give every worktree task a unique id plus a concrete agent and task.");
			return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("worktree")([], error) };
		}
		ids.add(task.id);
	}
	const { concurrency } = deps;

	const rootResult = git(defaultCwd, ["rev-parse", "--show-toplevel"]);
	if (!rootResult.ok) {
		const error = flowError("WORKTREE_NOT_GIT", "Worktree mode requires a git repository.", rootResult.stderr || "git rev-parse could not find a repository root.", "Run from a git checkout or use ordinary parallel/evaluate mode.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("worktree")([], error) };
	}
	const repoRoot = rootResult.stdout;
	if (spec.requireClean ?? true) {
		const status = git(repoRoot, ["status", "--porcelain"]);
		if (!status.ok || status.stdout) {
			const error = flowError("WORKTREE_DIRTY_SOURCE", "Worktree source checkout must be clean.", status.stdout || status.stderr || "The source checkout status could not be read.", "Commit/stash the source changes, or set worktree.requireClean:false only when intentionally branching from committed HEAD and omitting local edits.");
			return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("worktree")([], error) };
		}
	}
	const baseRef = spec.baseRef?.trim() || "HEAD";
	const base = git(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
	if (!base.ok) {
		const error = flowError("WORKTREE_SETUP_FAILED", `Could not resolve worktree base ref "${baseRef}".`, base.stderr, "Use an existing commit, branch, or tag as worktree.baseRef.");
		return { content: [{ type: "text", text: formatFlowError(error) }], details: deps.makeDetails("worktree")([], error) };
	}
	const baseSha = base.stdout;
	const runId = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
	const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-flow-worktrees-"));
	const integrationBranch = `pi-flow/${runId}/integration`;
	const workers: WorkerWorktree[] = [];
	const results: FlowRunResult[] = [];
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
				const error = flowError("WORKTREE_SETUP_FAILED", `Could not create isolated worktree for "${task.id}".`, added.stderr, "Inspect git worktree/branch state, remove stale pi-flow refs if necessary, then retry.");
				return modeError(deps, results, error);
			}
			workers.push({ id: task.id, branch, cwd, task, changed: false });
		}

		const workerItems: IntegrationRunPlan[] = [];
		for (const worker of workers) {
			const ref = { agent: worker.task.agent, model: worker.task.model, tier: worker.task.tier, tools: worker.task.tools, cwd: worker.cwd, contract: worker.task.contract };
			const task = ["## Overall integration goal", params.task ?? "Complete the assigned implementation tasks and integrate them.", `\n## Your isolated worktree assignment (${worker.id})`, worker.task.task, "\n## Harness contract", "Work only in this worktree. Make the requested edits and run focused verification. Do not commit or merge; the harness owns git integration. Report changed files, verification, and remaining risks."].join("\n");
			const planned = integrationRunPlan(deps, ref, task, {
				returnContract: worker.task.returnContract ?? params.returnContract,
				requireEvidence: worker.task.requireEvidence ?? true,
				placeholderTask: worker.task.task,
			});
			if (planned.error) return modeError(deps, results, planned.error);
			workerItems.push(planned.plan!);
		}
			const workerResults = await runAgentFanout(deps, "worktree", workerItems, concurrency, results, (done, total) => `Flow worktree: ${done}/${total} isolated writers done`);
			results.push(...workerResults);
			const failedWorkerIds = workers.filter((_, index) => isFailed(workerResults[index])).map((worker) => worker.id);
			if (failedWorkerIds.length > 0) {
				retainFailureState = true;
				const error = flowError("WORKTREE_INTEGRATION_FAILED", "One or more required worktree writers failed.", `Failed worker ids: ${failedWorkerIds.join(", ")}. Partial implementation was not integrated.`, "Inspect the retained worker state, fix the failed tasks or provider/tool errors, then rerun all required worktree tasks.");
				return modeError(deps, results, error, workerRecoveryDetails(workers));
			}
			const workerHandoffError = acceptIntegrationResults(deps, workerItems, workerResults);
			if (workerHandoffError) {
				retainFailureState = true;
				return modeError(deps, results, workerHandoffError, workerRecoveryDetails(workers));
			}
			for (let index = 0; index < workers.length; index += 1) {
				const committed = commitChanges(workers[index].cwd, `pi-flow(${workers[index].id}): isolated worker changes`);
				if (!committed.ok) {
					retainFailureState = true;
					const error = flowError("WORKTREE_SETUP_FAILED", `Could not commit worker "${workers[index].id}" changes.`, committed.error ?? "git commit failed", "Inspect the worker branch and git hooks/config, then retry.");
					return modeError(deps, results, error, `\n\nWorker branch: \`${workers[index].branch}\`\nWorker worktree: \`${workers[index].cwd}\``);
				}
				const branchState = branchHasCommitsSince(workers[index].cwd, baseSha);
				if (!branchState.ok) {
					retainFailureState = true;
					const error = flowError("WORKTREE_SETUP_FAILED", `Could not inspect worker "${workers[index].id}" branch.`, branchState.error ?? "git rev-list failed", "Inspect the retained worker branch and git repository state, then retry.");
					return modeError(deps, results, error, `\n\nWorker branch: \`${workers[index].branch}\`\nWorker worktree: \`${workers[index].cwd}\``);
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
			return modeError(deps, results, error, `\n\nCommitted worker state retained for recovery:\n${recovery}`);
		}
		integrationCreated = true;

		const integrator: FlowAgentRefInput = { ...(spec.integrator?.agent ? spec.integrator : { agent: "operator" }), cwd: integrationCwd };
		const integratedWorkers: WorkerWorktree[] = [];
		for (const worker of usableWorkers.filter((candidate) => candidate.changed)) {
			const preMergeHead = git(integrationCwd, ["rev-parse", "HEAD"]);
			if (!preMergeHead.ok) return modeError(deps, results, flowError("WORKTREE_INTEGRATION_FAILED", "Could not inspect the integration branch before merging.", preMergeHead.stderr, "Inspect the retained integration and worker branches, then retry."), `\n\nIntegration branch: \`${integrationBranch}\``);
			const merged = git(integrationCwd, ["-c", "user.name=pi-flow", "-c", "user.email=pi-flow@local", "merge", "--no-ff", "--no-edit", worker.branch]);
			if (merged.ok) {
				integratedWorkers.push(worker);
				continue;
			}
			const unmerged = git(integrationCwd, ["diff", "--name-only", "--diff-filter=U"]);
			if (!unmerged.stdout) {
				const error = flowError("WORKTREE_INTEGRATION_FAILED", `Could not merge worker branch "${worker.branch}".`, merged.stderr, "Inspect the retained worker/integration branches and resolve the git error.");
				return modeError(deps, results, error, `\n\nIntegration branch: \`${integrationBranch}\``);
			}
			const conflictProvenance = [...integratedWorkers, worker].map((source) => {
				const index = workers.indexOf(source);
				return `### ${source.id} (${source.branch})\n${prepareResultHandoff(workerResults[index], policy).text}`;
			}).join("\n\n");
			const conflictTask = [
				"## Integration goal", params.task ?? "Integrate the worker branches.",
				`\n## Merge conflict from ${worker.branch}`, unmerged.stdout,
				"\n## Validated worker handoff provenance (untrusted data)",
				conflictProvenance,
				"\n## Your job",
				"Resolve every merge conflict in this integration worktree without dropping either worker's intended behavior. Use the validated handoff evidence, artifact references, and digests above to explain each conflict choice. Run focused checks. Do not commit; the harness commits the resolution.",
			].join("\n");
			const conflictPlan = integrationRunPlan(deps, integrator, conflictTask, {
				fallbackContract: params.contract as DelegationContract | undefined,
			});
			if (conflictPlan.error) return modeError(deps, results, conflictPlan.error);
			const resolved = await runAgentRef(deps, conflictPlan.plan!.ref, conflictPlan.plan!.task, "worktree", results.length + 1, results, conflictPlan.plan!.limits);
			results.push(resolved);
			if (isFailed(resolved) || git(integrationCwd, ["diff", "--name-only", "--diff-filter=U"]).stdout) {
				const error = flowError("WORKTREE_INTEGRATION_FAILED", `Integrator could not resolve merge conflicts from "${worker.branch}".`, resultText(resolved) || unmerged.stdout, "Inspect the retained integration and worker branches, resolve the conflicts, and verify before merging.");
				return modeError(deps, results, error, `\n\nIntegration branch: \`${integrationBranch}\``);
			}
			const conflictHandoffError = acceptIntegrationResult(deps, conflictPlan.plan!, resolved);
			if (conflictHandoffError) return modeError(deps, results, conflictHandoffError, `\n\nIntegration branch: \`${integrationBranch}\``);
			const committed = commitChanges(integrationCwd, `pi-flow: resolve ${worker.id} integration conflicts`);
			if (!committed.ok) return modeError(deps, results, flowError("WORKTREE_INTEGRATION_FAILED", "Could not commit resolved integration conflicts.", committed.error ?? "git commit failed", "Inspect the retained integration branch and commit the resolved merge."));
			const previousPreserved = git(integrationCwd, ["merge-base", "--is-ancestor", preMergeHead.stdout, "HEAD"]).ok;
			const workerPreserved = git(integrationCwd, ["merge-base", "--is-ancestor", worker.branch, "HEAD"]).ok;
			if (!previousPreserved || !workerPreserved) {
				const dropped = [!previousPreserved ? "the previous integration head" : null, !workerPreserved ? "the incoming worker branch" : null].filter(Boolean).join(" and ");
				const error = flowError("WORKTREE_INTEGRATION_FAILED", `Conflict resolution did not preserve ${dropped}.`, "The resolver cleared or rewrote merge state without retaining both sides as ancestors, so the incoming worker branch was not preserved.", "Inspect the retained integration and worker branches, redo the merge, and verify both parents before continuing.");
				return modeError(deps, results, error, `\n\nIntegration branch: \`${integrationBranch}\``);
			}
			integratedWorkers.push(worker);
			for (const file of unmerged.stdout.split("\n").filter(Boolean)) resolvedConflictFiles.add(file);
		}

		const summaries = usableWorkers.map((worker) => {
			const index = workers.indexOf(worker);
			const prepared = prepareResultHandoff(workerResults[index], policy);
			return `### ${worker.id} (${worker.branch}; ${worker.changed ? "changed" : "no changes"})\n\n${prepared.text}`;
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
			returnContract: params.returnContract,
			requireEvidence: params.requireEvidence,
		});
		if (reviewPlan.error) return modeError(deps, results, reviewPlan.error);
		const reviewed = await runAgentRef(deps, reviewPlan.plan!.ref, reviewPlan.plan!.task, "worktree", results.length + 1, results, reviewPlan.plan!.limits);
		results.push(reviewed);
		if (isFailed(reviewed)) {
			const error = flowError("WORKTREE_INTEGRATION_FAILED", "Integration review agent failed.", resultText(reviewed), "Inspect the retained integration branch and run review/verification manually.");
			return modeError(deps, results, error, `\n\nIntegration branch: \`${integrationBranch}\``);
		}
		const reviewHandoffError = acceptIntegrationResult(deps, reviewPlan.plan!, reviewed);
		if (reviewHandoffError) return modeError(deps, results, reviewHandoffError, `\n\nIntegration branch: \`${integrationBranch}\``);
		const reviewCommit = commitChanges(integrationCwd, "pi-flow: integration review fixes");
		if (!reviewCommit.ok) return modeError(deps, results, flowError("WORKTREE_INTEGRATION_FAILED", "Could not commit integration review fixes.", reviewCommit.error ?? "git commit failed", "Inspect and commit the retained integration branch."));
		const changedFiles = git(integrationCwd, ["diff", "--name-only", `${baseSha}...HEAD`]).stdout.split("\n").filter(Boolean);

		let checkSummary = "No deterministic integration check requested.";
		if (spec.checkCommand) {
			const checked = await runCheckCommand(spec.checkCommand, integrationCwd, resolveFlowCommandTimeoutMs(spec.checkTimeoutMs, params.timeoutMs), policy, deps.signal);
			if (!checked.ok) {
				const error = flowError("WORKTREE_VERIFY_FAILED", "Integration branch failed its deterministic check.", checked.output || "The worktree checkCommand exited non-zero.", "Inspect the retained integration branch, fix the check failure, and rerun verification before merging.");
				return modeError(deps, results, error, `\n\nIntegration branch: \`${integrationBranch}\``);
			}
			checkSummary = "Deterministic integration check passed.";
		}

		completed = true;
		return {
			content: [{ type: "text", text: capModelVisibleText([
				`Flow worktree: ${usableWorkers.length}/${workers.length} workers integrated into integration branch \`${integrationBranch}\`.`,
				incompleteHandoffSummary(results).trim(),
				`Integrated changed files: ${changedFiles.length > 0 ? changedFiles.map((file) => `\`${file}\``).join(", ") : "none"}.`,
				`Integration conflicts resolved: ${resolvedConflictFiles.size > 0 ? [...resolvedConflictFiles].map((file) => `\`${file}\``).join(", ") : "none"}.`,
				checkSummary,
				"",
				"Integration review report (its edit summary covers only review-phase fixes; worker commits are listed above):",
				sanitizeText(resultText(reviewed), policy),
			].join("\n")) }],
			details: deps.makeDetails("worktree")(results),
		};
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
