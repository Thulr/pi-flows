function comparisonArgs(command, { baseline, candidate, guardrails = [], scoreGuardrails = [], efficiencyGuardrails = [], noiseBand, format, json, redaction }) {
	const args = [command];
	if (json) args.push("--json");
	if (format) args.push("--format", format);
	for (const dimension of guardrails) args.push("--guardrail", dimension);
	for (const dimension of scoreGuardrails) args.push("--score-guardrail", dimension);
	for (const metric of efficiencyGuardrails) args.push("--efficiency-guardrail", metric);
	if (noiseBand !== undefined) args.push("--noise-band", String(noiseBand));
	if (redaction) args.push("--redaction", redaction);
	args.push(baseline, candidate);
	return args;
}

/** Build the non-blocking A/B comparison argv. */
export function compareArgs(input) {
	return comparisonArgs("compare", input);
}

/** Build the regression-gating comparison argv. */
export function gateArgs(input) {
	return comparisonArgs("gate", input);
}

/** Build the position-swapped pairwise quality comparison argv. */
export function duelArgs({ traceA, traceB, labelA, labelB, out, model, concurrency, evalSet, json, judgeBin }) {
	const args = ["duel"];
	if (json) args.push("--json");
	args.push(traceA, traceB);
	if (labelA) args.push("--label-a", labelA);
	if (labelB) args.push("--label-b", labelB);
	if (out) args.push("--out", out);
	if (model) args.push("--model", model);
	if (concurrency) args.push("--concurrency", String(concurrency));
	if (evalSet) args.push("--eval-set", evalSet);
	if (judgeBin) args.push("--judge-bin", judgeBin);
	return args;
}
