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
import { currentFlowDepth, nonSpawningFlowCall, spawnJustificationMissing, validateConcurrency } from "../extensions/pi-flows/validate.ts";
import { firstSpawnPlan, modePreSpawnRefusalForParams, preSpawnSharedWriteRefusal } from "../extensions/pi-flows/modes/contract.ts";
import { plannedContract } from "../extensions/pi-flows/modes/plan.ts";
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

// Which of the active mode's declared pre-spawn refusals this seam scores.
// The mode table (modes/contract.ts) declares every refusal a mode reaches
// before its first spawn; this seam deliberately scores a subset, because the
// rest are per-mode bounds a selection is not judged on — TOO_FEW_VOTERS and
// vote's no-voters INVALID_MODE are shape mismatches the shape matchers
// already see, and GRAPH_INVALID names a malformed topology rather than a
// misselected mode. Everything outside the set scores as admissible, exactly
// as it did when this seam imported five predicates by hand. Widening the
// vocabulary is now this one line, not a new import plus a new ordered call.
const SCORED_PRE_SPAWN_CODES = new Set([
	"TOO_MANY_TASKS",
	"PARALLEL_SIZING_REQUIRED",
	"GRAPH_CYCLE",
	"MONITOR_INVALID",
	"WORKFLOW_INVALID",
	"WORKFLOW_APPROVAL_REQUIRED",
]);

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
// outside this seam's vocabulary (per-mode bounds such as TOO_FEW_VOTERS, or
// the roster rule for monitor and worktree, whose refusal is not statically
// certain) score as admissible.
//
// Per-mode pre-spawn refusals are no longer enumerated here: the mode table
// declares what each mode refuses before its first spawn, and
// modePreSpawnRefusalForParams resolves the active one, so a new mode joins this
// gate by existing. What stays this seam's own decision is which of those
// codes to score — SCORED_PRE_SPAWN_CODES above.
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
	// Whatever the ACTIVE mode declares it refuses before its first spawn,
	// asked of the tool's own declaration rather than reassembled here: the
	// raw parallel bounds (fan-out cap and intentional sizing), vote's fan-out
	// cap, a graph with no runnable first wave,
	// monitor's probe validation, and workflow's phase-shape and
	// opening-approval rules all arrive through this one call. The subject runs
	// headless, so an approval gate that needs a UI refuses here. A mode added
	// to the table is covered without touching this file; only the scored
	// vocabulary above is this seam's own decision.
	const modeRefusal = modePreSpawnRefusalForParams(effective ?? {}, { headless: true });
	if (modeRefusal && SCORED_PRE_SPAWN_CODES.has(modeRefusal.code)) {
		return { code: modeRefusal.code, reason: modeRefusal.message.replace(/\.$/, "") };
	}
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
	// For workflow the first-spawn role is its first work phase (#91); that
	// refusal follows the fresh-state write, so the play-out policy
	// terminates it (actsBeforeRunner, select.mjs) instead of re-running it.
	const known = new Set(scoringDiscovery.agents.map((agent) => agent.name));
	const opening = firstSpawnPlan(effective ?? {});
	// Workflow writes fresh state before resolving its first work phase. Its
	// contract refusal is real, but not an entry refusal the eval may play out
	// unchanged (#91), so only its roster rule is scored here.
	const openingContractRule = mode === "workflow" ? undefined : opening.contracts;
	const consumedContract = (ref) => {
		const contract = plannedContract(ref, effective?.contract, openingContractRule);
		return contract && typeof contract === "object" && !Array.isArray(contract) ? contract : undefined;
	};
	const roleRefusal = (ref) => {
		if (typeof ref.agent === "string" && !known.has(ref.agent)) return "UNKNOWN_AGENT";
		// A contract counts only where the opener's declared wave says it is
		// enforced: own role contract, or role contract then call fallback.
		const contract = consumedContract(ref);
		if (contract && Budget.forContract(contract.budget)?.refusesSpawn()) {
			return "BUDGET_EXCEEDED";
		}
		return null;
	};
	const firstSpawnRefs = opening.refs;
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
