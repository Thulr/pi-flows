import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactText } from "../extensions/pi-flows/sanitize.ts";
import { canonicalDigest } from "./calibration-key.mjs";
import { reliabilityAttestationIsValid } from "./reliability.mjs";
import { promotionProvenanceIssues } from "./evaluation-artifacts.mjs";
import { withExclusiveFileLock } from "./file-lock.mjs";
export const FAILURE_INPUT_SCHEMA_VERSION = "pi-flows.validated-production-failure.v1";
export const FAILURE_LEDGER_SCHEMA_VERSION = "pi-flows.failure-ledger-event.v1";
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STRUCTURE_VALUES = {
	decomposability: new Set(["atomic", "parallel", "sequential"]),
	sharedState: new Set(["none", "read-only", "mutable"]),
	risk: new Set(["low", "medium", "high", "critical"]),
	reversibility: new Set(["not-applicable", "reversible", "partially-reversible", "irreversible"]),
};

function digest(value) {
	return canonicalDigest(value, 64);
}

export function evaluatedSystemDigest(reliability) {
	return digest({
		system: reliability?.evaluatedSystem ?? null,
		evaluation: reliability?.evaluation ?? null,
	});
}

export function failureLedgerIdentity(events, sha256) {
	return {
		sha256,
		headHash: events.at(-1)?.eventHash ?? null,
		promotedCaseIds: promotedRegressionCaseIds(events),
		importedCases: Object.fromEntries(events
			.filter((event) => event.type === "failure.imported")
			.map((event) => [event.case.id, { eventHash: event.eventHash, caseDigest: digest(event.case) }])
			.sort(([left], [right]) => left.localeCompare(right))),
	};
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
		const normalized = path.posix.normalize(relative);
		if (relative.includes("\0") || relative === "." || relative.endsWith("/") || normalized !== relative || path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
			throw new Error(`case.initialState.files[${index}].path must be one normalized file path inside the case workspace`);
		}
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

export function buildFailureImport(input, { importedAt = new Date().toISOString(), traceValidation } = {}) {
	requireKeys(input, ["schemaVersion", "validation", "case"], "failure input");
	if (input.schemaVersion !== FAILURE_INPUT_SCHEMA_VERSION) throw new Error(`failure input must use ${FAILURE_INPUT_SCHEMA_VERSION}`);
	requireKeys(input.validation, ["status", "validator", "validatedAt", "privacyReview"], "validation");
	if (input.validation.status !== "validated") throw new Error("validation.status must be validated");
	if (input.validation.privacyReview !== "passed") throw new Error("validation.privacyReview must be passed");
	if (!traceValidation?.valid) throw new Error(`production trace validation is required: ${(traceValidation?.issues ?? ["validation was not run"]).join("; ")}`);
	if (traceValidation.sha256 !== input.case?.traceLink?.sha256
		|| traceValidation.traceId !== input.case?.traceLink?.traceId
		|| traceValidation.rootSpanId !== input.case?.traceLink?.rootSpanId) {
		throw new Error("production trace validation does not match the failure trace link");
	}
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
		traceValidation: {
			sha256: traceValidation.sha256,
			traceId: traceValidation.traceId,
			rootSpanId: traceValidation.rootSpanId,
		},
	};
}

function eventPayload(event, sequence, previousHash) {
	const payload = { schemaVersion: FAILURE_LEDGER_SCHEMA_VERSION, sequence, previousHash, ...event };
	return { ...payload, eventHash: digest(payload) };
}

function eventBody(event) {
	const { schemaVersion, sequence, previousHash, eventHash, ...body } = event;
	return body;
}

function importedEventIssue(event, label) {
	try {
		requireKeys(eventBody(event), ["type", "recordedAt", "validation", "case", "traceValidation"], label);
		if (event.type !== "failure.imported") throw new Error(`${label}.type is invalid`);
		const validation = event.validation;
		requireKeys(validation, ["status", "validator", "validatedAt", "privacyReview"], `${label}.validation`);
		const expectedValidation = {
			status: "validated",
			validator: requiredText(validation.validator, `${label}.validation.validator`, 256),
			validatedAt: requiredText(validation.validatedAt, `${label}.validation.validatedAt`, 128),
			privacyReview: "passed",
		};
		if (validation.status !== "validated" || validation.privacyReview !== "passed" || digest(validation) !== digest(expectedValidation)) {
			throw new Error(`${label}.validation is not a canonical validated privacy review`);
		}
		const { suite, initialState, ...candidate } = event.case ?? {};
		const canonicalCase = sanitizedCase({ ...candidate, initialState: { files: initialState?.files } });
		if (suite !== "capability" || digest(event.case) !== digest(canonicalCase)) throw new Error(`${label}.case is not canonical sanitized import data`);
		requireKeys(event.traceValidation, ["sha256", "traceId", "rootSpanId"], `${label}.traceValidation`);
		if (event.traceValidation.sha256 !== canonicalCase.traceLink.sha256
			|| event.traceValidation.traceId !== canonicalCase.traceLink.traceId
			|| event.traceValidation.rootSpanId !== canonicalCase.traceLink.rootSpanId) {
			throw new Error(`${label}.traceValidation does not match its case trace link`);
		}
		return null;
	} catch (error) {
		return error.message;
	}
}

