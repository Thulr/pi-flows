// Pure call scoring for the tool-selection eval: given the flow calls a run
// emitted, decide what they mean — mode classification, expectation matching,
// admissibility, and the sequence predicates (first-call requirement,
// forbidden shapes, refused-call budget). No process is spawned here; the
// stream harness and CLI live in select.mjs and consume this module.
//
// The .ts imports make this module require the tsx loader (`node --import
// tsx`), which every current entrypoint already passes; do not import it from
// a bare-node script such as eval:review or eval:pareto.
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { callAdmissibilityFailure, scoringDiscovery } from "./select-admissibility.mjs";
import { effectiveTools, firstSpawnAgentRefs, isWorkflowWorkPhase } from "../extensions/pi-flows/validate.ts";

export { callAdmissibilityFailure } from "./select-admissibility.mjs";

export function parseToolArguments(raw) {
	if (!raw) return {};
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw);
		} catch {
			return { __unparsed: raw };
		}
	}
	if (typeof raw === "object") return raw;
	return { __raw: raw };
}

export function hasUsefulArguments(args) {
	return !!args && typeof args === "object" && !args.__unparsed && !args.__raw && modeOf(args) !== "unknown";
}

function values(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

// Raw model args can put anything where the schema wants a list; matcher
// helpers iterate through this so a defined-but-non-array collection is an
// empty one, never a crash mid-eval.
function asArray(value) {
	return Array.isArray(value) ? value : [];
}

// The workflow phases the handler would actually spawn, per its own imported
// predicate (agent AND task): an approval-only phase legitimately carries no
// task, and handleWorkflow refuses an agentless task phase outright
// (WORKFLOW_INVALID, a code the admissibility vocabulary does not cover) —
// so neither may count toward a case's work-phase minimum or carry its
// role-by-role binding (#88).
function workflowWorkPhases(args) {
	return asArray(args?.workflow?.phases).filter((phase) => isWorkflowWorkPhase(phase));
}

// Mirrors resolveFlowPreset: reserved keys plus the caller-control passthrough set
// are always allowed, and anything else must be an override the *selected* preset
// declares. An allowlist closes the class rather than chasing individual raw fields.
const PRESET_CALL_KEYS = new Set([
	"preset", "task", "list", "showConfig",
	"why", "agentScope", "confirmProjectAgents", "maxCostUsd", "checkpoint", "reflexion",
	"traceFile", "traceLabel", "traceContext", "traceStrict",
	"handoffPolicy", "modeHandoffPolicy", "incompleteHandoffPolicy",
	"recordContent", "redactSecrets", "allowSharedWriteCwd",
]);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");



/** Declared overrides per bundled preset, read from the preset files so the eval cannot drift from them. */
const bundledPresetsDir = path.resolve(repoRoot, "presets");
const presetOverrides = new Map(
	fsSync.readdirSync(bundledPresetsDir)
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => fsSync.readFileSync(path.join(bundledPresetsDir, entry), "utf8"))
		.map((content) => [
			content.match(/^name:\s*(\S+)\s*$/m)?.[1] ?? "",
			new Set((content.match(/^overrides:\s*(.+)$/m)?.[1] ?? "").split(",").map((key) => key.trim()).filter(Boolean)),
		]),
);

function modeOf(args) {
	if (args?.list) return "list";
	if (args?.showConfig) return "config";
	if (typeof args?.preset === "string" && args.preset) {
		// The tool refuses a preset call that also names raw workflow shape
		// (PRESET_OVERRIDE_INVALID), so scoring it as a preset selection would
		// credit a call the harness never runs.
		// The tool answers UNKNOWN_PRESET for a name it cannot discover, so an
		// invented preset is not a preset selection either.
		const allowed = presetOverrides.get(args.preset);
		if (!allowed) return "preset-unknown";
		const extra = Object.keys(args).filter((key) => args[key] !== undefined && !PRESET_CALL_KEYS.has(key) && !allowed.has(key));
		return extra.length ? "preset-conflict" : "preset";
	}
	if (Array.isArray(args?.tasks)) return "parallel";
	if (Array.isArray(args?.chain)) return "chain";
	if (args?.evaluate !== undefined) return "evaluate";
	if (args?.vote !== undefined) return "vote";
	if (args?.route !== undefined) return "route";
	if (args?.orchestrate !== undefined) return "orchestrate";
	if (args?.graph !== undefined) return "graph";
	if (args?.loop !== undefined) return "loop";
	if (args?.search !== undefined) return "search";
	if (args?.workflow !== undefined) return "workflow";
	if (args?.worktree !== undefined) return "worktree";
	if (args?.debate !== undefined) return "debate";
	if (args?.dossier !== undefined) return "dossier";
	if (args?.monitor !== undefined) return "monitor";
	if (args?.agent && args?.task) return "single";
	return "unknown";
}

