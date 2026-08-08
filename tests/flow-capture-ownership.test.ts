// Issue #100: the resolved capture policy has exactly one owner — the Flow
// aggregate. After preset expansion, ports receive the resolved call (params,
// policy, preset) as arguments; nothing reads it back through a
// composition-root closure. These tests fake every port as a pure function
// that records what it was *given*, so a port that could only work by closing
// over execute() locals fails here.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentCatalog } from "../extensions/pi-flows/agent-catalog.ts";
import { Flow, type DetailsBuilder, type FlowPorts, type ResolvedCall } from "../extensions/pi-flows/flow.ts";
import { detectRunMode } from "../extensions/pi-flows/modes/registry.ts";
import { parseTraceJsonl } from "../extensions/pi-flows/trace.ts";
import type { CapturePolicy, FlowPreset, ModeDeps, ModeOutput, RunMode } from "../extensions/pi-flows/types.ts";
import { faultDiscovery } from "./fault-adapter.ts";

function workspace(): string {
	return mkdtempSync(path.join(tmpdir(), "pi-flow-capture-ownership-"));
}

const PRESET: FlowPreset = {
	name: "scout",
	description: "one reconnaissance pass",
	source: "package",
	filePath: "/presets/scout.md",
	overrides: [],
	template: { agent: "recon", task: "{task}" },
};

const CALLER_POLICY: CapturePolicy = { recordContent: true, redactSecrets: true };
const TIGHTENED_POLICY: CapturePolicy = { recordContent: false, redactSecrets: true };

/** What each port received, recorded verbatim so assertions can compare by reference. */
interface Received {
	detectMode?: { candidate: Record<string, any>; makeDetails: DetailsBuilder };
	approvePresetTrust?: { call: ResolvedCall; mode: RunMode; makeDetails: DetailsBuilder };
	preparePresetRun?: { call: ResolvedCall; mode: RunMode };
	formatResult?: { output: ModeOutput };
	resolveTask?: { candidate: Record<string, any>; policy: CapturePolicy };
	recordLesson?: { policy: CapturePolicy };
	decorateRootAttributes?: { preset?: FlowPreset };
}

interface Harness {
	ports: FlowPorts;
	order: string[];
	/** Every ResolvedCall the makeDetails factory was constructed from. */
	factoryCalls: ResolvedCall[];
	/** The builders the factory handed back, in construction order. */
	builders: DetailsBuilder[];
	received: Received;
	handlerDeps: ModeDeps[];
}

/**
 * A preset flow faked at the aggregate's ports. The preset expands to new
 * params under a tightened capture policy, and every port records the
 * resolution it received instead of reaching for shared state.
 */
function presetHarness(options: {
	handler?: (deps: ModeDeps) => Promise<ModeOutput>;
	formatResult?: (output: ModeOutput) => void;
	params?: Record<string, unknown>;
	overrides?: Partial<FlowPorts>;
} = {}): Harness {
	const order: string[] = [];
	const factoryCalls: ResolvedCall[] = [];
	const builders: DetailsBuilder[] = [];
	const received: Received = {};
	const handlerDeps: ModeDeps[] = [];
	const discovery = faultDiscovery();
	const catalog = createAgentCatalog(discovery, "user");
	// Trace settings are passthrough keys in real preset expansion, so the fake
	// carries them through too — the sink is built from post-preset params.
	const traceFile = options.params?.traceFile;
	const expandedParams = { agent: "recon", task: "inspect the repo", why: "explicit user request", recordContent: false, ...(traceFile !== undefined ? { traceFile } : {}) };
	const handler = options.handler ?? (async (deps: ModeDeps) => {
		order.push("handler");
		handlerDeps.push(deps);
		const result = {
			agent: "recon",
			agentSource: "package" as const,
			task: "inspect",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text" as const, text: "found it" }] }],
			stderr: "",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
			durationMs: 5,
		};
		deps.recordSpan?.(result, { scope: { key: "single" } });
		return { content: [{ type: "text" as const, text: "found it" }], details: deps.makeDetails("single")([result]) };
	});
	const ports: FlowPorts = {
		params: { preset: "scout", task: "inspect the repo", why: "explicit user request" },
		policy: CALLER_POLICY,
		cwd: workspace(),
		hasUI: false,
		approvalActor: "test-operator",
		agentScope: "user",
		discovery,
		runChild: async () => { throw new Error("capture-ownership tests stub the handler, not the child seam"); },
		makeDetails: (call) => {
			order.push("makeDetails.factory");
			factoryCalls.push(call);
			const builder: DetailsBuilder = (mode, agents) => catalog.makeDetails(mode, agents);
			builders.push(builder);
			return builder;
		},
		resolvePreset: () => {
			order.push("resolvePreset");
			return { params: expandedParams, policy: TIGHTENED_POLICY, preset: PRESET };
		},
		detectMode: (candidate, makeDetails) => {
			order.push("detectMode");
			received.detectMode = { candidate, makeDetails };
			const detected = detectRunMode(candidate);
			assert.ok(!("error" in detected), "the expanded preset params must detect a mode");
			return detected;
		},
		approvePresetTrust: async (call, mode, makeDetails) => {
			order.push("approvePresetTrust");
			received.approvePresetTrust = { call, mode, makeDetails };
			return { record: () => order.push("recordPresetApproval") };
		},
		preparePresetRun: (call, mode) => {
			order.push("preparePresetRun");
			received.preparePresetRun = { call, mode };
			return {
				params: call.params,
				runDefaultCwd: ports.cwd,
				formatResult: (output) => {
					order.push("formatResult");
					received.formatResult = { output };
					options.formatResult?.(output);
				},
			};
		},
		approveProjectAgents: async () => null,
		checkpoint: async () => null,
		handlerFor: () => handler,
		presence: { start: () => undefined, update: () => undefined, settle: () => undefined },
		resolveTask: (candidate, policy) => {
			order.push("resolveTask");
			received.resolveTask = { candidate, policy };
			return candidate;
		},
		recordLesson: async (_candidate, _mode, _text, policy) => {
			order.push("recordLesson");
			received.recordLesson = { policy };
		},
		decorateRootAttributes: (attributes, _details, _deliverable, preset) => {
			order.push("decorateRootAttributes");
			received.decorateRootAttributes = { preset };
			return attributes;
		},
		persist: () => order.push("persist"),
		...(options.params ? { params: options.params } : {}),
		...options.overrides,
	};
	return { ports, order, factoryCalls, builders, received, handlerDeps };
}

