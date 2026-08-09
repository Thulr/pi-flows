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
 * Only the shared error vocabulary is imported, on purpose: the predicate
 * must stay pure and unit-testable, and the foreign-import ledger admits no
 * new module with foreign imports. Spawn plumbing (the `-e` argv that loads
 * the enforcer) lives with the enforcer in bash-readonly-extension.ts.
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

/**
 * Which layer will enforce a bash-ro child's read-only-ness, given what the
 * host offers. The OS sandbox (writes to the checkout denied at the kernel) is
 * the security boundary when available; the in-child command allowlist (loaded
 * via an explicit `-e`, which survives `--no-extensions`) is the fallback and,
 * when the sandbox is present, defense-in-depth. `null` means neither is
 * available — the caller must refuse rather than grant an unrestricted shell.
 */
export type BashReadonlyEnforcement = "sandbox" | "allowlist";

export function bashReadonlyEnforcement(enforcerLoadable: boolean, sandboxUsable: boolean, requireSandbox: boolean): BashReadonlyEnforcement | null {
	if (sandboxUsable) return "sandbox";
	// Off the sandbox the command allowlist is the fallback, on by default. It
	// is best-effort, not an exhaustive boundary (getopt-style option
	// abbreviation yields endless spellings across every tool), so a caller who
	// needs a kernel-enforced guarantee sets requireSandbox to refuse instead.
	if (enforcerLoadable && !requireSandbox) return "allowlist";
	return null;
}

/**
 * Child env that neutralizes repository-configured git helpers which would
 * otherwise launch external programs on a plain inspection command
 * (diff.external, pager, fsmonitor, hooks). Applied to every bash-ro child so
 * the guarantee does not depend on the command string. Uses git's
 * GIT_CONFIG_COUNT override mechanism (git >= 2.31).
 */
export function bashReadonlyGitEnv(): Record<string, string> {
	const pairs: Array<[string, string]> = [["diff.external", ""], ["core.pager", "cat"], ["core.fsmonitor", "false"], ["core.hooksPath", "/dev/null"]];
	const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
	pairs.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}

/** The fail-closed refusal: never spawn a bash-ro child no layer can enforce. */
export function bashReadonlyUnenforceableError(): FlowError {
	return flowError(
		"BASH_READONLY_UNENFORCEABLE",
		"bash-ro cannot be enforced on this host.",
		"The OS read-only-checkout sandbox is unavailable or opted out (no macOS sandbox-exec, or PI_FLOWS_BASH_RO_NO_SANDBOX), and the command-allowlist fallback is also unavailable (PI_FLOWS_BASH_RO_REQUIRE_SANDBOX is set, or the enforcer extension could not be located) — so spawning would grant the child unrestricted bash in the shared checkout.",
		"Run on macOS (without PI_FLOWS_BASH_RO_NO_SANDBOX) so the sandbox enforces it; unset PI_FLOWS_BASH_RO_REQUIRE_SANDBOX to allow the best-effort allowlist fallback; or change the role's tools to bash (write-capable) or read,grep,find,ls.",
	);
}

/** What bash-ro permits, for refusal reasons and user-facing attribution. */
export function bashReadonlySummary(): string {
	return "git inspection (log/diff/show/blame/status/rev-parse/...), file inspection (ls/cat/grep/find/head/...), and repo verification (npm test, npm run <script>, node --test)";
}

const GIT_SUBCOMMANDS = new Set(["log", "diff", "show", "blame", "status", "rev-parse", "ls-files", "ls-tree", "merge-base", "shortlog", "describe", "cat-file", "grep", "name-rev", "branch", "tag", "remote", "reflog"]);

/**
 * git flags that redirect output to files, inject config-named commands, or run
 * repository-configured conversion filters (smudge/textconv) as external
 * programs. These are the OS sandbox's job to contain; screened here so the
 * allowlist fallback has no known write/exec hole either.
 */
const GIT_FORBIDDEN_FLAGS = ["-c", "-o", "--output", "--output-directory", "--ext-diff", "--open-files-in-pager", "--filters", "--textconv"];

const GIT_LIST_ONLY: Record<string, (args: string[]) => boolean> = {
	branch: (args) => args.every((arg) => arg.startsWith("-") && ["--list", "-a", "-r", "-v", "-vv", "--contains"].some((ok) => arg === ok || arg.startsWith("--contains"))),
	tag: (args) => args.every((arg) => arg === "-l" || arg === "--list" || arg.startsWith("-n")),
	remote: (args) => args.length === 0 || (args.length === 1 && (args[0] === "-v" || args[0] === "show")),
	// reflog also takes expire/delete, which mutate reflog state.
	reflog: (args) => args.every((arg) => arg.startsWith("-")) || args[0] === "show" || args[0] === "exists",
};

function gitRefusal(args: string[]): string | null {
	for (const arg of args) {
		if (GIT_FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) return `git flag "${arg}" can write output or inject config`;
		if (arg.startsWith("-O")) return `git flag "${arg}" launches a pager command`;
	}
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (!subcommand || !GIT_SUBCOMMANDS.has(subcommand)) return `git subcommand "${subcommand ?? "(none)"}" is not read-only inspection`;
	const listOnly = GIT_LIST_ONLY[subcommand];
	if (listOnly && !listOnly(args.slice(args.indexOf(subcommand) + 1))) return `git ${subcommand} is allowed in listing form only`;
	return null;
}

const PLAIN_INSPECTORS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "rg", "stat", "file", "pwd", "du", "df", "diff", "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "which", "echo", "printf", "date"]);

