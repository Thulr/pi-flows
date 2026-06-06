// LLM-as-judge for quality dimensions that objective assertions can't capture.
//
// Kept deliberately small and explicit (see judge-calibration concerns): it asks
// for a single 0..1 score plus a PASS/FAIL verdict against ONE stated criterion,
// then parses both. Runs through the same `flow` tool (a single `redteam` call),
// so it uses whatever model/provider pi is configured with. In --dry-run it is
// short-circuited so the harness framework can be smoke-tested with no model.

export async function judge(ctx, { criteria, answer }) {
	if (ctx.dryRun) return { pass: true, score: 1, reasoning: "(dry-run: judge skipped)" };

	const task = [
		"You are grading an answer against a single criterion. Be strict and literal.",
		`Criterion: ${criteria}`,
		"",
		"--- ANSWER ---",
		answer,
		"--- END ANSWER ---",
		"",
		"Reply with exactly two lines and nothing else:",
		"SCORE: <a number from 0.0 to 1.0>",
		"VERDICT: PASS or FAIL",
	].join("\n");

	const result = await ctx.flow.execute(
		"eval:judge",
		{ agent: "redteam", task, model: ctx.model, maxCostUsd: 0.05, timeoutMs: 120000 },
		new AbortController().signal,
		undefined,
		ctx.flowCtx,
	);

	const out = result?.content?.[0]?.text ?? "";
	const match = out.match(/SCORE:\s*([0-9]*\.?[0-9]+)/i);
	const score = match ? Math.max(0, Math.min(1, Number.parseFloat(match[1]))) : Number.NaN;
	const pass = /VERDICT:\s*PASS/i.test(out)
		? true
		: /VERDICT:\s*(FAIL|REVISE)/i.test(out)
			? false
			: Number.isFinite(score) && score >= 0.7;

	return { pass, score: Number.isFinite(score) ? score : pass ? 1 : 0, reasoning: out.replace(/\s+/g, " ").slice(0, 200) };
}