function heldOutEventIssue(event, label) {
	try {
		requireKeys(eventBody(event), [
			"type", "recordedAt", "caseId", "runId", "trialId", "systemDigest", "passed", "traceHealth", "policyPassed", "verifiedOutcomePassed", "runtimeTraceSha256",
			"importEventHash", "caseDigest", "ledgerSha256", "ledgerHeadHash", "judgedRunSha256", "calibrationSha256", "reliabilitySha256",
			"attestationKeyId", "attestationPayloadDigest", "reliabilityAttestationSignature", "evidenceDigest",
		], label);
		if (!ID_PATTERN.test(event.caseId ?? "") || !requiredText(event.runId, `${label}.runId`, 256)
			|| !requiredText(event.trialId, `${label}.trialId`, 512)
			|| !/^[a-f0-9]{64}$/.test(event.systemDigest ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.runtimeTraceSha256 ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.importEventHash ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.caseDigest ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.ledgerSha256 ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.ledgerHeadHash ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.judgedRunSha256 ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.calibrationSha256 ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.reliabilitySha256 ?? "")
			|| !/^[a-f0-9]{16}$/.test(event.attestationKeyId ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.attestationPayloadDigest ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.reliabilityAttestationSignature ?? "")
			|| !/^[a-f0-9]{64}$/.test(event.evidenceDigest ?? "")
			|| typeof event.passed !== "boolean"
			|| !["recorded", "degraded", "missing"].includes(event.traceHealth)
			|| typeof event.policyPassed !== "boolean"
			|| typeof event.verifiedOutcomePassed !== "boolean") {
			throw new Error(`${label} contains invalid held-out evidence`);
		}
		return null;
	} catch (error) {
		return error.message;
	}
}

function semanticEventIssue(event, previousEvents, label) {
	if (event.type === "failure.imported") {
		const issue = importedEventIssue(event, label);
		if (issue) return issue;
		return previousEvents.some((previous) => previous.type === "failure.imported" && previous.case?.id === event.case?.id)
			? `${label} duplicates an existing imported case id`
			: null;
	}
	if (event.type === "failure.held-out-trial") {
		const issue = heldOutEventIssue(event, label);
		if (issue) return issue;
		const imports = previousEvents.filter((previous) => previous.type === "failure.imported" && previous.case?.id === event.caseId);
		if (imports.length !== 1) return `${label} must follow exactly one matching imported case`;
		const imported = imports[0];
		if (event.importEventHash !== imported.eventHash || event.caseDigest !== digest(imported.case)) {
			return `${label} is not bound to its prior imported case`;
		}
		const duplicate = previousEvents.some((previous) => previous.type === "failure.held-out-trial"
			&& previous.caseId === event.caseId && previous.runId === event.runId && previous.trialId === event.trialId);
		return duplicate ? `${label} duplicates an existing held-out trial identity` : null;
	}
	if (event.type === "failure.promotion") {
		try {
			const expected = buildPromotionDecision(previousEvents, event.caseId, {
				cohortId: event.cohortId,
				decidedAt: event.recordedAt,
			});
			return digest(eventBody(event)) === digest(expected) ? null : `${label} promotion decision is not derivable from prior evidence`;
		} catch (error) {
			return `${label} promotion decision is invalid: ${error.message}`;
		}
	}
	return `${label} has unsupported event type`;
}

export async function readFailureLedger(ledgerPath) {
	let bytes;
	try {
		bytes = await readFile(ledgerPath);
	} catch (error) {
		if (error.code === "ENOENT") return { valid: true, issues: [], events: [], sha256: null };
		throw error;
	}
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let raw;
	try {
		raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return { valid: false, issues: ["failure ledger is not valid UTF-8"], events: [], sha256 };
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
		const semanticIssue = semanticEventIssue(event, events.slice(0, index), `failure ledger line ${index + 1}`);
		if (semanticIssue) issues.push(semanticIssue);
		previousHash = eventHash;
	}
	return { valid: issues.length === 0, issues, events, sha256 };
}

export async function appendFailureEvent(ledgerPath, event) {
	const [record] = await appendFailureEvents(ledgerPath, [event]);
	return record;
}

