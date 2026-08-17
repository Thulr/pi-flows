// Trace-evidence coordination faults: the run coordinates correctly, and its
// evidence never reaches disk.
//
// Containment for this family lives outside any mode handler. The export fails
// silently by design — losing a span must not fail the work — so the strict
// gate is what refuses to treat an unevidenced run as evidenced. A case here
// therefore drives a real fan-out through a poisoned sink, then applies the
// same policy function the dispatch core applies.
import { makeTraceSink, strictTraceError, traceEvidenceIssue } from "../extensions/pi-flows/trace.ts";
import { handleParallel } from "../extensions/pi-flows/modes/parallel.ts";
import type { FlowTraceLink, ModeOutput } from "../extensions/pi-flows/types.ts";
import path from "node:path";
import { faultDeps, makeFaultAdapter, type FaultAdapter } from "./fault-adapter.ts";
import { BASE_CONTRACT, FAULT_SUITE, envelopeFor, observe, workspace, type FaultScenario } from "./fault-scenarios.ts";

export interface TraceSuppressionRun {
	coordinationError: string | null;
	childrenSucceeded: number;
	spansAttempted: number;
	health: string;
	strictIssue: string | null;
	link: FlowTraceLink;
	output: ModeOutput;
	adapter: FaultAdapter;
}

export async function runTraceSuppression(): Promise<TraceSuppressionRun> {
	const cwd = workspace();
	const sink = makeTraceSink(path.join(cwd, "missing-dir", "trace.jsonl"), "parallel", { recordContent: true, redactSecrets: true });
	const adapter = makeFaultAdapter({ replies: { recon: envelopeFor(BASE_CONTRACT) } });
	const deps = faultDeps(
		{
			task: "collect two findings", tier: "capable",
			contract: BASE_CONTRACT,
			tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }],
		},
		adapter,
		cwd,
		{ recordSpan: sink.record, recordEvent: sink.event },
	);
	const output = await handleParallel(deps);
	const link = await sink.finalize({ ok: !output.details.error });
	return {
		coordinationError: output.details.error?.code ?? null,
		childrenSucceeded: output.details.results.filter((result) => result.exitCode === 0).length,
		spansAttempted: link.spans?.expectedSpans ?? 0,
		health: link.health,
		strictIssue: traceEvidenceIssue(link),
		link,
		output,
		adapter,
	};
}

function traceSuppressionScenario(): FaultScenario {
	return {
		id: "trace-suppression-under-strict",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults: [],
		faultKind: "none",
		description: "The trace export is suppressed; strict mode refuses the run rather than the agents.",
		attackOpportunities: 1,
		benignOpportunities: 2,
		expected: {
			// Under strict tracing the missing evidence is the refusal, exactly as the
			// dispatch core reports it.
			outcome: { errorCode: "TRACE_INCOMPLETE" },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// Both children still completed and both handoffs were banked: what was
			// lost is the evidence, not the work.
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		run: async () => {
			const suppressed = await runTraceSuppression();
			const checks = observe(suppressed.output, suppressed.adapter.ledger, ["debrief"], { attack: true });
			// The real gate, not a copy of it: `strictTraceError` is the function the
			// dispatch core calls, so changing the gate changes this case too.
			const strictOutcome = checks.outcome.errorCode ?? strictTraceError(suppressed.link, true)?.code ?? null;
			return {
				...checks,
				outcome: { errorCode: strictOutcome },
				policy: { contained: strictOutcome !== null, falselyBlocked: false },
			};
		},
	};
}

export function traceEvidenceScenarios(): FaultScenario[] {
	return [traceSuppressionScenario()];
}
