import assert from "node:assert/strict";
import { realpathSync, rmSync, symlinkSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { handleWorkflow } from "../extensions/pi-flows/modes/workflow.ts";
import { runFlowAgent } from "../extensions/pi-flows/runner.ts";
import type { ModeDeps } from "../extensions/pi-flows/types.ts";
import { resolveCwdTarget } from "../extensions/pi-flows/validate.ts";
import { faultDeps, makeFaultAdapter } from "./fault-adapter.ts";
import { freshDir } from "./stub-harness.ts";

const roster = {
	available: [{ reference: "test-provider/model", provider: "test-provider", id: "model", reasoning: true, thinkingLevels: ["off", "low"], contextWindow: 100_000 }],
	source: "derived",
	issues: [],
} as any;

test("gated dispatch rechecks the cwd target after the state write", { skip: process.platform === "win32" }, async () => {
	const cwd = await freshDir();
	const approvedTarget = path.join(cwd, "approved-target");
	const changedTarget = path.join(cwd, "changed-target");
	const alias = path.join(cwd, "workspace-link");
	await mkdir(approvedTarget);
	await mkdir(changedTarget);
	await symlink(approvedTarget, alias, "dir");
	const params = {
		task: "Ship the release.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve" } },
				{ id: "ship", agent: "operator", task: "Ship", cwd: alias, model: "test-provider/model", thinking: "low" },
			],
		},
	};
	const adapter = makeFaultAdapter({ replies: { operator: "SHIPPED" } });
	const base = faultDeps(params, adapter, cwd, { roster, requestApproval: async () => "approved" });
	let dispatchedCwd: string | undefined;
	let repointed = false;
	const recordEvent: ModeDeps["recordEvent"] = (event) => {
		base.recordEvent?.(event);
		if (!repointed && event.name === "workflow.phase.started" && event.attributes?.["flow.workflow.phase_id"] === "ship") {
			rmSync(alias);
			symlinkSync(changedTarget, alias, "dir");
			repointed = true;
		}
	};
	const output = await handleWorkflow({
		...base,
		recordEvent,
		runChild: async (options) => {
			dispatchedCwd = options.cwd;
			return adapter.runChild(options);
		},
	});

	assert.equal(output.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.equal(repointed, true);
	assert.equal(realpathSync.native(alias), realpathSync.native(changedTarget));
	assert.equal(dispatchedCwd, undefined, "alias drift after the state write must refuse before dispatch");
	assert.equal(adapter.ledger.dispatches.length, 0);
});

test("gated dispatch refuses replacement of the canonical target itself", { skip: process.platform === "win32" }, async () => {
	const cwd = await freshDir();
	const approvedTarget = path.join(cwd, "approved-target");
	const changedTarget = path.join(cwd, "changed-target");
	const alias = path.join(cwd, "workspace-link");
	await mkdir(approvedTarget);
	await mkdir(changedTarget);
	await symlink(approvedTarget, alias, "dir");
	const params = {
		task: "Ship the release.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve" } },
				{ id: "ship", agent: "operator", task: "Ship", cwd: alias, model: "test-provider/model", thinking: "low" },
			],
		},
	};
	const adapter = makeFaultAdapter({ replies: { operator: "MUST NOT RUN" } });
	const base = faultDeps(params, adapter, cwd, { roster, requestApproval: async () => "approved" });
	const recordEvent: ModeDeps["recordEvent"] = (event) => {
		base.recordEvent?.(event);
		if (event.name === "workflow.phase.started" && event.attributes?.["flow.workflow.phase_id"] === "ship") {
			rmSync(approvedTarget, { recursive: true });
			symlinkSync(changedTarget, approvedTarget, "dir");
		}
	};

	const output = await handleWorkflow({ ...base, recordEvent });
	assert.equal(output.details.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.equal(adapter.ledger.dispatches.length, 0);
});

test("a trailing approval dispatches the exact debrief cwd target it verified", { skip: process.platform === "win32" }, async () => {
	const cwd = await freshDir();
	const approvedTarget = path.join(cwd, "approved-target");
	const changedTarget = path.join(cwd, "changed-target");
	const alias = path.join(cwd, "debrief-link");
	await mkdir(approvedTarget);
	await mkdir(changedTarget);
	await symlink(approvedTarget, alias, "dir");
	const params = {
		task: "Approve synthesis.",
		workflow: {
			stateFile: "workflow.json",
			phases: [{ id: "approve", approval: { message: "Approve" } }],
			debrief: { agent: "debrief", cwd: alias, model: "test-provider/model", thinking: "low" },
		},
	};
	const adapter = makeFaultAdapter({ replies: { debrief: "SUMMARY" } });
	const base = faultDeps(params, adapter, cwd, { roster, requestApproval: async () => "approved" });
	const approvedCanonical = realpathSync.native(approvedTarget);
	let dispatchedCwd: string | undefined;
	let dispatchedBinding: { path: string; identity: string } | undefined;
	const output = await handleWorkflow({
		...base,
		runChild: async (options) => {
			rmSync(alias);
			symlinkSync(changedTarget, alias, "dir");
			dispatchedCwd = options.cwd;
			dispatchedBinding = options.cwdBinding;
			return adapter.runChild(options);
		},
	});

	assert.equal(output.details.error, undefined);
	assert.equal(realpathSync.native(alias), realpathSync.native(changedTarget));
	assert.equal(dispatchedCwd, approvedCanonical, "debrief dispatch must receive the target hashed by trailing verification");
	assert.equal(dispatchedBinding?.path, approvedCanonical);
	assert.equal(typeof dispatchedBinding?.identity, "string", "the production seam must receive the approved filesystem identity");
});