export async function appendFailureEvents(ledgerPath, events, { expectedSha256, expectedHeadHash } = {}) {
	if (!Array.isArray(events) || events.length === 0) throw new Error("at least one failure event is required");
	await mkdir(path.dirname(ledgerPath), { recursive: true });
	return withExclusiveFileLock(`${ledgerPath}.lock`, async () => {
		const ledger = await readFailureLedger(ledgerPath);
		if (!ledger.valid) throw new Error(`refusing to append to an invalid failure ledger: ${ledger.issues.join("; ")}`);
		if (expectedSha256 !== undefined && ledger.sha256 !== expectedSha256) throw new Error("failure ledger changed after validation");
		if (expectedHeadHash !== undefined && (ledger.events.at(-1)?.eventHash ?? null) !== expectedHeadHash) throw new Error("failure ledger head changed after validation");
		const records = [];
		for (const event of events) {
			const prior = [...ledger.events, ...records];
			const previous = prior.at(-1);
			const record = eventPayload(event, prior.length + 1, previous?.eventHash ?? null);
			const semanticIssue = semanticEventIssue(record, prior, "new failure ledger event");
			if (semanticIssue) throw new Error(`refusing to append invalid failure evidence: ${semanticIssue}`);
			records.push(record);
		}
		await appendFile(ledgerPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(ledgerPath, 0o600);
		return records;
	});
}

export function buildHeldOutTrialEvents({ caseId, reliability, systemDigest, runtimeTraceValidation, judgedRunValidation, calibrationValidation, attestationKey, reliabilitySha256, ledgerIdentity, importBinding, recordedAt = new Date().toISOString() }) {
	if (!ID_PATTERN.test(caseId ?? "")) throw new Error("caseId must be a stable kebab-case identifier");
	if (reliability?.schemaVersion !== "pi-flows.reliability.v1") throw new Error("reliability artifact schema is unsupported");
	if (typeof reliability?.runId !== "string" || reliability.runId.length === 0) throw new Error("reliability artifact must identify its held-out run");
	if (reliability?.evidencePurpose?.kind !== "failure-promotion-held-out" || reliability.evidencePurpose.caseId !== caseId) {
		throw new Error(`reliability artifact must come from a dedicated held-out promotion run for ${caseId}`);
	}
	const purpose = reliability.evidencePurpose;
	if (!importBinding || purpose.eventHash !== importBinding.eventHash || purpose.caseDigest !== importBinding.caseDigest
		|| purpose.ledgerSha256 !== importBinding.ledgerSha256 || purpose.ledgerHeadHash !== importBinding.ledgerHeadHash) {
		throw new Error("held-out reliability is not bound to the target imported case and source ledger");
	}
	if (digest(reliability?.evaluation?.failureLedger) !== digest(ledgerIdentity)
		|| ledgerIdentity?.sha256 !== importBinding.ledgerSha256
		|| ledgerIdentity?.headHash !== importBinding.ledgerHeadHash
		|| digest(ledgerIdentity?.importedCases?.[caseId]) !== digest({ eventHash: importBinding.eventHash, caseDigest: importBinding.caseDigest })) {
		throw new Error("held-out reliability evaluation ledger does not match the validated source ledger");
	}
	if (!runtimeTraceValidation?.valid) {
		throw new Error(`held-out runtime trace validation failed: ${(runtimeTraceValidation?.issues ?? ["validation was not run"]).join("; ")}`);
	}
	if (!judgedRunValidation?.valid) {
		throw new Error(`held-out judged-run validation failed: ${(judgedRunValidation?.issues ?? ["validation was not run"]).join("; ")}`);
	}
	if (!calibrationValidation?.valid || calibrationValidation.calibration?.gate?.blocks !== false) {
		throw new Error(`held-out calibration validation failed: ${(calibrationValidation?.issues ?? ["calibration blocks or validation was not run"]).join("; ")}`);
	}
	if (!/^[a-f0-9]{64}$/.test(runtimeTraceValidation.sha256 ?? "")) throw new Error("held-out runtime trace validation must bind the trace SHA-256");
	if (!/^[a-f0-9]{64}$/.test(reliabilitySha256 ?? "")) throw new Error("held-out reliability must bind its exact artifact SHA-256");
	if (!reliabilityAttestationIsValid(reliability, { key: attestationKey })) throw new Error("held-out reliability lacks a valid operator-authenticated harness attestation");
	if (!reliability?.evaluatedSystem?.code?.commit || reliability.evaluatedSystem.code.dirty !== false) {
		throw new Error("held-out reliability must pin a clean evaluated system");
	}
	const provenanceIssues = promotionProvenanceIssues(reliability, caseId);
	if (provenanceIssues.length) throw new Error(provenanceIssues.join("; "));
	const completeSystemDigest = evaluatedSystemDigest(reliability);
	if (systemDigest !== completeSystemDigest) throw new Error("systemDigest must match the complete evaluated-system provenance");
	const suiteIds = reliability?.evaluation?.suite?.caseIds;
	if (!Array.isArray(suiteIds) || suiteIds.length !== 1 || suiteIds[0] !== caseId) {
		throw new Error(`held-out reliability suite must contain only ${caseId}`);
	}
	const matching = (reliability?.cases ?? []).find((entry) => entry.caseId === caseId);
	if (!matching || !Array.isArray(matching.trials) || matching.trials.length === 0) throw new Error(`reliability artifact has no trials for ${caseId}`);
	if (matching.trials.length !== reliability.subjectTrials) throw new Error("held-out reliability trial count does not match subjectTrials");
	if (reliability?.evaluation?.budgets?.subjectTrials !== reliability.subjectTrials) throw new Error("held-out reliability trial count does not match evaluation-time budgets");
	const trialIds = matching.trials.map((trial) => trial.trialId);
	if (new Set(trialIds).size !== trialIds.length) throw new Error("held-out reliability contains duplicate trial identities");
	for (const trial of matching.trials) {
		if (trial.traceCaseId !== trial.trialId
			|| trial.objective?.pass !== true || trial.judge?.criterion?.verdict !== true
			|| typeof trial.model !== "string" || trial.model.length === 0) {
			throw new Error(`${trial.trialId ?? caseId} lacks canonical objective, model, or judged-run evidence`);
		}
	}
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
		runtimeTraceSha256: runtimeTraceValidation.sha256,
		importEventHash: importBinding.eventHash,
		caseDigest: importBinding.caseDigest,
		ledgerSha256: importBinding.ledgerSha256,
		ledgerHeadHash: importBinding.ledgerHeadHash,
		judgedRunSha256: reliability.evaluation.judgedRun.sha256,
		calibrationSha256: reliability.evaluation.calibration.sha256,
		reliabilitySha256,
		attestationKeyId: reliability.harnessAttestation.keyId,
		attestationPayloadDigest: reliability.harnessAttestation.payloadDigest,
		reliabilityAttestationSignature: reliability.harnessAttestation.signature,
		evidenceDigest: digest(trial),
	}));
}

