// Call admissibility for the tool-selection eval: "would the flow tool have
// accepted this call, or refused it before any child spawned?" — one uniform
// question across refusal codes, every rule the tool's own predicate. The
// shape matchers and case scoring live in select-scoring.mjs and consume
// this module.
//
// The .ts imports make this module require the tsx loader (`node --import
// tsx`), which every current entrypoint already passes; do not import it from
// a bare-node script such as eval:review or eval:pareto.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { currentFlowDepth, firstSpawnAgentRefs, graphCycleRefusal, monitorInvalidRefusal, nonSpawningFlowCall, preSpawnFanoutRefusal, preSpawnSharedWriteRefusal, spawnJustificationMissing, validateConcurrency, workflowHeadlessApprovalRefusal, workflowPhasesRefusal } from "../extensions/pi-flows/validate.ts";
import { MAX_FLOW_DEPTH } from "../extensions/pi-flows/types.ts";
import { validateDelegationContract } from "../extensions/pi-flows/delegation.ts";
import { Budget } from "../extensions/pi-flows/budget.ts";
import { discoverFlowAgents } from "../extensions/pi-flows/agents.ts";
import { discoverFlowPresets, resolveFlowPreset } from "../extensions/pi-flows/presets.ts";
import { flowParamsSchemaError } from "../extensions/pi-flows/schema.ts";
import { detectRunMode } from "../extensions/pi-flows/modes/registry.ts";
import { strictTraceConfigError } from "../extensions/pi-flows/trace.ts";
import { checkpointGates } from "../extensions/pi-flows/ui.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Admissibility scoring resolves each agent's effective toolset against the
// bundled roster only: the shared-write verdict must be a property of the
// case, not of whatever ~/.pi/flow-agents happens to contain on the machine
// running the eval. The toggle is restored immediately so importing this
// module never leaks the env var to anything else in the process; the harness
// (select.mjs) separately pins the same toggle for the spawned subject, so
// scorer and subject resolve the identical bundled roster.
const packageOnlyPrevious = process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY;
process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = "1";
let discoveredAgents;
let discoveredPresets;
try {
	discoveredAgents = discoverFlowAgents(repoRoot, "user");
	discoveredPresets = discoverFlowPresets(repoRoot, "user");
} finally {
	if (packageOnlyPrevious === undefined) delete process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY;
	else process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = packageOnlyPrevious;
}
export const scoringDiscovery = discoveredAgents;
const scoringPresetDiscovery = discoveredPresets;

/** The modes whose handlers apply the top-level params.contract to their FIRST child (verified per handler: single uses it directly; chain, parallel, vote, debate pass fallbackContract; evaluate's operator falls back to it). Dossier is deliberately absent: its fallback goes to the debrief synthesizer, and its first-spawn section plans carry only their own contracts. */
const CONTRACT_FALLBACK_MODES = new Set(["single", "chain", "parallel", "vote", "debate", "evaluate"]);

/** The modes whose openers run through integrationRunPlan, which resolves (and validates) each ref's own contract: the fallback modes plus graph nodes, dossier sections (modes/dossier.ts:33 — no fallback, own contracts only), and the orchestrate commander (modes/orchestrate.ts:53). route/search/loop openers use runAgentRef with no contract limits, so a role contract there is ignored by the tool and must be ignored here. */
const ROLE_CONTRACT_MODES = new Set([...CONTRACT_FALLBACK_MODES, "graph", "dossier", "orchestrate"]);

// The tool resolves a preset before any gate runs, so admissibility must be
// asked of the expanded call, not the raw preset reference: a permitted
// override (say concurrency:2 on code-review) can turn a safe preset into a
// call the shared-write guard refuses, and a raw-args check would credit it.
// Resolution failures split two ways: an unknown name or undeclared override
// key is visible to shape scoring (preset-unknown/preset-conflict), so those
// stay outside the vocabulary — but a declared key with a schema-invalid
// value, or a missing required task, still classifies as a clean preset
// shape, so those are scored with the tool's own resolution codes
// (PRESET_EXPANSION_INVALID, PRESET_TASK_REQUIRED).
const SHAPE_VISIBLE_PRESET_FAILURES = new Set(["UNKNOWN_PRESET", "PRESET_OVERRIDE_INVALID"]);

function effectiveCallParams(args) {
	if (typeof args?.preset !== "string" || !args.preset) return { params: args };
	const resolved = resolveFlowPreset(args, scoringPresetDiscovery);
	return "error" in resolved ? { params: args, resolutionError: resolved.error } : { params: resolved.params };
}

