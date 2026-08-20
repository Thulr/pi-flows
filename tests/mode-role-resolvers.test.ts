// A mode's role defaults are declared once and read by both its plan and its
// handler (CONTEXT.md: Mirror).
//
// The defect this replaces: which agent fills a role when the caller names none
// was written twice per mode — once inside the plan declaration and once inside
// the handler, 50+ lines apart in the same file. Nothing compared them.
// tests/mode-plan.test.ts pins each plan against literals captured when the
// declarations were introduced, which is a third copy rather than a check
// against what the handler dispatches; a mode whose handler changed its default
// would keep passing there.
//
// What this file pins instead: for every mode that defaults a role, the plan's
// declared refs name exactly the agents the shared resolver returns — the same
// resolver the handler dispatches. A default changed in one reader and not the
// other fails here rather than shipping as a plan that describes a topology the
// flow no longer runs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { planSearch, searchRoles, SEARCH_ROLE_DEFAULTS } from "../extensions/pi-flows/modes/search.ts";
import { planOrchestrate } from "../extensions/pi-flows/modes/orchestrate.ts";
import { orchestrateRoles, ORCHESTRATE_ROLE_DEFAULTS } from "../extensions/pi-flows/modes/orchestrate-call.ts";
import { planEvaluate, evaluateRoles, EVALUATE_ROLE_DEFAULTS } from "../extensions/pi-flows/modes/evaluate.ts";
import { planRoute, routeRoles, ROUTE_CONTROLLER_DEFAULT } from "../extensions/pi-flows/modes/route.ts";
import { planDossier, dossierRoles, DOSSIER_DEBRIEF_DEFAULT } from "../extensions/pi-flows/modes/dossier.ts";
import { planDebate, debateRoles, DEBATE_ADJUDICATOR_DEFAULT } from "../extensions/pi-flows/modes/debate.ts";
import { planMonitor, monitorRoles, MONITOR_REACTOR_DEFAULT } from "../extensions/pi-flows/modes/monitor.ts";
import { planWorktree, worktreeRoles, WORKTREE_INTEGRATOR_DEFAULT } from "../extensions/pi-flows/modes/worktree.ts";
import { renderRunModeLabel } from "../extensions/pi-flows/modes/contract.ts";

/** Every agent name the declared plan lists, in wave order. */
const plannedAgents = (plan: { waves: { refs: { agent: string }[] }[] }) => plan.waves.flatMap((wave) => wave.refs.map((ref) => ref.agent));

// ---------------------------------------------------------------------------
// Each defaulted role reaches the plan from the resolver the handler uses
// ---------------------------------------------------------------------------

test("search: the three role defaults reach the declared plan", () => {
	const params = { task: "t", search: {} };
	const roles = searchRoles(params);
	assert.deepEqual(roles.generator, SEARCH_ROLE_DEFAULTS.generator);
	assert.deepEqual(roles.scorer, SEARCH_ROLE_DEFAULTS.scorer);
	assert.deepEqual(roles.debrief, SEARCH_ROLE_DEFAULTS.debrief);

	const agents = new Set(plannedAgents(planSearch(params)));
	assert.equal(agents.has(roles.generator.agent), true, "the declared plan generates with the resolver's generator");
	assert.equal(agents.has(roles.scorer.agent), true);
	assert.equal(agents.has(roles.debrief.agent), true);
});

test("search: a caller-named role replaces the default in both readers", () => {
	const params = { task: "t", search: { generator: { agent: "custom-gen" }, debrief: { agent: "custom-debrief" } } };
	const roles = searchRoles(params);
	assert.equal(roles.generator.agent, "custom-gen");
	assert.equal(roles.debrief.agent, "custom-debrief");

	const agents = new Set(plannedAgents(planSearch(params)));
	assert.equal(agents.has("custom-gen"), true);
	assert.equal(agents.has("custom-debrief"), true);
	assert.equal(agents.has(SEARCH_ROLE_DEFAULTS.generator.agent), false, "the default is not also declared alongside the override");
	assert.equal(agents.has(roles.scorer.agent), true, "the role the caller left alone still defaults");
});

