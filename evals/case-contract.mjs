import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = new Set(["representative", "capability", "regression", "adversarial"]);
const DECOMPOSABILITY = new Set(["atomic", "parallel", "sequential"]);
const SHARED_STATE = new Set(["none", "read-only", "mutable"]);
const RISKS = new Set(["low", "medium", "high", "critical"]);
const REVERSIBILITY = new Set(["not-applicable", "reversible", "partially-reversible", "irreversible"]);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const metadata = new Map();
const atomic = { decomposability: "atomic", dependencyDepth: 0, sharedState: "none", risk: "low", reversibility: "not-applicable" };
const lookup = { decomposability: "atomic", dependencyDepth: 1, sharedState: "read-only", risk: "low", reversibility: "reversible" };
const review = { decomposability: "parallel", dependencyDepth: 1, sharedState: "read-only", risk: "medium", reversibility: "reversible" };
const decision = { decomposability: "parallel", dependencyDepth: 2, sharedState: "read-only", risk: "high", reversibility: "irreversible" };
const workflow = { decomposability: "sequential", dependencyDepth: 3, sharedState: "mutable", risk: "high", reversibility: "partially-reversible" };
const worktree = { decomposability: "parallel", dependencyDepth: 2, sharedState: "mutable", risk: "medium", reversibility: "reversible" };
const dossier = { decomposability: "parallel", dependencyDepth: 2, sharedState: "read-only", risk: "medium", reversibility: "reversible" };
const monitor = { decomposability: "sequential", dependencyDepth: 2, sharedState: "read-only", risk: "medium", reversibility: "reversible" };

function register(names, suite, taskFamily, structure) {
	for (const name of names) metadata.set(name, { suite, taskFamily, structure });
}

register([
	"pattern-workflow-train-release",
	"pattern-workflow-holdout-keys",
], "representative", "workflow", workflow);
register([
	"pattern-debate-train-queue",
	"pattern-debate-holdout-audit",
	"pattern-debate-train-publication-review",
	"pattern-debate-holdout-regional-writes",
], "representative", "decision", decision);
register([
	"pattern-dossier-train-deploy",
	"pattern-dossier-holdout-auth",
], "representative", "evidence-synthesis", dossier);
register([
	"pattern-monitor-train-queue",
	"pattern-monitor-holdout-disk",
], "representative", "monitoring", monitor);
register([
	"pattern-worktree-train-library",
	"pattern-worktree-holdout-library",
	"pattern-worktree-train-envelope-migration",
	"pattern-worktree-holdout-tenant-idempotency",
], "representative", "isolated-implementation", worktree);

register(["route-classifies-bug-to-recon"], "regression", "routing", lookup);
register(["recon-retrieves-known-value"], "capability", "repository-lookup", lookup);
register(["return-contract-preserves-evidence"], "regression", "return-contract", lookup);
register(["vote-reaches-known-consensus"], "capability", "consensus", review);
register(["vote-warns-on-same-model-voters"], "regression", "consensus", review);
register(["evaluate-loop-completes-with-gate"], "capability", "iterative-evaluation", workflow);
register(["single-answer-quality-judged"], "representative", "direct-answer", atomic);
register([
	"review-finds-all-webhook-defects",
	"review-finds-session-cache-defects",
], "regression", "code-review", review);

register([
	"calibration-pattern-migration-unsupported",
], "adversarial", "workflow", workflow);
register([
	"calibration-pattern-dossier-smoothed",
], "adversarial", "evidence-synthesis", dossier);
register([
	"calibration-pattern-monitor-invented",
], "adversarial", "monitoring", monitor);
register([
	"calibration-known-value-wrong",
], "adversarial", "repository-lookup", lookup);
register([
	"calibration-webhook-partial-review",
], "adversarial", "code-review", review);
register([
	"calibration-consensus-wrong-answer",
], "adversarial", "consensus", review);

