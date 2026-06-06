// Eval cases. Each runs a real `flow` delegation (through real `pi`) and scores
// the behaviour. Scoring is objective wherever possible (a known answer, the
// chosen route, the gate passing) and falls back to the LLM judge only for
// genuinely subjective quality.
//
// Shape:
//   name    – stable id (also used by --filter)
//   params  – the `flow` tool input
//   cwd     – optional working directory for the child agents
//   score(result, ctx) -> { pass, score, notes }   // may be async (judge)
//   mock    – a canned result used by `run.mjs --dry-run` to exercise the runner
//             offline. It should make `score` pass, documenting the expected shape.
import { fileURLToPath } from "node:url";
import { judge } from "./judge.mjs";

const fixturesRepo = fileURLToPath(new URL("./fixtures/repo", import.meta.url));
const text = (r) => r?.content?.[0]?.text ?? "";
const agentsRun = (r) => (r?.details?.results ?? []).map((x) => x.agent);

export const CASES = [
	{
		name: "route-classifies-bug-to-recon",
		params: { task: "The billing webhook returns 500s in production. Investigate the root cause.", route: { candidates: ["recon", "strategist", "overwatch"], fallback: "recon" } },
		score(r) {
			const dispatched = agentsRun(r).includes("recon") || /\brecon\b/i.test(text(r));
			return { pass: dispatched, score: dispatched ? 1 : 0, notes: dispatched ? "routed to recon" : `did not route to recon: ${text(r).slice(0, 120)}` };
		},
		mock: { content: [{ type: "text", text: "ROUTE: recon — investigating the 500s." }], details: { mode: "route", results: [{ agent: "controller" }, { agent: "recon" }] } },
	},
	{
		name: "recon-retrieves-known-value",
		params: { agent: "recon", task: "Find the value assigned to MAGIC_TOKEN in this repo and report exactly that value." },
		cwd: fixturesRepo,
		score(r) {
			const found = /xyzzy-42/.test(text(r));
			return { pass: found, score: found ? 1 : 0, notes: found ? "found MAGIC_TOKEN=xyzzy-42" : `value not found: ${text(r).slice(0, 120)}` };
		},
		mock: { content: [{ type: "text", text: "MAGIC_TOKEN is xyzzy-42" }], details: { mode: "single", results: [{ agent: "recon" }] } },
	},
	{
		name: "vote-reaches-known-consensus",
		params: { task: "Is the regex /^(a+)+$/ vulnerable to catastrophic backtracking? Answer YES or NO and give a one-line reason.", vote: { voters: [{ agent: "recon" }, { agent: "overwatch" }], debrief: { agent: "debrief" } } },
		score(r) {
			const yes = /\byes\b/i.test(text(r)) && !/\bno\b\s*[,.]?\s*not\b/i.test(text(r));
			return { pass: yes, score: yes ? 1 : 0, notes: yes ? "consensus: yes (vulnerable)" : `expected YES: ${text(r).slice(0, 120)}` };
		},
		mock: { content: [{ type: "text", text: "Flow vote: 2/2 voters succeeded. Consensus: YES, it is vulnerable to catastrophic backtracking." }], details: { mode: "vote", results: [{ agent: "recon" }, { agent: "overwatch" }] } },
	},
	{
		name: "evaluate-loop-completes-with-gate",
		params: { task: "Write a single clear sentence describing what a health-check endpoint does.", evaluate: { operator: { agent: "operator" }, redteam: { agent: "redteam" }, checkCommand: "exit 0", maxIterations: 2 } },
		score(r) {
			const errored = (r?.details?.results ?? []).some((x) => typeof x.exitCode === "number" && x.exitCode !== 0);
			const produced = text(r).trim().length > 0;
			const pass = !errored && produced;
			return { pass, score: pass ? 1 : 0, notes: pass ? "loop produced output with the gate passing" : "loop errored or produced no output" };
		},
		mock: { content: [{ type: "text", text: "A health-check endpoint reports whether a service is running and able to serve traffic." }], details: { mode: "evaluate", results: [{ agent: "operator", exitCode: 0 }, { agent: "redteam", exitCode: 0 }] } },
	},
	{
		name: "single-answer-quality-judged",
		params: { agent: "analyst", task: "In 2-3 sentences, explain why prompt injection is a risk when one model's output is fed into another model's prompt." },
		async score(r, ctx) {
			const j = await judge(ctx, {
				criteria: "States that untrusted content carried in a handoff can contain injected instructions that the receiving model may follow/obey.",
				answer: text(r),
			});
			return { pass: j.pass, score: j.score, notes: j.reasoning };
		},
		mock: { content: [{ type: "text", text: "Because the second model treats the first model's output as part of its instructions, an attacker who controls that output can smuggle commands the second model then obeys." }], details: { mode: "single", results: [{ agent: "analyst" }] } },
	},
];