test("orchestrate: the three defaulted roles reach the declared plan, and the two optional ones stay absent", () => {
	const params = { task: "t", orchestrate: {} };
	const roles = orchestrateRoles(params);
	assert.deepEqual(roles.commander, ORCHESTRATE_ROLE_DEFAULTS.commander);
	assert.deepEqual(roles.recon, ORCHESTRATE_ROLE_DEFAULTS.recon);
	assert.deepEqual(roles.debrief, ORCHESTRATE_ROLE_DEFAULTS.debrief);
	assert.equal(roles.review, undefined, "review is opt-in: naming it is what turns the stage on");
	assert.equal(roles.verify, undefined);

	const agents = plannedAgents(planOrchestrate(params));
	assert.equal(agents.includes(roles.commander.agent), true);
	assert.equal(agents.includes(roles.recon.agent), true);
	assert.equal(agents.includes(roles.debrief.agent), true);
});

test("orchestrate: an optional role only exists once the caller names an agent", () => {
	const named = orchestrateRoles({ task: "t", orchestrate: { review: { agent: "critic" }, verify: { agent: "checker" } } });
	assert.equal(named.review?.agent, "critic");
	assert.equal(named.verify?.agent, "checker");

	const agentless = orchestrateRoles({ task: "t", orchestrate: { review: {}, verify: { agent: 7 } } });
	assert.equal(agentless.review, undefined, "a ref naming no agent is absent, never defaulted into existence");
	assert.equal(agentless.verify, undefined);
});

test("orchestrate: an optional role reaches the declared plan only through the resolver", () => {
	const off = plannedAgents(planOrchestrate({ task: "t", orchestrate: {} }));
	assert.equal(off.includes("critic"), false);

	const on = plannedAgents(planOrchestrate({ task: "t", orchestrate: { review: { agent: "critic" }, verify: { agent: "checker" } } }));
	assert.equal(on.includes("critic"), true, "naming review declares its wave");
	assert.equal(on.includes("checker"), true);

	// A ref naming no agent is absent to both readers: the resolver omits it and
	// the plan declares no wave for it.
	const agentless = plannedAgents(planOrchestrate({ task: "t", orchestrate: { review: {}, verify: { agent: 7 } } }));
	assert.deepEqual(agentless, off, "an agent-less optional role declares nothing, exactly as when it is absent");
});

test("evaluate: the generator default and the critic panel reach the declared plan", () => {
	const params = { task: "t", evaluate: {} };
	const roles = evaluateRoles(params);
	assert.deepEqual(roles.operator, EVALUATE_ROLE_DEFAULTS.operator);
	assert.deepEqual(roles.critics, [EVALUATE_ROLE_DEFAULTS.critic]);

	const agents = plannedAgents(planEvaluate(params));
	assert.equal(agents.includes(roles.operator.agent), true);
	assert.equal(agents.includes(EVALUATE_ROLE_DEFAULTS.critic.agent), true);
});

test("evaluate: a critic panel normalizes to a list for both readers", () => {
	const panel = evaluateRoles({ task: "t", evaluate: { redteam: [{ agent: "a" }, { agent: "b" }] } });
	assert.deepEqual(panel.critics.map((ref) => ref.agent), ["a", "b"]);

	const single = evaluateRoles({ task: "t", evaluate: { redteam: { agent: "solo" } } });
	assert.deepEqual(single.critics.map((ref) => ref.agent), ["solo"], "one critic and a panel are the same shape to both readers");

	const agents = plannedAgents(planEvaluate({ task: "t", evaluate: { redteam: [{ agent: "a" }, { agent: "b" }] } }));
	assert.equal(agents.includes("a") && agents.includes("b"), true);
});

// ---------------------------------------------------------------------------
// The single-role modes
// ---------------------------------------------------------------------------