register([
	"trivial-answer-no-flow",
	"tiny-transform-no-flow",
	"short-explanation-no-flow",
], "representative", "direct-answer", atomic);
register([
	"small-repo-lookup-no-flow",
	"single-file-summary-no-dossier",
	"one-command-status-no-monitor",
	"branch-name-no-worktree-flow",
], "representative", "repository-lookup", lookup);
register([
	"package-version-no-flow",
	"plausible-two-file-explain-no-flow",
	"plausible-refactor-scoping-no-flow",
	"plausible-investigation-no-flow",
	"plausible-release-summary-no-flow",
	"plausible-verification-no-flow",
	"plausible-deps-audit-no-flow",
], "regression", "selection-discipline", lookup);
register([
	"quick-comparison-no-debate",
	"unrequested-constrained-decision-no-debate",
], "adversarial", "selection-discipline", decision);
register([
	"small-edit-no-workflow",
], "representative", "small-edit", { ...lookup, sharedState: "mutable" });
register([
	"explicit-flow-list-uses-flow",
	"explicit-delegation-uses-flow",
	"implicit-readonly-agent-uses-recon",
], "capability", "delegation-selection", lookup);
register([
	"implicit-parallel-doc-check-uses-parallel",
	"implicit-plan-critic-uses-evaluate",
	"implicit-broad-map-uses-orchestrate",
], "capability", "delegation-selection", review);
register([
	"implicit-phase-gated-work-uses-workflow",
], "capability", "delegation-selection", workflow);
register([
	"implicit-isolated-writers-use-worktree",
], "capability", "delegation-selection", worktree);
register([
	"explicit-adversarial-decision-uses-debate",
], "capability", "delegation-selection", decision);
register([
	"implicit-evidence-corpus-uses-dossier",
], "capability", "delegation-selection", dossier);
register([
	"implicit-trigger-react-uses-monitor",
], "capability", "delegation-selection", monitor);

/** Attach the declared portfolio and task-structure contract to case objects. */
export function defineCases(cases) {
	return cases.map((testCase) => ({
		...testCase,
		id: testCase.name,
		...(metadata.get(testCase.name) ?? {}),
	}));
}

function getPath(value, segments) {
	return segments.reduce((current, segment) => current?.[segment], value);
}

function pathInsideRoot(repoRoot, relativePath) {
	const absolutePath = resolve(repoRoot, relativePath);
	const sourceRelative = relative(repoRoot, absolutePath);
	const outsideRoot = sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative);
	return outsideRoot ? null : absolutePath;
}

function sourceExpectationIssues(testCase, repoRoot) {
	const expectation = testCase.sourceExpectation;
	if (!expectation) return [];
	const label = `${testCase.id ?? testCase.name}.sourceExpectation`;
	if (typeof expectation.path !== "string" || !Array.isArray(expectation.jsonPath)) {
		return [`${label} must declare path and jsonPath`];
	}
	const sourcePath = pathInsideRoot(repoRoot, expectation.path);
	if (!sourcePath) return [`${label}.path must stay inside the repository`];
	let source;
	try {
		source = getPath(JSON.parse(readFileSync(sourcePath, "utf8")), expectation.jsonPath);
	} catch (error) {
		return [`${label} could not read ${expectation.path}: ${error.message}`];
	}
	if (source === undefined) return [`${label} did not resolve ${expectation.jsonPath.join(".")} in ${expectation.path}`];

	const expected = getPath(testCase, expectation.expectedPath ?? ["mock", "answer"]);
	const pattern = getPath(testCase, expectation.patternPath ?? ["answerPattern"]);
	const issues = [];
	if (String(expected) !== String(source)) {
		issues.push(`${label} is stale: ${expectation.path} contains ${JSON.stringify(source)} but the case expects ${JSON.stringify(expected)}`);
	}
	try {
		if (typeof pattern !== "string" || !new RegExp(pattern).test(String(source))) {
			issues.push(`${label} pattern ${JSON.stringify(pattern)} does not accept source value ${JSON.stringify(source)}`);
		}
	} catch {
		issues.push(`${label} pattern ${JSON.stringify(pattern)} is not a valid regular expression`);
	}
	return issues;
}

function directoryFiles(directory) {
	return readdirSync(directory).sort().flatMap((entry) => {
		const path = resolve(directory, entry);
		return statSync(path).isDirectory() ? directoryFiles(path) : [path];
	});
}

function directoryDigest(directory) {
	const digest = createHash("sha256");
	for (const path of directoryFiles(directory)) {
		digest.update(relative(directory, path).split(sep).join("/"));
		digest.update("\0");
		digest.update(readFileSync(path));
		digest.update("\0");
	}
	return digest.digest("hex");
}