function primaryAgents(args, mode) {
	if (mode === "single") return [args.agent].filter(Boolean);
	if (mode === "parallel") return asArray(args.tasks).map((task) => task?.agent).filter(Boolean);
	// Mirrors handleVote's voter construction: an explicit list, else the one
	// replicated agent.
	if (mode === "vote") {
		const voters = asArray(args.vote?.voters).map((voter) => voter?.agent).filter(Boolean);
		if (voters.length > 0) return voters;
		return [args.vote?.agent].filter(Boolean);
	}
	if (mode === "evaluate") return [args.evaluate?.operator?.agent ?? "operator"].filter(Boolean);
	if (mode === "orchestrate") return [args.orchestrate?.recon?.agent ?? "recon"].filter(Boolean);
	// Work phases only: a schema-valid approval phase may carry a stray agent
	// field the handler never spawns, and letting it into the allowlist or
	// knownAgentsOnly would fail a call the tool runs fine.
	if (mode === "workflow") return workflowWorkPhases(args).map((phase) => phase.agent);
	if (mode === "worktree") return asArray(args.worktree?.tasks).map((task) => task?.agent).filter(Boolean);
	if (mode === "debate") return asArray(args.debate?.participants).map((participant) => participant?.agent).filter(Boolean);
	if (mode === "dossier") return asArray(args.dossier?.sections).map((section) => section?.agent).filter(Boolean);
	if (mode === "monitor") return [args.monitor?.reactor?.agent ?? "analyst"].filter(Boolean);
	return [];
}

function taskCount(args, mode) {
	// asArray, not .length: a schema-invalid non-array collection (a string
	// has a length too) must count as zero roles, per this module's totality
	// contract, or minTasks could be satisfied by a call that cannot run.
	if (mode === "parallel") return asArray(args.tasks).length;
	// minTasks over a workflow is a work-phase minimum: counting approval or
	// agentless phases would satisfy it with a call that spawns no work (#88).
	if (mode === "workflow") return workflowWorkPhases(args).length;
	if (mode === "worktree") return asArray(args.worktree?.tasks).length;
	if (mode === "debate") return asArray(args.debate?.participants).length;
	if (mode === "dossier") return asArray(args.dossier?.sections).length;
	// Mirrors handleVote's voter construction: a NON-EMPTY explicit voters
	// list, else the replicated count, else the handler's default of three —
	// an empty voters list is ignored by the handler, so it must not zero the
	// count here either.
	if (mode === "vote") {
		const voters = args.vote?.voters;
		if (Array.isArray(voters) && voters.length > 0) return voters.length;
		// A present but non-numeric count is schema-refused, so it counts zero
		// roles instead of inheriting the handler default of three.
		const count = args.vote?.count;
		if (count !== undefined) return Number.isFinite(count) ? Math.floor(count) : 0;
		return 3;
	}
	return 0;
}

// Role-preserving agent names for the modes whose roles carry their own
// refs: an agent-less counted role contributes "(unnamed)" rather than
// vanishing, so neither the allowed-agents predicate nor knownAgentsOnly can
// be satisfied by the named subset of a fan-out (the tool refuses the
// unnamed role at its schema layer — the shape must not pass what cannot
// run). Vote mirrors handleVote: a non-empty voters list carries the names;
// otherwise the one replicated agent does, and its absence is itself
// "(unnamed)" — the handler refuses that call for having no voters at all.
// Other modes keep primaryAgents' role/default semantics.
function perRoleAgentNames(args, mode) {
	const roleRefs = {
		parallel: args.tasks,
		chain: args.chain,
		worktree: args.worktree?.tasks,
		dossier: args.dossier?.sections,
		vote: Array.isArray(args.vote?.voters) && args.vote.voters.length > 0 ? args.vote.voters : undefined,
	}[mode];
	if (Array.isArray(roleRefs)) {
		return roleRefs.map((role) => (typeof role?.agent === "string" && role.agent ? role.agent : "(unnamed)"));
	}
	if (mode === "vote") {
		return typeof args.vote?.agent === "string" && args.vote.agent ? [args.vote.agent] : ["(unnamed)"];
	}
	return primaryAgents(args, mode);
}

