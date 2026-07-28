// The deterministic coordination fault-injection suite: what is injected, what
// containment is expected, and what each case is worth as evidence.
//
// Every case declares four independent checks, because "did it fail safely?" is
// four different questions:
//   outcome       — what the caller is told
//   process       — what coordination actually did (which children were reached)
//   policy        — whether the fault was contained, and whether a clean run was
//                   wrongly blocked
//   residualState — what the fault left behind for a retry to cope with
//
// And every case declares its denominators. `attackOpportunities` counts the
// injected fault deliveries the parent had a chance to catch; `benignOpportunities`
// counts the clean deliveries that must survive untouched. Containment is
// reported as a rate over those denominators rather than as a pile of passing
// assertions, so a case that is *not* contained stays visible instead of being
// quietly omitted from the suite.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { delegationContractId } from "../extensions/pi-flows/delegation.ts";
import { handleEvaluate } from "../extensions/pi-flows/modes/evaluate.ts";
import { handleParallel } from "../extensions/pi-flows/modes/parallel.ts";
import { handleVote } from "../extensions/pi-flows/modes/vote.ts";
import { makeTraceSink, strictTraceError, traceEvidenceIssue } from "../extensions/pi-flows/trace.ts";
import type { DelegationContract, FlowErrorCode, FlowTraceLink, ModeOutput } from "../extensions/pi-flows/types.ts";
import { faultDeps, makeFaultAdapter, type FaultAdapter, type FaultKind, type FaultLedger, type FaultRule, type ReplyScript } from "./fault-adapter.ts";

export const FAULT_SUITE = "fault-injection";

export interface FaultChecks {
	/** What the caller is told: the refusal code, or null when the run must succeed. */
	outcome: { errorCode: FlowErrorCode | null };
	/** What coordination did: children that ran, children refused before spawning, and roles never reached. */
	process: { dispatched: number; refused: number; unreached: string[] };
	/** The containment decision. `contained` is the numerator over attackOpportunities. */
	policy: { contained: boolean; falselyBlocked: boolean };
	/**
	 * What the fault left behind for a retry: whether the refusal offers one, and
	 * how many child handoffs the parent actually banked. A refusal that had
	 * already merged the bad work is not containment.
	 */
	residualState: { retryable: boolean; acceptedHandoffs: number };
}

export interface FaultScenario {
	id: string;
	suite: typeof FAULT_SUITE;
	/** `adversarial` cases inject a fault; `control` cases run the same harness clean. */
	portfolio: "adversarial" | "control";
	/** The adapter rules this scenario actually injects. Empty when the fault is in the scripted reply or the topology. */
	faults: FaultRule[];
	/** How the case is classified. `"none"` means no adapter rule — the fault is the scripted reply or the topology itself. */
	faultKind: FaultKind | "none";
	description: string;
	/** Injected fault deliveries the parent had a chance to contain. */
	attackOpportunities: number;
	/** Clean deliveries this case carries. In a control they are the false-containment denominator; in an adversarial case their survival is pinned by `residualState.acceptedHandoffs`. */
	benignOpportunities: number;
	expected: FaultChecks;
	run: () => Promise<FaultChecks>;
}

// --- shared fixtures -------------------------------------------------------

const returnSchema = { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false };

function contractFor(objective: string): DelegationContract {
	return {
		objective,
		constraints: ["Report only what the workspace supports."],
		nonGoals: [],
		dependencies: [],
		authority: { may: ["read the workspace"], mustNot: ["contact the network"], requiresApproval: [] },
		sideEffectClass: "reversible",
		budget: {},
		acceptanceChecks: ["The answer names the artifact it is based on."],
		returnSchema,
		owner: "parent",
	};
}

const BASE_CONTRACT = contractFor("Return one verified finding.");

function envelopeFor(contract: DelegationContract, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: "pi-flows.return-envelope.v1",
		contractId: delegationContractId(contract),
		status: "completed",
		summary: "Finding recorded.",
		evidence: [{ claim: "finding is in report.txt", source: "report.txt" }],
		artifactReferences: [],
		digests: [],
		changedState: [],
		unresolvedQuestions: [],
		retry: { retryable: false },
		data: { answer: "report.txt" },
		...overrides,
	});
}

function workspace(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-flow-fault-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content, "utf8");
	return dir;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Read the four check families off one completed run.
 *
 * "Contained" means the fault was *surfaced* rather than silently absorbed:
 * either the run refused, or the affected child is visibly failed/refused in the
 * result set. It deliberately does not require a refusal — a fan-out that keeps
 * a healthy sibling and reports the broken one has contained the fault — and it
 * deliberately does not accept a clean answer as containment, which is what a
 * duplicated ballot or a persuasive-but-wrong claim relies on.
 */