function sourceSnapshotIssues(snapshots, repoRoot) {
	if (snapshots === undefined) return [];
	if (!Array.isArray(snapshots)) return ["corpus.sourceSnapshots must be an array"];
	const issues = [];
	const seen = new Set();
	for (const snapshot of snapshots) {
		const label = `source snapshot ${snapshot?.id ?? "<unnamed>"}`;
		if (!ID_PATTERN.test(snapshot?.id ?? "")) issues.push(`${label} must have a stable kebab-case id`);
		if (seen.has(snapshot?.id)) issues.push(`${label} is duplicated`);
		seen.add(snapshot?.id);
		const sourcePath = typeof snapshot?.path === "string" ? pathInsideRoot(repoRoot, snapshot.path) : null;
		if (!sourcePath) {
			issues.push(`${label} path must stay inside the repository`);
			continue;
		}
		try {
			const actual = directoryDigest(sourcePath);
			if (actual !== snapshot.sha256) {
				issues.push(`${label} is stale: ${snapshot.path} digest is ${actual}, expected ${snapshot.sha256}`);
			}
		} catch (error) {
			issues.push(`${label} could not read ${snapshot.path}: ${error.message}`);
		}
	}
	return issues;
}

function caseIssues(testCase, repoRoot) {
	const label = testCase?.id ?? testCase?.name ?? "<unnamed>";
	const issues = [];
	if (!ID_PATTERN.test(testCase?.id ?? "")) issues.push(`${label}.id must be a stable kebab-case identifier`);
	if (testCase?.name !== testCase?.id) issues.push(`${label}.name must equal its stable id`);
	if (!SUITES.has(testCase?.suite)) issues.push(`${label}.suite must be representative, capability, regression, or adversarial`);
	if (!ID_PATTERN.test(testCase?.taskFamily ?? "")) issues.push(`${label}.taskFamily must be a non-empty kebab-case label`);
	const taskStructure = testCase?.structure;
	if (!DECOMPOSABILITY.has(taskStructure?.decomposability)) issues.push(`${label}.structure.decomposability is invalid`);
	if (!Number.isInteger(taskStructure?.dependencyDepth) || taskStructure.dependencyDepth < 0) issues.push(`${label}.structure.dependencyDepth must be a non-negative integer`);
	if (!SHARED_STATE.has(taskStructure?.sharedState)) issues.push(`${label}.structure.sharedState is invalid`);
	if (!RISKS.has(taskStructure?.risk)) issues.push(`${label}.structure.risk is invalid`);
	if (!REVERSIBILITY.has(taskStructure?.reversibility)) issues.push(`${label}.structure.reversibility is invalid`);
	issues.push(...sourceExpectationIssues(testCase, repoRoot));
	return issues;
}

export function validateCaseCorpus(corpus, { repoRoot = REPO_ROOT } = {}) {
	const groups = ["measurement", "calibration", "selection"];
	const issues = [];
	const seen = new Set();
	for (const group of groups) {
		if (!Array.isArray(corpus?.[group])) {
			issues.push(`corpus.${group} must be an array`);
			continue;
		}
		for (const testCase of corpus[group]) {
			issues.push(...caseIssues(testCase, repoRoot));
			if (seen.has(testCase.id)) issues.push(`${testCase.id} is duplicated across the eval corpus`);
			seen.add(testCase.id);
		}
	}
	issues.push(...sourceSnapshotIssues(corpus?.sourceSnapshots, repoRoot));
	return { ok: issues.length === 0, issues, caseCount: seen.size };
}

function groupedCounts(cases, key, excluded) {
	const counts = {};
	for (const testCase of cases) {
		const label = testCase[key];
		counts[label] ??= { cases: 0, excluded: 0 };
		counts[label].cases += 1;
		if (excluded.has(testCase.id ?? testCase.name)) counts[label].excluded += 1;
	}
	return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function portfolioReport(cases, { excluded = [] } = {}) {
	const excludedIds = new Set(excluded);
	return {
		bySuite: groupedCounts(cases, "suite", excludedIds),
		byTaskFamily: groupedCounts(cases, "taskFamily", excludedIds),
	};
}

function formatCounts(counts) {
	return Object.entries(counts)
		.map(([name, count]) => `${name} ${count.cases} (${count.excluded} excluded)`)
		.join(", ");
}

export function formatPortfolioReport(report) {
	return `suite: ${formatCounts(report.bySuite)}\ntask family: ${formatCounts(report.byTaskFamily)}`;
}

export function corpusPreflightStep(corpus, { repoRoot = REPO_ROOT, onValid = console.log } = {}) {
	return () => {
		const validation = validateCaseCorpus(corpus, { repoRoot });
		if (!validation.ok) return `Eval corpus preflight failed before model invocation:\n- ${validation.issues.join("\n- ")}`;
		const cases = ["measurement", "calibration", "selection"].flatMap((group) => corpus[group]);
		onValid(`Eval corpus: ${validation.caseCount} cases\n${formatPortfolioReport(portfolioReport(cases))}`);
		return null;
	};
}
