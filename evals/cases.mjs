// Eval cases. Each runs a real `flow` delegation (through real `pi`) and is scored
// on TWO independent axes:
//   1. an objective `score(result, ctx)` — deterministic behaviour checks (a known
//      answer, the chosen route, the gate passing). This is the plumbing gate.
//   2. a `criterion` — one strict, literal statement the cross-model LLM judge
//      (run.mjs, on a different vendor than the subject) grades the answer against.
// A case passes only when BOTH agree, so plumbing correctness and answer quality
// are checked separately (decomposed evaluators, not one god-metric).
//
// Shape:
//   name      – stable id (also used by --filter)
//   params    – the `flow` tool input
//   cwd       – optional working directory for the child agents
//   criterion – one strict, literal criterion for the judge (required)
//   score(result, ctx) -> { pass, score, notes }   // objective, deterministic
//   mock      – a canned result used by `run.mjs --dry-run` to exercise the runner
//               offline. It should make `score` pass and document the expected shape.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixturesRepo = fileURLToPath(new URL("./fixtures/repo", import.meta.url));
const text = (r) => r?.content?.[0]?.text ?? "";
const agentsRun = (r) => (r?.details?.results ?? []).map((x) => x.agent);

export const CASES = [
	{
		name: "route-classifies-bug-to-recon",
		params: { task: "The billing webhook handler in this repo returns HTTP 500 on every call in production. Find the root cause.", route: { candidates: ["recon", "strategist", "overwatch"], fallback: "recon" } },
		cwd: fixturesRepo,
		baselinePrompt: "The billing webhook handler in this repo returns HTTP 500 on every call in production. Find the root cause and name the specific defect.",
		criterion: "Identifies the root cause: recordPayment references `ledger` — an in-memory store that is never declared or initialized — so every webhook call throws a ReferenceError and the endpoint returns HTTP 500.",
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
		params: { agent: "recon", task: "Find the value assigned to MAGIC_TOKEN in this repo and report exactly that value." },
		cwd: fixturesRepo,
		criterion: "The response states that the value of MAGIC_TOKEN is xyzzy-42.",
		score(r) {
			const found = /xyzzy-42/.test(text(r));
			return { pass: found, score: found ? 1 : 0, notes: found ? "found MAGIC_TOKEN=xyzzy-42" : `value not found: ${text(r).slice(0, 120)}` };
		},
		mock: { content: [{ type: "text", text: "MAGIC_TOKEN is xyzzy-42" }], details: { mode: "single", results: [{ agent: "recon" }] } },
	},
	{
		name: "return-contract-preserves-evidence",
		params: {
			agent: "recon",
			task: "Find the value assigned to MAGIC_TOKEN in this repo.",
			returnContract: "Return one sentence containing the value and the evidence path.",
			requireEvidence: true,
		},
		cwd: fixturesRepo,
		// The plain-pi A/B arm has no return-contract feature, so give it the same goal in the prompt — a fair control.
		baselinePrompt: "Find the value assigned to MAGIC_TOKEN in this repo. Reply with one sentence containing the value and the evidence path (the file it lives in).",
		criterion: "The response contains both the MAGIC_TOKEN value (xyzzy-42) and a citation of where it was found (a file name or path such as settings.txt).",
		score(r) {
			const body = text(r);
			const found = /xyzzy-42/.test(body);
			const cited = /settings\.txt/i.test(body) || /MAGIC_TOKEN/i.test(body);
			return { pass: found && cited, score: found && cited ? 1 : found ? 0.5 : 0, notes: found && cited ? "value and evidence survived the contract" : `missing value or evidence: ${body.slice(0, 160)}` };
		},
		mock: { content: [{ type: "text", text: "MAGIC_TOKEN is xyzzy-42 in evals/fixtures/repo/settings.txt." }], details: { mode: "single", results: [{ agent: "recon" }] } },
	},
	{
		name: "vote-reaches-known-consensus",
		params: { task: "Is the regex /^(a+)+$/ vulnerable to catastrophic backtracking? Answer YES or NO and give a one-line reason.", vote: { voters: [{ agent: "recon" }, { agent: "overwatch" }], debrief: { agent: "debrief" } } },
		criterion: "The response concludes YES — the regex /^(a+)+$/ IS vulnerable to catastrophic backtracking (ReDoS).",
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
			task: "In the current working directory, create a file `isPrime.js` that exports a function `isPrime(n)` via CommonJS (`module.exports = { isPrime }`), returning true if and only if n is a prime number. Handle edge cases correctly: 0 and 1 are NOT prime, 2 IS prime, and negative numbers are NOT prime.",
			evaluate: {
				operator: { agent: "operator" },
				redteam: { agent: "redteam" },
				checkCommand: `node -e "const {isPrime}=require('./isPrime.js'); const ok=isPrime(2)&&isPrime(3)&&isPrime(13)&&!isPrime(0)&&!isPrime(1)&&!isPrime(9)&&!isPrime(-7); process.exit(ok?0:1)"`,
				maxIterations: 3,
				passContract: "isPrime(2), isPrime(3), isPrime(13) return true; isPrime(0), isPrime(1), isPrime(9), isPrime(-7) return false; the module exports { isPrime } via CommonJS.",
			},
		},
		baselinePrompt: "In the current working directory, create a file `isPrime.js` that exports `isPrime(n)` via CommonJS (`module.exports = { isPrime }`), returning true iff n is prime. 0 and 1 are not prime, 2 is prime, negative numbers are not prime.",
		criterion: "The produced isPrime returns true for 2, 3, and 13, and false for 0, 1, 9, and negative numbers, exported via CommonJS as { isPrime }.",
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
		params: { agent: "analyst", task: "In 2-3 sentences, explain why prompt injection is a risk when one model's output is fed into another model's prompt." },
		criterion: "The answer states that untrusted content carried in a handoff can contain injected instructions that the receiving model may follow or obey.",
		score(r) {
			const produced = text(r).trim().length > 0;
			return { pass: produced, score: produced ? 1 : 0, notes: produced ? "produced an answer (quality graded by judge)" : "no answer produced" };
		},
		mock: { content: [{ type: "text", text: "Because the second model treats the first model's output as part of its instructions, an attacker who controls that output can smuggle commands the second model then obeys." }], details: { mode: "single", results: [{ agent: "analyst" }] } },
	},
];