for (const [label, plan, roles, roleName, fallback, activate] of [
	["route", planRoute, routeRoles, "controller", ROUTE_CONTROLLER_DEFAULT, (spec: unknown) => ({ task: "t", route: spec })],
	["dossier", planDossier, dossierRoles, "debrief", DOSSIER_DEBRIEF_DEFAULT, (spec: unknown) => ({ task: "t", dossier: spec })],
	["debate", planDebate, debateRoles, "adjudicator", DEBATE_ADJUDICATOR_DEFAULT, (spec: unknown) => ({ task: "t", debate: spec })],
	["monitor", planMonitor, monitorRoles, "reactor", MONITOR_REACTOR_DEFAULT, (spec: unknown) => ({ task: "t", monitor: spec })],
	["worktree", planWorktree, worktreeRoles, "integrator", WORKTREE_INTEGRATOR_DEFAULT, (spec: unknown) => ({ task: "t", worktree: spec })],
] as const) {
	test(`${label}: the ${roleName} default reaches the declared plan`, () => {
		const params = activate({});
		const resolved = (roles as (p: any) => Record<string, { agent: string }>)(params)[roleName]!;
		assert.deepEqual(resolved, fallback, "the resolver returns the shared default constant itself");

		const agents = plannedAgents((plan as (p: any) => any)(params));
		assert.equal(agents.includes(fallback.agent), true, `the declared plan lists the ${roleName} the handler would dispatch`);
	});

	test(`${label}: a caller-named ${roleName} replaces the default in both readers`, () => {
		const params = activate({ [roleName]: { agent: `custom-${roleName}` } });
		const resolved = (roles as (p: any) => Record<string, { agent: string }>)(params)[roleName]!;
		assert.equal(resolved.agent, `custom-${roleName}`);

		const agents = plannedAgents((plan as (p: any) => any)(params));
		assert.equal(agents.includes(`custom-${roleName}`), true);
		// Replaces, not joins: a plan that declared the default alongside the
		// override would satisfy an includes-only check while describing a
		// topology with one more role than the flow runs.
		assert.equal(agents.includes(fallback.agent), false, `the ${roleName} default is still declared beside the override`);
	});
}

// ---------------------------------------------------------------------------
// Every resolver is total over the garbage a model can emit
// ---------------------------------------------------------------------------

test("every role resolver is total over arbitrary params", () => {
	const hostile: unknown[] = [undefined, null, {}, { search: null }, { orchestrate: 7 }, { evaluate: "x" }, { route: [] }, { dossier: { debrief: 3 } }, { debate: { adjudicator: null } }, { monitor: { reactor: [] } }, { worktree: { integrator: "" } }];
	for (const params of hostile) {
		assert.doesNotThrow(() => {
			searchRoles(params);
			orchestrateRoles(params);
			evaluateRoles(params);
			routeRoles(params);
			dossierRoles(params);
			debateRoles(params);
			monitorRoles(params);
			worktreeRoles(params);
		}, `resolvers threw on ${JSON.stringify(params)}`);
	}
});

test("a malformed ref never yields a role with no agent name", () => {
	// The handler passes an agent-less ref on to be refused by name; what must
	// not happen is a resolver inventing a ref that names nothing at all.
	assert.equal(typeof searchRoles({ search: { generator: {} } }).generator, "object");
	assert.equal(dossierRoles({ dossier: { debrief: {} } }).debrief.agent, DOSSIER_DEBRIEF_DEFAULT.agent, "an agent-less ref falls back to the default under the ?.agent idiom");
	assert.equal(debateRoles({ debate: { adjudicator: { agent: "" } } }).adjudicator.agent, DEBATE_ADJUDICATOR_DEFAULT.agent, "an empty agent name is not a named role");
});

// ---------------------------------------------------------------------------
// The defaults are shared objects, so they are frozen
// ---------------------------------------------------------------------------

