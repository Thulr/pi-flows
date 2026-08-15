/**
 * The effective Agent profile one Child would execute: the selected discovered
 * Agent plus every material Role override and flow fallback resolved before
 * spawn. Approval and dispatch use this same resolution so consent cannot bind
 * one profile while the runner executes another.
 */
import { resolveChildModel, type ChildModelChoice } from "./child-model.ts";
import { canonicalSha256 } from "./delegation.ts";
import { knownModel } from "./model-roster.ts";
import type { AgentSource, FlowAgent, ModelRoster, ThinkingLevel } from "./types.ts";
import { parseToolsOverride, resolveCwdTarget } from "./validate.ts";

/** A material profile condition that durable approval cannot identify. */
export type UnboundAgentProfileCondition = "selected Agent" | "effective tools" | "working directory" | "model" | "Thinking level";

/** Non-disclosing identity of the executable conditions an approval binds. */
export interface EffectiveAgentProfileIdentity {
	readonly source: AgentSource | null;
	/** Full SHA-256 identity of the selected Agent's system prompt; never the prompt text. */
	readonly promptDigest: string | null;
	/** The post-override tool list. null means Pi defaults, whose concrete set is unavailable before spawn. */
	readonly effectiveTools: readonly string[] | null;
	readonly resolvedCwd: string;
	/** Filesystem identity of the canonical cwd target; hashed into approval bindings, never persisted raw. */
	readonly cwdIdentity: string | null;
	readonly model: string | null;
	readonly thinking: ThinkingLevel | null;
}

/**
 * Resolution shared by durable approval and the child-process adapter.
 * `unbound` is empty exactly when every identity field is concrete enough for a
 * receipt; ordinary ungated dispatch may still execute Pi defaults.
 */
export interface EffectiveAgentProfile {
	readonly agent: FlowAgent | undefined;
	readonly identity: EffectiveAgentProfileIdentity;
	readonly effectiveTools: string[] | undefined;
	readonly modelChoice: ChildModelChoice;
	readonly unbound: readonly UnboundAgentProfileCondition[];
}

/** The invocation-scoped inputs shared by every Role profile resolution. */
export interface AgentProfileEnvironment {
	readonly agents: readonly FlowAgent[];
	readonly defaultCwd: string;
	readonly roster?: ModelRoster;
}

/** One Role's authored conditions plus its invocation environment. */
export interface AgentProfileRequest extends AgentProfileEnvironment {
	readonly agentName: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly tier?: string;
	readonly thinking?: ThinkingLevel;
	readonly flowThinking?: ThinkingLevel;
	readonly tools?: string;
}

/** Stable, non-disclosing identity of the selected Agent's system prompt. */
export const agentPromptDigest = (systemPrompt: string): string => canonicalSha256(systemPrompt);

/** Resolve one Role exactly as the runner will execute it. */
export function resolveAgentProfile(options: AgentProfileRequest): EffectiveAgentProfile {
	const agent = options.agents.find((candidate) => candidate.name === options.agentName);
	const modelChoice = resolveChildModel(
		{ model: agent?.model, tier: agent?.tier, thinking: agent?.thinking },
		{ model: options.model, tier: options.tier, thinking: options.thinking, flowThinking: options.flowThinking },
		options.roster,
	);
	const parsedTools = parseToolsOverride(options.tools, agent?.tools);
	const effectiveTools = parsedTools === undefined ? undefined : [...parsedTools];
	const concreteModel = knownModel(options.roster, modelChoice.model);
	const cwd = resolveCwdTarget(options.defaultCwd, options.cwd);
	const unbound: UnboundAgentProfileCondition[] = [];
	if (!agent) unbound.push("selected Agent");
	if (effectiveTools === undefined) unbound.push("effective tools");
	if (!cwd.bindable) unbound.push("working directory");
	// Pi fuzzy-matches --model, including provider-qualified patterns. Only an
	// exact current roster reference is a concrete identity that cannot retarget.
	if (!concreteModel) unbound.push("model");
	if (modelChoice.thinking === undefined) unbound.push("Thinking level");
	return {
		agent,
		effectiveTools,
		modelChoice,
		unbound,
		identity: {
			source: agent?.source ?? null,
			promptDigest: agent ? agentPromptDigest(agent.systemPrompt) : null,
			effectiveTools: effectiveTools ?? null,
			resolvedCwd: cwd.path,
			cwdIdentity: cwd.identity,
			model: concreteModel?.reference ?? null,
			thinking: modelChoice.thinking ?? null,
		},
	};
}
