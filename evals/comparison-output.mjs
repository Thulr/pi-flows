import {
	armLine,
	duelQualitySummary,
	fixed,
	formatCostComparison,
	formatTokenComparison,
	judgeDelta,
	pct,
	pickArm,
} from "./compare-report.mjs";

export function reportPerCase(rows, { candidateLabel, referenceLabel }) {
	console.log("\nPer-case results");
	for (const row of rows) {
		const delta = judgeDelta(row);
		const arrow = delta === null ? "inconclusive" : delta > 0.001 ? candidateLabel : delta < -0.001 ? referenceLabel : "tie";
		console.log(row.name);
		console.log(armLine(candidateLabel, row.flows));
		console.log(armLine(referenceLabel, row.plain));
		console.log(`   judge delta ${delta === null ? "n/a" : fixed(delta)}  ${arrow}`);
		if (row.duel) {
			if (row.duel.winner === "skipped") console.log(`   duel skipped (${row.duel.reason})`);
			else console.log(`   duel ${row.duel.winner}  (passes: ${row.duel.first_pass}, ${row.duel.second_pass})`);
		}
	}
}

export function reportSummary(rows, totals, exclusions, { candidateLabel, referenceLabel, duelEnabled }) {
	const comparable = totals.qualityRows.length;
	const caseCount = new Set(rows.map((row) => row.caseId)).size;
	console.log(`\nSummary over ${rows.length} paired trial${rows.length === 1 ? "" : "s"} across ${caseCount} case${caseCount === 1 ? "" : "s"}`);
	const inconclusive = rows.length - comparable;
	console.log(`  quality rows    ${comparable}/${rows.length} comparable${inconclusive ? `  ·  inconclusive ${inconclusive}` : ""}`);
	const duelSummary = duelQualitySummary(rows);
	if (duelEnabled && duelSummary.decided + duelSummary.skipped > 0) {
		console.log(`  thulr duel     ${candidateLabel} wins ${duelSummary.flows} - ${referenceLabel} wins ${duelSummary.plain} - ties ${duelSummary.ties} - flips ${duelSummary.flips}${duelSummary.skipped ? ` - skipped ${duelSummary.skipped}` : ""}`);
	}
	console.log(`  thulr pass     ${candidateLabel} ${totals.flowsCriterionPasses}/${comparable} (${pct(totals.flowsCriterionPasses, comparable)})    ${referenceLabel} ${totals.plainCriterionPasses}/${comparable} (${pct(totals.plainCriterionPasses, comparable)})`);
	console.log(`  thulr mean     ${candidateLabel} ${comparable ? totals.flowsJudgeMean.toFixed(2) : "n/a"}    ${referenceLabel} ${comparable ? totals.plainJudgeMean.toFixed(2) : "n/a"}    lift ${comparable ? fixed(totals.flowsJudgeMean - totals.plainJudgeMean) : "n/a"}`);
	console.log(`  abs per-case   ${candidateLabel} wins ${totals.wins} - ${referenceLabel} wins ${totals.losses} - ties ${comparable - totals.wins - totals.losses}`);
	if (exclusions.flows.infra || exclusions.plain.infra || exclusions.flows.debug_budget || exclusions.plain.debug_budget) {
		console.log(`  exclusions     ${candidateLabel} infra ${exclusions.flows.infra}, debug ${exclusions.flows.debug_budget}  ·  ${referenceLabel} infra ${exclusions.plain.infra}, debug ${exclusions.plain.debug_budget}`);
	}
	console.log(`  ${formatCostComparison(candidateLabel, totals.flowsCost, totals.flowsCostKnown, referenceLabel, totals.plainCost, totals.baselineCostKnown)}`);
	console.log(`  ${formatTokenComparison(candidateLabel, totals.flowsTokens, referenceLabel, totals.plainTokens)}`);
	console.log(`  wall-clock     ${candidateLabel} ${totals.flowsSeconds.toFixed(0)}s    ${referenceLabel} ${totals.plainSeconds.toFixed(0)}s`);
	console.log(`\nNote: ${referenceLabel} is the reference and ${candidateLabel} is the candidate. Both arms must report the same underlying model or the pair is excluded. Native thulr duel is the head-to-head quality signal.`);
}

export function rawArtifactRows(rows, { candidateLabel, referenceLabel, legacyDefaultArms }) {
	return rows.map((row) => ({
		caseId: row.caseId,
		trialId: row.trialId,
		traceCaseId: row.traceCaseId,
		trialIndex: row.trialIndex,
		suite: row.suite,
		taskFamily: row.taskFamily,
		armOrder: row.armOrder.map((kind) => kind === "plain" ? legacyDefaultArms ? "baseline" : referenceLabel : legacyDefaultArms ? "flows" : candidateLabel),
		constraint: row.constraint,
		duel: row.duel,
		comparable: row.flowsTraceOk && row.plainTraceOk,
		flows: pickArm(row.flows),
		baseline: pickArm(row.plain),
	}));
}
