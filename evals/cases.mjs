// Eval cases. Each runs a real `flow` delegation (through real `pi`) and is scored
// on TWO independent axes:
//   1. an objective `score(result, ctx)` — deterministic behaviour checks (a known
//      answer, the chosen route, the gate passing). This is the plumbing gate.
//   2. a `criterion` plus optional named `criteria` dimensions — literal rubrics
//      the cross-model thulr judge grades the answer against.
// A case passes only when BOTH agree, so plumbing correctness and answer quality
// are checked separately (decomposed evaluators, not one god-metric).
//
// Shape:
//   name      – stable id (also used by --filter)
//   params    – the `flow` tool input
//   cwd       – optional working directory for the child agents
//   criterion – primary strict, literal criterion for the judge (required)
//   criteria  – optional named thulr.criteria.<dimension> rubrics
//   score(result, ctx) -> { pass, score, notes }   // objective, deterministic
//   mock      – a canned result used by `run.mjs --dry-run` to exercise the runner
//               offline. It should make `score` pass and document the expected shape.
//
// CALIBRATION_CASES are fixed judge canaries, not live flow delegations. They put
// known-bad and partial answers into thulr's EvalRun so calibration has true
// negatives and score headroom without making the subject run slower or flakier.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PATTERN_CALIBRATION_CASES, PATTERN_CASES } from "./pattern-cases.mjs";

const fixturesRepo = fileURLToPath(new URL("./fixtures/repo", import.meta.url));
const text = (r) => r?.content?.[0]?.text ?? "";
const agentsRun = (r) => (r?.details?.results ?? []).map((x) => x.agent);