function observe(output: ModeOutput, ledger: FaultLedger, watched: string[], options: { attack: boolean }): FaultChecks {
	const errorCode = (output.details.error?.code as FlowErrorCode | undefined) ?? null;
	const surfaced = errorCode !== null || output.details.results.some((result) => result.exitCode !== 0 || result.error);
	return {
		outcome: { errorCode },
		process: {
			dispatched: ledger.dispatches.filter((dispatch) => dispatch.delivery !== "refused").length,
			refused: ledger.countDelivered("refused"),
			unreached: watched.filter((agent) => !ledger.reached(agent)),
		},
		policy: {
			contained: options.attack && surfaced,
			// The mirror error: a clean run that gets refused or degraded anyway.
			falselyBlocked: !options.attack && surfaced,
		},
		residualState: {
			retryable: output.details.error?.retryable ?? false,
			acceptedHandoffs: output.details.results.filter((result) => result.handoff).length,
		},
	};
}

function scenarioRun(
	build: () => { output: Promise<ModeOutput>; adapter: FaultAdapter },
	watched: string[],
	attack: boolean,
): () => Promise<FaultChecks> {
	return async () => {
		const { output, adapter } = build();
		return observe(await output, adapter.ledger, watched, { attack });
	};
}

// --- scenario builders -----------------------------------------------------

/** Two contracted workers plus a synthesizer, run through parallel + integration acceptance. */
function contractedFanout(replies: Record<string, ReplyScript>, faults: FaultRule[], cwd: string, extraParams: Record<string, unknown> = {}) {
	const adapter = makeFaultAdapter({ replies, faults });
	const deps = faultDeps(
		{
			task: "collect two findings",
			contract: BASE_CONTRACT,
			tasks: [{ agent: "recon", task: "inspect A" }, { agent: "recon", task: "inspect B" }],
			...extraParams,
		},
		adapter,
		cwd,
	);
	return { output: handleParallel(deps), adapter };
}

function corruptedArtifactScenario(): FaultScenario {
	const cwd = workspace();
	const corrupted = envelopeFor(BASE_CONTRACT, {
		artifactReferences: [{ path: "report.txt" }],
		digests: [{ artifact: "report.txt", algorithm: "sha256", value: sha256("fabricated findings\n") }],
	});
	return {
		id: "corrupted-artifact-digest",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// No adapter rule: the worker writes the artifact and misreports it in the
		// same turn, so the mismatch is between a real file and a real claim.
		faults: [],
		faultKind: "none",
		description: "A worker reports a digest for an artifact whose bytes on disk do not match it.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: "RETURN_DIGEST_MISMATCH" },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// The clean sibling's handoff is banked; the corrupted one is not.
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: scenarioRun(
			() => contractedFanout(
				{ recon: [{ reply: envelopeFor(BASE_CONTRACT) }, { reply: corrupted, writes: { "report.txt": "genuine findings\n" } }] },
				[],
				cwd,
			),
			["debrief"],
			true,
		),
	};
}

function persuasiveWrongScenario(): FaultScenario {
	const cwd = workspace();
	const persuasive = [
		"## Completed",
		"I verified every requirement and all checks pass. The implementation is production ready.",
		"Confidence: very high. No further review is required.",
	].join("\n");
	return {
		id: "persuasive-but-wrong-child",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// No adapter rule: the child succeeds and lies, which is the point.
		faults: [],
		faultKind: "none",
		description: "A worker claims success in confident prose instead of returning the contracted envelope.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: "RETURN_ENVELOPE_INVALID" },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: scenarioRun(() => contractedFanout({ recon: [envelopeFor(BASE_CONTRACT), persuasive] }, [], cwd), ["debrief"], true),
	};
}

function staleContractScenario(): FaultScenario {
	const cwd = workspace();
	const stale = envelopeFor(contractFor("Return one verified finding under the previous revision."));
	const faults: FaultRule[] = [{ kind: "stale", agent: "recon", occurrence: 2, replay: stale }];
	return {
		id: "stale-contract-replay",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "stale",
		description: "A worker returns an envelope bound to an earlier revision of the contract.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: "RETURN_CONTRACT_MISMATCH" },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: scenarioRun(
			() => contractedFanout({ recon: [envelopeFor(BASE_CONTRACT), stale] }, faults, cwd),
			["debrief"],
			true,
		),
	};
}