// The per-role task strings a call actually assigns, for modes whose roles
// carry their own tasks; modes whose roles share the top-level task (vote,
// preset, single, evaluate, …) contribute that. Distinct from taskText, which
// concatenates for a run-wide match: everyTaskPattern must hold role by role,
// so one on-topic task cannot vouch for an off-topic sibling. Every counted
// role keeps an entry — a role whose required task is absent or non-string
// contributes "", which no pattern matches, so a taskless role cannot slip
// past the binding the way a filtered-out one would. Workflow phases are the
// exception: an approval-only phase legitimately carries no task, so only the
// handler's work phases are counted and bound.
function perRoleTaskTexts(args, mode) {
	if (mode === "workflow") {
		return workflowWorkPhases(args).map((phase) => (typeof phase.task === "string" ? phase.task : ""));
	}
	const roleTasks = {
		parallel: args.tasks,
		chain: args.chain,
		worktree: args.worktree?.tasks,
		dossier: args.dossier?.sections,
	}[mode];
	if (roleTasks !== undefined) {
		return asArray(roleTasks).map((role) => (typeof role?.task === "string" ? role.task : ""));
	}
	return typeof args?.task === "string" ? [args.task] : [];
}

// Task text is collected only from the fields the flow contract actually
// reads. Models sometimes invent per-ref task fields (for example
// debate.participants[].task, recorded on PR #86); those never reach a child,
// so crediting them would score intent no child receives — and could score a
// call the tool refuses outright when the required top-level task is missing.
function taskText(args) {
	const pieces = [];
	if (typeof args?.task === "string") pieces.push(args.task);
	for (const task of asArray(args?.tasks)) {
		if (typeof task?.task === "string") pieces.push(task.task);
	}
	for (const task of asArray(args?.chain)) {
		if (typeof task?.task === "string") pieces.push(task.task);
	}
	if (typeof args?.evaluate?.operator?.task === "string") pieces.push(args.evaluate.operator.task);
	if (typeof args?.evaluate?.redteam?.task === "string") pieces.push(args.evaluate.redteam.task);
	for (const critic of Array.isArray(args?.evaluate?.redteam) ? args.evaluate.redteam : []) {
		if (typeof critic?.task === "string") pieces.push(critic.task);
	}
	if (typeof args?.orchestrate?.task === "string") pieces.push(args.orchestrate.task);
	if (typeof args?.orchestrate?.returnContract === "string") pieces.push(args.orchestrate.returnContract);
	for (const node of asArray(args?.graph?.nodes)) {
		if (typeof node?.task === "string") pieces.push(node.task);
	}
	for (const phase of asArray(args?.workflow?.phases)) {
		if (typeof phase?.task === "string") pieces.push(phase.task);
		if (typeof phase?.approval?.message === "string") pieces.push(phase.approval.message);
		if (typeof phase?.checkCommand === "string") pieces.push(phase.checkCommand);
	}
	for (const task of asArray(args?.worktree?.tasks)) {
		if (typeof task?.task === "string") pieces.push(task.task);
	}
	for (const section of asArray(args?.dossier?.sections)) {
		if (typeof section?.task === "string") pieces.push(section.task);
	}
	if (typeof args?.monitor?.command === "string") pieces.push(args.monitor.command);
	if (typeof args?.monitor?.pattern === "string") pieces.push(args.monitor.pattern);
	return pieces.join("\n");
}


