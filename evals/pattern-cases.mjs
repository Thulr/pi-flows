import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineCases } from "./case-contract.mjs";

const fixtures = fileURLToPath(new URL("./fixtures/patterns", import.meta.url));
const answer = (result) => result?.content?.[0]?.text ?? "";

function coverage(body, checks) {
	const missed = checks.flatMap((pattern, index) => pattern.test(body) ? [] : [index + 1]);
	const found = checks.length - missed.length;
	return { pass: found === checks.length, score: found / checks.length, notes: `${found}/${checks.length} required findings${missed.length > 0 ? `; missed checks ${missed.join(", ")}` : ""}` };
}

function artifactCoverage(result, ctx, relativePath, checks) {
	const file = join(ctx.flowCtx.cwd, relativePath);
	const realExists = existsSync(file);
	const exists = ctx?.dryRun || realExists;
	const body = `${answer(result)}\n${realExists ? readFileSync(file, "utf8") : ""}`;
	const scored = coverage(body, checks);
	return {
		pass: exists && scored.pass,
		score: (scored.score * checks.length + (exists ? 1 : 0)) / (checks.length + 1),
		notes: `${exists ? "artifact exists" : "artifact missing"}; ${scored.notes}`,
	};
}

function setupFixture(name, { git = false, executable = [] } = {}) {
	return (cwd) => {
		const source = join(fixtures, name);
		for (const entry of readdirSync(source)) cpSync(join(source, entry), join(cwd, entry), { recursive: true });
		for (const relative of executable) chmodSync(join(cwd, relative), 0o755);
		if (!git) return;
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.name", "Eval"], { cwd });
		execFileSync("git", ["config", "user.email", "eval@example.com"], { cwd });
		execFileSync("git", ["add", "."], { cwd });
		execFileSync("git", ["commit", "-qm", "seed"], { cwd });
	};
}