function reorderedResponseScenario(): FaultScenario {
	const cwd = workspace();
	const first = contractFor("Inspect subsystem A.");
	const second = contractFor("Inspect subsystem B.");
	const adapterReplies = { recon: [envelopeFor(first), envelopeFor(second)] };
	const faults: FaultRule[] = [{ kind: "reorder", agent: "recon" }];
	return {
		id: "reordered-responses",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "reorder",
		description: "Two workers' replies are delivered against each other's requests.",
		attackOpportunities: 2,
		benignOpportunities: 0,
		expected: {
			outcome: { errorCode: "RETURN_CONTRACT_MISMATCH" },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// Neither reply is banked: the first swapped envelope is already wrong.
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: scenarioRun(() => {
			const adapter = makeFaultAdapter({ replies: adapterReplies, faults });
			const deps = faultDeps(
				{
					task: "inspect both subsystems",
					tasks: [
						{ agent: "recon", task: "inspect A", contract: first },
						{ agent: "recon", task: "inspect B", contract: second },
					],
				},
				adapter,
				cwd,
			);
			return { output: handleParallel(deps), adapter };
		}, ["debrief"], true),
	};
}

function lostResponseScenario(): FaultScenario {
	const cwd = workspace();
	const faults: FaultRule[] = [{ kind: "loss", agent: "recon", occurrence: 2 }];
	return {
		id: "lost-response",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "loss",
		description: "One fan-out worker's response never arrives.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			// Contained without refusing: the loss surfaces as a failed child and the
			// healthy sibling is kept, rather than the run silently reporting 2/2.
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: scenarioRun(
			() => contractedFanout({ recon: envelopeFor(BASE_CONTRACT) }, faults, cwd),
			["debrief"],
			true,
		),
	};
}

function duplicateBallotScenario(): FaultScenario {
	const cwd = workspace();
	const faults: FaultRule[] = [{ kind: "duplicate", agent: "recon", occurrence: 2 }];
	return {
		id: "duplicated-ballot",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "duplicate",
		description: "A voter's ballot is delivered twice, so agreement is self-agreement.",
		attackOpportunities: 1,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 3, refused: 0, unreached: [] },
			// Measured, not asserted away: untyped ballots carry no identity, so a
			// replayed one is indistinguishable from independent agreement. The
			// denominator keeps that gap visible instead of dropping the case.
			policy: { contained: false, falselyBlocked: false },
			// All three handoffs are banked, replay included: nothing in the untyped
			// ballot path can tell the duplicate from an independent second vote.
			residualState: { retryable: false, acceptedHandoffs: 3 },
		},
		run: scenarioRun(() => {
			const adapter = makeFaultAdapter({
				replies: { recon: ["the answer is 42", "the answer is 7"], debrief: "consensus: 42" },
				faults,
			});
			const deps = faultDeps(
				{ task: "agree on the answer", vote: { agent: "recon", count: 2, debrief: { agent: "debrief" } } },
				adapter,
				cwd,
			);
			return { output: handleVote(deps), adapter };
		}, [], true),
	};
}

function exhaustedBudgetScenario(): FaultScenario {
	const cwd = workspace();
	return {
		id: "exhausted-budget",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		// The ceiling is the fault here, not a scripted reply: the run simply costs more than it may.
		faults: [],
		faultKind: "none",
		description: "An expensive fan-out exhausts the flow budget mid-run.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: null },
			// The ceiling bites between children: the second is refused before it spawns.
			process: { dispatched: 1, refused: 1, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// The child that ran before the ceiling is kept; the refused one banks nothing.
			residualState: { retryable: false, acceptedHandoffs: 1 },
		},
		run: async () => {
			const adapter = makeFaultAdapter({ replies: { recon: "finding" }, usage: { input: 100, output: 100, cost: 0.4 } });
			const deps = faultDeps(
				{ task: "collect findings", tasks: [{ agent: "recon", task: "A" }, { agent: "recon", task: "B" }] },
				adapter,
				cwd,
				// Concurrency 1 makes the ceiling bite between children rather than racing them.
				{ concurrency: 1, budget: { maxCostUsd: 0.3, spentCost: 0, spentTokens: 0, spentGeneratedTokens: 0 } },
			);
			const output = await handleParallel(deps);
			// The refusal spawns nothing, so the ledger's event record is the only
			// place it is observable at all — which is why production emits it.
			if (!adapter.ledger.eventNames("budget").includes("child.refused")) {
				throw new Error("the budget refusal left no attributable event behind");
			}
			return observe(output, adapter.ledger, ["debrief"], { attack: true });
		},
	};
}

