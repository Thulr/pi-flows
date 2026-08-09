// Offline tests for the bash-ro SHARED_WRITE_CWD recovery case (issue #103):
// a concurrent read-only fan-out whose roles carry plain `bash` in one
// checkout is refused, and swapping `bash` for `bash-ro` — the recovery the
// tool guidance documents — is admitted at concurrency > 1. The case scores
// that sequence: one refusal of budget, a recovery that actually runs, and no
// allowSharedWriteCwd:true escape hatch for work the request calls read-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAdmissibilityFailure, flowCallMatchesExpectation, scoreSelection } from "../evals/select.mjs";
import { SELECTION_CASES } from "../evals/selection-cases.mjs";
import { validateCaseCorpus } from "../evals/case-contract.mjs";

const CASE_NAME = "readonly-shell-fanout-bash-ro-recovery";

/** Every direct case dereference goes through this, so a renamed case fails with a named error, not a TypeError. */
function recoveryCase(): any {
	const testCase = SELECTION_CASES.find((candidate: any) => candidate.name === CASE_NAME);
	assert.ok(testCase, `selection case fixture missing — was ${CASE_NAME} renamed?`);
	return testCase;
}

// Taken from the case's own dry-run mock rather than restated here: these
// tests claim to score the sequence the case scores, so a mock that drifts
// must move them too.
/** The fan-out a model reaches for first: shell-capable reviewers, one checkout, default concurrency. */
const PLAIN_BASH_FANOUT: any = recoveryCase().mock.flowCallArgs[0];
/** The documented recovery: the same fan-out with the shell restricted to the read-only allowlist. */
const BASH_RO_FANOUT: any = recoveryCase().mock.flowCallArgs[1];
const WHY = PLAIN_BASH_FANOUT.why;
const READONLY_TASKS: string[] = PLAIN_BASH_FANOUT.tasks.map((task: any) => task.task);

function scored(flowCallArgs: Array<Record<string, unknown>>) {
	return scoreSelection(recoveryCase(), { flowCalls: flowCallArgs.length, flowCallArgs, stoppedAfterFlowCall: true, answer: "" });
}

test("the plain-bash fan-out is refused SHARED_WRITE_CWD and the bash-ro one is admitted", () => {
	// The property the case rests on, asked through the same seam the scorer
	// uses: bash-ro is not write-capable, so two of them may share a checkout.
	assert.equal(callAdmissibilityFailure(PLAIN_BASH_FANOUT)?.code, "SHARED_WRITE_CWD");
	assert.equal(callAdmissibilityFailure(BASH_RO_FANOUT), null);
	// A toolset carrying both is write-capable again — swapping, not adding, is
	// what the guidance says counts.
	const bothShells = { ...PLAIN_BASH_FANOUT, tasks: READONLY_TASKS.map((task: string) => ({ agent: "overwatch", tools: "read,bash,bash-ro", task })) };
	assert.equal(callAdmissibilityFailure(bothShells)?.code, "SHARED_WRITE_CWD");
});

test("refuse-then-bash-ro is the scored recovery: it passes within the one-refusal budget", () => {
	const result = scored([PLAIN_BASH_FANOUT, BASH_RO_FANOUT]);
	assert.equal(result.pass, true, result.notes);
	// And the recovery on its own — a model that never spends the refusal.
	assert.equal(scored([BASH_RO_FANOUT]).pass, true);
});

test("the already-scored recoveries still pass alongside bash-ro", () => {
	// Serialized shell reviewers, and an independent-voter panel that keeps the
	// shell — both change the topology rather than the work.
	const serialized = { ...PLAIN_BASH_FANOUT, concurrency: 1 };
	const voters = {
		why: WHY,
		task: READONLY_TASKS[0],
		vote: { voters: [{ agent: "overwatch", tools: "read,grep,find,ls,bash-ro" }, { agent: "overwatch", tools: "read,grep,find,ls,bash-ro" }] },
	};
	for (const call of [serialized, voters]) {
		const result = scored([PLAIN_BASH_FANOUT, call]);
		assert.equal(result.pass, true, `expected a pass for ${JSON.stringify(call).slice(0, 120)}: ${result.notes}`);
	}
});

test("dropping the shell is not a recovery — the roles could not run the requested commands", () => {
	// Admissible (recon/analyst are not write-capable) but shell-less: the task
	// asks for inspection with read-only shell commands, so crediting this
	// would score abandoning the work as a SHARED_WRITE_CWD recovery.
	const shellLess = {
		why: WHY,
		tasks: [{ agent: "recon", task: READONLY_TASKS[0] }, { agent: "analyst", task: READONLY_TASKS[1] }],
	};
	assert.equal(callAdmissibilityFailure(shellLess), null, "the shell-less fan-out is admissible — only the case shape rejects it");
	assert.equal(scored([PLAIN_BASH_FANOUT, shellLess]).pass, false);
	// Asked of the call itself, the note names the cause — the run-level note
	// reports the first call's mismatch, which would hide it.
	const match = flowCallMatchesExpectation({ arguments: shellLess }, recoveryCase().expectedFlowCall);
	assert.equal(match.pass, false);
	assert.match(match.notes, /no shell in their effective tools/);
});