function worktreeScore(result, ctx, testArgs = []) {
	if (result?.details?.mode === "worktree") {
		if (result.details.error) return { pass: false, score: 0, notes: `worktree error: ${result.details.error.code ?? "unknown"}` };
		if (ctx.dryRun) return { pass: true, score: 1, notes: "dry-run worktree mock" };
		const branch = answer(result).match(/integration branch `([^`]+)`/)?.[1];
		if (!branch || !/^pi-flow\/[a-z0-9._/-]+\/integration$/i.test(branch)) return { pass: false, score: 0, notes: "durable integration branch missing from result" };
		const detached = mkdtempSync(join(tmpdir(), "pi-eval-integrated-"));
		try {
			execFileSync("git", ["worktree", "add", "--detach", detached, branch], { cwd: ctx.flowCtx.cwd, stdio: "ignore" });
			const base = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: detached, encoding: "utf8" }).trim();
			execFileSync("git", ["diff", "--quiet", base, "--", "requirements.md", "test.js"], { cwd: detached, stdio: "ignore" });
			execFileSync("node", ["test.js", ...testArgs], { cwd: detached, stdio: "ignore" });
			return { pass: true, score: 1, notes: `durable integration branch passed node test.js ${testArgs.join(" ")}`.trim() };
		} catch {
			return { pass: false, score: 0, notes: "durable integration branch failed oracle or immutable-fixture check" };
		} finally {
			try { execFileSync("git", ["worktree", "remove", "--force", detached], { cwd: ctx.flowCtx.cwd, stdio: "ignore" }); } catch {}
			rmSync(detached, { recursive: true, force: true });
		}
	}
	try {
		execFileSync("git", ["diff", "--quiet", "HEAD", "--", "requirements.md", "test.js"], { cwd: ctx.flowCtx.cwd, stdio: "ignore" });
		execFileSync("node", ["test.js", ...testArgs], { cwd: ctx.flowCtx.cwd, stdio: "ignore" });
		return { pass: true, score: 1, notes: `workspace passed node test.js ${testArgs.join(" ")}`.trim() };
	} catch {
		return { pass: false, score: 0, notes: "workspace failed oracle or immutable-fixture check" };
	}
}

const sharedCriteria = (correctness, completeness, evidenceQuality) => ({
	correctness,
	completeness,
	evidence_quality: evidenceQuality,
});

export const PATTERN_CASES = defineCases([
	{
		name: "pattern-workflow-train-release",
		pattern: "workflow",
		evalSplit: "train",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("workflow-release"),
		judgeArtifacts: ["checkout-ledger-migration-runbook.md"],
		params: {
			task: "Read requirements.md, telemetry.md, and incident.md and create checkout-ledger-migration-runbook.md. It must be executable by an on-call engineer and explicitly state numeric gates, rollback, approval, owners, source evidence, and unresolved risk. Verify the file and summarize it.",
			timeoutMs: 600_000,
			workflow: {
				phases: [
					{ id: "draft", agent: "operator", task: "Read requirements.md, telemetry.md, and incident.md, then create checkout-ledger-migration-runbook.md. Include an executable sequence, numeric gates, file:line citations, rollback mechanics, owners, approval boundary, and unresolved risks. If a binding source-required value has no source-backed rule, do not invent one: add a blocking pre-cutover decision gate with a named owner, required evidence, validation, and explicit no-cutover condition. Run focused checks and report evidence.", requireEvidence: true },
					{ id: "challenge", agent: "redteam", task: "Audit checkout-ledger-migration-runbook.md against all three source files. Identify every dropped or unsupported constraint, including any uncertainty that is merely documented instead of converted into a fail-closed execution gate. Prescribe exact corrections without inventing source policy.", requireEvidence: true },
					{ id: "revise", agent: "operator", task: "Revise checkout-ledger-migration-runbook.md to address every valid critique below. Any unresolved binding policy must block cutover through a named decision owner and validation gate; do not invent the missing policy. Recheck all source constraints and report the final verification with source-path citations.\n\n{phase.challenge}", checkCommand: "test -f checkout-ledger-migration-runbook.md && grep -q '1,500' checkout-ledger-migration-runbook.md && grep -q '0.5%' checkout-ledger-migration-runbook.md && grep -Eqi 'release.?manager' checkout-ledger-migration-runbook.md && grep -qi 'region' checkout-ledger-migration-runbook.md && grep -Eqi '(no|not|block).{0,40}cutover|cutover.{0,40}(block|prohibit|must not)' checkout-ledger-migration-runbook.md", requireEvidence: true },
				],
			},
		},
		criterion: "The runbook respects every binding source constraint, uses the observed 2,000 rows/s saturation limit to set a lower backfill rate, includes the 0.5% mismatch gate, keeps dual-write under 24 hours, requires release-manager approval before cutover, and gives a rollback under five minutes without replaying duplicate charges.",
		criteria: sharedCriteria("Chooses a migration sequence and rollback that do not violate the source constraints or repeat the duplicate-charge incident.", "Includes the backfill rate, 0.5% mismatch gate, 24-hour dual-write cap, under-five-minute rollback, approval boundary, owners, and unresolved nullable-region risk.", "Cites requirements.md, telemetry.md, and incident.md for the claims they support and distinguishes observed facts from recommendations."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result, ctx) => artifactCoverage(result, ctx, "checkout-ledger-migration-runbook.md", [/1[,.]?500\s*rows?\/s|1500\s*rows/i, /0\.5\s*%/, /24\s*(?:hours?|h\b)/i, /(five|5)[ -]?minute/i, /release.manager.*approv|approv.*release.manager/i, /nullable.*region|region.*nullable/i]),
		mock: { content: [{ type: "text", text: "Backfill at 1,500 rows/s, gate on 0.5% mismatch, cap dual-write at 24 hours, require release-manager approval, rollback in 5 minutes, and track the nullable region risk with citations." }], details: { mode: "workflow", results: [] } },
	},
	{
		name: "pattern-workflow-holdout-keys",
		pattern: "workflow",
		evalSplit: "holdout",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("workflow-keys"),
		judgeArtifacts: ["signing-key-rotation-runbook.md"],
		params: {
			task: "Read policy.md, runtime.md, and postmortem.md and create signing-key-rotation-runbook.md with measurable gates, ownership, approval, rollback, and citations. Verify the file and summarize it.",
			timeoutMs: 600_000,
			workflow: {
				phases: [
					{ id: "draft", agent: "operator", task: "Read policy.md, runtime.md, and postmortem.md, then create signing-key-rotation-runbook.md with file:line citations, measurable gates, ownership, rollback, approval, and unresolved risks." },
					{ id: "challenge", agent: "redteam", task: "Audit signing-key-rotation-runbook.md against policy.md, runtime.md, and postmortem.md; state exact corrections for every violation." },
					{ id: "revise", agent: "operator", task: "Revise signing-key-rotation-runbook.md to address every valid critique, then verify the source constraints.\n\n{phase.challenge}", checkCommand: "test -f signing-key-rotation-runbook.md && grep -q '48' signing-key-rotation-runbook.md && grep -q '99.9%' signing-key-rotation-runbook.md && grep -qi 'security' signing-key-rotation-runbook.md" },
				],
			},
		},
		criterion: "The runbook stages a 48-hour overlap, keeps the old key verify-only, waits for all three regions to exceed 99.9% new-key signing for six hours, requires security approval before revocation, and rolls back by restoring old-key signing rather than distributing a third key.",
		criteria: sharedCriteria("The sequence obeys policy and avoids the postmortem's premature-revocation and third-key failure modes.", "Includes 48-hour overlap, verify-only old key, three regions, 99.9% for six hours, security approval, clock-skew check, and rollback.", "Uses specific citations from policy.md, runtime.md, and postmortem.md and labels remaining uncertainty."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result, ctx) => artifactCoverage(result, ctx, "signing-key-rotation-runbook.md", [/48[ -]?hour/i, /verify.only/i, /(three|3) regions?|us-east.*us-west.*eu-central/is, /99\.9\s*%/, /(six|6)\s*(?:hours?|h\b)/i, /security.*approv|approv.*security/i, /clock[ -]skew/i]),
		mock: { content: [{ type: "text", text: "Use a 48-hour overlap, old key verify-only, require all 3 regions at 99.9% for 6 hours plus a clock skew check and security approval." }], details: { mode: "workflow", results: [] } },
	},
	{
		name: "pattern-debate-train-queue",
		pattern: "debate",
		evalSplit: "train",
		control: true,
		controlReason: "A simple one-file decision saturated both arms and showed no debate lift; keep it as a threshold negative for automatic activation.",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("debate-queue"),
		params: { task: "Read decision.md and choose exactly one migration design, A (application dual-write) or B (database CDC), against every stated constraint. Give the decision, decisive tradeoffs, mitigations, and reversal conditions.", timeoutMs: 600_000, debate: { participants: [{ agent: "strategist" }, { agent: "analyst" }], adjudicator: { agent: "analyst" }, rounds: 2 } },
		criterion: "Chooses B (CDC): A cannot be delivered during the 14-day application freeze and previously diverged; B's measured 75-second p99 lag is inside the two-minute SLA. It mitigates CDC schema drift and reverses if lag exceeds two minutes for ten minutes.",
		criteria: sharedCriteria("Selects B for the correct binding reasons without claiming it is risk-free.", "Covers the app freeze, 75-second lag versus the two-minute SLA, prior dual-write divergence, schema-drift mitigation, and a concrete reversal condition.", "Grounds decisive claims in decision.md's measurements and separates facts, assumptions, and recommendation."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [/\bB\b|CDC/i, /14[ -]?day.*(?:freeze|frozen)|(?:freeze|frozen).{0,30}14(?:[ -]?days?)?/i, /75\s*(?:seconds?|s\b)/i, /(two|2)[ -]?minute.{0,30}(?:SLA|cap|limit|maximum)|(?:SLA|cap|limit|maximum).{0,30}(two|2)[ -]?minute/i, /schema drift/i, /(ten|10).{0,20}minutes?/i]),
		mock: { content: [{ type: "text", text: "Choose B/CDC: the 14-day freeze blocks A, 75-second lag fits the 2-minute SLA; mitigate schema drift and reverse after 10 minutes over the lag limit." }], details: { mode: "debate", results: [] } },
	},
	{
		name: "pattern-debate-holdout-audit",
		pattern: "debate",
		evalSplit: "holdout",
		control: true,
		controlReason: "A simple one-file decision saturated both arms and showed no debate lift; keep it as a threshold negative for automatic activation.",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("debate-audit"),
		params: { task: "Read decision.md and choose exactly one audit architecture, A (transactional outbox) or B (log scraping), against every stated constraint. Give mitigations and reversal conditions.", timeoutMs: 600_000, debate: { participants: [{ agent: "strategist" }, { agent: "analyst" }], adjudicator: { agent: "analyst" }, rounds: 2 } },
		criterion: "Chooses A (transactional outbox) because compliance forbids credentials in the log pipeline and requires atomic audit capture; addresses A's 8% write overhead, uses the measured 11% headroom carefully, and reverses if p99 latency exceeds 180ms for 15 minutes.",
		criteria: sharedCriteria("Selects A because the compliance constraints disqualify B, while acknowledging A's capacity risk.", "Covers atomicity, credential prohibition, 8% overhead versus 11% headroom, capacity mitigation, and the 180ms/15-minute reversal gate.", "Uses decision.md's exact measurements and constraints rather than generic architecture preferences."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [/\bA\b|outbox/i, /credential.*log|log.*credential/i, /atomic/i, /8\s*%/, /11\s*%/, /180\s*ms/i, /15.{0,20}minutes?/i]),
		mock: { content: [{ type: "text", text: "Choose A/outbox for atomic capture and no credentials in logs; watch its 8% overhead against 11% headroom and reverse after 15 minutes above 180ms." }], details: { mode: "debate", results: [] } },
	},
	{
		name: "pattern-debate-train-publication-review",
		pattern: "debate",
		evalSplit: "train",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("debate-publication-review"),
		params: {
			task: "Read decision.md, trial.csv, operations.md, and policy.md. Choose exactly one launch architecture, A or B. Return the complete decision record in your final answer and do not modify workspace files. Begin with an exact line `DECISION: A` or `DECISION: B`. Give a file:line-cited constraint matrix covering both options, show every derived calculation under policy.md's conservative rules, state the strongest case for the rejected option, identify required prelaunch controls, and give the exact reversal conditions. Use only workspace evidence; do not merge the options or invent controls.",
			timeoutMs: 600_000,
			debate: { participants: [{ agent: "strategist" }, { agent: "analyst" }], adjudicator: { agent: "analyst" }, rounds: 2 },
		},
		criterion: "Chooses B with its approved prelaunch checker, the only launch-feasible indivisible option. Uses conservative upper/lower bounds, preserves A's real simplicity and raw overall-rate advantage, distinguishes observed inputs from derived values, and does not borrow controls across options.",
		criteria: sharedCriteria("Selects B because its conservative residual rates and review demand pass every hard launch gate without inventing or borrowing controls.", "Shows both options in a constraint matrix, every conservative calculation, A's strongest case, B's required checker, and both exact reversal conditions.", "Cites all four workspace sources at file:line granularity and distinguishes source measurements, policy rules, and derived calculations."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [
			/^DECISION:\s*B\s*$/im,
			/upper bound.{0,100}lower bound|lower bound.{0,100}upper bound|conservative (?:overall |new-supplier )?residual|(?=[\s\S]*raw upper)(?=[\s\S]*lower bounds?)/is,
			/0\.86\s*%.{0,80}(?:>|exceed|fail).{0,40}0\.80\s*%|0\.80\s*%.{0,80}(?:<|below).{0,40}0\.86\s*%/is,
			/(?=[\s\S]*0\.70\s*%)(?=[\s\S]*(?:35\s*%|0\.35))(?=[\s\S]*0\.455\s*%)(?=[\s\S]*0\.50\s*%)/i,
			/(?=[\s\S]*1\.05\s*%)(?=[\s\S]*(?:25\s*%|0\.25))(?=[\s\S]*0\.7875\s*%)(?=[\s\S]*0\.80\s*%)/i,
			/(?=[\s\S]*22\s*%)(?=[\s\S]*6\s*(?:pp|percentage points?))(?=[\s\S]*28\s*%)(?=[\s\S]*8\.96)(?=[\s\S]*[`*_]*10[`*_]*\s*(?:h|hours?))/i,
			/(?=[\s\S]*(?:strongest|best) case[^\n]*\bA\b)(?=[\s\S]*0\.48\s*%)(?=[\s\S]*7\.68)/i,
			/post.publication.{0,120}(?:ineligible|does not|cannot|not count|after release)/is,
			/(?:manual hold|hold all|all publication.{0,30}hold).{0,180}0\.50\s*%.{0,100}0\.80\s*%.{0,120}(?:2,?000|2000)/is,
			/(?:review demand|review hours|capacity).{0,100}(?:exceed|>|above).{0,30}[`*_]*10[`*_]*\s*(?:h|hours?).{0,80}[`*_]*(?:3|three)[`*_]* consecutive days?/is,
			/(?=[\s\S]*decision\.md:\d+)(?=[\s\S]*trial\.csv:\d+)(?=[\s\S]*operations\.md:\d+)(?=[\s\S]*policy\.md:\d+)/i,
		]),
		mock: { content: [{ type: "text", text: "DECISION: B\nConservative upper/lower bounds leave B at 0.455% overall and 0.7875% cohort, with 28% review share and 8.96h/day. A fails cohort at 0.86%. Sources: decision.md:2, trial.csv:2, operations.md:2, policy.md:2." }], details: { mode: "debate", results: [] } },
	},
	{
		name: "pattern-debate-holdout-regional-writes",
		pattern: "debate",
		evalSplit: "holdout",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("debate-regional-writes"),
		params: {
			task: "Read architecture.md, measurements.csv, change-window.md, constraints.md, and incident.md. Choose exactly one day-10 topology, A or B. Return the complete decision record in your final answer and do not modify workspace files. Begin with an exact line `DECISION: A` or `DECISION: B`. Give a file:line-cited constraint matrix covering both options, show every conservative-envelope calculation, state the strongest case for the rejected option, identify the controls actually available by day 10, and give the exact reversal conditions. Use only workspace evidence; do not merge the options or assume an unavailable control.",
			timeoutMs: 600_000,
			debate: { participants: [{ agent: "strategist" }, { agent: "analyst" }], adjudicator: { agent: "analyst" }, rounds: 2 },
		},
		criterion: "Chooses A with fencing because it clears every day-10 hard gate under conservative bounds. Preserves B's genuine zero-duplicate, latency, cost, and simplicity advantages, but rejects B because no day-10 mitigation satisfies both CPU and budget; never assumes early batch eviction or claims fencing eliminates all risk.",
		criteria: sharedCriteria("Selects A with the approved fencing control and correctly rejects each infeasible B mitigation under the day-10 constraints.", "Shows both options, every conservative calculation, strongest B case, available controls, and A's exact duplicate and latency reversal conditions.", "Cites all five sources at file:line granularity and distinguishes measurements, control effects, hard constraints, and derived envelopes."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [
			/^DECISION:\s*A\s*$/im,
			/upper bound.{0,100}lower bound|conservative envelope|lower bound.{0,100}upper bound/is,
			/1\.60\s*%.{0,80}(?:1\s*[-\u2212]\s*(?:90\s*%|0\.90)).{0,100}0\.16\s*%.{0,80}(?:<=|\u2264|pass|within).{0,40}0\.25\s*%/is,
			/164\s*(?:ms)?\s*\+\s*9\s*(?:ms)?.{0,80}173\s*ms.{0,80}(?:<|below).{0,30}175\s*ms/is,
			/(?:25\s*\+\s*2|\$?27\s*k).{0,80}\$?27\s*k?.{0,80}(?:<=|\u2264|within).{0,30}\$?28\s*k?.{0,120}(?:6\s*(?:days?|d)\s*(?:<=|\u2264).{0,20}10|deploy.{0,40}6\s*(?:days?|d))/is,
			/42\s*(?:seconds?|s\b).{0,100}(?:12\s*(?:seconds?|s\b)).{0,120}(?:pass|within|<=|\u2264)/is,
			/68\s*%\s*\+\s*24\s*(?:pp|percentage points?).{0,80}92\s*%.{0,60}(?:>|exceed|fail).{0,30}90\s*%/is,
			/(?:68\s*%\s*\+\s*24\s*(?:pp|percentage points?)\s*[-\u2212]\s*8\s*(?:pp|percentage points?).{0,60}84\s*%|84\s*%).{0,160}(?:21\s*\+\s*8|\$?29\s*k).{0,80}(?:>|exceed).{0,30}\$?28\s*k/is,
			/(?:batch eviction|eviction).{0,100}86\s*%.{0,100}(?:day\s*31|unavailable.{0,30}31|not available.{0,30}31)/is,
			/(?:strongest|best).{0,100}\bB\b.{0,160}(?:zero|0\s*%)\s*(?:duplicates?|duplicate side effects?).{0,160}158\s*ms.{0,160}\$?21\s*k/is,
			/(?:single.primary|disable secondary writes).{0,160}0\.25\s*%.{0,100}(?:two|2) consecutive 15.minute windows?/is,
			/(?:>=|\u2265|at least)\s*175\s*ms.{0,80}(?:10|ten) continuous minutes?/is,
			/(?=[\s\S]*architecture\.md:\d+)(?=[\s\S]*measurements\.csv:\d+)(?=[\s\S]*change-window\.md:\d+)(?=[\s\S]*constraints\.md:\d+)(?=[\s\S]*incident\.md:\d+)/i,
		]),
		mock: { content: [{ type: "text", text: "DECISION: A\nFencing yields 0.16% duplicates, 173ms, and $27k by day 6. B's 84% add-on costs $29k; eviction is unavailable until day 31. Sources: architecture.md:2, measurements.csv:2, change-window.md:2, constraints.md:2, incident.md:2." }], details: { mode: "debate", results: [] } },
	},
	{
		name: "pattern-dossier-train-deploy",
		pattern: "dossier",
		evalSplit: "train",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("dossier-deploy"),
		params: { task: "Read runbook.md, config.yaml, incident.md, and change-ticket.md. Build an evidence dossier explaining the June 12 deployment saturation, the actual concurrency setting, contradictions, confidence, and remaining gaps. Cite every source.", timeoutMs: 600_000, dossier: { sections: [{ agent: "recon", task: "Extract evidence from runbook.md only." }, { agent: "recon", task: "Extract evidence from config.yaml only." }, { agent: "analyst", task: "Extract evidence from incident.md only." }, { agent: "analyst", task: "Extract evidence from change-ticket.md only." }], debrief: { agent: "debrief" } } },
		criterion: "Concludes actual concurrency was 8, contradicting the runbook maximum of 4; the ticket approved 6, while an unreviewed config change raised it to 8; the incident correlates saturation with 8 but cannot prove sole causality because host metrics are missing.",
		criteria: sharedCriteria("Reconciles actual, documented, and approved concurrency without treating correlation as proof of sole cause.", "Includes runbook=4, ticket=6, config=8, unreviewed change, incident timing, confidence by claim, and missing host metrics.", "Cites all four sources next to the claims they support and preserves contradictions explicitly."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [/runbook.{0,80}\b4\b|\b4\b.{0,80}runbook/is, /ticket.{0,80}\b6\b|\b6\b.{0,80}ticket/is, /config.{0,80}\b8\b|\b8\b.{0,80}config/is, /unreviewed|without review|no review (?:record|artifact)/i, /host(?:-level)?.{0,80}metrics?.{0,80}(?:missing|absent|unavailable|not retained)|no retained host.{0,80}metrics?/is]),
		mock: { content: [{ type: "text", text: "runbook.md says 4, change-ticket.md approved 6, config.yaml set 8 via an unreviewed change; incident.md correlates 8 with saturation, but host metrics are missing." }], details: { mode: "dossier", results: [] } },
	},
	{
		name: "pattern-dossier-holdout-auth",
		pattern: "dossier",
		evalSplit: "holdout",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("dossier-auth"),
		params: { task: "Read policy.md, deployed.json, incident.md, and metrics.md. Build an evidence dossier for the May 3 auth outage. Reconcile TTL and clock-skew claims, cite sources, assign confidence, and list unresolved gaps.", timeoutMs: 600_000, dossier: { sections: [{ agent: "recon", task: "Extract policy.md evidence only." }, { agent: "recon", task: "Extract deployed.json evidence only." }, { agent: "analyst", task: "Extract incident.md evidence only." }, { agent: "analyst", task: "Extract metrics.md evidence only." }], debrief: { agent: "debrief" } } },
		criterion: "Reports policy TTL 15 minutes, deployed TTL 60 minutes, incident's initial clock-skew hypothesis, and metrics showing only 4 seconds skew but a 59-minute stale-token acceptance window. Concludes TTL drift is strongly supported while root deployment provenance remains unknown.",
		criteria: sharedCriteria("Distinguishes the weak clock-skew hypothesis from the strongly supported TTL drift conclusion.", "Includes 15-minute policy, 60-minute deployment, four-second skew, 59-minute window, confidence, contradictions, and missing deployment provenance.", "Cites all four sources beside claims and does not invent who changed the deployment."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [/15[ -]?minute/i, /60[ -]?minute|access_token_ttl_minutes.{0,20}60|60.{0,30}TTL/i, /(four|4)[ -]?second.*skew|skew.*(four|4)[ -]?second/i, /59[ -]?minute/i, /provenance|owner.*(?:unknown|missing|null|not found|unresolved)|no (?:recorded )?(?:deployment|change) owner|change_owner.{0,20}null/i]),
		mock: { content: [{ type: "text", text: "policy.md says 15 minutes; deployed.json says 60 minutes. metrics.md shows 4-second skew and a 59-minute stale-token window, while deployment provenance is unknown." }], details: { mode: "dossier", results: [] } },
	},
	{
		name: "pattern-monitor-train-queue",
		pattern: "monitor",
		evalSplit: "train",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("monitor-queue"),
		params: { task: "Run `node probe.mjs` repeatedly, at most five times, stopping on the first output containing DEGRADED. Preserve that exact transient event, then inspect service.log and runbook.md and report event identity, likely cause, bounded response, and missing evidence.", timeoutMs: 300_000, monitor: { command: "node probe.mjs", trigger: "match", pattern: "DEGRADED", intervalMs: 10, maxChecks: 5, reactor: { agent: "analyst" } } },
		criterion: "Captures check 3's DEGRADED event for shard s7, trace t-41, queue depth 912; links it to worker w3 clock skew and compactor lease expiry; recommends draining w3 and reacquiring the lease before verifying depth below 100, without restarting the primary.",
		criteria: sharedCriteria("Diagnoses the captured transient event rather than a later healthy state and avoids the forbidden primary restart.", "Includes shard s7, trace t-41, depth 912, worker w3, clock skew, lease expiry, drain/reacquire actions, and below-100 verification.", "Separates probe evidence, log evidence, runbook action, and remaining causal uncertainty."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [/\bs7\b/i, /t-41/i, /912/, /\bw3\b/i, /clock[ -]skew/i, /lease.*expir|expir.*lease/i, /below\s+[`*_]*100|<\s*[`*_]*100/i]),
		mock: { content: [{ type: "text", text: "Captured shard=s7 trace=t-41 depth=912; logs show worker w3 clock skew expired the lease. Drain w3, reacquire, and verify below 100." }], details: { mode: "monitor", results: [] } },
	},
	{
		name: "pattern-monitor-holdout-disk",
		pattern: "monitor",
		evalSplit: "holdout",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("monitor-disk"),
		params: { task: "Run `node probe.mjs` repeatedly, at most six times, stopping on the first non-zero exit. Preserve that exact failure, inspect service.log and runbook.md, and report event identity, diagnosis, safe response, and verification gates.", timeoutMs: 300_000, monitor: { command: "node probe.mjs", trigger: "failure", intervalMs: 10, maxChecks: 6, reactor: { agent: "analyst" } } },
		criterion: "Captures the fourth probe failure: node n2, volume v9, 97% usage, event d-88; links it to orphan snapshots from job j17; recommends pausing j17, deleting only snapshots older than seven days, and verifying below 80% before resume.",
		criteria: sharedCriteria("Diagnoses the first failing observation and does not recommend indiscriminate volume deletion.", "Includes n2, v9, 97%, d-88, j17, orphan snapshots, older-than-seven-days rule, pause, and below-80% gate.", "Connects each action to the probe/log/runbook evidence and states what remains unverified."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result) => coverage(answer(result), [/\bn2\b/i, /\bv9\b/i, /97\s*%/, /d-88/i, /\bj17\b/i, /older than (seven|7) days?|(seven|7)[ -]?day/i, /below\s+[`*_]*80|<\s*[`*_]*80/i]),
		mock: { content: [{ type: "text", text: "Captured n2/v9 at 97%, event d-88. Pause j17, remove orphan snapshots older than 7 days, and verify below 80%." }], details: { mode: "monitor", results: [] } },
	},
	{
		name: "pattern-worktree-train-library",
		pattern: "worktree",
		evalSplit: "train",
		control: true,
		controlReason: "Two independent small module fixes were faster and higher quality with direct Codex; retain as a threshold negative for worktree activation.",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("worktree-library", { git: true }),
		params: { task: "Fix src/normalize.js and src/retry.js so every assertion in test.js passes, preserving their CommonJS APIs. Run node test.js and report the changes and verification.", timeoutMs: 600_000, worktree: { tasks: [{ id: "normalize", agent: "operator", task: "Fix src/normalize.js against its normalizeEmail assertions in test.js. Do not edit retry.js." }, { id: "retry", agent: "operator", task: "Fix src/retry.js against its retryDelay assertions in test.js. Do not edit normalize.js." }], integrator: { agent: "operator" }, checkCommand: "node test.js" } },
		criterion: "The integrated artifact passes every test.js assertion: email normalization trims/lowercases and rejects invalid/non-string input; retry delay clamps negative attempts, doubles from 100ms, and caps at 800ms; CommonJS exports remain intact.",
		criteria: sharedCriteria("The resulting integrated code passes test.js without weakening tests.", "Both modules and all stated edge cases are fixed, with no task silently omitted.", "The final report names changed files and the exact deterministic verification result."),
		score: worktreeScore,
		mock: { content: [{ type: "text", text: "Both isolated worker commits were integrated; deterministic integration check passed." }], details: { mode: "worktree", results: [] } },
	},
	{
		name: "pattern-worktree-holdout-library",
		pattern: "worktree",
		evalSplit: "holdout",
		control: true,
		controlReason: "Two independent small module fixes were faster and higher quality with direct Codex; retain as a threshold negative for worktree activation.",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("worktree-routing", { git: true }),
		params: { task: "Fix src/window.js and src/routing.js so every assertion in test.js passes, preserving CommonJS APIs. Run node test.js and report the changes and verification.", timeoutMs: 600_000, worktree: { tasks: [{ id: "window", agent: "operator", task: "Fix src/window.js against test.js. Do not edit routing.js." }, { id: "routing", agent: "operator", task: "Fix src/routing.js against test.js. Do not edit window.js." }], integrator: { agent: "operator" }, checkCommand: "node test.js" } },
		criterion: "The integrated artifact passes test.js: clampWindow handles reversed bounds and non-finite values, chooseRegion ignores unhealthy regions and breaks latency ties lexically, and CommonJS exports remain intact.",
		criteria: sharedCriteria("The resulting integrated code passes test.js without weakening tests.", "Both modules and every reversed-bound, non-finite, health, and tie-break edge case are fixed.", "The final report names changed files and the exact deterministic verification result."),
		score: worktreeScore,
		mock: { content: [{ type: "text", text: "Both isolated worker commits were integrated; deterministic integration check passed." }], details: { mode: "worktree", results: [] } },
	},
	{
		name: "pattern-worktree-train-envelope-migration",
		pattern: "worktree",
		evalSplit: "train",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("worktree-envelope-migration", { git: true }),
		params: {
			task: "Read requirements.md and implement the queue-envelope v1-to-v2 migration. New envelopes must be strict v2 with nested job metadata and traceId; the consumer must normalize strict v1 and v2 envelopes, reject hybrids and unknown versions, and preserve the CommonJS APIs. Do not change requirements.md or test.js. Run `node test.js all`, report changed files and the exact verification result.",
			timeoutMs: 600_000,
			concurrency: 2,
			worktree: {
				tasks: [
					{ id: "producer-contract", agent: "operator", task: "Own src/producer.js and the encodeCurrent/CURRENT_VERSION portion of src/protocol.js. Implement strict v2 writes. Do not edit src/consumer.js, requirements.md, or test.js. Run node test.js producer." },
					{ id: "consumer-compatibility", agent: "operator", task: "Own src/consumer.js and the decodeAny/LEGACY_VERSION/CURRENT_VERSION portion of src/protocol.js. Implement strict v1/v2 reads. Do not edit src/producer.js, requirements.md, or test.js. Run node test.js consumer." },
				],
				integrator: { agent: "operator" },
				checkCommand: "BASE=$(git rev-list --max-parents=0 HEAD) && git diff --quiet \"$BASE\" -- requirements.md test.js && node test.js all",
			},
		},
		criterion: "The immutable oracle passes on the final tree: producer emits exact strict v2 envelopes, consumer strictly normalizes v1 and v2 while rejecting hybrids and malformed inputs, all four protocol exports survive reconciliation, and round-trip integration works.",
		criteria: sharedCriteria("The final integrated branch passes the unchanged oracle without dropping either side of the shared protocol contract.", "Implements producer, consumer, all protocol exports, strict validation, backward compatibility, and combined round-trip behavior.", "Names all changed files, explicitly reports reconciliation of src/protocol.js, and gives the exact node test.js all result."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result, ctx) => worktreeScore(result, ctx, ["all"]),
		mock: { content: [{ type: "text", text: "Integrated producer and consumer branches, resolved src/protocol.js, and passed node test.js all." }], details: { mode: "worktree", results: [] } },
	},
	{
		name: "pattern-worktree-holdout-tenant-idempotency",
		pattern: "worktree",
		evalSplit: "holdout",
		hard: true,
		workspace: true,
		setupWorkspace: setupFixture("worktree-tenant-idempotency", { git: true }),
		params: {
			task: "Read requirements.md and implement tenant authentication plus tenant-scoped idempotency in the request pipeline. Authentication must run before idempotency; unauthorized requests and non-2xx responses must never be cached; valid replays must be isolated by tenant, preserve request context, and bypass caching when no key is present. Preserve the CommonJS APIs. Do not change requirements.md or test.js. Run `node test.js all`, report changed files and the exact verification result.",
			timeoutMs: 600_000,
			concurrency: 2,
			worktree: {
				tasks: [
					{ id: "authentication-boundary", agent: "operator", task: "Own src/auth.js and authentication registration in src/pipeline.js. Implement the auth boundary and preserve context. Do not edit src/idempotency.js, requirements.md, or test.js. Run node test.js auth." },
					{ id: "idempotency-boundary", agent: "operator", task: "Own src/idempotency.js and idempotency registration in src/pipeline.js. Implement tenant-scoped success-only caching and bypass. Do not edit src/auth.js, requirements.md, or test.js. Run node test.js idempotency." },
				],
				integrator: { agent: "operator" },
				checkCommand: "BASE=$(git rev-list --max-parents=0 HEAD) && git diff --quiet \"$BASE\" -- requirements.md test.js && node test.js all",
			},
		},
		criterion: "The immutable oracle passes on the final tree: auth is outside idempotency, invalid requests never reach or poison the cache, successful replays are tenant-scoped, context is preserved, missing keys bypass, and non-2xx responses are not cached.",
		criteria: sharedCriteria("The final integrated branch passes the unchanged oracle with the security boundary and cache semantics composed in the correct order.", "Implements both middleware modules, shared pipeline composition, tenant isolation, context preservation, bypass, failure behavior, and combined integration cases.", "Names all changed files, explicitly reports reconciliation of src/pipeline.js, and gives the exact node test.js all result."),
		judgeOnlyDimensions: ["evidence_quality"],
		score: (result, ctx) => worktreeScore(result, ctx, ["all"]),
		mock: { content: [{ type: "text", text: "Integrated auth and idempotency branches, resolved src/pipeline.js, and passed node test.js all." }], details: { mode: "worktree", results: [] } },
	},
]);

export const PATTERN_CALIBRATION_CASES = defineCases([
	{
		name: "calibration-pattern-migration-unsupported",
		task: "Produce a source-grounded migration runbook with gates and rollback.",
		answer: "Cut over immediately at full speed. Rollback should not be necessary, and approval can happen afterward.",
		criterion: "A correct runbook must preserve source constraints, include measurable gates, approval before cutover, evidence, and a viable rollback.",
		criteria: sharedCriteria("Does not violate binding migration constraints.", "Includes gates, approval, rollback, risks, and ownership.", "Grounds claims in concrete source evidence."),
		expectedBehavior: "The answer should be rejected as unsafe, incomplete, and unsupported.",
		objective: { pass: false, score: 0, notes: "known-bad unsafe migration" },
		failureModes: ["final_answer.unsafe", "final_answer.incomplete", "final_answer.unsupported"],
	},
	{
		name: "calibration-pattern-dossier-smoothed",
		task: "Reconcile contradictory operational sources into an evidence dossier.",
		answer: "All sources agree the setting was 4, so there are no conflicts or remaining gaps.",
		criterion: "A correct dossier must preserve contradictions, report the actual observed setting, cite each source, assign confidence, and list gaps.",
		criteria: sharedCriteria("Reconciles the actual facts without a false conclusion.", "Includes every material source conflict, confidence, and unresolved gap.", "Cites specific evidence instead of asserting consensus."),
		expectedBehavior: "The answer should be rejected for smoothing contradictions and inventing consensus.",
		objective: { pass: false, score: 0, notes: "known-bad contradiction smoothing" },
		failureModes: ["final_answer.factually_wrong", "final_answer.incomplete", "final_answer.unsupported"],
	},
	{
		name: "calibration-pattern-monitor-invented",
		task: "Diagnose a captured transient event from probe, log, and runbook evidence.",
		answer: "This is probably a database outage. Restart everything and delete old data; no further verification is needed.",
		criterion: "A correct diagnosis must preserve event identity, connect probe/log evidence, follow bounded runbook actions, avoid destructive invention, and state verification gaps.",
		criteria: sharedCriteria("Diagnoses the captured event without invented or destructive claims.", "Includes event identity, cause, bounded action, verification, and unknowns.", "Distinguishes probe, log, and runbook evidence."),
		expectedBehavior: "The answer should be rejected as invented, incomplete, destructive, and unsupported.",
		objective: { pass: false, score: 0, notes: "known-bad invented monitor response" },
		failureModes: ["final_answer.factually_wrong", "final_answer.incomplete", "final_answer.unsupported"],
	},
]);