/**
 * Inspection-oriented programs whose own flags can still write or execute:
 * being on the inspector list admits the executable, and these screens refuse
 * the specific mutating invocations of it. Short flags are matched as cluster
 * prefixes (`-ofile`, `-ro out`), because getopt accepts attached optargs and
 * bundling — an exact `=== "-o"` test would admit the attached form.
 */
function hasShortFlag(letter: string, longForm: string | null): (args: string[]) => boolean {
	const cluster = new RegExp(`^-[^-]*${letter}`);
	return (args) => args.some((arg) => cluster.test(arg) || (longForm !== null && (arg === longForm || arg.startsWith(`${longForm}=`))));
}

// A `--`-flag is an abbreviation of `full` when its non-empty name is a prefix
// of `full` (getopt_long accepts any unambiguous prefix, down to one letter).
// Over-refusing an ambiguous prefix is fine — fail-closed. Not exhaustive
// across all tools, which is why the allowlist is best-effort and gated off
// the sandbox.
function isLongAbbrev(arg: string, full: string): boolean {
	const name = arg.replace(/^--/, "").split("=")[0];
	return arg.startsWith("--") && name.length >= 1 && full.startsWith(name);
}
// sort writes with -o/--output (abbrev) and runs a program with --compress-program (abbrev).
const SORT_WRITES = (args: string[]) => hasShortFlag("o", "--output")(args) || args.some((arg) => isLongAbbrev(arg, "output") || isLongAbbrev(arg, "compress-program"));
const FILE_COMPILES = hasShortFlag("C", null);
// Leading `-s` only, not the cluster: `date -Iseconds` is a read the cluster
// regex would misread as carrying `s`.
const DATE_SETS = (args: string[]) => args.some((arg) => /^-s/.test(arg) || arg === "--set" || arg.startsWith("--set="));
const UNIQ_OPTARG_FLAGS = new Set(["-f", "-s", "-w"]);

/**
 * Positional args of uniq, skipping the optargs of -f/-s/-w so `uniq -f 2 a`
 * reads as one path. A bare `-` counts as a positional: it is the stdin input
 * operand, so in `uniq - out` the second word is an output file.
 */
function uniqPositionals(args: string[]): number {
	let count = 0;
	for (let index = 0; index < args.length; index += 1) {
		if (UNIQ_OPTARG_FLAGS.has(args[index])) index += 1;
		else if (!args[index].startsWith("-") || args[index] === "-") count += 1;
	}
	return count;
}

const INSPECTOR_SCREENS: Record<string, (args: string[]) => string | null> = {
	sort: (args) => SORT_WRITES(args) ? "sort -o/--output writes a file" : null,
	uniq: (args) => uniqPositionals(args) > 1 ? "uniq with a second path writes it" : null,
	date: (args) => DATE_SETS(args) ? "date -s/--set mutates the clock" : null,
	file: (args) => FILE_COMPILES(args) ? "file -C compiles a magic file to disk" : null,
	rg: (args) => args.some((arg) => ["--pre", "--hostname-bin"].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) ? "rg --pre/--hostname-bin launches an external command" : null,
};

const FIND_FORBIDDEN = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"];

/**
 * Tokenize one segment the way bash would hand words to the command, so the
 * allowlist validates what actually executes: quotes are stripped ("--output"
 * must match the forbidden flag), and the transformations that could disguise
 * a flag — backslash escapes and unquoted `$` expansion — are refused rather
 * than modeled. Single-quoted content is literal in bash, so anything inside
 * it (including `$`) is safe to pass through.
 */
function tokenizeSegment(segment: string): { tokens: string[] } | { refusal: string } {
	const tokens: string[] = [];
	let current = "";
	let index = 0;
	const flush = () => {
		if (current) tokens.push(current);
		current = "";
	};
	while (index < segment.length) {
		const char = segment[index];
		if (char === "\\") return { refusal: "backslash escaping can disguise a forbidden flag" };
		if (char === "$") return { refusal: "unquoted $ expands before the command runs" };
		if (char === "{" || char === "}") return { refusal: "unquoted brace expansion rewrites tokens before the command runs" };
		if (char === "*" || char === "?" || char === "[") return { refusal: "unquoted glob expansion can inject repo-controlled filenames as flags; quote the pattern" };
		if (char === "'" || char === '"') {
			const end = segment.indexOf(char, index + 1);
			if (end === -1) return { refusal: "unterminated quote" };
			const inner = segment.slice(index + 1, end);
			if (char === '"' && /[\\$]/.test(inner)) return { refusal: "expansion inside double quotes" };
			current += inner;
			index = end + 1;
		} else if (/\s/.test(char)) {
			flush();
			index += 1;
		} else {
			current += char;
			index += 1;
		}
	}
	flush();
	return { tokens };
}

function segmentRefusal(segment: string): string | null {
	const tokenized = tokenizeSegment(segment);
	if ("refusal" in tokenized) return tokenized.refusal;
	const tokens = tokenized.tokens;
	if (tokens.length === 0) return "empty command segment";
	const command = tokens[0];
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command)) return `env-assignment prefix "${command}" is not allowed`;
	const args = tokens.slice(1);
	if (command === "git") return gitRefusal(args);
	if (PLAIN_INSPECTORS.has(command)) return INSPECTOR_SCREENS[command]?.(args) ?? null;
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
	const stripped = command.replace(/\d?>&\d/g, " ").replace(/\d?>>?\s*\/dev\/null(?=\s|$)/g, " ");
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
