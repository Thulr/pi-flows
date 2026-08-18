// Labeled Decomposition-quality corpus for issue #160. Every fixture is
// structurally admissible. The labels cover model judgments that the
// deterministic Decomposition validator must not make.

export const DECOMPOSITION_QUALITY_CASES = [
	{
		id: "flat-smallest-sufficient-control",
		family: "flat-control",
		label: "pass",
		goal: "Map the independent login and logout request paths.",
		returnRequirements: "Name the entry route and session change for each path.",
		obligations: [
			{ id: "login", text: "Map the login request path." },
			{ id: "logout", text: "Map the logout request path." },
		],
		entries: ["Map the login path and its session change", "Map the logout path and its session change"],
	},
	{
		id: "structured-dependency-control",
		family: "structured-control",
		label: "pass",
		goal: "Find the authentication entry points, trace token refresh from them, and write a supported summary.",
		obligations: [
			{ id: "entry", text: "Find the authentication entry points." },
			{ id: "refresh", text: "Trace token refresh from the entry points." },
			{ id: "summary", text: "Write a supported summary." },
		],
		entries: [
			{ id: "entry", objective: "List authentication entry points", acceptanceEvidence: "File and symbol names" },
			{ id: "refresh", objective: "Trace token refresh", dependsOn: ["entry"], inputs: "Use the discovered entry points", acceptanceEvidence: "Call chain with file locations" },
			{ id: "summary", objective: "Write the supported summary", dependsOn: ["refresh"], expectedReturn: "Concise findings with evidence" },
		],
	},
	{
		id: "coverage-gap",
		family: "coverage-gap",
		label: "revise",
		goal: "Map the login, refresh, and logout request paths.",
		obligations: [
			{ id: "login", text: "Map the login request path." },
			{ id: "refresh", text: "Map the refresh request path." },
			{ id: "logout", text: "Map the logout request path." },
		],
		entries: [{ id: "login", objective: "Map login" }, { id: "logout", objective: "Map logout" }],
	},
	{
		id: "overlapping-scope",
		family: "overlap",
		label: "revise",
		goal: "Map every authentication route once.",
		obligations: [{ id: "routes", text: "Map every authentication route once." }],
		entries: [
			{ id: "all", objective: "Map every authentication route" },
			{ id: "login", objective: "Map the login route", scope: "Login only" },
		],
	},
	{
		id: "oversized-subtask",
		family: "worker-fit",
		label: "revise",
		goal: "Map authentication, billing, deployment, and incident-response behavior across the repository.",
		obligations: [
			{ id: "auth", text: "Map authentication behavior." },
			{ id: "billing", text: "Map billing behavior." },
			{ id: "deploy", text: "Map deployment behavior." },
			{ id: "incident", text: "Map incident-response behavior." },
		],
		entries: ["Investigate the complete repository and report all authentication, billing, deployment, and incident-response behavior"],
	},
	{
		id: "needless-dependency",
		family: "dependency",
		label: "revise",
		goal: "Map the independent login and logout routes.",
		obligations: [{ id: "login", text: "Map the login route." }, { id: "logout", text: "Map the logout route." }],
		entries: [
			{ id: "login", objective: "Map login" },
			{ id: "logout", objective: "Map logout", dependsOn: ["login"] },
		],
	},
	{
		id: "weak-context",
		family: "context",
		label: "revise",
		goal: "Trace refresh-token rotation from the HTTP route to session storage.",
		obligations: [
			{ id: "route", text: "Find the refresh-token HTTP route." },
			{ id: "storage", text: "Trace rotation to session storage." },
		],
		entries: [{ id: "trace", objective: "Investigate it", inputs: "Use the relevant files" }],
	},
	{
		id: "excessive-fragmentation",
		family: "fragmentation",
		label: "revise",
		goal: "Document the login route and its session write.",
		obligations: [{ id: "login", text: "Document the login route and its session write." }],
		entries: [
			"Find the route file", "Read the route name", "Find the handler", "Read the handler", "Find the session write", "Write one summary",
		],
	},
];

export function validateDecompositionQualityCases(cases = DECOMPOSITION_QUALITY_CASES) {
	const issues = [];
	const ids = new Set();
	for (const testCase of cases) {
		if (!testCase?.id || ids.has(testCase.id)) issues.push(`case id is missing or duplicated: ${testCase?.id ?? "<missing>"}`);
		ids.add(testCase?.id);
		if (!new Set(["pass", "revise"]).has(testCase?.label)) issues.push(`${testCase?.id}: label must be pass or revise`);
		if (!testCase?.goal || !Array.isArray(testCase?.entries) || testCase.entries.length === 0) issues.push(`${testCase?.id}: each case requires a goal and entries`);
		if (!Array.isArray(testCase?.obligations) || testCase.obligations.length === 0) issues.push(`${testCase?.id}: each case requires obligations`);
		const obligationIds = new Set(testCase?.obligations?.map((item) => item.id));
		if (obligationIds.size !== testCase?.obligations?.length) issues.push(`${testCase?.id}: obligation ids must be unique`);
	}
	return issues;
}