test("the production runner rechecks an approved cwd identity immediately before spawn", { skip: process.platform === "win32" }, async () => {
	const cwd = await freshDir();
	const approvedTarget = path.join(cwd, "approved-target");
	const changedTarget = path.join(cwd, "changed-target");
	await mkdir(approvedTarget);
	await mkdir(changedTarget);
	const approved = resolveCwdTarget(cwd, approvedTarget);
	assert.equal(approved.bindable, true);
	assert.equal(typeof approved.identity, "string");
	let repointed = false;
	const events: string[] = [];
	const result = await runFlowAgent({
		defaultCwd: cwd,
		agents: [{ name: "operator", description: "Approval fixture.", tools: ["read"], thinking: "low", systemPrompt: "", source: "package", filePath: "/pkg/operator.md" }],
		agentName: "operator",
		task: "MUST NOT RUN",
		cwd: approved.path,
		cwdBinding: { path: approved.path, identity: approved.identity! },
		model: "test-provider/model",
		thinking: "low",
		tools: "read",
		roster,
		onUpdate: () => {
			if (repointed) return;
			rmSync(approvedTarget, { recursive: true });
			symlinkSync(changedTarget, approvedTarget, "dir");
			repointed = true;
		},
		recordEvent: (event) => { events.push(event.name); },
		makeDetails: (() => ({})) as any,
	});

	assert.equal(repointed, true);
	assert.equal(result.error?.code, "APPROVAL_RECEIPT_STALE");
	assert.ok(events.includes("dispatch.approved_cwd_stale"));
});

test("approval refuses a cwd that has no canonical target", async () => {
	const cwd = await freshDir();
	const missing = path.join(cwd, "not-created");
	const params = {
		task: "Ship the release.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve" } },
				{ id: "ship", agent: "operator", task: "Ship", cwd: missing, model: "test-provider/model", thinking: "low" },
			],
		},
	};
	const adapter = makeFaultAdapter({ replies: { operator: "MUST NOT RUN" } });
	let prompts = 0;
	const output = await handleWorkflow(faultDeps(params, adapter, cwd, {
		roster,
		requestApproval: async () => { prompts += 1; return "approved"; },
	}));

	assert.equal(output.details.error?.code, "WORKFLOW_INVALID");
	assert.match(output.details.error?.cause ?? "", /nonexistent, non-directory, unreadable, or unsearchable working directories/);
	assert.equal(prompts, 0, "unbound cwd targets are refused before asking for consent");
	assert.equal(adapter.ledger.dispatches.length, 0);
});

test("approval refuses an unreadable cwd target", { skip: process.platform === "win32" }, async () => {
	const cwd = await freshDir();
	const unreadable = path.join(cwd, "unreadable");
	await mkdir(unreadable);
	await chmod(unreadable, 0o000);
	const params = {
		task: "Ship the release.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve" } },
				{ id: "ship", agent: "operator", task: "Ship", cwd: unreadable, model: "test-provider/model", thinking: "low" },
			],
		},
	};
	const adapter = makeFaultAdapter({ replies: { operator: "MUST NOT RUN" } });
	try {
		const output = await handleWorkflow(faultDeps(params, adapter, cwd, { roster, requestApproval: async () => "approved" }));
		assert.equal(output.details.error?.code, "WORKFLOW_INVALID");
		assert.equal(adapter.ledger.dispatches.length, 0);
	} finally {
		await chmod(unreadable, 0o700);
	}
});

test("approval refuses a cwd target that is not a directory", async () => {
	const cwd = await freshDir();
	const file = path.join(cwd, "workspace-file");
	await writeFile(file, "not a directory");
	const params = {
		task: "Ship the release.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve" } },
				{ id: "ship", agent: "operator", task: "Ship", cwd: file, model: "test-provider/model", thinking: "low" },
			],
		},
	};
	const adapter = makeFaultAdapter({ replies: { operator: "MUST NOT RUN" } });
	let prompts = 0;
	const output = await handleWorkflow(faultDeps(params, adapter, cwd, {
		roster,
		requestApproval: async () => { prompts += 1; return "approved"; },
	}));

	assert.equal(output.details.error?.code, "WORKFLOW_INVALID");
	assert.equal(prompts, 0);
	assert.equal(adapter.ledger.dispatches.length, 0);
});

test("resume refuses when an approved cwd target has disappeared", { skip: process.platform === "win32" }, async () => {
	const cwd = await freshDir();
	const approvedTarget = path.join(cwd, "approved-target");
	const alias = path.join(cwd, "workspace-link");
	await mkdir(approvedTarget);
	await symlink(approvedTarget, alias, "dir");
	const params = {
		task: "Ship the release.",
		workflow: {
			stateFile: "workflow.json",
			phases: [
				{ id: "approve", approval: { message: "Approve" } },
				{ id: "ship", agent: "operator", task: "Ship", cwd: alias, model: "test-provider/model", thinking: "low" },
			],
		},
	};
	const failed = makeFaultAdapter({ replies: { operator: "boom" }, faults: [{ kind: "failure", agent: "operator" }] });
	await handleWorkflow(faultDeps(params, failed, cwd, { roster, requestApproval: async () => "approved" }));
	rmSync(approvedTarget, { recursive: true });
	const retry = makeFaultAdapter({ replies: { operator: "MUST NOT RUN" } });

	const output = await handleWorkflow(faultDeps({ ...params, workflow: { ...params.workflow, resume: true } }, retry, cwd, { roster }));
	assert.equal(output.details.error?.code, "WORKFLOW_INVALID");
	assert.equal(retry.ledger.dispatches.length, 0);
});
