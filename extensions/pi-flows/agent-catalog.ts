import {
	DEFAULT_CONCURRENCY,
	DEFAULT_TIMEOUT_MS,
	MAX_PARALLEL_TASKS,
	MODEL_VISIBLE_OUTPUT_CAP,
	PI_FLOWS_VERSION,
	type AgentScope,
	type DiscoveryIssue,
	type FlowAgent,
	type FlowDetails,
	type FlowDiscovery,
	type FlowError,
	type FlowMode,
	type FlowRunResult,
	type ModelRoster,
} from "./types.ts";
import { safePath } from "./sanitize.ts";
import { describeModelRoster } from "./model-roster.ts";
import { requestedAgentNamesForParams } from "./modes/contract.ts";

export function summarizeDiscoveryIssues(issues: DiscoveryIssue[]): string {
	if (issues.length === 0) return "";
	return issues
		.map((issue) => `- ${issue.severity.toUpperCase()} ${issue.code}${issue.filePath ? ` (${issue.filePath})` : ""}: ${issue.message}${issue.fix ? ` Fix: ${issue.fix}` : ""}`)
		.join("\n");
}

export function summarizeAgents(agents: FlowAgent[], issues: DiscoveryIssue[] = []): string {
	const agentText = agents.length === 0
		? "No flow agents found."
		: agents
				.map((agent) => {
					const bits = [`${agent.name} (${agent.source})`, agent.description];
					if (agent.model) bits.push(`model=${agent.model}`);
					if (agent.tier) bits.push(`tier=${agent.tier}`);
					if (agent.thinking) bits.push(`thinking=${agent.thinking}`);
					if (agent.tools) bits.push(`tools=${agent.tools.length ? agent.tools.join(",") : "none"}`);
					return `- ${bits.join(" — ")}`;
				})
				.join("\n");
	const issueText = summarizeDiscoveryIssues(issues);
	return issueText ? `${agentText}\n\nDiscovery issues:\n${issueText}` : agentText;
}

export function safeAgentForDetails(agent: FlowAgent): Pick<FlowAgent, "name" | "description" | "source" | "filePath" | "model" | "tier" | "thinking" | "tools"> {
	return {
		name: agent.name,
		description: agent.description,
		source: agent.source,
		filePath: safePath(agent.filePath) ?? agent.filePath,
		model: agent.model,
		tier: agent.tier,
		thinking: agent.thinking,
		tools: agent.tools,
	};
}

export function requestedAgentNames(params: any): Set<string> {
	return requestedAgentNamesForParams(params);
}

export function projectAgentsForRequest(discovery: FlowDiscovery, params: any): FlowAgent[] {
	const requested = requestedAgentNames(params);
	return Array.from(requested)
		.map((name) => discovery.agents.find((agent) => agent.name === name))
		.filter((agent): agent is FlowAgent => agent?.source === "project");
}

/**
 * The one FlowDetails constructor. `results` is always the runs accumulated so
 * far — error paths pass what already ran (children that spent real tokens must
 * stay visible to the ledger, trace, and inspector), plus the error itself.
 */
export function makeFlowDetails(discovery: FlowDiscovery, agentScope: AgentScope, mode: FlowMode, agents = discovery.agents) {
	return (results: FlowRunResult[], error?: FlowError): FlowDetails => ({
		mode,
		version: PI_FLOWS_VERSION,
		agentScope,
		config: {
			defaultConcurrency: DEFAULT_CONCURRENCY,
			maxParallelTasks: MAX_PARALLEL_TASKS,
			modelVisibleOutputCapBytes: MODEL_VISIBLE_OUTPUT_CAP,
			defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
			recordContentDefault: true,
			redactSecretsDefault: true,
			handoffPolicyDefault: "warn",
		},
		agentsDir: {
			package: safePath(discovery.packageAgentsDir) ?? discovery.packageAgentsDir,
			user: safePath(discovery.userAgentsDir) ?? discovery.userAgentsDir,
			project: safePath(discovery.projectAgentsDir),
		},
		results,
		agents: agents.map(safeAgentForDetails),
		discoveryIssues: discovery.issues,
		...(error ? { error } : {}),
	});
}

export function configSummary(discovery: FlowDiscovery, agentScope: AgentScope, roster?: ModelRoster): string {
	const lines = [
		`pi-flows ${PI_FLOWS_VERSION}`,
		`agentScope: ${agentScope}`,
		`agentsDir.package: ${safePath(discovery.packageAgentsDir)}`,
		`agentsDir.user: ${safePath(discovery.userAgentsDir)}`,
		`agentsDir.project: ${safePath(discovery.projectAgentsDir) ?? "(none)"}`,
		`modelRoster: ${roster?.source ?? "unresolved"}`,
		...describeModelRoster(roster),
		`defaultConcurrency: ${DEFAULT_CONCURRENCY}`,
		`maxParallelTasks: ${MAX_PARALLEL_TASKS}`,
		`defaultTimeoutMs: ${DEFAULT_TIMEOUT_MS}`,
		`modelVisibleOutputCapBytes: ${MODEL_VISIBLE_OUTPUT_CAP}`,
		`recordContentDefault: true`,
		`redactSecretsDefault: true`,
		`handoffPolicyDefault: warn`,
		"",
		"Agents:",
		summarizeAgents(discovery.agents, discovery.issues),
	];
	return lines.join("\n");
}

export interface AgentCatalog {
	discovery: FlowDiscovery;
	agentScope: AgentScope;
	summary: () => string;
	configSummary: (roster?: ModelRoster) => string;
	projectAgentsFor: (params: any) => FlowAgent[];
	makeDetails: (mode: FlowMode, agents?: FlowAgent[]) => (results: FlowRunResult[], error?: FlowError) => FlowDetails;
	errorDetails: (mode: FlowMode, error: FlowError) => FlowDetails;
}

export function createAgentCatalog(discovery: FlowDiscovery, agentScope: AgentScope): AgentCatalog {
	return {
		discovery,
		agentScope,
		summary: () => summarizeAgents(discovery.agents, discovery.issues),
		configSummary: (roster) => configSummary(discovery, agentScope, roster),
		projectAgentsFor: (params) => projectAgentsForRequest(discovery, params),
		makeDetails: (mode, agents) => makeFlowDetails(discovery, agentScope, mode, agents),
		errorDetails: (mode, error) => makeFlowDetails(discovery, agentScope, mode)([], error),
	};
}
