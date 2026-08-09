/**
 * The code-review-v1 result unit: freezing a review request to immutable
 * commit identities before dispatch, and formatting the settled output —
 * verdict derivation over Git-verified typed envelopes, finding salvage from
 * partial, failed, and schema-rejected axes. Split from presets.ts the way
 * validate.ts fronts validate-workflow.ts: presets.ts remains the discovery
 * and expansion facade and re-exports this module's public names.
 */
import { execFileSync } from "node:child_process";
import { Run } from "./run.ts";
import { isFailed, sanitizeText } from "./sanitize.ts";
import type { CapturePolicy, FlowPreset, ModeOutput } from "./types.ts";

function findingLine(finding: any): string {
	const line = Number.isFinite(finding?.startLine) ? `:${finding.startLine}${Number.isFinite(finding?.endLine) && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ""}` : "";
	const severity = typeof finding?.severity === "string" ? finding.severity.toUpperCase() : "FINDING";
	const identity = [finding?.id, finding?.category].filter((item) => typeof item === "string" && item).join("/");
	return `- ${severity} ${finding?.path ?? "(unknown path)"}${line}${identity ? ` [${identity}]` : ""} — ${finding?.claim ?? "(missing claim)"}${finding?.evidence ? ` Evidence: ${finding.evidence}` : ""}${finding?.suggestion ? ` Suggested fix: ${finding.suggestion}` : ""}`;
}

function gitOutput(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return null;
	}
}

export interface CodeReviewRange {
	base: string;
	head: string;
}

/**
 * `symmetric` records the requested range kind. `base...head` is the proposed
 * branch change set (diff from the merge base), which is not the same file set as
 * the two-endpoint `base head` diff once the branches have diverged.
 */
function requestedReviewRefs(task: string): { base: string; head: string; symmetric: boolean } | null {
	const base = task.match(/\bbase(?:\s+(?:commit|sha))?\s*(?:is|=|:)?\s*([0-9a-f]{40,64})\b/i)?.[1];
	const head = task.match(/\bhead(?:\s+(?:commit|sha))?\s*(?:is|=|:)?\s*([0-9a-f]{40,64})\b/i)?.[1];
	if (base && head) return { base, head, symmetric: false };
	// `~` and `^` belong to the ref: `HEAD~1..HEAD` is the range people actually
	// type, and stopping short of the suffix pins the wrong commit or nothing.
	const gitRef = "[A-Za-z0-9][A-Za-z0-9._/^~-]*";
	// A ref may contain dots but never ends in one, and it may end in `^`/`~N`. `\b`
	// gets both wrong: it reads `base...head` as a two-dot range off `base.`, and it
	// backtracks `HEAD^` down to `HEAD` because `^` is not a word character. This
	// ends a ref at anything that cannot continue one, sentence periods included.
	const refEnd = "(?<!\\.)(?![A-Za-z0-9_/^~-])";
	const range = task.match(new RegExp(`\\b(${gitRef})${refEnd}\\s*(\\.{2,3})\\s*(${gitRef})${refEnd}`, "i"));
	if (range) return { base: range[1], head: range[3], symmetric: range[2].length === 3 };
	const against = task.match(new RegExp(`\\b(${gitRef})${refEnd}\\s+against\\s+(${gitRef})${refEnd}`, "i"));
	return against ? { base: against[2], head: against[1], symmetric: false } : null;
}

function resolveCommit(cwd: string, ref: string): string | null {
	const commit = gitOutput(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])?.trim();
	return commit && /^[0-9a-f]{40,64}$/i.test(commit) ? commit.toLowerCase() : null;
}

/** Both arguments are already-resolved commit hashes, so they cannot be read as options. */
function mergeBaseCommit(cwd: string, base: string, head: string): string | null {
	const commit = gitOutput(cwd, ["merge-base", base, head])?.trim();
	return commit && /^[0-9a-f]{40,64}$/i.test(commit) ? commit.toLowerCase() : null;
}

/**
 * Freeze a code-review request before dispatch. Ref syntax remains caller-facing
 * prose, but children and the formatter receive immutable commit identities.
 */