function sharedWriterRaceScenario(): FaultScenario {
	const cwd = workspace();
	return {
		id: "shared-writer-race",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults: [],
		faultKind: "none",
		description: "Two write-capable workers are pointed at one working directory.",
		attackOpportunities: 1,
		benignOpportunities: 0,
		expected: {
			outcome: { errorCode: "SHARED_WRITE_CWD" },
			// Contained before dispatch: the race never gets a chance to happen.
			process: { dispatched: 0, refused: 0, unreached: ["operator", "debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: scenarioRun(() => {
			const adapter = makeFaultAdapter({ replies: { operator: "edited the file" } });
			const deps = faultDeps(
				{ task: "edit the shared file", tasks: [{ agent: "operator", task: "edit A" }, { agent: "operator", task: "edit B" }] },
				adapter,
				cwd,
			);
			return { output: handleParallel(deps), adapter };
		}, ["operator", "debrief"], true),
	};
}

function partialThenRetryScenario(): FaultScenario {
	const cwd = workspace();
	const partial = envelopeFor(BASE_CONTRACT, { status: "partial", unresolvedQuestions: ["subsystem B was unreachable"], retry: { retryable: true, reason: "transient" } });
	return {
		id: "partial-integration-then-retry",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults: [],
		faultKind: "none",
		description: "A worker returns partial work; the default policy refuses to integrate it and offers a retry.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: "RETURN_ENVELOPE_INCOMPLETE" },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			// The refusal is retryable and only the clean sibling was banked — the two
			// properties a caller needs before retrying.
			residualState: { retryable: true, acceptedHandoffs: 1 },
		},
		run: scenarioRun(() => contractedFanout({ recon: [envelopeFor(BASE_CONTRACT), partial] }, [], cwd), ["debrief"], true),
	};
}

function retryAfterPartialControlScenario(): FaultScenario {
	const partial = envelopeFor(BASE_CONTRACT, { status: "partial", unresolvedQuestions: ["subsystem B was unreachable"], retry: { retryable: true, reason: "transient" } });
	return {
		id: "retry-after-partial-succeeds",
		suite: FAULT_SUITE,
		portfolio: "control",
		faults: [],
		faultKind: "none",
		description: "Retrying the refused fan-out in the same workspace completes and integrates.",
		attackOpportunities: 0,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: false, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		// A real retry: the same workspace the refused partial run left behind,
		// still holding the half-finished artifact that run produced. A fresh
		// workspace would prove nothing about whether the refusal left recoverable
		// state — it would only prove that a clean run is clean.
		run: async () => {
			const cwd = workspace();
			const refused = await contractedFanout(
				{ recon: [{ reply: envelopeFor(BASE_CONTRACT) }, { reply: partial, writes: { "partial-notes.txt": "subsystem A only\n" } }] },
				[],
				cwd,
			).output;
			if (refused.details.error?.code !== "RETURN_ENVELOPE_INCOMPLETE") {
				throw new Error(`retry precondition failed: expected the partial run to be refused, got ${refused.details.error?.code ?? "no error"}`);
			}
			if (!existsSync(path.join(cwd, "partial-notes.txt"))) {
				throw new Error("retry precondition failed: the refusal destroyed the residual artifact the retry has to cope with");
			}
			const retried = contractedFanout({ recon: envelopeFor(BASE_CONTRACT) }, [], cwd);
			const checks = observe(await retried.output, retried.adapter.ledger, ["debrief"], { attack: false });
			if (!existsSync(path.join(cwd, "partial-notes.txt"))) {
				throw new Error("the retry destroyed the residual artifact instead of working alongside it");
			}
			return checks;
		},
	};
}

function benignSlowChildScenario(): FaultScenario {
	const cwd = workspace();
	const faults: FaultRule[] = [{ kind: "delay", agent: "recon", delayMs: 4_000 }];
	return {
		id: "slow-but-within-budget",
		suite: FAULT_SUITE,
		portfolio: "control",
		faults,
		faultKind: "delay",
		description: "A slow child that still finishes inside its ceiling must not be contained.",
		attackOpportunities: 0,
		benignOpportunities: 2,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: false, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 2 },
		},
		run: scenarioRun(
			() => contractedFanout({ recon: envelopeFor(BASE_CONTRACT) }, faults, cwd, { timeoutMs: 30_000 }),
			["debrief"],
			false,
		),
	};
}

