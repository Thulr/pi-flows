import * as fs from "node:fs/promises";
import { safePath, sanitizeText } from "./sanitize.ts";
import type { CapturePolicy } from "./types.ts";
import type { FlowTraceStructure } from "./trace-scope.ts";
import { declaresOwnRoot, optionalNumericAttr, stringAttr, traceStructure, type TraceSpanRecord } from "./trace-structure.ts";

/**
 * Reading a finished export back. Kept apart from the sink that wrote it: the
 * writer knows only what it attempted, and the whole point of this question is
 * that it is answered by whoever opens the file afterwards. Separating them
 * also keeps the writer from importing a reader to check its own work.
 */

/** Where an invocation's record begins in its shared, append-only file — the glossary's Record extent (CONTEXT.md). */
export interface RecordExtent {
	start: number;
}

/**
 * The bytes of a shared, append-only file from `start` on — the region an
 * invocation's record occupies (#129). Reading from the extent instead of
 * byte 0 is what keeps a finalize's cost proportional to its own record: in
 * the eval setup one file accumulates every flow of a run, and a whole-file
 * read made flow N traverse flows 1..N-1 just to skip them. The boundary is
 * sound because the file only grows: everything before the extent was on disk
 * before the sink existed, so it cannot carry the sink's random invocation id
 * honestly, and everything a concurrent writer lands afterwards is inside the
 * region and judged as before. `start` may cut a foreign line — a recorded
 * extent under-estimates when a cross-process append raced its capture — and
 * the fragment is skipped by the same marker test as any other foreign row.
 */
async function readExtent(traceFile: string, start: number): Promise<string> {
	if (start <= 0) return fs.readFile(traceFile, "utf8");
	const handle = await fs.open(traceFile, "r");
	try {
		const { size } = await handle.stat();
		const length = Math.max(0, size - start);
		if (length === 0) return "";
		const buffer = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return buffer.toString("utf8", 0, offset);
	} finally {
		await handle.close();
	}
}

/**
 * Read the finished export back and say whether it is a span tree. The strict
 * gate used to answer only from write-time accounting, which cannot see a
 * child parented to a stage nobody wrote or a root that does not reach itself
 * — the refusal text even sent readers to `npm run trace:report --strict` to
 * do this by hand. A run that stakes its verdict on evidence should not be the
 * one caller that never checks it.
 *
 * A read that itself fails is reported as invalid rather than swallowed:
 * evidence nobody could re-read is not evidence.
 *
 * Scoped to this flow's own trace_id AND its invocation id, the way the
 * read-back report groups before validating. One JSONL file routinely holds
 * many flows — an eval sets PI_FLOWS_TRACE_FILE once for a whole run — so
 * validating the file whole would judge every flow after the first against its
 * predecessors' spans and fail it for a surplus that is simply someone else's
 * trace. The trace id alone is not enough (#127): stableTraceIds derives it
 * from the trace context and mode, so two calls sharing both — a project-preset
 * refusal and the retry after it, into one file — write two roots under one id,
 * and a reading scoped only to the id refused the second, healthy, run over the
 * first one's rows. The invocation id is minted per sink, so it separates
 * exactly what the stable id deliberately does not. A row the flow wrote that
 * no longer parses, or that lost its invocation stamp, is caught by the count
 * instead: the trace comes back shorter than it declared. Stampless rows under
 * this trace id inside the record extent are decided by the report's own
 * predicate — a whole run from a pre-discriminator writer is ignored, a
 * remainder no run claims refuses — so the live and report gates agree about
 * everything this invocation could have affected; rows that predate the extent
 * are the report's alone (see readExtent above). The residual is a writer
 * forging both ids inside the extent, which no honest writer produces.
 *
 * `attempted` is what the run has written when this reading happens — the rows
 * that must be present now. `declared` is what the root says, one more than
 * attempted, because the root reserves a slot for the certification this
 * reading produces afterwards. `extent.start` is where the invocation's record
 * begins — the file's size when its sink was born; the default reads the file
 * whole. Rows before the extent predate the invocation: stamped ones were
 * always another run's evidence, and a stampless remainder there is a
 * predecessor's torn record — the whole-file report's business, judged when
 * the file is read whole, the same way rows appended after finalize already
 * are. The live verdict covers the region this invocation could have affected.
 */