test("cwd isolation is not a recovery for a task naming one checkout", () => {
	// Distinct per-role cwds make the guard admit the plain-bash pair (it groups
	// by resolved directory), but the request is to inspect this branch in this
	// checkout — so the refusal stops without the work being done.
	const relocated = {
		why: WHY,
		tasks: PLAIN_BASH_FANOUT.tasks.map((task: any, index: number) => ({ ...task, cwd: `/tmp/checkout-${index}` })),
	};
	assert.equal(callAdmissibilityFailure(relocated), null, "distinct cwds are admissible — only the case shape rejects them");
	const match = flowCallMatchesExpectation({ arguments: relocated }, recoveryCase().expectedFlowCall);
	assert.equal(match.pass, false);
	assert.match(match.notes, /outside the requested single checkout/);
	// A subdirectory of the checkout is still the checkout: the roles can read
	// this branch's history from there, so containment — not equality with the
	// root — is the test.
	const subdirectory = flowCallMatchesExpectation(
		{ arguments: { ...BASH_RO_FANOUT, tasks: BASH_RO_FANOUT.tasks.map((task: any) => ({ ...task, cwd: "extensions/pi-flows" })) } },
		recoveryCase().expectedFlowCall,
	);
	assert.equal(subdirectory.pass, true, subdirectory.notes);
	// A role cwd that resolves to the evaluation checkout is not a relocation:
	// the handlers resolve it the same way, and the work runs where asked.
	const sameCheckout = flowCallMatchesExpectation(
		{ arguments: { ...BASH_RO_FANOUT, tasks: BASH_RO_FANOUT.tasks.map((task: any) => ({ ...task, cwd: "." })) } },
		recoveryCase().expectedFlowCall,
	);
	assert.equal(sameCheckout.pass, true, sameCheckout.notes);
	// …and top-level cwd counts only where the tool reads it: a raw parallel call resolves per-role
	// cwd only (integrationRunPlan), so a stray top-level cwd changes nothing
	// and must not fail an otherwise-correct recovery.
	const strayTopLevel = flowCallMatchesExpectation({ arguments: { ...BASH_RO_FANOUT, cwd: "/tmp/elsewhere" } }, recoveryCase().expectedFlowCall);
	assert.equal(strayTopLevel.pass, true, strayTopLevel.notes);
	// In single mode the handler does read it, so there the same field relocates.
	const singleElsewhere = flowCallMatchesExpectation(
		{ arguments: { why: WHY, agent: "overwatch", tools: "read,grep,find,ls,bash-ro", task: READONLY_TASKS[0], cwd: "/tmp/elsewhere" } },
		{ mode: "single", everyRoleSharesCwd: true },
	);
	assert.equal(singleElsewhere.pass, false);
	assert.match(singleElsewhere.notes, /out of the requested checkout/);
});

test("an unchanged retry after the refusal exceeds the budget", () => {
	const result = scored([PLAIN_BASH_FANOUT, PLAIN_BASH_FANOUT]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /exceed the case budget of 1/);
	assert.match(result.notes, /SHARED_WRITE_CWD/);
});

test("the bypass is forbidden for work the request describes as read-only", () => {
	const result = scored([PLAIN_BASH_FANOUT, { ...PLAIN_BASH_FANOUT, allowSharedWriteCwd: true }]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /forbidden shape/);
});

test("every role must itself inspect the history — an off-topic sibling cannot ride the request", () => {
	const mixed = {
		why: WHY,
		tasks: [
			{ agent: "overwatch", tools: "read,grep,find,ls,bash-ro", task: READONLY_TASKS[0] },
			{ agent: "overwatch", tools: "read,grep,find,ls,bash-ro", task: "Summarize README.md." },
		],
	};
	const result = scored([mixed]);
	assert.equal(result.pass, false);
	assert.match(result.notes, /role task 2 did not match/);
	// An invented reviewer halves the requested independence, too.
	const invented = {
		why: WHY,
		tasks: [{ agent: "recon", task: READONLY_TASKS[0] }, { agent: "history-bot", task: READONLY_TASKS[1] }],
	};
	assert.match(scored([invented]).notes, /not bundled flow agents/);
	// Inspection without the requested output is not the delegation either: the
	// harness stops at the admitted call and waives answerPattern, so a role
	// that is never asked for the riskiest commit must fail the binding.
	const noAsk = {
		why: WHY,
		tasks: BASH_RO_FANOUT.tasks.map((task: any) => ({ ...task, task: "Inspect the git commit history on this branch." })),
	};
	const match = flowCallMatchesExpectation({ arguments: noAsk }, recoveryCase().expectedFlowCall);
	assert.equal(match.pass, false);
	assert.match(match.notes, /role task 1 did not match/);
});

test("the case binds the guidance it measures, and preflight fails when that guidance moves", () => {
	const testCase = recoveryCase();
	const guidance = (testCase.sourceExpectations ?? []).find((expectation: any) => expectation.path === "extensions/pi-flows/index.ts");
	assert.ok(guidance, "the case must pin the model-facing recovery guidance in index.ts");
	assert.ok(
		guidance.patterns.some((pattern: string) => /bash-ro counts/.test(pattern)),
		"the pinned patterns must include the `bash -> bash-ro counts` sentence this case measures",
	);
	assert.equal(validateCaseCorpus({ measurement: [], calibration: [], selection: [testCase] }).ok, true);
	// Point the same expectation at a file without the sentence: preflight must
	// fail rather than let the case pass while the guidance says nothing.
	const moved = { ...testCase, sourceExpectations: [{ ...guidance, path: "package.json" }] };
	const validation = validateCaseCorpus({ measurement: [], calibration: [], selection: [moved] });
	assert.equal(validation.ok, false);
	assert.ok(validation.issues.some((issue: string) => issue.includes("does not match")));
});