export function preparePresetRun(
	preset: FlowPreset | undefined,
	params: Record<string, unknown>,
	task: string,
	cwd: string,
): { params: Record<string, unknown>; codeReviewRange?: CodeReviewRange } {
	if (preset?.result !== "code-review-v1") return { params };
	const refs = requestedReviewRefs(task);
	const requestedBase = refs && resolveCommit(cwd, refs.base);
	const head = refs && resolveCommit(cwd, refs.head);
	if (!requestedBase || !head) return { params };
	// Freezing a three-dot request at its merge base keeps the pinned pair equal to
	// the change set the caller asked for, so the manifest diff below stays honest.
	const base = refs.symmetric ? mergeBaseCommit(cwd, requestedBase, head) : requestedBase;
	if (!base) return { params };
	const codeReviewRange = { base, head };
	const instruction = `Harness-pinned review range: base ${base}, head ${head}. Review and report exactly these commit identities; do not substitute another range.`;
	const tasks = Array.isArray(params.tasks)
		? params.tasks.map((item) => item && typeof item === "object" && typeof (item as any).task === "string"
			? { ...(item as Record<string, unknown>), task: `${(item as any).task}\n\n${instruction}` }
			: item)
		: params.tasks;
	return { params: { ...params, tasks }, codeReviewRange };
}

/** The findings array a review envelope carries, or none — the one shape every salvage path extracts. */
function envelopeFindings(envelope: { data: unknown } | undefined): any[] {
	const findings = (envelope?.data as any)?.findings;
	return Array.isArray(findings) ? findings : [];
}

function changedFileManifest(cwd: string, base: unknown, head: unknown): Set<string> | null {
	if (typeof base !== "string" || typeof head !== "string") return null;
	const repoRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	if (!repoRoot) return null;
	const resolvedBase = gitOutput(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`])?.trim();
	const resolvedHead = gitOutput(repoRoot, ["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`])?.trim();
	if (resolvedBase?.toLowerCase() !== base.toLowerCase() || resolvedHead?.toLowerCase() !== head.toLowerCase()) return null;
	const names = gitOutput(repoRoot, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z", resolvedBase, resolvedHead, "--"]);
	if (names === null) return null;
	return new Set(names.split("\0").filter(Boolean));
}

