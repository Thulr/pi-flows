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

export const stubPi = fileURLToPath(new URL("./fixtures/stub-pi.mjs", import.meta.url));
process.argv[1] = stubPi;

export function flowTool(api: Record<string, any> = {}) {
	const tools = new Map<string, any>();
	registerPiFlows({ ...api, registerCommand() {}, registerShortcut() {}, registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
	return tools.get("flow");
}

export type Call = { agent: string; callIndex: number; task: string; systemPrompt: string; args: string[]; cwd: string };

export async function freshDir() {
	return mkdtemp(path.join(tmpdir(), "stub-pi-"));
}

export async function runFlow(
	params: any,
	plan: Record<string, unknown>,
	options: { api?: Record<string, any>; ui?: Record<string, any>; cwd?: string; hasUI?: boolean } = {},
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
		{ cwd: stubDir, hasUI: options.hasUI ?? false, ui: { confirm: async () => true, notify: () => undefined, ...(options.ui ?? {}) } },
	);
	const log = await readFile(path.join(stubDir, "calls.jsonl"), "utf8").catch(() => "");
	const calls: Call[] = log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { result, calls, text: result.content[0]?.text ?? "", stubDir };
}

export const byAgent = (calls: Call[], name: string) => calls.filter((call) => call.agent === name);