export function buildPromotionDecision(events, caseId, { cohortId, decidedAt = new Date().toISOString() } = {}) {
	const imported = events.find((event) => event.type === "failure.imported" && event.case?.id === caseId);
	if (!imported) throw new Error(`failure ${caseId} has not been imported`);
	const previousApproval = events.find((event) => event.type === "failure.promotion" && event.caseId === caseId && event.decision === "approved");
	if (previousApproval) throw new Error(`failure ${caseId} is already promoted`);
	if (typeof cohortId !== "string" || cohortId.length === 0) throw new Error("promotion requires an explicit held-out cohort id");
	const trials = events.filter((event) => event.type === "failure.held-out-trial" && event.caseId === caseId && event.runId === cohortId);
	const uniqueTrials = new Map(trials.map((trial) => [trial.trialId, trial]));
	const evidence = [...uniqueTrials.values()];
	const policy = imported.case.promotionPolicy;
	const reasons = [];
	if (uniqueTrials.size !== trials.length) reasons.push("held-out cohort contains duplicate trial identities");
	if (evidence.length < policy.minimumHeldOutTrials) reasons.push(`promotion requires ${policy.minimumHeldOutTrials} held-out trials; found ${evidence.length}`);
	if (new Set(evidence.map((trial) => trial.systemDigest)).size > 1) reasons.push("held-out trials must evaluate the same evaluated system");
	if (new Set(evidence.map((trial) => trial.runtimeTraceSha256)).size > 1) reasons.push("held-out trials must come from one runtime trace artifact");
	if (new Set(evidence.map((trial) => trial.reliabilitySha256)).size > 1
		|| new Set(evidence.map((trial) => `${trial.attestationKeyId}:${trial.attestationPayloadDigest}:${trial.reliabilityAttestationSignature}`)).size > 1) {
		reasons.push("held-out trials must come from one authenticated reliability artifact");
	}
	if (evidence.some((trial) => !trial.passed)) reasons.push("every held-out trial must pass");
	if (evidence.some((trial) => trial.traceHealth !== "recorded")) reasons.push("every held-out trial must retain its required runtime trace");
	if (evidence.some((trial) => !trial.policyPassed)) reasons.push("every held-out trial must pass policy compliance");
	if (evidence.some((trial) => !trial.verifiedOutcomePassed)) reasons.push("every held-out trial must have a verified successful outcome");
	return {
		type: "failure.promotion",
		recordedAt: decidedAt,
		caseId,
		cohortId,
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
				productionFailure: {
					traceLink: stored.traceLink,
					initialStateDigest: stored.initialState.sha256,
					promotionPolicy: stored.promotionPolicy,
				},
			};
		});
}