export const CASES = [
	...PATTERN_CASES,
	{
		name: "route-classifies-bug-to-recon",
		params: { task: "The billing webhook handler in this repo returns HTTP 500 on every call in production. Find the root cause and name the specific defect.", route: { candidates: ["recon", "strategist", "overwatch"], fallback: "recon" } },
		cwd: fixturesRepo,
		criterion: "Identifies the root cause: recordPayment references `ledger` — an in-memory store that is never declared or initialized — so every webhook call throws a ReferenceError and the endpoint returns HTTP 500.",
		criteria: {
			correctness: "Identifies `recordPayment` referencing undeclared or uninitialized `ledger` as the specific root cause of the production HTTP 500s.",
			evidence_quality: "Grounds the answer in the fixture code by naming `billing-webhook.js`, `recordPayment`, or `ledger` rather than giving only generic debugging advice.",
		},
		judgeOnlyDimensions: ["evidence_quality"],
		journeyStage: "routing",
		score(r) {
			const body = text(r);
			const routed = agentsRun(r).includes("recon") || /\brecon\b/i.test(body);
			const foundCause = /ledger/i.test(body) && /(never (defined|declared|initial)|not (defined|declared|initial)|undeclared|undefined|referenceerror)/i.test(body);
			return { pass: routed && foundCause, score: routed && foundCause ? 1 : foundCause ? 0.5 : 0, notes: routed && foundCause ? "routed to recon; found the undeclared `ledger` bug" : `routed=${routed} foundCause=${foundCause}: ${body.slice(0, 160)}` };
		},
		mock: { content: [{ type: "text", text: "ROUTE: recon. Root cause: recordPayment references `ledger`, which is never declared, so each call throws a ReferenceError and the endpoint returns HTTP 500 (billing-webhook.js)." }], details: { mode: "route", results: [{ agent: "controller" }, { agent: "recon" }] } },
	},
	{
		name: "recon-retrieves-known-value",
		params: { agent: "recon", task: "Find the value assigned to SAMPLE_IDENTIFIER in this repo and report exactly that value." },
		cwd: fixturesRepo,
		criterion: "The response contains the exact SAMPLE_IDENTIFIER value `xyzzy-42`; a terse answer of only `xyzzy-42` is acceptable.",
		criteria: {
			exactness: "Reports the exact value `xyzzy-42` with no spelling drift, alternate value, or explanatory hedge that changes the value.",
		},
		journeyStage: "grounding",
		score(r) {
			const found = /xyzzy-42/.test(text(r));
			return { pass: found, score: found ? 1 : 0, notes: found ? "found SAMPLE_IDENTIFIER=xyzzy-42" : `value not found: ${text(r).slice(0, 120)}` };
		},
		mock: { content: [{ type: "text", text: "SAMPLE_IDENTIFIER is xyzzy-42" }], details: { mode: "single", results: [{ agent: "recon" }] } },
	},
	{
		name: "return-contract-preserves-evidence",
		params: {
			agent: "recon",
			task: "Find the value assigned to SAMPLE_IDENTIFIER in this repo. Reply with one sentence containing the value and the evidence path (the file it lives in).",
			returnContract: "Return one sentence containing the value and the evidence path.",
			requireEvidence: true,
		},
		cwd: fixturesRepo,
		criterion: "The response contains both the SAMPLE_IDENTIFIER value (xyzzy-42) and a citation of where it was found (a file name or path such as settings.txt).",
		criteria: {
			exactness: "Reports the exact value `xyzzy-42`.",
			evidence_quality: "Names the evidence location, such as `settings.txt` or the `SAMPLE_IDENTIFIER` assignment.",
			contract_adherence: "Uses the requested compact return contract: one sentence containing both the value and the evidence path.",
		},
		journeyStage: "contract",
		score(r) {
			const body = text(r);
			const found = /xyzzy-42/.test(body);
			const cited = /settings\.txt/i.test(body) || /SAMPLE_IDENTIFIER/i.test(body);
			return { pass: found && cited, score: found && cited ? 1 : found ? 0.5 : 0, notes: found && cited ? "value and evidence survived the contract" : `missing value or evidence: ${body.slice(0, 160)}` };
		},
		mock: { content: [{ type: "text", text: "SAMPLE_IDENTIFIER is xyzzy-42 in evals/fixtures/repo/settings.txt." }], details: { mode: "single", results: [{ agent: "recon" }] } },
	},
	{
		name: "vote-reaches-known-consensus",
		params: { task: "Is the regex /^(a+)+$/ vulnerable to catastrophic backtracking? Answer YES or NO and give a one-line reason.", vote: { voters: [{ agent: "recon" }, { agent: "overwatch" }], debrief: { agent: "debrief" } } },
		criterion: "The response concludes YES — the regex /^(a+)+$/ IS vulnerable to catastrophic backtracking (ReDoS).",
		criteria: {
			correctness: "Concludes YES: `/^(a+)+$/` is vulnerable to catastrophic backtracking / ReDoS.",
			reason_quality: "Mentions the nested quantifier or catastrophic backtracking mechanism, not merely a bare yes/no.",
		},
		journeyStage: "consensus",
		score(r) {
			const yes = /\byes\b/i.test(text(r)) && !/\bno\b\s*[,.]?\s*not\b/i.test(text(r));
			return { pass: yes, score: yes ? 1 : 0, notes: yes ? "consensus: yes (vulnerable)" : `expected YES: ${text(r).slice(0, 120)}` };
		},
		mock: { content: [{ type: "text", text: "Flow vote: 2/2 voters succeeded. Consensus: YES, it is vulnerable to catastrophic backtracking." }], details: { mode: "vote", results: [{ agent: "recon" }, { agent: "overwatch" }] } },
	},
	{
		name: "vote-warns-on-same-model-voters",
		params: { task: "Is 2+2=4? Answer YES or NO and give a one-line reason.", vote: { agent: "recon", count: 2 } },
		criterion: "The response answers YES — 2+2 does equal 4.",
		criteria: {
			correctness: "Answers YES: 2+2 equals 4.",
			contract_adherence: "Surfaces that the voters share the same model or otherwise warns about correlated same-model voting.",
		},
		journeyStage: "consensus",
		score(r) {
			const body = text(r);
			const warned = /share model|same-model|Vendor-diverse/i.test(body);
			const yes = /\byes\b/i.test(body);
			return { pass: warned && yes, score: warned && yes ? 1 : warned ? 0.5 : 0, notes: warned && yes ? "same-model warning surfaced with correct answer" : `warning or answer missing: ${body.slice(0, 160)}` };
		},
		mock: { content: [{ type: "text", text: '> ⚠ All 2 voters share model "(default)". Vendor-diverse voting breaks correlated errors.\n\nYES, 2+2=4.' }], details: { mode: "vote", results: [{ agent: "recon" }, { agent: "recon" }] } },
	},
	{
		name: "evaluate-loop-completes-with-gate",
		workspace: true,
		params: {
			// The operator->redteam->revise loop legitimately runs past the default
			// 120s/agent on a cheap subject model; the case declares its own clock.
			timeoutMs: 300_000,
			task: "In the current working directory, create a file `isPrime.js` that exports a function `isPrime(n)` via CommonJS (`module.exports = { isPrime }`), returning true if and only if n is a prime number. Handle edge cases correctly: 0 and 1 are NOT prime, 2 IS prime, and negative numbers are NOT prime.",
			evaluate: {
				operator: { agent: "operator" },
				redteam: { agent: "redteam" },
				checkCommand: `node -e "const {isPrime}=require('./isPrime.js'); const ok=isPrime(2)&&isPrime(3)&&isPrime(13)&&!isPrime(0)&&!isPrime(1)&&!isPrime(9)&&!isPrime(-7); process.exit(ok?0:1)"`,
				maxIterations: 3,
				passContract: "isPrime(2), isPrime(3), isPrime(13) return true; isPrime(0), isPrime(1), isPrime(9), isPrime(-7) return false; the module exports { isPrime } via CommonJS.",
			},
		},
		criterion: "The produced isPrime returns true for 2, 3, and 13, and false for 0, 1, 9, and negative numbers, exported via CommonJS as { isPrime }.",
		criteria: {
			correctness: "The implementation handles prime/composite edge cases: true for 2, 3, 13 and false for 0, 1, 9, and negative numbers.",
			contract_adherence: "Exports `{ isPrime }` via CommonJS from `isPrime.js` in the current working directory.",
		},
		journeyStage: "test",
		score(r, ctx) {
			if (ctx?.dryRun) return { pass: true, score: 1, notes: "(dry-run: gate not executed)" };
			try {
				execFileSync("node", ["-e", "const {isPrime}=require('./isPrime.js'); const ok=isPrime(2)&&isPrime(3)&&isPrime(13)&&!isPrime(0)&&!isPrime(1)&&!isPrime(9)&&!isPrime(-7); process.exit(ok?0:1)"], { cwd: ctx.flowCtx.cwd, stdio: "ignore" });
				return { pass: true, score: 1, notes: "isPrime.js passes the prime assertion in the workspace" };
			} catch {
				return { pass: false, score: 0, notes: "isPrime.js missing or fails the prime assertion (0/1/2/negative edge cases)" };
			}
		},
		mock: { content: [{ type: "text", text: "Created isPrime.js exporting { isPrime }; the node gate passed." }], details: { mode: "evaluate", results: [{ agent: "operator", exitCode: 0 }, { agent: "redteam", exitCode: 0 }] } },
	},
	{
		name: "single-answer-quality-judged",
		control: true,
		controlReason: "Simple answer-only task. Used as a threshold/control case: if flows ties plain pi with overhead, parent selection should not invoke flow for this shape.",
		params: { agent: "analyst", task: "In 2-3 sentences, explain why prompt injection is a risk when one model's output is fed into another model's prompt." },
		criterion: "The answer states that untrusted content carried in a handoff can contain injected instructions that the receiving model may follow or obey.",
		criteria: {
			correctness: "States that untrusted handoff content can contain instructions the receiving model may follow.",
			risk_mechanism: "Explains the mechanism: the second model may treat prior model output as prompt text rather than untrusted data.",
			conciseness: "Stays within the requested 2-3 sentence range.",
		},
		judgeOnlyDimensions: ["risk_mechanism"],
		journeyStage: "answer",
		score(r) {
			const produced = text(r).trim().length > 0;
			return { pass: produced, score: produced ? 1 : 0, notes: produced ? "produced an answer (quality graded by judge)" : "no answer produced" };
		},
		mock: { content: [{ type: "text", text: "Because the second model treats the first model's output as part of its instructions, an attacker who controls that output can smuggle commands the second model then obeys." }], details: { mode: "single", results: [{ agent: "analyst" }] } },
	},
	// --- Harder cases (hard:true) -------------------------------------------------
	// Multi-part criteria that a single pass typically only partially satisfies, so
	// thulr's judge scores them mid-scale (not 1.0) and a better prompt/config can
	// climb — i.e. real headroom for the optimizer. They are score-TRACKED, not
	// pass-gated: they feed the EvalRun + the --score-guardrail, but run.mjs does not
	// require them to pass for exit 0 (only a regression in their score blocks).
	{
		name: "review-finds-all-webhook-defects",
		hard: true,
		// Exhaustive multi-defect reviews on a cheap reasoning subject can take
		// >300s; hard cases are meaty by design, so they declare a longer clock.
		params: { agent: "recon", timeoutMs: 600_000, task: "Review billing-webhook.js in this repo for ALL production-correctness defects. Name each distinct defect you find and why it matters." },
		cwd: fixturesRepo,
		criterion: "The review identifies ALL FOUR distinct defects: (1) recordPayment references `ledger`, which is never declared/initialized, so every call throws a ReferenceError (500); (2) no idempotency/deduplication, so a duplicate or retried delivery double-counts the payment; (3) no verification of the webhook's signature/authenticity, so a forged request is accepted as a real payment; (4) no input validation or error handling, so a malformed `req.body.data.object` throws unhandled and 500s. Fewer than four is incomplete.",
		criteria: {
			completeness: "Identifies all four webhook defects: undeclared `ledger`, missing idempotency/deduplication, missing signature/authenticity verification, and missing payload validation/error handling.",
			evidence_quality: "Every defect is pinned to the specific code that causes it instead of listing generic webhook risks.",
			impact_explanation: "Every defect states its concrete production impact, including 500s, double-counted payments, forged requests, or malformed-payload failures.",
		},
		judgeOnlyDimensions: ["evidence_quality", "impact_explanation"],
		journeyStage: "review",
		score(r) {
			const body = text(r);
			const ledger = /ledger/i.test(body) && /(never (declared|defined|initiali)|undeclared|undefined|referenceerror|not (declared|defined|initiali))/i.test(body);
			const idempotency = /idempoten|dedup|duplicat|replay|retr(y|ied|ies)|deliver(ed|y|ies)[^.]{0,24}(twice|again|multiple|more than once)|double[- ]?(count|charg|bill|pay)/i.test(body);
			const signature = /signatur|verif|authentic|hmac|webhook secret|signing secret|spoof|forge|unauthenticated|anyone (can|could) (post|call|send|forge)|no auth/i.test(body);
			const validation = /(no|missing|lack|without|absent)[^.]{0,24}(validat|saniti[sz]|error handl|guard|null check|type check)|req\.body[^.]{0,30}(undefined|missing|malformed|unchecked|unvalidated)|malformed (payload|body|request|invoice)|unhandled|try.?\/?catch|throws? if[^.]{0,24}(body|payload|missing|malformed)/i.test(body);
			const found = [ledger && "undeclared-ledger", idempotency && "no-idempotency", signature && "no-signature-check", validation && "no-input-validation"].filter(Boolean);
			return { pass: found.length === 4, score: found.length / 4, notes: `defects: ${found.join(", ") || "none"} (${found.length}/4)` };
		},
		mock: { content: [{ type: "text", text: "Four defects: (1) recordPayment references `ledger`, never declared, so every call throws a ReferenceError and 500s; (2) no idempotency/dedup, so a duplicate webhook delivery double-counts the payment; (3) no signature/authenticity verification, so a forged request is accepted as a real payment; (4) no input validation or error handling, so a malformed req.body.data.object throws unhandled and 500s." }], details: { mode: "single", results: [{ agent: "recon" }] } },
	},
	{
		name: "review-finds-session-cache-defects",
		hard: true,
		params: { agent: "recon", timeoutMs: 600_000, task: "Review session-cache.js in this repo for ALL correctness and reliability defects. Name each distinct defect you find and why it matters." },
		cwd: fixturesRepo,
		criterion: "The review identifies ALL THREE distinct defects: (1) getSession reads `entry.expiresAt` without checking the id exists, so an unknown/missing id dereferences `undefined` and throws a TypeError; (2) expired entries are never evicted (getSession returns null but leaves them), so the store grows unbounded — a memory leak; (3) ttlSeconds is never validated, so a missing, NaN, or negative TTL produces a broken/garbage expiry. Fewer than three is incomplete.",
		criteria: {
			completeness: "Identifies all three session-cache defects: missing-id dereference, expired entries never evicted, and unvalidated `ttlSeconds`.",
			evidence_quality: "Pins every defect to the specific `session-cache.js` behavior instead of only stating general cache best practices.",
			impact_explanation: "Explains the concrete TypeError, unbounded memory growth, and broken expiry caused by the three defects.",
		},
		judgeOnlyDimensions: ["evidence_quality", "impact_explanation"],
		journeyStage: "review",
		score(r) {
			const body = text(r);
			// Broadened after a real false negative: the model wrote "without a miss
			// guard / unknown id throws / cache miss can crash", none of which the old
			// pattern matched. Match the concept (a missing/unknown id or cache miss
			// dereferences/throws, or a missing existence guard), not one phrasing.
			const existence = /\btypeerror\b|(unknown|missing|absent|non-?existent|invalid|unrecogni[sz]ed)[^.]{0,30}\b(id|key|entry|session|lookup)\b|\bcache[- ]?miss\b|(entry|session|getsession)[^.]{0,40}(undefined|null|throw|crash|deref|not[^.]{0,8}(exist|found|present))|(no|missing|without|lacks?|add|needs?)[^.]{0,25}(existence|presence|null|miss|nil)?[- ]?(guard|check)|\bmiss[- ]?guard\b/i.test(body);
			const leak = /memory leak|never (evict|delet|remov|clean|free|purg)|unbounded|grow[^.]{0,16}(forever|unbounded|indefinit|without bound)|not[^.]{0,8}(evict|delet|remov|clean|purg)|\bleak/i.test(body);
			const ttl = /ttlseconds|\bttl\b/i.test(body) && /validat|negativ|\bnan\b|invalid|unchecked|non-numeric|immortal|never expir/i.test(body);
			const found = [existence && "no-existence-check", leak && "memory-leak", ttl && "no-ttl-validation"].filter(Boolean);
			return { pass: found.length === 3, score: found.length / 3, notes: `defects: ${found.join(", ") || "none"} (${found.length}/3)` };
		},
		mock: { content: [{ type: "text", text: "Three defects: (1) getSession reads `entry.expiresAt` without checking the id exists, so an unknown id dereferences undefined and throws a TypeError; (2) expired entries are never evicted, so the store grows unbounded — a memory leak; (3) ttlSeconds is never validated, so a missing, NaN, or negative TTL produces a broken expiry." }], details: { mode: "single", results: [{ agent: "recon" }] } },
	},
];