test("every role default is frozen, so a shared constant cannot be mutated in place", () => {
	// The resolvers hand the same object to every caller, and evaluate pushes
	// EVALUATE_ROLE_DEFAULTS.critic itself into a dispatched array. Nothing
	// mutates a ref today; freezing makes that hazard non-existent rather than
	// merely absent, since the resolvers' return type is mutable and TypeScript
	// would not catch it.
	const defaults = [
		...Object.values(SEARCH_ROLE_DEFAULTS),
		...Object.values(ORCHESTRATE_ROLE_DEFAULTS),
		...Object.values(EVALUATE_ROLE_DEFAULTS),
		ROUTE_CONTROLLER_DEFAULT,
		DOSSIER_DEBRIEF_DEFAULT,
		DEBATE_ADJUDICATOR_DEFAULT,
		MONITOR_REACTOR_DEFAULT,
		WORKTREE_INTEGRATOR_DEFAULT,
	];
	for (const ref of defaults) {
		assert.equal(Object.isFrozen(ref), true, `${ref.agent} default is not frozen`);
		assert.throws(() => { (ref as { agent: string }).agent = "hijacked"; }, TypeError, `${ref.agent} default accepted an in-place write`);
	}
});

// ---------------------------------------------------------------------------
// The mode table's label is a third reader, and reads the same resolver
// ---------------------------------------------------------------------------

test("a mode's rendered label names the role the flow would actually dispatch", () => {
	// renderLabel used to spell these defaults as bare strings — a third
	// derivation beside the plan and the handler, and route's label even used a
	// different idiom from route's dispatch.
	assert.equal(renderRunModeLabel({ task: "t", route: {} }), `route via ${ROUTE_CONTROLLER_DEFAULT.agent}`);
	assert.equal(renderRunModeLabel({ task: "t", route: { controller: { agent: "picker" } } }), "route via picker");

	assert.equal(renderRunModeLabel({ task: "t", orchestrate: {} }), `orchestrate ->${ORCHESTRATE_ROLE_DEFAULTS.recon.agent}`);
	assert.equal(renderRunModeLabel({ task: "t", orchestrate: { recon: { agent: "scout" } } }), "orchestrate ->scout");

	assert.equal(renderRunModeLabel({ task: "t", evaluate: {} }), `evaluate ${EVALUATE_ROLE_DEFAULTS.operator.agent}->${EVALUATE_ROLE_DEFAULTS.critic.agent}`);
	assert.equal(renderRunModeLabel({ task: "t", evaluate: { operator: { agent: "maker" }, redteam: { agent: "judge" } } }), "evaluate maker->judge");
	assert.equal(renderRunModeLabel({ task: "t", evaluate: { redteam: [{ agent: "a" }, { agent: "b" }] } }), `evaluate ${EVALUATE_ROLE_DEFAULTS.operator.agent}->2 critics`, "a panel is counted, not named");
});

test("a label falls back to the role default when the resolved ref names no agent", () => {
	// The `??`-idiom resolvers hand back the caller's ref untouched, so an
	// agent-less `{}` survives resolution and reaches dispatch to be refused by
	// name. A label cannot refuse, so it shows the role's default — the one
	// question roleLabel answers, and the reason those labels carry a fallback
	// at all. Pinned per idiom so a resolver contract change cannot quietly
	// blank a label.
	assert.equal(renderRunModeLabel({ task: "t", route: { controller: {} } }), `route via ${ROUTE_CONTROLLER_DEFAULT.agent}`);
	assert.equal(renderRunModeLabel({ task: "t", orchestrate: { recon: {} } }), `orchestrate ->${ORCHESTRATE_ROLE_DEFAULTS.recon.agent}`);
	assert.equal(renderRunModeLabel({ task: "t", evaluate: { operator: {}, redteam: {} } }), `evaluate ${EVALUATE_ROLE_DEFAULTS.operator.agent}->${EVALUATE_ROLE_DEFAULTS.critic.agent}`);

	// The `?.agent ?` modes never reach the fallback: their resolver already
	// substituted the default before the label saw the ref.
	assert.equal(dossierRoles({ dossier: { debrief: {} } }).debrief.agent, DOSSIER_DEBRIEF_DEFAULT.agent);
});
