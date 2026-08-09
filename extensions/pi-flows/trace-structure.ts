/**
 * Is this JSONL actually a span tree?
 *
 * Separate from the report because it answers a different question. The report
 * says what the runs did; this says whether the rows describing them hold
 * together — every row identified, every parent reachable, every dependency
 * pointing where it claims. A gate that reads the first without the second is
 * reporting on a shape it never checked.
 *
 * Both failure modes matter equally. Accepting corrupt evidence lets an
 * unauditable release through; rejecting sound evidence gets the gate switched
 * off, after which it protects nothing. Every check below is written to fire on
 * corruption and to stay silent on anything a healthy run can legitimately
 * produce — long author-supplied ids, ids containing the list delimiter, and
 * traces written before span roles existed.
 */
import { encodeUnitKey } from "./trace-scope.ts";

export interface TraceSpanRecord {
	trace_id?: string;
	span_id?: string;
	parent_span_id?: string | null;
	name?: string;
	start_time_unix_ms?: number;
	end_time_unix_ms?: number;
	status?: { code?: string; message?: string };
	attributes?: Record<string, unknown>;
}

export function numericAttr(span: TraceSpanRecord, key: string): number {
	const value = span.attributes?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Whether the row carries the attribute at all, regardless of whether its value
 * is usable. Presence and usability are different questions: a rewritten value
 * reads as absent to every typed accessor, so collapsing the two lets a
 * corrupted attribute pass as one that was never written.
 */
export function hasAttr(span: TraceSpanRecord, key: string): boolean {
	return span.attributes?.[key] !== undefined;
}

export function optionalNumericAttr(span: TraceSpanRecord, key: string): number | undefined {
	const value = span.attributes?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringAttr(span: TraceSpanRecord, key: string): string | undefined {
	const value = span.attributes?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function boolAttr(span: TraceSpanRecord, key: string): boolean {
	return span.attributes?.[key] === true;
}

export function optionalBoolAttr(span: TraceSpanRecord, key: string): boolean | undefined {
	const value = span.attributes?.[key];
	return typeof value === "boolean" ? value : undefined;
}

/** Traces written before span roles existed have only root and child spans, so an unlabeled span is a child. */
export function spanRole(span: TraceSpanRecord, root: TraceSpanRecord | undefined): "root" | "child" | "stage" | "event" {
	if (root && span === root) return "root";
	const declared = stringAttr(span, "flow.span_role");
	return declared === "stage" || declared === "event" || declared === "root" ? declared : "child";
}

/** The vocabulary a modern span may declare. Anything else is a row no bucket counts. */
const SPAN_ROLES = new Set(["root", "child", "stage", "event"]);

export interface TraceStructure {
	root?: TraceSpanRecord;
	/** Rows carrying a usable, unique span id. */
	observedSpans: number;
	duplicateSpans: number;
	malformedSpans: number;
	/** Rows beyond what the exporter declared — spans nobody claims to have written. */
	unexpectedSpans: number;
	/**
	 * Dependency links whose keys the writer recorded as never having resolved.
	 * Not corruption: the file is an honest record of a handler bug (a dependsOn
	 * key naming a unit that never registered), so it stays structurally valid
	 * while the count keeps the bug visible.
	 */
	danglingLinks: number;
	invalid: boolean;
}

function reachesRoot(start: TraceSpanRecord, byId: Map<string, TraceSpanRecord>, rootId: string | undefined): boolean {
	const seen = new Set<string>();
	let current: TraceSpanRecord | undefined = start;
	while (current) {
		const id = current.span_id;
		if (typeof id !== "string" || seen.has(id)) return false;
		seen.add(id);
		const parent = current.parent_span_id;
		if (parent === null) return id === rootId;
		if (typeof parent !== "string") return false;
		if (parent === rootId) return true;
		current = byId.get(parent);
	}
	return false;
}

/**
 * A span has to have happened: finite timestamps, no negative duration, and an
 * interval its parent actually covers.
 *
 * Nothing above notices this. Ids stay unique, parents stay reachable, and
 * dependencies stay resolvable while the tree describes an execution that could
 * not have occurred — a child running outside the flow that spawned it.
 */
function timesHold(span: TraceSpanRecord, byId: Map<string, TraceSpanRecord>): boolean {
	const start = span.start_time_unix_ms;
	const end = span.end_time_unix_ms;
	if (!Number.isFinite(start) || !Number.isFinite(end) || (start as number) > (end as number)) return false;
	const parent = typeof span.parent_span_id === "string" ? byId.get(span.parent_span_id) : undefined;
	if (!parent) return true;
	const parentStart = parent.start_time_unix_ms;
	const parentEnd = parent.end_time_unix_ms;
	if (!Number.isFinite(parentStart) || !Number.isFinite(parentEnd)) return false;
	return (parentStart as number) <= (start as number) && (end as number) <= (parentEnd as number);
}

/**
 * Which spans answer to each unit or stage key, so a dependency can be checked
 * against the unit it names rather than merely against the set of ids that exist.
 */
function spansByKey(spans: TraceSpanRecord[]): Map<string, Set<string>> {
	const byKey = new Map<string, Set<string>>();
	for (const span of spans) {
		const id = span.span_id;
		if (typeof id !== "string") continue;
		for (const attribute of ["flow.unit_key", "flow.stage_key"]) {
			const key = stringAttr(span, attribute);
			if (!key) continue;
			byKey.set(key, (byKey.get(key) ?? new Set<string>()).add(id));
		}
	}
	return byKey;
}

/** One row's dependency verdict: whether the metadata holds together, and how many links the writer recorded as unresolved. */
interface DependencyVerdict {
	holds: boolean;
	dangling: number;
}

const BROKEN: DependencyVerdict = { holds: false, dangling: 0 };

function dependenciesHold(span: TraceSpanRecord, knownIds: Set<string>, byKey: Map<string, Set<string>>): DependencyVerdict {
	const declared = stringAttr(span, "flow.depends_on");
	// No dependency metadata at all is a span that declared none. Some of it is a
	// span whose keys were removed while the row still proves they existed, which
	// is corruption wearing the shape of a unit that never depended on anything.
	// The unresolved marker and its truncation flag are metadata of the same
	// kind: either one proves a dependency list existed for them to describe.
	if (!declared) {
		const holds = !hasAttr(span, "flow.depends_on_count")
			&& !hasAttr(span, "flow.depends_on_span_ids")
			&& !hasAttr(span, "flow.depends_on_unresolved")
			&& !hasAttr(span, "flow.depends_on_unresolved_truncated");
		return holds ? { holds: true, dangling: 0 } : BROKEN;
	}
	// Counted from the attribute written for the purpose, falling back to the
	// joined string only for producers that emit no count. Inferring it from a
	// string any cap could have shortened would read an elision as a broken chain.
	const keys = declared.split(",").filter(Boolean);
	const declaredCount = optionalNumericAttr(span, "flow.depends_on_count");
	// The fallback is for producers that emit no count, not for a count that was
	// rewritten into something unreadable. Deriving one from the keys in that case
	// would reconstruct agreement out of the very attribute that was corrupted.
	if (declaredCount === undefined && hasAttr(span, "flow.depends_on_count")) return BROKEN;
	const expected = declaredCount ?? keys.length;
	// Capping can only shorten the joined list, never lengthen it. More keys than
	// the count is therefore corruption, not the truncation case below — and it is
	// what stops a count of zero from agreeing with an emptied id list and waving
	// through a dependency whose target has disappeared. A fractional or negative
	// count fails here or on the length comparison, since a list has whole members.
	if (keys.length > expected) return BROKEN;
	const resolved = (stringAttr(span, "flow.depends_on_span_ids") ?? "").split(",").filter(Boolean);
	// The writer's record of the keys that resolved to nothing. Its presence
	// changes the diagnosis of a shortfall below: ids the writer says never
	// existed are an honest record of a handler bug, not ids erased after the
	// write. The same presence-over-readability rule as the count applies — a
	// marker rewritten into something unreadable is corruption, not absence —
	// and a truncation flag with no list to describe proves a list was removed.
	const unresolvedDeclared = stringAttr(span, "flow.depends_on_unresolved");
	if (unresolvedDeclared === undefined && hasAttr(span, "flow.depends_on_unresolved")) return BROKEN;
	const unresolvedKeys = (unresolvedDeclared ?? "").split(",").filter(Boolean);
	const unresolvedTruncated = optionalBoolAttr(span, "flow.depends_on_unresolved_truncated") === true;
	if (unresolvedDeclared === undefined && hasAttr(span, "flow.depends_on_unresolved_truncated")) return BROKEN;
	if (unresolvedDeclared === undefined) {
		// Without the marker the arithmetic is what it always was: every declared
		// key resolved, so fewer ids than the count means ids were erased. The
		// writer stamps the marker whenever a key fails to resolve, so this shape
		// is one it no longer produces.
		if (resolved.length !== expected) return BROKEN;
	} else if (unresolvedTruncated ? resolved.length + unresolvedKeys.length >= expected : resolved.length + unresolvedKeys.length !== expected) {
		// With the marker, resolved ids and unresolved keys must account for the
		// count exactly — or fall short of it only under the marker's own
		// truncation flag, mirroring the key-list rule below: a list that is
		// whole cannot also be truncated, and a shortfall the flag does not
		// explain is erasure.
		return BROKEN;
	}
	if (resolved.some((id) => !knownIds.has(id))) return BROKEN;
	// Fewer keys than the count happens for exactly one legitimate reason, and the
	// writer marks it. Unmarked, the missing keys were erased, not capped — and
	// treating erasure as capping is what let a shortened list skip every check
	// below. A list that is whole cannot also be truncated.
	const truncated = optionalBoolAttr(span, "flow.depends_on_truncated") === true;
	if (keys.length < expected !== truncated) return BROKEN;
	// A resolved id can be rewritten to another id that exists, which passes a
	// membership test while pointing the chain at the wrong unit. The keys that
	// survived capping are still checked positionally against their ids — all but
	// the last, which the cap may have cut mid-key and left a fragment of. Only
	// what the cap actually destroyed goes unchecked.
	//
	// Unresolved keys hold no position in the id list, so the walk aligns the
	// two lists by letting a key that fails to match fall through as unresolved,
	// then holds those fall-throughs to the writer's own arithmetic: the count
	// minus the resolved ids is exactly how many keys the writer said resolved
	// to nothing. Membership in the unresolved list is deliberately not required
	// of a skipped key — redaction can collapse two different keys into one
	// stored spelling, and a key unresolved at write time may be answered by a
	// span recorded later, so either test would refuse evidence a healthy run
	// can produce. With no marker the budget is zero and the walk is the strict
	// positional check it always was.
	const checkable = truncated ? keys.slice(0, -1) : keys;
	const skipBudget = unresolvedDeclared === undefined ? 0 : expected - resolved.length;
	let matched = 0;
	let skipped = 0;
	for (const key of checkable) {
		if (matched < resolved.length && byKey.get(key)?.has(resolved[matched]) === true) matched += 1;
		else skipped += 1;
	}
	if (skipped > skipBudget) return BROKEN;
	return { holds: true, dangling: skipBudget };
}

/**
 * @param expectation `declared` is the root's own `flow.trace.expected_spans`,
 *   already validated as a positive integer, or undefined when it is missing or
 *   unusable. `present` says whether the attribute was written at all: a trace
 *   that claims an expectation is a modern trace even when the claim is
 *   unreadable, and an unreadable one invalidates it rather than exempting it.
 */
export function traceStructure(traceSpans: TraceSpanRecord[], expectation: { declared?: number; present: boolean }): TraceStructure {
	const declaredExpectation = expectation.declared;
	const identified = traceSpans.filter((span) => typeof span.span_id === "string" && span.span_id.trim());
	const identifiedIds = identified.map((span) => span.span_id as string);
	const knownIds = new Set(identifiedIds);
	const observedSpans = knownIds.size;
	const duplicateSpans = identified.length - observedSpans;
	const malformedSpans = traceSpans.length - identified.length;

	const rootCandidates = traceSpans.filter((span) => span.parent_span_id === null);
	const declaredRoots = traceSpans.filter((span) => stringAttr(span, "flow.span_role") === "root");
	const root = declaredRoots.find((span) => span.parent_span_id === null)
		?? rootCandidates[0]
		?? traceSpans.find((span) => span.name && !span.name.includes(".", "flow.".length));

	// Modern by either signal, so stripping one attribute cannot demote a trace
	// into the legacy path and out of every check below. A genuine legacy trace
	// carries neither and stays exempt.
	const modern = declaredRoots.length > 0
		|| traceSpans.some((span) => stringAttr(span, "flow.span_role") !== undefined)
		|| expectation.present;
	if (!modern) {
		return { root, observedSpans, duplicateSpans, malformedSpans, unexpectedSpans: 0, danglingLinks: 0, invalid: false };
	}

	// A row with no role, or an unrecognized one, is excluded from every bucket
	// and every check — which is precisely why its absence has to be the check.
	const rolesDeclared = traceSpans.every((span) => SPAN_ROLES.has(stringAttr(span, "flow.span_role") as string));
	const rootWellFormed = declaredRoots.length === 1 && rootCandidates.length === 1 && declaredRoots[0] === rootCandidates[0];
	const byId = new Map(identified.map((span) => [span.span_id as string, span]));
	const connected = traceSpans.every((span) => span === root || reachesRoot(span, byId, root?.span_id));
	const byKey = spansByKey(traceSpans);
	const dependencyVerdicts = traceSpans.map((span) => dependenciesHold(span, knownIds, byKey));
	const attributionHolds = dependencyVerdicts.every((verdict) => verdict.holds);
	const danglingLinks = dependencyVerdicts.reduce((sum, verdict) => sum + verdict.dangling, 0);
	const timesContained = traceSpans.every((span) => timesHold(span, byId));
	// Surplus counts as loss of a different kind: rows the exporter never claimed
	// to have written are not evidence it produced.
	const unexpectedSpans = declaredExpectation === undefined ? 0 : Math.max(0, observedSpans - declaredExpectation);
	// A stated expectation nothing can read is not an absent one: the trace still
	// claims a count, and there is no way to check the count it claims.
	const expectationUnusable = expectation.present && declaredExpectation === undefined;

	return {
		root,
		observedSpans,
		duplicateSpans,
		malformedSpans,
		unexpectedSpans,
		danglingLinks,
		invalid: expectationUnusable || !rolesDeclared || !rootWellFormed || !connected || !attributionHolds || !timesContained,
	};
}