export const CALIBRATION_CASES = [
	...PATTERN_CALIBRATION_CASES,
	{
		name: "calibration-known-value-wrong",
		task: "Find the value assigned to SAMPLE_IDENTIFIER in this repo and report exactly that value.",
		answer: "SAMPLE_IDENTIFIER is xyzzx-42.",
		criterion: "The response contains the exact SAMPLE_IDENTIFIER value `xyzzy-42`; no near-miss spelling or alternate value is acceptable.",
		criteria: {
			exactness: "Reports the exact value `xyzzy-42` with no near-miss spelling.",
		},
		expectedBehavior: "A correct answer must report exactly `xyzzy-42`.",
		objective: { pass: false, score: 0, notes: "known-bad fixture: wrong SAMPLE_IDENTIFIER value" },
		failureModes: ["final_answer.factually_wrong"],
	},
	{
		name: "calibration-webhook-partial-review",
		task: "Review billing-webhook.js in this repo for ALL production-correctness defects. Name each distinct defect you find and why it matters.",
		answer: "The main production defect is that recordPayment references `ledger`, which is never declared, so webhook calls throw and return 500. It should also validate the payload shape before reading req.body.data.object.",
		criterion: "The review identifies ALL FOUR distinct defects: (1) recordPayment references `ledger`, which is never declared/initialized, so every call throws a ReferenceError (500); (2) no idempotency/deduplication, so a duplicate or retried delivery double-counts the payment; (3) no verification of the webhook's signature/authenticity, so a forged request is accepted as a real payment; (4) no input validation or error handling, so a malformed `req.body.data.object` throws unhandled and 500s. Fewer than four is incomplete.",
		criteria: {
			completeness: "Identifies all four webhook defects: undeclared `ledger`, missing idempotency/deduplication, missing signature/authenticity verification, and missing payload validation/error handling.",
			evidence_quality: "Connects each reported defect to concrete code behavior in `billing-webhook.js` instead of listing generic webhook risks.",
		},
		judgeOnlyDimensions: ["evidence_quality"],
		expectedBehavior: "A correct answer must name all four webhook defects; naming only ledger and validation is partial.",
		objective: { pass: false, score: 0.5, notes: "known-partial fixture: names 2/4 webhook defects" },
		failureModes: ["final_answer.incomplete"],
	},
	{
		name: "calibration-consensus-wrong-answer",
		task: "Is the regex /^(a+)+$/ vulnerable to catastrophic backtracking? Answer YES or NO and give a one-line reason.",
		answer: "NO. The anchors keep the input bounded, so this regex is safe from catastrophic backtracking.",
		criterion: "The response concludes YES — the regex /^(a+)+$/ IS vulnerable to catastrophic backtracking (ReDoS).",
		criteria: {
			correctness: "Concludes YES: `/^(a+)+$/` is vulnerable to catastrophic backtracking / ReDoS.",
			reason_quality: "Mentions the nested quantifier or catastrophic backtracking mechanism.",
		},
		expectedBehavior: "A correct answer must conclude YES and mention the nested quantifier/backtracking risk.",
		objective: { pass: false, score: 0, notes: "known-bad fixture: wrong ReDoS conclusion" },
		failureModes: ["final_answer.factually_wrong"],
	},
];
