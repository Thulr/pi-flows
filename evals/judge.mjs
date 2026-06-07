// LLM-as-judge for quality dimensions that objective assertions can't capture.
//
// Kept deliberately small and explicit (see judge-calibration concerns): it asks
// for a single 0..1 score plus a PASS/FAIL verdict against ONE stated criterion,
// then parses both. Runs through the `flow` tool as a single `redteam` call with
// NO tools — a pure inline-text grader that never explores the repo — on whatever
// model `ctx.model` names. The runner points that at a DIFFERENT vendor than the
// subject under test (e.g. Anthropic grading an OpenAI answer), so the judge is
// not grading its own model family. In --dry-run it is short-circuited so the
// harness framework can be smoke-tested with no model.

// A judge that could not reach its model must not be reported as a quality FAIL.
// Mirrors run.mjs's infraError; kept local to avoid an import cycle.
function judgeInfraError(result) {
	if (result?.details?.error) return result.details.error.message ?? String(result.details.error.code ?? "flow error");
	for (const child of result?.details?.results ?? []) {
		if (child?.error) return child.error.message ?? "judge child error";
		if ((typeof child?.exitCode === "number" && child.exitCode !== 0) || child?.stopReason === "error" || child?.stopReason === "timeout") {
			return child?.errorMessage ?? `judge child ${child.stopReason ?? "exited with error"}`;
		}
	}
	const text = result?.content?.[0]?.text ?? "";
	if (/"type":\s*"error"|invalid_request_error|authentication|out of (extra )?usage|rate.?limit|\b40[13]\b|api[_ -]?key|model .*not found|unknown model/i.test(text)) return "judge provider/model error";
	return null;
}

const judgeCost = (result) => (result?.details?.results ?? []).reduce((acc, x) => acc + (x?.usage?.cost ?? 0), 0);

export async function judge(ctx, { criteria, answer }) {
	if (ctx.dryRun) return { pass: true, score: 1, reasoning: "(dry-run: judge skipped)", cost: 0, infra: null };

	const task = [
		"You are grading an answer against a single criterion. Be strict and literal.",
		`Criterion: ${criteria}`,
		"",
		"--- ANSWER ---",
		answer,
		"--- END ANSWER ---",
		"",
		"Judge only the text above against the criterion. Do not use tools.",
		"Reply with exactly two lines and nothing else:",
		"SCORE: <a number from 0.0 to 1.0>",
		"VERDICT: PASS or FAIL",
	].join("\n");

	const result = await ctx.flow.execute(
		"eval:judge",
		{ agent: "redteam", task, model: ctx.model, tools: "none", maxCostUsd: 0.1, timeoutMs: 120000 },
		new AbortController().signal,
		undefined,
		ctx.flowCtx,
	);

	const infra = judgeInfraError(result);
	const cost = judgeCost(result);
	if (infra) return { pass: false, score: 0, reasoning: infra, cost, infra };

	const out = result?.content?.[0]?.text ?? "";
	const match = out.match(/SCORE:\s*([0-9]*\.?[0-9]+)/i);
	const score = match ? Math.max(0, Math.min(1, Number.parseFloat(match[1]))) : Number.NaN;
	const pass = /VERDICT:\s*PASS/i.test(out)
		? true
		: /VERDICT:\s*(FAIL|REVISE)/i.test(out)
			? false
			: Number.isFinite(score) && score >= 0.7;

	return { pass, score: Number.isFinite(score) ? score : pass ? 1 : 0, reasoning: out.replace(/\s+/g, " ").slice(0, 200), cost, infra: null };
}

// Pairwise preference judge for the flows-vs-plain A/B. Shows the judge BOTH answers
// to the same task and asks which better meets the criterion — far more sensitive to
// small differences than independent absolute scoring, and explicitly told NOT to
// reward length (the compact-summary bias we want to rule out). Position bias is
// handled by the caller, which runs this twice with the answers swapped. Same
// tool-less `redteam` call on the cross-vendor judge model as judge().
export async function judgePairwise(ctx, { criteria, answerA, answerB }) {
	if (ctx.dryRun) return { winner: "TIE", reasoning: "(dry-run: judge skipped)", cost: 0, infra: null };

	const task = [
		"Two answers — A and B — respond to the SAME task. Pick the one that better satisfies the criterion below. If they meet it equally well, answer TIE.",
		"Judge content and correctness only. Do NOT reward greater length: a concise correct answer is not worse than a longer one that conveys the same thing.",
		`Criterion: ${criteria}`,
		"",
		"--- ANSWER A ---",
		answerA,
		"--- END ANSWER A ---",
		"",
		"--- ANSWER B ---",
		answerB,
		"--- END ANSWER B ---",
		"",
		"Reply with exactly two lines and nothing else:",
		"WINNER: A or B or TIE",
		"REASON: <one short line>",
	].join("\n");

	const result = await ctx.flow.execute(
		"eval:pairwise",
		{ agent: "redteam", task, model: ctx.model, tools: "none", maxCostUsd: 0.1, timeoutMs: 120000 },
		new AbortController().signal,
		undefined,
		ctx.flowCtx,
	);

	const infra = judgeInfraError(result);
	const cost = judgeCost(result);
	if (infra) return { winner: "ERROR", reasoning: infra, cost, infra };

	const out = result?.content?.[0]?.text ?? "";
	const match = out.match(/WINNER:\s*(A|B|TIE)/i);
	const winner = match ? match[1].toUpperCase() : "TIE";
	return { winner, reasoning: out.replace(/\s+/g, " ").slice(0, 200), cost, infra: null };
}