function timeoutCeilingScenario(): FaultScenario {
	const cwd = workspace();
	const faults: FaultRule[] = [{ kind: "delay", agent: "recon", delayMs: 90_000 }];
	return {
		id: "delay-past-ceiling",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "delay",
		description: "A child that runs past its ceiling is stopped rather than waited on.",
		attackOpportunities: 2,
		benignOpportunities: 0,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: scenarioRun(
			() => contractedFanout({ recon: envelopeFor(BASE_CONTRACT) }, faults, cwd, { timeoutMs: 5_000 }),
			["debrief"],
			true,
		),
	};
}

function failedVerifierScenario(): FaultScenario {
	const cwd = workspace();
	const faults: FaultRule[] = [{ kind: "failure", agent: "redteam", errorCode: "CHILD_PROVIDER_ERROR" }];
	return {
		id: "verifier-failure",
		suite: FAULT_SUITE,
		portfolio: "adversarial",
		faults,
		faultKind: "failure",
		description: "The independent critic dies mid-run, so no verdict is available to read as a pass.",
		attackOpportunities: 1,
		benignOpportunities: 1,
		expected: {
			outcome: { errorCode: null },
			// The generator ran; the critic ran and failed. Nothing is re-run to
			// paper over it, and the run does not proceed to a second iteration.
			process: { dispatched: 2, refused: 0, unreached: ["debrief"] },
			policy: { contained: true, falselyBlocked: false },
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: async () => {
			const adapter = makeFaultAdapter({
				replies: { operator: "draft", redteam: "VERDICT: PASS" },
				faults,
			});
			const deps = faultDeps({ task: "build the thing", evaluate: { maxIterations: 2 } }, adapter, cwd);
			const output = await handleEvaluate(deps);
			// A dead critic must never be reported as a pass: that is the whole
			// containment claim, and it is not visible in the four check families.
			if (/^Flow evaluate: PASS/.test(output.content[0].text)) {
				throw new Error("a failed critic was reported as a passing verdict");
			}
			return observe(output, adapter.ledger, ["debrief"], { attack: true });
		},
	};
}

function evaluateRetryControlScenario(): FaultScenario {
	const cwd = workspace();
	return {
		id: "critic-revise-then-pass",
		suite: FAULT_SUITE,
		portfolio: "control",
		faults: [],
		faultKind: "none",
		description: "A legitimate revise round must run to completion, not be mistaken for a fault.",
		attackOpportunities: 0,
		benignOpportunities: 4,
		expected: {
			outcome: { errorCode: null },
			process: { dispatched: 4, refused: 0, unreached: [] },
			policy: { contained: false, falselyBlocked: false },
			// evaluate validates verdicts rather than banking typed handoffs.
			residualState: { retryable: false, acceptedHandoffs: 0 },
		},
		run: scenarioRun(() => {
			const adapter = makeFaultAdapter({
				replies: { operator: ["first draft", "revised draft"], redteam: ["VERDICT: REVISE\nmissing tests", "VERDICT: PASS"] },
			});
			const deps = faultDeps({ task: "build the thing", evaluate: { maxIterations: 2 } }, adapter, cwd);
			return { output: handleEvaluate(deps), adapter };
		}, [], false),
	};
}

// --- trace suppression -----------------------------------------------------

/**
 * Trace suppression: the run coordinates correctly but its evidence never
 * reaches disk. Containment for this one lives outside a mode handler — the
 * export fails silently by design, and the strict-mode gate is what refuses to
 * treat the run as evidenced — so it drives a real fan-out through a poisoned
 * sink and then applies the same policy function the dispatch core applies.
 */
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
			task: "collect two findings",
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

// --- manifest --------------------------------------------------------------

export function faultScenarios(): FaultScenario[] {
	return [
		corruptedArtifactScenario(),
		persuasiveWrongScenario(),
		staleContractScenario(),
		reorderedResponseScenario(),
		lostResponseScenario(),
		duplicateBallotScenario(),
		exhaustedBudgetScenario(),
		sharedWriterRaceScenario(),
		traceSuppressionScenario(),
		failedVerifierScenario(),
		partialThenRetryScenario(),
		timeoutCeilingScenario(),
		retryAfterPartialControlScenario(),
		benignSlowChildScenario(),
		evaluateRetryControlScenario(),
	];
}

/** Every fault kind the adapter can inject, so the manifest cannot silently stop exercising one. */
export const FAULT_KINDS: FaultKind[] = ["delay", "loss", "duplicate", "reorder", "failure", "stale"];