/** Apply a harness-owned formatter after the ordinary mode has validated return envelopes. */
export function formatPresetResult(
	preset: FlowPreset,
	output: ModeOutput,
	policy: CapturePolicy,
	cwd = process.cwd(),
	expectedRange?: CodeReviewRange,
): ModeOutput {
	if (preset.result !== "code-review-v1") return output;
	if (output.details.error) {
		// One axis failing validation is a flow error, not a verdict — but a finding
		// the other axis already anchored and had validated is still worth acting on.
		const anchored = output.details.results
			.map((result) => Run.of(result).takeValidatedReturnEnvelope())
			.flatMap(envelopeFindings);
		// A shape-valid envelope the strict schema rejected still carries the
		// child's own claims. Surfacing them as unvalidated — the way incomplete
		// coverage is surfaced — keeps a schema miss from zeroing out the spend,
		// while never letting them count toward a verdict.
		const rejected = output.details.results
			.map((result) => Run.of(result).takeRejectedReturnEnvelope())
			.flatMap(envelopeFindings);
		if (policy.recordContent && (anchored.length || rejected.length)) {
			const sections = [
				anchored.length ? `Findings a validated review axis already anchored:\n${anchored.map(findingLine).join("\n")}` : "",
				rejected.length ? `Findings from a review envelope that failed schema validation (unvalidated — verify before acting):\n${rejected.map(findingLine).join("\n")}` : "",
			].filter(Boolean);
			const text = `${output.content[0]?.text ?? ""}\n\n${sections.join("\n\n")}`;
			output.content = [{ type: "text", text: sanitizeText(text, policy) }];
		}
		return output;
	}
	const completed = output.details.results.filter((result) => result.exitCode === 0 && result.envelope?.status === "completed");
	// A reviewer that skipped a file can still have anchored a real bug in the files
	// it did read. Its envelope cannot prove coverage, so it never counts toward the
	// verdict, but dropping its findings would hide the one thing worth acting on.
	const incomplete = output.details.results.filter((result) => result.exitCode === 0 && result.envelope && !completed.includes(result));
	const envelopes = completed.map((result) => Run.of(result).takeValidatedReturnEnvelope() ?? result.envelope);
	const incompleteEnvelopes = incomplete.map((result) => Run.of(result).takeValidatedReturnEnvelope() ?? result.envelope);
	const incompleteFindings = incompleteEnvelopes.flatMap(envelopeFindings);
	const data = envelopes.map((envelope) => envelope?.data as any);
	const axes = new Set(data.map((item) => item?.axis));
	const coverage = data.map((item) => Array.isArray(item?.coverage) ? item.coverage : []);
	const coverageSets = coverage.map((items) => new Set(items.map((item: any) => item?.path).filter((item: unknown): item is string => typeof item === "string")));
	const sameCoverage = coverageSets.length === 2
		&& coverageSets.every((set, index) => set.size === coverage[index].length)
		&& coverageSets[0].size === coverageSets[1].size
		&& [...coverageSets[0]].every((file) => coverageSets[1].has(file));
	const hasSkipped = coverage.some((items) => items.some((item: any) => item?.status !== "reviewed"));
	const sameRange = data.length === 2
		&& typeof data[0]?.base === "string"
		&& typeof data[0]?.head === "string"
		&& data[0].base.toLowerCase() === data[1]?.base?.toLowerCase()
		&& data[0].head.toLowerCase() === data[1]?.head?.toLowerCase();
	const matchesExpectedRange = Boolean(expectedRange && data.length === 2 && data.every((item) =>
		typeof item?.base === "string"
		&& typeof item?.head === "string"
		&& item.base.toLowerCase() === expectedRange.base
		&& item.head.toLowerCase() === expectedRange.head
	));
	const manifest = expectedRange ? changedFileManifest(cwd, expectedRange.base, expectedRange.head) : null;
	const matchesGitManifest = manifest !== null
		&& coverageSets.length === 2
		&& coverageSets.every((set) => set.size === manifest.size && [...manifest].every((file) => set.has(file)));
	const findings = envelopes.flatMap(envelopeFindings);
	const findingsConsistent = findings.every((finding) =>
		typeof finding?.path === "string"
		&& coverageSets.every((set) => set.has(finding.path))
		&& Number.isFinite(finding?.startLine)
		&& Number.isFinite(finding?.endLine)
		&& finding.endLine >= finding.startLine
	);
	const noUnresolvedState = envelopes.every((envelope) => envelope?.unresolvedQuestions.length === 0 && envelope.changedState.length === 0);
	const complete = completed.length === 2 && axes.size === 2 && axes.has("standards") && axes.has("spec") && sameRange && matchesExpectedRange && sameCoverage && matchesGitManifest && !hasSkipped && findingsConsistent && noUnresolvedState;
	const status = !complete ? "PARTIAL" : findings.length ? "FINDINGS" : "CLEAN";
	output.details.presetOutcome = status;
	const reported = [...findings, ...incompleteFindings];
	const details = policy.recordContent && reported.length ? `\n\n${reported.map(findingLine).join("\n")}` : "";
	// Naming the concrete gap is what makes the verdict actionable: the caller can
	// supply the missing issue context, fix an unreadable path, or rerun narrower.
	const reviewedEnvelopes = [...envelopes, ...incompleteEnvelopes];
	const skipped = reviewedEnvelopes
		.flatMap((envelope) => Array.isArray((envelope?.data as any)?.coverage) ? (envelope!.data as any).coverage : [])
		.filter((item: any) => typeof item?.path === "string" && item.status !== "reviewed")
		.map((item: any) => `${item.path} (${item.status ?? "unknown"})`);
	const questions = reviewedEnvelopes.flatMap((envelope) => envelope?.unresolvedQuestions ?? []);
	// These reviewers run with a bash-ro shell (allowlist-restricted in the
	// child), so state they admit to changing is still what the caller needs
	// to see — allowed verification scripts can write caches.
	const changed = reviewedEnvelopes.flatMap((envelope) => envelope?.changedState ?? []);
	const gapItems = policy.recordContent
		? [
			skipped.length ? `skipped coverage: ${skipped.join(", ")}` : "",
			questions.length ? `unresolved: ${questions.join("; ")}` : "",
			changed.length ? `changed state: ${changed.map((item: any) => typeof item === "string" ? item : JSON.stringify(item)).join("; ")}` : "",
		].filter(Boolean)
		: [];
	const gap = complete ? "" : `\n\nCoverage could not be proven complete across both review axes; do not treat this result as clean.${gapItems.length ? ` Gaps — ${gapItems.join(" · ")}.` : ""}`;
	// This formatter replaces the ordinary parallel summary, so a reviewer that
	// timed out or died would otherwise be reported as an unexplained PARTIAL.
	const failed = output.details.results.filter(isFailed)
		.map((result) => `${result.role ?? result.agent} (${result.error?.code ?? result.stopReason ?? `exit ${result.exitCode}`})`);
	const failureText = failed.length ? `\n\nReview axes that did not return: ${failed.join(", ")}.` : "";
	output.content = [{ type: "text", text: sanitizeText(`Code review: ${status}${details}${gap}${failureText}`, policy) }];
	return output;
}