// Admissibility: would the flow tool have accepted this call, or refused it
// before any child spawned? Scored uniformly across every spawning mode so a
// call the tool would refuse cannot count as a correct selection, however well
// its shape fits. Each rule must be the tool's own predicate (imported, not
// hand-copied) so the scored gate cannot drift from the enforced one: mode
// detection (detectRunMode's exactly-one-active-mode rule), the spawn gate
// from #83, and, from #84, the concurrency bound and the pre-spawn
// shared-write guard — the latter answered by the tool's own
// validateSharedWriteCwd over the same ref waves the mode handlers check,
// against the bundled agent roster, and asked of the preset-expanded call
// exactly as the tool asks it. Checks run in the dispatch core's order.
// Returns { code, reason } so callers phrase their own notes and the
// refused-call budget can group verdicts by refusal code. Refusal codes
// outside this seam's vocabulary (unknown agents, per-mode bounds such as
// TOO_FEW_VOTERS) score as admissible; extending the vocabulary means adding
// the tool's own predicate here.
export function callAdmissibilityFailure(args) {
	// pi validates the raw call against the public flow schema before execute
	// ever runs, so a schema-invalid call is refused ahead of every gate below
	// — including list/showConfig and preset resolution. No FlowError code
	// exists for that layer; the seam names it SCHEMA_INVALID.
	const schemaError = flowParamsSchemaError(args ?? {});
	if (schemaError) return { code: "SCHEMA_INVALID", reason: `outside the public flow schema: ${schemaError}` };
	if (nonSpawningFlowCall(args ?? {})) return null;
	const resolution = effectiveCallParams(args ?? {});
	const effective = resolution.params;
	// A preset whose resolution failed is refused by the tool right there, and
	// none of the later gates ever run, so none of their codes may be claimed
	// for it. Shape-visible failures score as shape mismatches; the rest score
	// as the tool's own resolution refusal.
	if (resolution.resolutionError) {
		if (SHAPE_VISIBLE_PRESET_FAILURES.has(resolution.resolutionError.code)) return null;
		return { code: resolution.resolutionError.code, reason: resolution.resolutionError.message.replace(/\.$/, "") };
	}
	// The tool requires exactly one active mode; a call activating zero or
	// several is refused before any other gate, so first-activator scoring
	// must not quietly admit it.
	const detected = detectRunMode(effective ?? {});
	if ("error" in detected) return { code: detected.error.code, reason: "exactly one mode must be active" };
	const mode = detected.mode;
	if (spawnJustificationMissing(effective?.why)) return { code: "WHY_REQUIRED", reason: "why is missing or empty" };
	// The subject inherits PI_FLOWS_DEPTH; at the cap it refuses every
	// spawning call, so an eval launched from inside a flow child must score
	// that refusal instead of crediting selections that can never run.
	if (currentFlowDepth() >= MAX_FLOW_DEPTH) {
		return { code: "FLOW_DEPTH_EXCEEDED", reason: `the subject inherits flow depth ${currentFlowDepth()} of ${MAX_FLOW_DEPTH}` };
	}
	const concurrencyError = validateConcurrency(effective?.concurrency);
	if (concurrencyError) return { code: concurrencyError.code, reason: concurrencyError.message.replace(/\.$/, "") };
	// The dispatch core resolves both strict-trace inputs from params with the
	// same environment fallbacks the spawned subject inherits, and refuses a
	// strict run with no trace destination before dispatch.
	const traceStrict = effective?.traceStrict ?? /^(1|true|yes)$/i.test(process.env.PI_FLOWS_TRACE_STRICT?.trim() ?? "");
	const traceError = strictTraceConfigError(traceStrict, effective?.traceFile ?? process.env.PI_FLOWS_TRACE_FILE);
	if (traceError) return { code: traceError.code, reason: traceError.message.replace(/\.$/, "") };
	// The subject runs headless, so a checkpoint gating the spawn (the
	// default target) is refused before the handler runs.
	if (checkpointGates(effective?.checkpoint, "spawn")) {
		return { code: "CHECKPOINT_APPROVAL_REQUIRED", reason: "a spawn checkpoint cannot collect approval in the headless subject" };
	}
	const fanout = preSpawnFanoutRefusal(effective ?? {});
	if (fanout) return { code: fanout.code, reason: fanout.message.replace(/\.$/, "") };
	// A structurally valid but rootless graph deadlocks its first wave;
	// handleGraph refuses GRAPH_CYCLE before any child spawns.
	const cycle = graphCycleRefusal(effective ?? {});
	if (cycle) return { code: cycle.code, reason: cycle.message.replace(/\.$/, "") };
	// handleMonitor validates its probe command and match pattern before the
	// probe ever runs; a call it refuses MONITOR_INVALID spawns nothing.
	const monitorInvalid = monitorInvalidRefusal(effective ?? {});
	if (monitorInvalid) return { code: monitorInvalid.code, reason: monitorInvalid.message.replace(/\.$/, "") };
	// handleWorkflow validates phase shape before touching state or spawning
	// — 1..MAX phases, unique ids, each phase exactly one kind (agent+task
	// work or approval) — and an invalid phase refuses the call WHOLE
	// (WORKFLOW_INVALID), so a topology whose valid siblings would satisfy a
	// case must not score as one the tool runs (#88).
	const workflowPhases = workflowPhasesRefusal(effective ?? {});
	if (workflowPhases) return { code: workflowPhases.code, reason: workflowPhases.message.replace(/\.$/, "") };
	// A workflow opening with an approval phase is refused in the headless
	// subject before any child spawns (state is persisted first, so the
	// play-out branch still terminates it via the stateful-mode rule).
	const workflowApproval = workflowHeadlessApprovalRefusal(effective ?? {});
	if (workflowApproval) return { code: workflowApproval.code, reason: workflowApproval.message.replace(/\.$/, "") };
	const sharedWrite = preSpawnSharedWriteRefusal(scoringDiscovery, repoRoot, effective ?? {});
	if (sharedWrite) return { code: sharedWrite.code, reason: sharedWrite.message.replace(/\.$/, "") };
	// A flow budget that starts exhausted (a zero ceiling) refuses at the
	// first spawn, before any child runs — the tool's own Budget object is
	// the judge, exactly as the runner consults it.
	if (Budget.forFlow(effective ?? {})?.refusesSpawn()) {
		return { code: "BUDGET_EXCEEDED", reason: "a zero budget ceiling refuses the first spawn" };
	}
	// The runner refuses each first-spawn role for its own cause — an agent
	// outside the roster (UNKNOWN_AGENT) or a contract budget that starts
	// exhausted (BUDGET_EXCEEDED, role contract else the top-level fallback
	// where the opener consumes it) — so the causes must be judged per role
	// and COMBINED: a wave mixing one unknown reviewer with one exhausted one
	// spawns nothing, even though neither cause alone covers every role. One
	// startable role means real children run and the call counts as admitted.
	const known = new Set(scoringDiscovery.agents.map((agent) => agent.name));
	const consumedContract = (ref) => {
		const roleContract = ROLE_CONTRACT_MODES.has(mode) ? ref.contract : undefined;
		const contract = roleContract ?? (CONTRACT_FALLBACK_MODES.has(mode) ? effective?.contract : undefined);
		return contract && typeof contract === "object" && !Array.isArray(contract) ? contract : undefined;
	};
	const roleRefusal = (ref) => {
		if (typeof ref.agent === "string" && !known.has(ref.agent)) return "UNKNOWN_AGENT";
		// A contract counts only where the tool's opener actually consumes it:
		// integrationRunPlan resolves ref.contract ?? the top-level fallback
		// for the fallback modes; route/search/loop/orchestrate openers run
		// with no contract limits, so neither source applies there — claiming
		// a refusal for them would let the play-out branch execute a call the
		// tool admits.
		const contract = consumedContract(ref);
		if (contract && Budget.forContract(contract.budget)?.refusesSpawn()) {
			return "BUDGET_EXCEEDED";
		}
		return null;
	};
	const firstSpawnRefs = firstSpawnAgentRefs(effective ?? {});
	// integrationRunPlan validates each consumed contract while constructing
	// plans, before any fanout starts — one invalid contract among the
	// first-spawn roles refuses the whole call (INVALID_DELEGATION_CONTRACT),
	// unlike the per-child budget refusals below.
	for (const ref of firstSpawnRefs) {
		const contract = consumedContract(ref);
		const contractError = contract ? validateDelegationContract(contract) : null;
		if (contractError) return { code: contractError.code, reason: contractError.message.replace(/\.$/, "") };
	}
	const causes = firstSpawnRefs.map(roleRefusal);
	if (firstSpawnRefs.length > 0 && causes.every(Boolean)) {
		const codes = [...new Set(causes)];
		return { code: codes.length === 1 ? codes[0] : "UNKNOWN_AGENT", reason: `no first-spawn role can start (${codes.join(" + ")})` };
	}
	return null;
}
