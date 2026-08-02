import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { THINKING_LEVELS, type AgentScope, type AgentSource, type DiscoveryIssue, type FlowAgent, type FlowDiscovery, type ThinkingLevel } from "./types.ts";
import { isThinkingLevel } from "./model-roster.ts";
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

		// An unrecognized level is reported rather than silently dropped: a typo
		// here would otherwise look like the agent simply chose not to set one.
		const rawThinking = frontmatter.thinking?.trim();
		if (rawThinking && !isThinkingLevel(rawThinking)) {
			issues.push({
				severity: "warning",
				code: "AGENT_THINKING_INVALID",
				source,
				filePath: safePath(filePath) ?? filePath,
				message: `Ignored thinking level "${rawThinking}" in flow-agent frontmatter: not a pi thinking level.`,
				fix: `Use one of: ${THINKING_LEVELS.join(", ")}.`,
			});
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
			thinking: isThinkingLevel(rawThinking) ? (rawThinking as ThinkingLevel) : undefined,
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
	const packageOnly = process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY === "1";

	const packageLoad = loadAgentsFromDir(packageAgentsDir, "package");
	const userLoad = packageOnly || scope === "project" ? { agents: [] as FlowAgent[], issues: [] as DiscoveryIssue[] } : loadAgentsFromDir(userAgentsDir, "user");
	const projectLoad = packageOnly || scope === "user" || !projectAgentsDir
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
