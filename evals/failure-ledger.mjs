import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactText } from "../extensions/pi-flows/sanitize.ts";

export const FAILURE_INPUT_SCHEMA_VERSION = "pi-flows.validated-production-failure.v1";
export const FAILURE_LEDGER_SCHEMA_VERSION = "pi-flows.failure-ledger-event.v1";
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STRUCTURE_VALUES = {
	decomposability: new Set(["atomic", "parallel", "sequential"]),
	sharedState: new Set(["none", "read-only", "mutable"]),
	risk: new Set(["low", "medium", "high", "critical"]),
	reversibility: new Set(["not-applicable", "reversible", "partially-reversible", "irreversible"]),
};

function canonicalValue(value) {
	if (Array.isArray(value)) return value.map(canonicalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function digest(value) {
	return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function requireKeys(value, allowed, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function requiredText(value, label, maximum = 4_096) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text`);
	if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
	return redactText(value.trim());
}

function boundedContent(value, label, maximum) {
	if (typeof value !== "string") throw new Error(`${label} must be text`);
	if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
	return redactText(value);
}

function sanitizedStructure(structure) {
	requireKeys(structure, ["decomposability", "dependencyDepth", "sharedState", "risk", "reversibility"], "case.structure");
	for (const [key, values] of Object.entries(STRUCTURE_VALUES)) {
		if (!values.has(structure[key])) throw new Error(`case.structure.${key} is invalid`);
	}
	if (!Number.isInteger(structure.dependencyDepth) || structure.dependencyDepth < 0) throw new Error("case.structure.dependencyDepth must be a non-negative integer");
	return structuredClone(structure);
}

function sanitizedFiles(initialState) {
	requireKeys(initialState, ["files"], "case.initialState");
	if (!Array.isArray(initialState.files) || initialState.files.length === 0) throw new Error("case.initialState.files must be non-empty");
	let totalBytes = 0;
	const files = initialState.files.map((file, index) => {
		requireKeys(file, ["path", "content"], `case.initialState.files[${index}]`);
		const relative = requiredText(file.path, `case.initialState.files[${index}].path`, 256).replaceAll("\\", "/");
		if (path.posix.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error(`case.initialState.files[${index}].path must stay inside the case workspace`);
		const content = boundedContent(file.content, `case.initialState.files[${index}].content`, 32_768);
		totalBytes += Buffer.byteLength(content, "utf8");
		return { path: relative, content };
	});
	if (totalBytes > 65_536) throw new Error("case.initialState exceeds 65536 bytes");
	if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("case.initialState file paths must be unique");
	return { files, sha256: digest(files) };
}

function sanitizedTraceLink(traceLink) {
	requireKeys(traceLink, ["runId", "caseId", "trialId", "traceFile", "traceId", "rootSpanId", "sha256"], "case.traceLink");
	return Object.fromEntries(Object.entries(traceLink).map(([key, value]) => [key, requiredText(value, `case.traceLink.${key}`, 1_024)]));
}

function sanitizedCase(input) {
	requireKeys(input, [
		"id", "title", "taskFamily", "structure", "agent", "task", "criterion", "expectedBehavior",
		"objective", "initialState", "traceLink", "failure", "promotionPolicy",
	], "case");
	if (!ID_PATTERN.test(input.id ?? "")) throw new Error("case.id must be a stable kebab-case identifier");
	if (!ID_PATTERN.test(input.taskFamily ?? "")) throw new Error("case.taskFamily must be a kebab-case identifier");
	requireKeys(input.objective, ["kind", "value"], "case.objective");
	if (input.objective.kind !== "answer-includes") throw new Error("case.objective.kind must be answer-includes");
	requireKeys(input.failure, ["summary", "labels"], "case.failure");
	if (!Array.isArray(input.failure.labels) || input.failure.labels.some((label) => typeof label !== "string")) throw new Error("case.failure.labels must be text labels");
	requireKeys(input.promotionPolicy, ["minimumHeldOutTrials", "requiredPassRate"], "case.promotionPolicy");
	const minimum = input.promotionPolicy.minimumHeldOutTrials;
	if (!Number.isInteger(minimum) || minimum < 3 || minimum > 50) throw new Error("case.promotionPolicy.minimumHeldOutTrials must be an integer from 3 to 50");
	if (input.promotionPolicy.requiredPassRate !== 1) throw new Error("case.promotionPolicy.requiredPassRate must be 1");
	return {
		id: input.id,
		title: requiredText(input.title, "case.title"),
		suite: "capability",
		taskFamily: input.taskFamily,
		structure: sanitizedStructure(input.structure),
		agent: requiredText(input.agent, "case.agent", 128),
		task: requiredText(input.task, "case.task"),
		criterion: requiredText(input.criterion, "case.criterion"),
		expectedBehavior: requiredText(input.expectedBehavior, "case.expectedBehavior"),
		objective: { kind: "answer-includes", value: requiredText(input.objective.value, "case.objective.value", 1_024) },
		initialState: sanitizedFiles(input.initialState),
		traceLink: sanitizedTraceLink(input.traceLink),
		failure: {
			summary: requiredText(input.failure.summary, "case.failure.summary"),
			labels: input.failure.labels.map((label, index) => requiredText(label, `case.failure.labels[${index}]`, 256)),
		},
		promotionPolicy: { minimumHeldOutTrials: minimum, requiredPassRate: 1 },
	};
}

export function buildFailureImport(input, { importedAt = new Date().toISOString() } = {}) {
	requireKeys(input, ["schemaVersion", "validation", "case"], "failure input");
	if (input.schemaVersion !== FAILURE_INPUT_SCHEMA_VERSION) throw new Error(`failure input must use ${FAILURE_INPUT_SCHEMA_VERSION}`);
	requireKeys(input.validation, ["status", "validator", "validatedAt", "privacyReview"], "validation");
	if (input.validation.status !== "validated") throw new Error("validation.status must be validated");
	if (input.validation.privacyReview !== "passed") throw new Error("validation.privacyReview must be passed");
	return {
		type: "failure.imported",
		recordedAt: importedAt,
		validation: {
			status: "validated",
			validator: requiredText(input.validation.validator, "validation.validator", 256),
			validatedAt: requiredText(input.validation.validatedAt, "validation.validatedAt", 128),
			privacyReview: "passed",
		},
		case: sanitizedCase(input.case),
	};
}

function eventPayload(event, sequence, previousHash) {
	const payload = { schemaVersion: FAILURE_LEDGER_SCHEMA_VERSION, sequence, previousHash, ...event };
	return { ...payload, eventHash: digest(payload) };
}

export async function readFailureLedger(ledgerPath) {
	let raw;
	try {
		raw = await readFile(ledgerPath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return { valid: true, issues: [], events: [] };
		throw error;
	}
	const events = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
		try {
			return JSON.parse(line);
		} catch {
			throw new Error(`failure ledger line ${index + 1} is not valid JSON`);
		}
	});
	const issues = [];
	let previousHash = null;
	for (const [index, event] of events.entries()) {
		const { eventHash, ...payload } = event;
		if (event.schemaVersion !== FAILURE_LEDGER_SCHEMA_VERSION) issues.push(`line ${index + 1} has an unsupported schema`);
		if (event.sequence !== index + 1) issues.push(`line ${index + 1} has a broken sequence`);
		if (event.previousHash !== previousHash) issues.push(`line ${index + 1} has a broken previousHash`);
		if (eventHash !== digest(payload)) issues.push(`line ${index + 1} has a broken eventHash`);
		previousHash = eventHash;
	}
	return { valid: issues.length === 0, issues, events };
}

export async function appendFailureEvent(ledgerPath, event) {
	const ledger = await readFailureLedger(ledgerPath);
	if (!ledger.valid) throw new Error(`refusing to append to an invalid failure ledger: ${ledger.issues.join("; ")}`);
	const previous = ledger.events.at(-1);
	const record = eventPayload(event, ledger.events.length + 1, previous?.eventHash ?? null);
	await mkdir(path.dirname(ledgerPath), { recursive: true });
	await appendFile(ledgerPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(ledgerPath, 0o600);
	return record;
}

export function buildHeldOutTrialEvents({ caseId, reliability, systemDigest, recordedAt = new Date().toISOString() }) {
	if (!ID_PATTERN.test(caseId ?? "")) throw new Error("caseId must be a stable kebab-case identifier");
	const matching = (reliability?.cases ?? []).find((entry) => entry.caseId === caseId);
	if (!matching || !Array.isArray(matching.trials) || matching.trials.length === 0) throw new Error(`reliability artifact has no trials for ${caseId}`);
	return matching.trials.map((trial) => ({
		type: "failure.held-out-trial",
		recordedAt,
		caseId,
		runId: reliability.runId ?? null,
		trialId: trial.trialId,
		systemDigest: requiredText(systemDigest, "systemDigest", 256),
		passed: trial.pass === true && !trial.exclusion,
		traceHealth: trial.scoreFamilies?.traceHealth?.status ?? "missing",
		policyPassed: trial.scoreFamilies?.policyCompliance?.pass === true,
		verifiedOutcomePassed: trial.scoreFamilies?.verifiedOutcome?.pass === true,
		evidenceDigest: digest(trial),
	}));
}

export function buildPromotionDecision(events, caseId, { decidedAt = new Date().toISOString() } = {}) {
	const imported = events.find((event) => event.type === "failure.imported" && event.case?.id === caseId);
	if (!imported) throw new Error(`failure ${caseId} has not been imported`);
	const previousApproval = events.find((event) => event.type === "failure.promotion" && event.caseId === caseId && event.decision === "approved");
	if (previousApproval) throw new Error(`failure ${caseId} is already promoted`);
	const trials = events.filter((event) => event.type === "failure.held-out-trial" && event.caseId === caseId);
	const uniqueTrials = new Map(trials.map((trial) => [trial.trialId, trial]));
	const evidence = [...uniqueTrials.values()];
	const policy = imported.case.promotionPolicy;
	const reasons = [];
	if (evidence.length < policy.minimumHeldOutTrials) reasons.push(`promotion requires ${policy.minimumHeldOutTrials} held-out trials; found ${evidence.length}`);
	if (new Set(evidence.map((trial) => trial.systemDigest)).size > 1) reasons.push("held-out trials must evaluate the same evaluated system");
	if (evidence.some((trial) => !trial.passed)) reasons.push("every held-out trial must pass");
	if (evidence.some((trial) => trial.traceHealth !== "recorded")) reasons.push("every held-out trial must retain its required runtime trace");
	if (evidence.some((trial) => !trial.policyPassed)) reasons.push("every held-out trial must pass policy compliance");
	if (evidence.some((trial) => !trial.verifiedOutcomePassed)) reasons.push("every held-out trial must have a verified successful outcome");
	return {
		type: "failure.promotion",
		recordedAt: decidedAt,
		caseId,
		fromSuite: "capability",
		toSuite: reasons.length === 0 ? "regression" : null,
		decision: reasons.length === 0 ? "approved" : "denied",
		reasons,
		systemDigest: evidence[0]?.systemDigest ?? null,
		trialIds: evidence.map((trial) => trial.trialId).sort(),
		evidenceDigest: digest(evidence),
	};
}

export function promotedRegressionCaseIds(events) {
	return events
		.filter((event) => event.type === "failure.promotion" && event.decision === "approved")
		.map((event) => event.caseId)
		.filter((caseId, index, all) => all.indexOf(caseId) === index)
		.sort();
}

export function failureCasesFromLedger(events) {
	const promoted = new Set(promotedRegressionCaseIds(events));
	return events
		.filter((event) => event.type === "failure.imported")
		.filter((event, index, all) => all.findIndex((candidate) => candidate.case?.id === event.case?.id) === index)
		.map((event) => {
			const stored = event.case;
			return {
				name: stored.id,
				id: stored.id,
				suite: promoted.has(stored.id) ? "regression" : "capability",
				taskFamily: stored.taskFamily,
				structure: stored.structure,
				params: { agent: stored.agent, task: stored.task },
				criterion: stored.criterion,
				expectedBehavior: stored.expectedBehavior,
				failureModes: stored.failure.labels,
				workspace: true,
				setupWorkspace(cwd) {
					for (const file of stored.initialState.files) {
						const target = path.join(cwd, file.path);
						mkdirSync(path.dirname(target), { recursive: true });
						writeFileSync(target, file.content, { encoding: "utf8", mode: 0o600 });
					}
				},
				score(result) {
					const answer = result?.content?.[0]?.text ?? "";
					const pass = answer.includes(stored.objective.value);
					return { pass, score: pass ? 1 : 0, notes: pass ? "matched imported objective" : "imported objective did not match" };
				},
				mock: { content: [{ type: "text", text: stored.objective.value }], details: { results: [] } },
				productionFailure: { traceLink: stored.traceLink, initialStateDigest: stored.initialState.sha256 },
			};
		});
}
