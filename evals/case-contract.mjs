import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
	"calibration-consensus-correct-answer",
], "adversarial", "consensus", review);
register([
	"calibration-known-value-correct",
	"calibration-nonanswer-restates-task",
], "adversarial", "repository-lookup", lookup);
register([
	"calibration-webhook-complete-review",
	"calibration-session-cache-partial-review",
	"calibration-session-cache-fabricated-defect",
], "adversarial", "code-review", review);

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
	"explicit-scout-uses-preset",
	"implicit-readonly-agent-uses-recon",
], "capability", "delegation-selection", lookup);
register([
	"implicit-parallel-doc-check-uses-parallel",
	"implicit-plan-critic-uses-evaluate",
	"implicit-broad-map-uses-orchestrate",
	"explicit-code-review-uses-preset",
	"explicit-map-codebase-uses-preset",
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
	"independent-review-safe-first-call",
], "regression", "delegation-selection", review);
register([
	"implicit-evidence-corpus-uses-dossier",
], "capability", "delegation-selection", dossier);
register([
	"implicit-trigger-react-uses-monitor",
], "capability", "delegation-selection", monitor);

/** Attach portfolio metadata and the spawning justification owned by the eval harness. */
export function defineCases(cases) {
	return cases.map((testCase) => ({
		...testCase,
		id: testCase.name,
		...(metadata.get(testCase.name) ?? {}),
		...(testCase.params ? {
			params: {
				why: `controlled evaluation case ${testCase.name} requires bounded child execution`,
				...testCase.params,
			},
		} : {}),
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

function patternIssues(label, value, patterns) {
	const issues = [];
	for (const pattern of patterns ?? []) {
		try {
			if (typeof pattern !== "string" || !new RegExp(pattern, "im").test(String(value))) {
				issues.push(`${label} does not match ${JSON.stringify(pattern)}`);
			}
		} catch {
			issues.push(`${label} pattern ${JSON.stringify(pattern)} is not a valid regular expression`);
		}
	}
	return issues;
}

function oneSourceExpectationIssues(testCase, expectation, repoRoot, label) {
	if (typeof expectation?.path !== "string") return [`${label} must declare path`];
	const sourcePath = pathInsideRoot(repoRoot, expectation.path);
	if (!sourcePath) return [`${label}.path must stay inside the repository`];
	if (expectation.format === "node-script") {
		try {
			const output = execFileSync(process.execPath, [sourcePath], { cwd: repoRoot, encoding: "utf8" });
			return patternIssues(label, output, expectation.patterns);
		} catch (error) {
			return [`${label} failed: ${error.stderr?.toString().trim() || error.message}`];
		}
	}
	let raw;
	try {
		raw = readFileSync(sourcePath, "utf8");
	} catch (error) {
		return [`${label} could not read ${expectation.path}: ${error.message}`];
	}
	if (expectation.format === "text") return patternIssues(label, raw, expectation.patterns);

	let json;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return [`${label} could not parse ${expectation.path}: ${error.message}`];
	}
	if (expectation.relation === "disjoint-keys") {
		const [leftPath, rightPath] = expectation.jsonPaths ?? [];
		const left = getPath(json, leftPath ?? []) ?? {};
		const right = getPath(json, rightPath ?? []) ?? {};
		const overlap = Object.keys(left).filter((key) => Object.hasOwn(right, key));
		return overlap.length === 0 ? [] : [`${label} is stale: overlapping keys are ${overlap.join(", ")}`];
	}
	if (!Array.isArray(expectation.jsonPath)) return [`${label} must declare jsonPath`];
	const source = getPath(json, expectation.jsonPath);
	if (source === undefined) return [`${label} did not resolve ${expectation.jsonPath.join(".")} in ${expectation.path}`];

	const issues = [];
	if (Array.isArray(expectation.expectedPath)) {
		const expected = getPath(testCase, expectation.expectedPath);
		if (String(expected) !== String(source)) {
			issues.push(`${label} is stale: ${expectation.path} contains ${JSON.stringify(source)} but the case expects ${JSON.stringify(expected)}`);
		}
	}
	if (Array.isArray(expectation.patternPath)) {
		const pattern = getPath(testCase, expectation.patternPath);
		const mismatch = patternIssues(`${label} source value ${JSON.stringify(source)}`, source, [pattern]);
		issues.push(...mismatch);
	}
	issues.push(...patternIssues(label, source, expectation.patterns));
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
		const content = readFileSync(path);
		digest.update(content.includes(0) ? content : content.toString("utf8").replaceAll("\r\n", "\n"));
		digest.update("\0");
	}
	return digest.digest("hex");
}

function sourceExpectationIssues(testCase, repoRoot) {
	const issues = [];
	const expectations = [];
	if (testCase.sourceExpectation) expectations.push(testCase.sourceExpectation);
	if (testCase.sourceExpectations !== undefined && !Array.isArray(testCase.sourceExpectations)) {
		issues.push(`${testCase.id}.sourceExpectations must be an array`);
	} else {
		expectations.push(...(testCase.sourceExpectations ?? []));
	}
	for (const [index, expectation] of expectations.entries()) {
		issues.push(...oneSourceExpectationIssues(testCase, expectation, repoRoot, `${testCase.id}.sourceExpectations[${index}]`));
	}
	return issues;
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

function asList(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

// The scorer reads exactly these shape fields; anything else is a typo the
// scorer would silently ignore. firstCall is meaningful only on a top-level
// expectation — inside anyOf arms and forbidden shapes it would be a silent
// no-op, so it is unknown there.
const SHAPE_KEYS = new Set(["preset", "mode", "modes", "agent", "agents", "minTasks", "taskPattern", "everyTaskPattern", "params", "anyOf", "knownAgentsOnly"]);

function flowCallShapeIssues(label, shape, { requireNonEmpty, allowFirstCall = false }) {
	if (!shape || typeof shape !== "object" || Array.isArray(shape)) return [`${label} must be an object shape`];
	const issues = [];
	if (requireNonEmpty && Object.keys(shape).length === 0) {
		issues.push(`${label} must name at least one field — an empty forbidden shape would match every call`);
	}
	// A top-level expectation carrying no shape field (empty, or firstCall
	// alone) matches any admitted call, silently disabling the argument
	// constraints the case appears to have.
	if (!requireNonEmpty && !Object.keys(shape).some((key) => SHAPE_KEYS.has(key))) {
		issues.push(`${label} must name at least one shape field (${[...SHAPE_KEYS].join(", ")}) — otherwise any admitted call matches`);
	}
	for (const key of Object.keys(shape)) {
		if (!SHAPE_KEYS.has(key) && !(allowFirstCall && key === "firstCall")) {
			issues.push(`${label}.${key} is not a shape field the scorer reads (known: ${[...SHAPE_KEYS, ...(allowFirstCall ? ["firstCall"] : [])].join(", ")})`);
		}
	}
	// A present-but-vacuous predicate constrains nothing: an empty params
	// object or agent list matches every call (and, as a forbidden shape,
	// rejects every call), silently — the same trap as an unknown key.
	for (const listField of ["mode", "modes", "agent", "agents"]) {
		if (Array.isArray(shape[listField]) && shape[listField].length === 0) {
			issues.push(`${label}.${listField} must not be an empty list — it would constrain nothing`);
		}
	}
	for (const patternField of ["preset", "taskPattern", "everyTaskPattern"]) {
		if (shape[patternField] !== undefined && (typeof shape[patternField] !== "string" || shape[patternField] === "")) {
			issues.push(`${label}.${patternField} must be a non-empty string`);
		}
	}
	if (shape.firstCall !== undefined && typeof shape.firstCall !== "boolean") {
		issues.push(`${label}.firstCall must be a boolean`);
	}
	if (shape.knownAgentsOnly !== undefined && shape.knownAgentsOnly !== true) {
		issues.push(`${label}.knownAgentsOnly must be true when present — false is the default and would constrain nothing`);
	}
	// Validation is mode-blind; what minTasks counts is per-mode (for workflow
	// it is the handler's work phases, not raw phase count) and lives with the
	// scorer in select-scoring.mjs and evals/README.md.
	if (shape.minTasks !== undefined && (!Number.isInteger(shape.minTasks) || shape.minTasks < 1)) {
		issues.push(`${label}.minTasks must be a positive integer — anything else makes the comparison vacuous`);
	}
	for (const patternField of ["taskPattern", "everyTaskPattern"]) {
		if (shape[patternField] === undefined) continue;
		try {
			new RegExp(shape[patternField], "i");
		} catch {
			issues.push(`${label}.${patternField} is not a valid regular expression`);
		}
	}
	if (shape.params !== undefined) {
		if (!shape.params || typeof shape.params !== "object" || Array.isArray(shape.params)) {
			issues.push(`${label}.params must be an object of scalar pins`);
		} else if (Object.keys(shape.params).length === 0) {
			issues.push(`${label}.params must pin at least one value — an empty pin set would constrain nothing`);
		} else {
			for (const [key, value] of Object.entries(shape.params)) {
				if (!["boolean", "number", "string"].includes(typeof value)) {
					issues.push(`${label}.params.${key} must pin a boolean, number, or string`);
				}
			}
		}
	}
	if (shape.anyOf !== undefined) {
		if (!Array.isArray(shape.anyOf) || shape.anyOf.length === 0) {
			issues.push(`${label}.anyOf must be a non-empty array of shapes`);
		} else {
			for (const [index, arm] of shape.anyOf.entries()) {
				issues.push(...flowCallShapeIssues(`${label}.anyOf[${index}]`, arm, { requireNonEmpty: true }));
			}
		}
	}
	return issues;
}

/**
 * The sequence predicates are opt-in per case and silently doing nothing is
 * their worst failure mode, so a typo'd field must fail corpus preflight
 * before any model is invoked.
 */
function sequencePredicateIssues(testCase) {
	const label = testCase?.id ?? testCase?.name ?? "<unnamed>";
	const issues = [];
	for (const [index, expectation] of asList(testCase?.expectedFlowCall ?? testCase?.expectedFlowCalls).entries()) {
		issues.push(...flowCallShapeIssues(`${label}.expectedFlowCalls[${index}]`, expectation, { requireNonEmpty: false, allowFirstCall: true }));
	}
	for (const [index, shape] of asList(testCase?.forbiddenFlowCall ?? testCase?.forbiddenFlowCalls).entries()) {
		issues.push(...flowCallShapeIssues(`${label}.forbiddenFlowCalls[${index}]`, shape, { requireNonEmpty: true }));
	}
	if (testCase?.maxRefusedCalls !== undefined && (!Number.isInteger(testCase.maxRefusedCalls) || testCase.maxRefusedCalls < 0)) {
		issues.push(`${label}.maxRefusedCalls must be a non-negative integer`);
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
	if (typeof testCase?.answerPattern === "string" && typeof testCase?.mock?.answer === "string") {
		issues.push(...patternIssues(`${label}.mock.answer`, testCase.mock.answer, [testCase.answerPattern]));
	}
	issues.push(...sequencePredicateIssues(testCase));
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
