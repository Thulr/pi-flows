// Shared offline harness for flow execution tests.
//
// Exercises the real spawn/parse/orchestrate machinery in
// extensions/pi-flows/index.ts against a stub `pi` (tests/fixtures/stub-pi.mjs)
// instead of a live model. pi-flows spawns a child agent by re-running its own
// entrypoint (process.argv[1]) via the current runtime — see getPiInvocation() —
// so pointing argv[1] at the stub makes pi-flows spawn the stub. No production
// code change and no network/model is involved.
//
// The stub keys its reply off the agent name and logs every invocation, so each
// test asserts on the wiring it cares about: which agents ran, in what order,
// and what task text each received (i.e. that handoffs actually propagated).
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import registerPiFlows from "../extensions/pi-flows/index.ts";

import { delegationContractId } from "../extensions/pi-flows/delegation.ts";

// The stub pi writes its calls.jsonl into the child cwd, which the real
// bash-ro OS sandbox (deny writes under cwd) would block — so every
// stub-driven flow opts out of it, and opts into the best-effort allowlist
// path so bash-ro children still spawn. The sandbox's own behavior is covered
// against real sandbox-exec in tests/bash-readonly-sandbox.test.ts.
process.env.PI_FLOWS_BASH_RO_NO_SANDBOX = "1";
process.env.PI_FLOWS_BASH_RO_ALLOW_UNSANDBOXED = "1";

export const stubPi = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));
process.argv[1] = stubPi;

export function flowTool(api: Record<string, any> = {}) {
	const tools = new Map<string, any>();
	registerPiFlows({ ...api, registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	return tools.get("flow");
}

export type Call = { agent: string; callIndex: number; task: string; systemPrompt: string; args: string[]; cwd: string; env: Record<string, string | null> };

export async function freshDir() {
	return mkdtemp(path.join(tmpdir(), "stub-pi-"));
}

/** The session model a stubbed run reports. Mirrors what pi supplies, so tiers resolve as they do in production. */
export const STUB_SESSION_MODEL = { provider: "test-provider", id: "session-model" };

/** A minimal three-model install: cheap, session, strong — enough for fast/capable/deep to resolve distinctly. */
export const STUB_REGISTRY = {
	getAvailable: () => [
		{ id: "cheap-model", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 0.1, output: 0.4 } },
		{ id: "session-model", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 3, output: 12 } },
		{ id: "strong-model", provider: "test-provider", reasoning: true, contextWindow: 200_000, maxTokens: 8192, cost: { input: 15, output: 60 } },
	],
};

export async function runFlow(
	params: any,
	plan: Record<string, unknown>,
	options: { api?: Record<string, any>; ui?: Record<string, any>; cwd?: string; hasUI?: boolean; registry?: any; model?: any; projectTrusted?: boolean } = {},
) {
	const stubDir = options.cwd ?? await freshDir();
	process.env.PI_STUB_DIR = stubDir;
	process.env.PI_STUB_PLAN = JSON.stringify(plan);
	// Spawning calls must justify delegation (WHY_REQUIRED). Tests that exercise
	// the refusal itself pass an explicit `why: undefined`.
	const paramsWithWhy = { why: "integration test exercising the delegation path", ...params };
	const result = await flowTool(options.api).execute(
		"tool-call-id",
		paramsWithWhy,
		new AbortController().signal,
		undefined,
		{
			cwd: stubDir,
			hasUI: options.hasUI ?? false,
			ui: { confirm: async () => true, notify: () => undefined, ...(options.ui ?? {}) },
			// A real pi always hands the extension a loaded registry and a current
			// model. Omitting them here left every test running against a roster
			// that could not resolve any tier — an install state that means pi is
			// broken, not a normal one — so tier behavior went unexercised by the
			// integration path. `options.registry: null` opts back out for the tests
			// that are specifically about a missing registry.
			...(options.registry === null ? {} : { modelRegistry: options.registry ?? STUB_REGISTRY, model: options.model ?? STUB_SESSION_MODEL }),
			isProjectTrusted: () => options.projectTrusted ?? false,
		},
	);
	const log = await readFile(path.join(stubDir, "calls.jsonl"), "utf8").catch(() => "");
	const calls: Call[] = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { result, calls, text: result.content[0]?.text ?? "", stubDir };
}

export const byAgent = (calls: Call[], name: string) => calls.filter((call) => call.agent === name);

/** A minimal read-only contract and a matching return envelope, shared by the
 * tests that exercise the typed delegation path end to end. */
export const integrationContract = {
	objective: "Find the sample identifier.",
	constraints: ["Read only."],
	nonGoals: ["Do not edit."],
	dependencies: ["settings.txt"],
	authority: { may: ["Read files."], mustNot: ["Write files."], requiresApproval: [] },
	sideEffectClass: "read-only",
	budget: { maxGeneratedTokens: 2_000 },
	acceptanceChecks: ["Return the identifier."],
	returnSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
	owner: "parent",
};
// Contract identity is not optional, so the fixture echoes the dispatched id.
export const integrationEnvelope = (data: unknown, contract: unknown = integrationContract) => JSON.stringify({
	schemaVersion: "pi-flows.return-envelope.v1", contractId: delegationContractId(contract as never), status: "completed", summary: "Found it.",
	evidence: [{ claim: "Identifier found.", source: "settings.txt:1" }], artifactReferences: [], digests: [],
	changedState: [], unresolvedQuestions: [], retry: { retryable: false }, data,
});