// The pure shape half of expectation matching: does this call look like the
// shape, ignoring whether the tool would run it? Kept separate so forbidden
// shapes can match refused calls too — a guard bypass must not escape its
// forbidden-shape verdict by being a call the matcher would refuse anyway.
// Returns a mismatch note, or null when the call matches the shape.
function flowCallShapeMismatch(args, shape) {
	const actualMode = modeOf(args);
	if (shape.preset && args.preset !== shape.preset) {
		return `expected preset ${shape.preset}, saw ${args.preset ?? "(none)"}`;
	}
	const expectedModes = values(shape.mode ?? shape.modes);
	if (expectedModes.length > 0 && !expectedModes.includes(actualMode)) {
		return `expected mode ${expectedModes.join("|")}, saw ${actualMode}`;
	}

	const allowedAgents = values(shape.agent ?? shape.agents);
	if (allowedAgents.length > 0) {
		const agents = perRoleAgentNames(args, actualMode);
		if (agents.length === 0 || !agents.every((agent) => allowedAgents.includes(agent))) {
			return `expected primary agent(s) ${allowedAgents.join("|")}, saw ${agents.join(",") || "none"}`;
		}
	}

	const actualTaskCount = taskCount(args, actualMode);
	if (shape.minTasks !== undefined && actualTaskCount < shape.minTasks) {
		return `expected at least ${shape.minTasks} ${actualMode} task(s), saw ${actualTaskCount}`;
	}

	// The gate itself, not just the work in front of it: a phase-gated case
	// must be able to require that the workflow actually pauses. Approval
	// phases are counted by the handler's own kind test (approval.message,
	// the same discriminator workflowPhasesRefusal enforces at the rider) —
	// only workflow calls have them, so any other mode counts zero.
	if (shape.minApprovalPhases !== undefined) {
		const approvalCount = asArray(args?.workflow?.phases).filter((phase) => Boolean(phase?.approval?.message)).length;
		if (approvalCount < shape.minApprovalPhases) {
			return `expected at least ${shape.minApprovalPhases} workflow approval phase(s), saw ${approvalCount}`;
		}
	}

	if (shape.taskPattern && !new RegExp(shape.taskPattern, "i").test(taskText(args))) {
		return `task did not match /${shape.taskPattern}/`;
	}

	// Role-by-role intent binding: every assigned task must match on its own,
	// so a fan-out cannot pass on one on-topic task concatenated with
	// off-topic siblings.
	if (shape.everyTaskPattern) {
		const texts = perRoleTaskTexts(args, actualMode);
		const pattern = new RegExp(shape.everyTaskPattern, "i");
		if (texts.length === 0) return `no role task text to match /${shape.everyTaskPattern}/`;
		const offTopic = texts.findIndex((text) => !pattern.test(text));
		if (offTopic !== -1) return `role task ${offTopic + 1} did not match /${shape.everyTaskPattern}/`;
	}

	// Scalar param pins, e.g. { params: { allowSharedWriteCwd: true } }.
	for (const [key, value] of Object.entries(shape.params ?? {})) {
		if (!Object.is(args?.[key], value)) {
			return `expected params.${key}=${JSON.stringify(value)}, saw ${JSON.stringify(args?.[key])}`;
		}
	}

	// Every counted role must name an agent the bundled roster resolves.
	// Admissibility only refuses when NO first-spawn ref is known (one known
	// ref spawns real children); this shape rule is how a case says a mixed
	// fan-out — an invented or unnamed sibling silently halving the requested
	// independence — is not the topology it asked for.
	if (shape.knownAgentsOnly) {
		const known = new Set(scoringDiscovery.agents.map((agent) => agent.name));
		const unknown = perRoleAgentNames(args, actualMode).filter((name) => !known.has(name));
		if (unknown.length > 0) return `role agent(s) ${[...new Set(unknown)].join(", ")} are not bundled flow agents`;
	}

	// A task that requires running commands is not delegated by roles that
	// cannot run any: a shell-less fan-out reads as a SHARED_WRITE_CWD recovery
	// (it is admissible) while assigning work its agents cannot do. Effective
	// tools are resolved by the tool's own predicate — a per-role override else
	// the agent's frontmatter — so `bash-ro` counts and pi defaults (which
	// include bash) count, while an unknown agent resolves to nothing and fails.
	if (shape.everyRoleShellCapable) {
		const refs = firstSpawnAgentRefs(args ?? {});
		const shell = (ref) => {
			const tools = effectiveTools(scoringDiscovery, ref);
			if (tools === null) return false;
			if (tools === undefined) return true;
			return tools.some((tool) => ["bash", "bash-ro"].includes(tool.toLowerCase()));
		};
		if (refs.length === 0) return "no first-spawn role to check for shell access";
		const shellLess = refs.filter((ref) => !shell(ref));
		if (shellLess.length > 0) {
			return `role(s) ${[...new Set(shellLess.map((ref) => ref.agent ?? "(unnamed)"))].join(", ")} have no shell in their effective tools, so they cannot run the requested commands`;
		}
	}

	// A disjunction of allowed sub-shapes on top of the shared fields above.
	if (Array.isArray(shape.anyOf) && shape.anyOf.length > 0) {
		const mismatches = shape.anyOf.map((arm) => flowCallShapeMismatch(args, arm)).filter((note) => note !== null);
		if (mismatches.length === shape.anyOf.length) return `no allowed shape matched: ${mismatches.join("; ")}`;
	}

	return null;
}