export async function verifyExportedTrace(traceFile: string, identity: { traceId: string; invocationId: string }, expectation: { attempted: number; declared: number }, policy: CapturePolicy, extent: RecordExtent = { start: 0 }): Promise<FlowTraceStructure> {
	const { traceId, invocationId } = identity;
	const { attempted, declared } = expectation;
	try {
		// Only this invocation's rows are parsed, and only its own extent is read.
		// A substring test is cheap and JSON.parse is not. The line filter is this
		// module's, the validator below is shared with the report — the same
		// check, not the same reader.
		const traceMarker = `"trace_id":${JSON.stringify(traceId)}`;
		const invocationMarker = `"flow.invocation_id":${JSON.stringify(invocationId)}`;
		const own: TraceSpanRecord[] = [];
		const unclaimed: TraceSpanRecord[] = [];
		let unreadable = 0;
		for (const line of (await readExtent(traceFile, extent.start)).split("\n")) {
			if (!line.includes(traceMarker)) continue;
			if (!line.includes(invocationMarker)) {
				// A shared-trace-id row without this run's stamp. Another invocation's
				// stamp makes it another run's evidence and none of this run's
				// business. No stamp at all is decided below by the same predicate the
				// report's grouping uses; a line that no longer parses is likewise
				// nobody's to claim — one of this run's own rows corrupted that far
				// lands in the missing count instead, so the trace still comes back
				// short.
				try {
					const row = JSON.parse(line) as TraceSpanRecord;
					// Absence through the same accessor the report's grouping reads, so
					// a stamp rewritten into something unusable is "no stamp" at both
					// gates rather than dropped here and counted against us there.
					if (row.trace_id === traceId && stringAttr(row, "flow.invocation_id") === undefined) unclaimed.push(row);
				} catch {}
				continue;
			}
			try {
				const row = JSON.parse(line) as TraceSpanRecord;
				// The substring can sit inside some other value of a foreign row;
				// counting such a row as this run's would refuse a healthy run for a
				// neighbour's payload. The attribute itself is the claim that counts.
				if (row.attributes?.["flow.invocation_id"] === invocationId) own.push(row);
			} catch {
				// A line carrying both markers that no longer parses was this run's row
				// — nothing else writes the invocation id.
				unreadable += 1;
			}
		}
		// The same decision the report's grouping makes, through the same
		// predicate, so the live gate and the report gate cannot disagree about
		// this run. A stampless remainder that declares its own root is a whole
		// run from a writer that predates the discriminator sharing this stable
		// trace id — not this run's problem; one that does not is rows no
		// invocation claims, and the report will count them against this run, so
		// this gate must refuse too rather than certify what the report rejects.
		const unclaimedRemainder = unclaimed.length > 0 && !declaresOwnRoot(unclaimed);
		const structure = traceStructure(own, { declared: attempted, present: true });
		// Accept by the report's own disjunction (trace-report.ts), not a subset of
		// it: `invalid` covers connectivity, attribution, and containment, while
		// duplicates, id-less rows, and surplus are separate counters there — and a
		// verifier that ignores any of them certifies evidence the downstream
		// strict report then rejects. Surplus is the live case: a concurrent
		// writer forging this run's trace and invocation ids leaves the tree
		// connected, so only the count sees it.
		const broken = structure.invalid || structure.duplicateSpans > 0 || structure.malformedSpans > 0 || structure.unexpectedSpans > 0 || unclaimedRemainder;
		const missing = Math.max(0, attempted - own.length);
		// The root records what the run attempted; if the persisted copy disagrees
		// with what this run actually attempted, the row carrying every other
		// accounting attribute has been rewritten, which is exactly the after-write
		// corruption this reading exists to catch — and the number a later
		// `trace:report --strict` would validate against.
		const persisted = structure.root ? optionalNumericAttr(structure.root, "flow.trace.expected_spans") : undefined;
		const expectationRewritten = structure.root !== undefined && persisted !== declared;
		if (!broken && missing === 0 && unreadable === 0 && !expectationRewritten) return { valid: true };
		const faults = [
			missing ? `${missing} of ${attempted} attempted row(s) missing` : "",
			unreadable ? `${unreadable} of this trace's row(s) no longer parse` : "",
			structure.root ? "" : "no root span",
			expectationRewritten ? `the root now declares ${persisted ?? "no"} expected span(s) where the run declared ${declared}` : "",
			structure.duplicateSpans ? `${structure.duplicateSpans} duplicate span id(s)` : "",
			structure.malformedSpans ? `${structure.malformedSpans} span(s) not reaching the root or outside its interval` : "",
			structure.unexpectedSpans ? `${structure.unexpectedSpans} span(s) beyond the ${attempted} attempted` : "",
			unclaimedRemainder ? `${unclaimed.length} row(s) under this trace id that no invocation claims` : "",
		].filter(Boolean);
		return { valid: false, issue: faults.join(", ") || "the exported rows are not a span tree" };
	} catch (error) {
		// A filesystem error names the path it failed on, so it goes out through
		// the same redaction as everything else the flow returns.
		const raw = error instanceof Error ? error.message : String(error);
		return { valid: false, issue: `the trace could not be read back: ${sanitizeText(safePath(raw) ?? raw, { ...policy, recordContent: true }, 512)}` };
	}
}

/**
 * One verdict for a dual reading. The preliminary failure is already durable —
 * the certification event recorded it as a revocation before the final reading
 * ran — so the final reading may confirm it but never overturn it: a live call
 * that out-voted its own persisted record would pass a run whose trace every
 * later reader withholds. The asymmetry is deliberate and fail-closed: a
 * preliminary pass overturned by a final failure refuses (the final state is
 * what the file holds), while a preliminary failure stands even when the final
 * reading recovers.
 */
export function reconcileVerdicts(preliminary: FlowTraceStructure, final: FlowTraceStructure): FlowTraceStructure {
	return preliminary.valid ? final : preliminary;
}