async function settleFlow(h: Harness): Promise<ModeOutput> {
	const admission = await Flow.admit(h.ports);
	assert.ok("admitted" in admission, `expected admission, got refusal: ${"refused" in admission ? JSON.stringify(admission.refused.details.error) : ""}`);
	const dispatched = await admission.admitted.dispatch();
	return dispatched.settle();
}

test("the details builder is constructed exactly once, from the post-preset resolution", async () => {
	const h = presetHarness();
	await settleFlow(h);
	assert.equal(h.factoryCalls.length, 1, "one flow call constructs one details builder");
	const call = h.factoryCalls[0]!;
	assert.equal(call.policy, TIGHTENED_POLICY, "the builder sees the tightened policy, not the caller's");
	assert.equal(call.preset, PRESET);
	assert.equal(call.params.recordContent, false, "the builder sees the expanded params");
	// The factory runs after preset expansion and before mode detection, so no
	// consumer can ever hold a builder made from pre-preset state.
	assert.ok(h.order.indexOf("resolvePreset") < h.order.indexOf("makeDetails.factory"));
	assert.ok(h.order.indexOf("makeDetails.factory") < h.order.indexOf("detectMode"));
});

test("every later consumer receives the one constructed builder, not a fresh copy", async () => {
	const h = presetHarness();
	await settleFlow(h);
	const builder = h.builders[0]!;
	assert.equal(h.received.detectMode!.makeDetails, builder, "mode detection refuses with details built from the resolution");
	assert.equal(h.received.approvePresetTrust!.makeDetails, builder, "preset trust refuses with details built from the resolution");
	assert.equal(h.handlerDeps[0]!.makeDetails, builder, "handlers consume the same builder through ModeDeps");
});

test("resolvePreset's result is the only copy: the trust and preparation gates receive it as an argument", async () => {
	const h = presetHarness();
	await settleFlow(h);
	const trust = h.received.approvePresetTrust!;
	assert.equal(trust.call.policy, TIGHTENED_POLICY);
	assert.equal(trust.call.preset, PRESET);
	assert.equal(trust.mode, "single");
	const prepare = h.received.preparePresetRun!;
	assert.equal(prepare.call.policy, TIGHTENED_POLICY);
	assert.equal(prepare.call.preset, PRESET);
	assert.equal(h.received.detectMode!.candidate.recordContent, false, "mode detection sees the expanded params");
});

test("the reflexion ports receive the resolved policy as an argument", async () => {
	const h = presetHarness();
	await settleFlow(h);
	assert.equal(h.received.resolveTask!.policy, TIGHTENED_POLICY);
	assert.equal(h.received.resolveTask!.candidate.recordContent, false, "the task resolves against the expanded params");
	assert.equal(h.received.recordLesson!.policy, TIGHTENED_POLICY);
});

test("the preset formatter returned by preparation runs during settle, before the lesson is recorded", async () => {
	const h = presetHarness();
	const output = await settleFlow(h);
	const format = h.order.indexOf("formatResult");
	const lesson = h.order.indexOf("recordLesson");
	assert.ok(format >= 0, "the formatter preparation returned must run at settle");
	assert.ok(lesson > format, `the lesson records the formatted result, got: ${h.order.join(" → ")}`);
	assert.equal(h.received.formatResult!.output, output, "the formatter received the settled output");
});

test("the root-span decorator receives the resolved preset from the aggregate", async () => {
	const cwd = workspace();
	const traceFile = path.join(cwd, "trace.jsonl");
	const h = presetHarness({
		params: { preset: "scout", task: "inspect the repo", why: "explicit user request", traceFile },
		overrides: { cwd },
	});
	await settleFlow(h);
	assert.equal(h.received.decorateRootAttributes!.preset, PRESET);
	const parsed = parseTraceJsonl(readFileSync(traceFile, "utf8"));
	const root = parsed.spans.find((span) => span.attributes["flow.span_role"] === "root");
	assert.equal(root?.attributes["flow.child_count"], 1);
});

test("a flow without a preset resolves to its own params and policy, and skips the preset formatter", async () => {
	const h = presetHarness({
		params: { agent: "recon", task: "inspect the repo", why: "explicit user request" },
		overrides: {
			resolvePreset: undefined,
			preparePresetRun: (call, _mode) => ({ params: call.params, runDefaultCwd: "/tmp" }),
		},
	});
	await settleFlow(h);
	const call = h.factoryCalls[0]!;
	assert.equal(call.policy, CALLER_POLICY, "with no preset, the caller's own policy is the resolution");
	assert.equal(call.preset, undefined);
	assert.ok(!h.order.includes("formatResult"), "no preparation formatter, nothing to run at settle");
	assert.equal(h.received.resolveTask!.policy, CALLER_POLICY);
});