export function flowCallMatchesExpectation(call, expected) {
	const args = call?.arguments ?? {};
	const mismatch = flowCallShapeMismatch(args, expected);
	if (mismatch) return { pass: false, notes: mismatch };

	// Checked after the shape checks so a gate regression is diagnosable as
	// "picked the right shape but the tool would have refused the call", which
	// is a different failure from picking the wrong shape.
	const inadmissible = callAdmissibilityFailure(args);
	if (inadmissible) {
		return { pass: false, notes: `${modeOf(args)} call matches the expected shape, but the tool would refuse it before any child spawns: ${inadmissible.reason} (${inadmissible.code})` };
	}

	return { pass: true, notes: `${modeOf(args)} flow call matched` };
}

function scoreFlowCallExpectations(testCase, result) {
	const expectations = values(testCase.expectedFlowCall ?? testCase.expectedFlowCalls);
	const forbidden = values(testCase.forbiddenFlowCall ?? testCase.forbiddenFlowCalls);
	const calls = result.flowCallArgs ?? [];
	if (expectations.length === 0 && forbidden.length === 0 && testCase.maxRefusedCalls === undefined) {
		return { pass: true, notes: "no flow argument expectation" };
	}
	const failures = [];

	// Forbidden shapes are negative properties of the whole run: no emitted
	// call may match one, whether or not the tool would have refused it.
	for (const shape of forbidden) {
		const hits = calls.flatMap((args, index) => (flowCallShapeMismatch(args, shape) === null ? [index + 1] : []));
		if (hits.length > 0) failures.push(`call ${hits.join(",")} matched the forbidden shape ${JSON.stringify(shape)}`);
	}

	// The refused-call budget scores recovery discipline: every refused call
	// burns a turn, and an unchanged or name-only retry after a refusal is the
	// failure this counts. It counts exactly the refusals the admissibility
	// vocabulary can name — a pre-dispatch refusal outside it (say a failed
	// preset resolution) is not counted, so the note names the codes.
	if (testCase.maxRefusedCalls !== undefined) {
		const refusals = calls.map((args) => callAdmissibilityFailure(args)).filter(Boolean);
		if (refusals.length > testCase.maxRefusedCalls) {
			failures.push(`${refusals.length} call(s) refused by the scored admissibility vocabulary (${[...new Set(refusals.map((refusal) => refusal.code))].join(",")}) exceed the case budget of ${testCase.maxRefusedCalls}`);
		}
	}

	for (const expectation of expectations) {
		if (expectation.firstCall) {
			const match = calls.length > 0
				? flowCallMatchesExpectation({ arguments: calls[0] }, expectation)
				: { pass: false, notes: "no flow call was emitted" };
			if (!match.pass) failures.push(`the first flow call must already satisfy the expectation: ${match.notes}`);
			continue;
		}
		const matches = calls.map((call) => flowCallMatchesExpectation({ arguments: call }, expectation));
		if (!matches.some((match) => match.pass)) {
			failures.push(matches[0]?.notes ?? "no flow call matched");
		}
	}

	if (failures.length > 0) {
		return { pass: false, notes: `${failures.join(" | ")}; calls=${JSON.stringify(calls).slice(0, 800)}` };
	}
	return { pass: true, notes: "flow arguments matched" };
}

export function scoreSelection(testCase, result) {
	if (result.inconclusive || result.timedOut) {
		return {
			pass: false,
			inconclusive: true,
			selectionOk: null,
			answerOk: null,
			argsOk: null,
			flowUsed: (result.flowCalls ?? result.flowCallArgs?.length ?? 0) > 0,
			notes: result.error ?? "selection arm was excluded by infrastructure",
		};
	}
	const flowUsed = (result.flowCalls ?? result.flowCallArgs?.length ?? 0) > 0;
	const selectionOk = flowUsed === testCase.expectFlow;
	const answerRequired = testCase.answerPattern && !(testCase.expectFlow && result.stoppedAfterFlowCall);
	const answerOk = answerRequired ? new RegExp(testCase.answerPattern, "i").test(result.answer ?? "") : true;
	const argsOk = testCase.expectFlow ? scoreFlowCallExpectations(testCase, result) : { pass: true, notes: "no flow expected" };
	return {
		pass: !result.error && selectionOk && answerOk && argsOk.pass,
		selectionOk,
		answerOk,
		argsOk: argsOk.pass,
		flowUsed,
		notes: result.error
			? result.error
			: selectionOk
				? answerOk
					? argsOk.pass ? "selection, arguments, and answer matched" : argsOk.notes
					: "selection matched; answer did not"
				: `expected flow=${testCase.expectFlow}, saw flow=${flowUsed}`,
	};
}

export function selectionExitCode({ failed, comparable }) {
	return failed === 0 && comparable > 0 ? 0 : 1;
}
