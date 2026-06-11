import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS, MAX_PARALLEL_TASKS, MODEL_VISIBLE_OUTPUT_CAP, PI_FLOWS_VERSION, type AgentScope, type AgentSource, type DiscoveryIssue, type FlowAgent, type FlowDetails, type FlowDiscovery, type FlowError, type FlowMode } from "./types.ts";
import { safePath } from "./sanitize.ts";

export const baseDir = path.dirname(fileURLToPath(import.meta.url));
export const packageAgentsDir = path.resolve(baseDir, "../../agents");

export function isDirectory(candidate: string): boolean {
	try {
		return fsSync.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

export function loadAgentsFromDir(dir: string, source: AgentSource): { agents: FlowAgent[]; issues: DiscoveryIssue[] } {
	if (!fsSync.existsSync(dir)) return { agents: [], issues: [] };

	let entries: fsSync.Dirent[];
	try {
		entries = fsSync.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		return {
			agents: [],
			issues: [
				{
					severity: "error",
					code: "AGENT_DIR_UNREADABLE",
					source,
					filePath: safePath(dir) ?? dir,
					message: `Could not read flow-agent directory: ${error instanceof Error ? error.message : String(error)}`,
					fix: "Check directory permissions or remove the unreadable flow-agent directory.",
				},
			],
		};
	}

	const agents: FlowAgent[] = [];
	const issues: DiscoveryIssue[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fsSync.readFileSync(filePath, "utf8");
		} catch (error) {
			issues.push({
				severity: "error",
				code: "AGENT_FILE_UNREADABLE",
				source,
				filePath: safePath(filePath) ?? filePath,
				message: `Could not read flow-agent file: ${error instanceof Error ? error.message : String(error)}`,
				fix: "Fix file permissions or remove the unreadable agent file.",
			});
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) {
			issues.push({
				severity: "warning",
				code: "AGENT_FRONTMATTER_INVALID",
				source,
				filePath: safePath(filePath) ?? filePath,
				message: "Skipped flow-agent file because YAML frontmatter is missing name or description.",
				fix: "Add frontmatter with at least `name` and `description`.",
			});
			continue;
		}

		const rawTools = frontmatter.tools?.trim();
		let tools: string[] | undefined;
		if (rawTools) {
			tools = rawTools.toLowerCase() === "none"
				? []
				: rawTools
						.split(",")
						.map((tool) => tool.trim())
						.filter(Boolean);
		}

		agents.push({
			name: frontmatter.name.trim(),
			description: frontmatter.description.trim(),
			tools,
			model: frontmatter.model?.trim() || undefined,
			tier: frontmatter.tier?.trim() || undefined,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return { agents, issues };
}

export function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, ".pi", "flow-agents");
		if (isDirectory(candidate)) return candidate;

		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverFlowAgents(cwd: string, scope: AgentScope): FlowDiscovery {
	const userAgentsDir = path.join(getAgentDir(), "flow-agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const packageLoad = loadAgentsFromDir(packageAgentsDir, "package");
	const userLoad = scope === "project" ? { agents: [] as FlowAgent[], issues: [] as DiscoveryIssue[] } : loadAgentsFromDir(userAgentsDir, "user");
	const projectLoad = scope === "user" || !projectAgentsDir
		? { agents: [] as FlowAgent[], issues: [] as DiscoveryIssue[] }
		: loadAgentsFromDir(projectAgentsDir, "project");

	const issues = [...packageLoad.issues, ...userLoad.issues, ...projectLoad.issues];
	const byName = new Map<string, FlowAgent>();
	for (const agent of packageLoad.agents) byName.set(agent.name, agent);
	for (const agent of userLoad.agents) {
		const previous = byName.get(agent.name);
		if (previous) {
			issues.push({
				severity: "warning",
				code: "AGENT_NAME_SHADOWED",
				source: agent.source,
				filePath: safePath(agent.filePath) ?? agent.filePath,
				message: `Flow agent "${agent.name}" from ${agent.source} shadows ${previous.source} agent at ${safePath(previous.filePath)}.`,
				fix: "Rename one agent or use a narrower agentScope.",
			});
		}
		byName.set(agent.name, agent);
	}
	for (const agent of projectLoad.agents) {
		const previous = byName.get(agent.name);
		if (previous) {
			issues.push({
				severity: "warning",
				code: "AGENT_NAME_SHADOWED",
				source: agent.source,
				filePath: safePath(agent.filePath) ?? agent.filePath,
				message: `Flow agent "${agent.name}" from ${agent.source} shadows ${previous.source} agent at ${safePath(previous.filePath)}.`,
				fix: "Rename one agent or use a narrower agentScope.",
			});
		}
		byName.set(agent.name, agent);
	}

	return {
		agents: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
		projectAgentsDir,
		userAgentsDir,
		packageAgentsDir,
		issues,
	};
}

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
					if (agent.tools) bits.push(`tools=${agent.tools.length ? agent.tools.join(",") : "none"}`);
					return `- ${bits.join(" — ")}`;
				})
				.join("\n");
	const issueText = summarizeDiscoveryIssues(issues);
	return issueText ? `${agentText}\n\nDiscovery issues:\n${issueText}` : agentText;
}

export function safeAgentForDetails(agent: FlowAgent): Pick<FlowAgent, "name" | "description" | "source" | "filePath" | "model" | "tools"> {
	return {
		name: agent.name,
		description: agent.description,
		source: agent.source,
		filePath: safePath(agent.filePath) ?? agent.filePath,
		model: agent.model,
		tools: agent.tools,
	};
}

export function configSummary(discovery: FlowDiscovery, agentScope: AgentScope): string {
	const lines = [
		`pi-flows ${PI_FLOWS_VERSION}`,
		`agentScope: ${agentScope}`,
		`agentsDir.package: ${safePath(discovery.packageAgentsDir)}`,
		`agentsDir.user: ${safePath(discovery.userAgentsDir)}`,
		`agentsDir.project: ${safePath(discovery.projectAgentsDir) ?? "(none)"}`,
		`defaultConcurrency: ${DEFAULT_CONCURRENCY}`,
		`maxParallelTasks: ${MAX_PARALLEL_TASKS}`,
		`defaultTimeoutMs: ${DEFAULT_TIMEOUT_MS}`,
		`modelVisibleOutputCapBytes: ${MODEL_VISIBLE_OUTPUT_CAP}`,
		`recordContentDefault: true`,
		`redactSecretsDefault: true`,
		"",
		"Agents:",
		summarizeAgents(discovery.agents, discovery.issues),
	];
	return lines.join("\n");
}

export function requestedAgentNames(params: any): Set<string> {
	const requested = new Set<string>();
	if (params.agent) requested.add(params.agent);
	for (const task of params.tasks ?? []) requested.add(task.agent);
	for (const step of params.chain ?? []) requested.add(step.agent);
	if (params.evaluate) {
		requested.add(params.evaluate.operator?.agent ?? "operator");
		const critics = Array.isArray(params.evaluate.redteam) ? params.evaluate.redteam : [params.evaluate.redteam];
		for (const critic of critics) if (critic?.agent) requested.add(critic.agent);
		if (!critics.some((critic: any) => critic?.agent)) requested.add("redteam");
	}
	if (params.vote) {
		if (params.vote.agent) requested.add(params.vote.agent);
		for (const voter of params.vote.voters ?? []) if (voter?.agent) requested.add(voter.agent);
		if (params.vote.debrief?.agent) requested.add(params.vote.debrief.agent);
	}
	if (params.route) {
		requested.add(params.route.controller?.agent ?? "controller");
		for (const candidate of params.route.candidates ?? []) if (typeof candidate === "string") requested.add(candidate);
		if (typeof params.route.fallback === "string") requested.add(params.route.fallback);
	}
	if (params.orchestrate) {
		requested.add(params.orchestrate.commander?.agent ?? "commander");
		requested.add(params.orchestrate.recon?.agent ?? "recon");
		requested.add(params.orchestrate.debrief?.agent ?? "debrief");
		if (params.orchestrate.verify?.agent) requested.add(params.orchestrate.verify.agent);
	}
	if (params.graph) {
		for (const node of params.graph.nodes ?? []) if (node?.agent) requested.add(node.agent);
		if (params.graph.debrief?.agent) requested.add(params.graph.debrief.agent);
	}
	if (params.loop) {
		if (params.loop.body?.agent) requested.add(params.loop.body.agent);
		if (params.loop.judge?.agent) requested.add(params.loop.judge.agent);
	}
	if (params.search) {
		requested.add(params.search.generator?.agent ?? "strategist");
		requested.add(params.search.scorer?.agent ?? "redteam");
		requested.add(params.search.debrief?.agent ?? "debrief");
	}
	return requested;
}

export function projectAgentsForRequest(discovery: FlowDiscovery, params: any): FlowAgent[] {
	const requested = requestedAgentNames(params);
	return Array.from(requested)
		.map((name) => discovery.agents.find((agent) => agent.name === name))
		.filter((agent): agent is FlowAgent => agent?.source === "project");
}

export function toolErrorDetails(discovery: FlowDiscovery, mode: FlowMode, agentScope: AgentScope, error: FlowError): FlowDetails {
	return {
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
		},
		agentsDir: {
			package: safePath(discovery.packageAgentsDir) ?? discovery.packageAgentsDir,
			user: safePath(discovery.userAgentsDir) ?? discovery.userAgentsDir,
			project: safePath(discovery.projectAgentsDir),
		},
		results: [],
		agents: discovery.agents.map(safeAgentForDetails),
		discoveryIssues: discovery.issues,
		error,
	};
}
