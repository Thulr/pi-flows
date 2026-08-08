/**
 * Read-only bash (`bash-ro`): the toolset token that grants a child bash
 * restricted to a command allowlist, enforced by the pi-flows extension
 * running inside that child rather than requested by prompt. The parent
 * classifies a bash-ro toolset as not write-capable; this module owns the
 * whole vocabulary — the env marker, the toolset split, and the allowlist
 * predicate — so the rule cannot drift between the parent and the child.
 *
 * This is coordination safety (preventing ad-hoc mutations of a shared
 * checkout, the same threat model as SHARED_WRITE_CWD), not a sandbox:
 * allowed verification commands (`npm test`, `npm run <script>`,
 * `node --test`) execute repo-authored code and may write caches.
 *
 * No foreign imports on purpose: the predicate must stay pure and
 * unit-testable, and the foreign-import ledger admits no new module with
 * foreign imports; only the shared error vocabulary is imported.
 */
import { flowError, type FlowError } from "./types.ts";

/** The env marker the runner sets on a child whose toolset carries bash-ro. */
export const BASH_READONLY_ENV = "PI_FLOWS_BASH_READONLY";

export const BASH_READONLY_TOOL = "bash-ro";

/** Same truthiness convention as PI_FLOWS_CHILD_NO_EXTENSIONS. */
export function bashReadonlyEnabled(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value?.trim() ?? "");
}

/**
 * Split a resolved toolset for spawning. `readonly` is true only when bash-ro
 * is present and plain bash is absent — a toolset carrying both is already
 * write-capable, so restricting it would misstate the classification; bash
 * wins and no marker is set. `argvTools` maps bash-ro to bash (deduplicated)
 * because the child pi only knows the built-in tool name.
 */
export function splitBashReadonly(tools: string[]): { argvTools: string[]; readonly: boolean } {
	const normalized = tools.map((tool) => tool.toLowerCase());
	const hasReadonly = normalized.includes(BASH_READONLY_TOOL);
	const hasBash = normalized.includes("bash");
	if (!hasReadonly) return { argvTools: tools, readonly: false };
	const argvTools: string[] = [];
	for (const tool of tools) {
		const mapped = tool.toLowerCase() === BASH_READONLY_TOOL ? "bash" : tool;
		if (!argvTools.some((existing) => existing.toLowerCase() === mapped.toLowerCase())) argvTools.push(mapped);
	}
	return { argvTools, readonly: !hasBash };
}

/** The fail-closed refusal: never spawn a bash-ro child whose enforcer cannot load. */
export function bashReadonlyUnenforceableError(): FlowError {
	return flowError(
		"BASH_READONLY_UNENFORCEABLE",
		"bash-ro cannot be enforced with child extensions disabled.",
		"PI_FLOWS_CHILD_NO_EXTENSIONS is set, so the child would run without the pi-flows extension that blocks non-read-only bash commands — spawning would silently grant unrestricted bash.",
		"Unset PI_FLOWS_CHILD_NO_EXTENSIONS, or change the role's tools to bash (accepting write-capable classification) or to read,grep,find,ls.",
	);
}

/** What bash-ro permits, for refusal reasons and user-facing attribution. */
export function bashReadonlySummary(): string {
	return "git inspection (log/diff/show/blame/status/rev-parse/...), file inspection (ls/cat/grep/find/head/...), and repo verification (npm test, npm run <script>, node --test)";
}

const GIT_SUBCOMMANDS = new Set(["log", "diff", "show", "blame", "status", "rev-parse", "ls-files", "ls-tree", "merge-base", "shortlog", "describe", "cat-file", "grep", "name-rev", "branch", "tag", "remote", "reflog"]);

/** git flags that redirect output to files or inject config-named commands. */
const GIT_FORBIDDEN_FLAGS = ["-c", "-o", "--output", "--output-directory", "--ext-diff"];

const GIT_LIST_ONLY: Record<string, (args: string[]) => boolean> = {
	branch: (args) => args.every((arg) => arg.startsWith("-") && ["--list", "-a", "-r", "-v", "-vv", "--contains"].some((ok) => arg === ok || arg.startsWith("--contains"))),
	tag: (args) => args.every((arg) => arg === "-l" || arg === "--list" || arg.startsWith("-n")),
	remote: (args) => args.length === 0 || (args.length === 1 && (args[0] === "-v" || args[0] === "show")),
};

function gitRefusal(args: string[]): string | null {
	for (const arg of args) {
		if (GIT_FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) return `git flag "${arg}" can write output or inject config`;
	}
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (!subcommand || !GIT_SUBCOMMANDS.has(subcommand)) return `git subcommand "${subcommand ?? "(none)"}" is not read-only inspection`;
	const listOnly = GIT_LIST_ONLY[subcommand];
	if (listOnly && !listOnly(args.slice(args.indexOf(subcommand) + 1))) return `git ${subcommand} is allowed in listing form only`;
	return null;
}

const PLAIN_INSPECTORS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "stat", "file", "pwd", "du", "df", "diff", "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "which", "echo", "printf", "date"]);

const FIND_FORBIDDEN = ["-delete", "-exec", "-execdir", "-ok", "-okdir"];

function segmentRefusal(segment: string): string | null {
	const tokens = segment.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "empty command segment";
	const command = tokens[0];
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) return `env-assignment prefix "${command}" is not allowed`;
	const args = tokens.slice(1);
	if (command === "git") return gitRefusal(args);
	if (PLAIN_INSPECTORS.has(command)) return null;
	if (command === "env") return args.length === 0 ? null : "env may only print the environment, not launch commands";
	if (command === "find") {
		const bad = args.find((arg) => FIND_FORBIDDEN.includes(arg) || arg.startsWith("-fprint"));
		return bad ? `find action "${bad}" mutates or executes` : null;
	}
	if (command === "npm") return args[0] === "test" || args[0] === "run" ? null : `npm subcommand "${args[0] ?? "(none)"}" is not test/run`;
	if (command === "node") return args.includes("--test") ? null : "node is allowed only with --test";
	return `command "${command}" is not on the read-only allowlist`;
}

/**
 * The allowlist predicate: null means the command is allowed; otherwise a
 * reason naming the offending segment. Fail-closed at every step — anything
 * unparseable (including quoted separators, which the deliberately
 * quote-unaware split mangles into a failing segment) is refused, never run.
 */
export function bashReadonlyRefusal(command: string): string | null {
	if (typeof command !== "string" || command.trim().length === 0) return refusalText("(empty)", "empty command");
	if (command.includes("$(") || command.includes("`")) return refusalText(command, "command substitution");
	if (command.includes("<(") || command.includes(">(")) return refusalText(command, "process substitution");
	const stripped = command.replace(/\d?>&\d/g, " ").replace(/\d?>>?\s*\/dev\/null/g, " ");
	if (stripped.includes(">")) return refusalText(command, "output redirection");
	// eval/exec/source/. need no dedicated check: as a segment's command they
	// fail the allowlist below, and as arguments they execute nothing.
	const segments = stripped.split(/&&|\|\||[;|&\n]/);
	for (const segment of segments) {
		const reason = segmentRefusal(segment.trim());
		if (reason !== null) return refusalText(segment.trim() || command, reason);
	}
	return null;
}

function refusalText(segment: string, reason: string): string {
	return `bash-ro blocked "${truncate(segment)}": ${reason}. This child runs bash under a read-only allowlist covering ${bashReadonlySummary()}. Use the read/grep/find/ls tools for file access, or return the needed command to the parent as a proposed next step.`;
}

function truncate(text: string): string {
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
