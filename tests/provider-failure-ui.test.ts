import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyProviderDiagnostic, providerFailureGuidance, providerFailureRetryable } from "../extensions/pi-flows/provider-failure.ts";
import { MODEL_VISIBLE_OUTPUT_CAP } from "../extensions/pi-flows/types.ts";
import { flowCardLines } from "../extensions/pi-flows/ui-flow-card.ts";
import { flowLiveBoardLines } from "../extensions/pi-flows/ui-live-row.ts";
import { providerFailurePresentation } from "../extensions/pi-flows/ui-style.ts";
import { runFlow } from "./stub-harness.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as any;

test("provider diagnostics classify into category-specific recovery", () => {
	const examples = [
		["input exceeds the context window", "context_window", false],
		["HTTP 429: rate limit exceeded", "rate_limit", true],
		["HTTP 401: invalid API key", "authentication", false],
		["503: service overloaded and at capacity", "capacity", true],
		["upstream socket closed unexpectedly", "unknown", false],
	] as const;

	for (const [diagnostic, category, retryable] of examples) {
		assert.equal(classifyProviderDiagnostic(diagnostic), category);
		assert.equal(providerFailureRetryable(category), retryable);
		assert.match(providerFailureGuidance(category), /retry|Inspect/i);
		if (category !== "context_window") {
			assert.doesNotMatch(providerFailureGuidance(category), /larger context|Reduce the child task\/input/i, `${category} must not receive context-window guidance`);
		}
	}
});

test("provider failure presentation preserves zero context values", () => {
	const view = providerFailurePresentation({ category: "unknown", diagnostic: "failure", termination: "prompt_exit", contextTokens: 0, contextWindow: 0, thinkingVerified: false }, undefined, 1);
	assert.equal(view.context, "ctx:0/0");
});

test("collapsed live and durable surfaces expose a sanitized context failure before replay", async () => {
	const entries: Array<{ customType: string; data: any }> = [];
	const rawSecret = ["sk", "providerDiagnosticSecret123456"].join("-");
	const rawEmail = ["provider", "example.com"].join("@");
	const diagnostic = `Provider error: input exceeds the context window; api_key=${rawSecret}; contact ${rawEmail}; file ${os.homedir()}/private.txt. ${"x".repeat(MODEL_VISIBLE_OUTPUT_CAP + 100)}`;
	const { result } = await runFlow(
		{ agent: "analyst", task: "inspect a bounded issue" },
		{ analyst: { reply: "partial notes", stopReason: "error", errorMessage: diagnostic, exitCode: 1 } },
		{ api: { appendEntry: (customType: string, data: any) => entries.push({ customType, data }) } },
	);

	const run = result.details.results[0];
	assert.equal(run.providerFailure?.category, "context_window");
	assert.equal(run.providerFailure?.termination, "prompt_exit");
	assert.equal(run.providerFailure?.contextTokens, 20);
	assert.equal(run.providerFailure?.contextWindow, 200_000);
	assert.match(run.providerFailure?.diagnostic ?? "", /\[REDACTED_SECRET\]/);
	assert.match(run.providerFailure?.diagnostic ?? "", /\[REDACTED_EMAIL\]/);
	assert.match(run.providerFailure?.diagnostic ?? "", /~\/private\.txt/);
	assert.match(run.providerFailure?.diagnostic ?? "", /Output truncated/);
	assert.doesNotMatch(run.providerFailure?.diagnostic ?? "", new RegExp(rawSecret));
	assert.doesNotMatch(run.providerFailure?.diagnostic ?? "", new RegExp(rawEmail.replace(".", "\\.")));

	const live = flowLiveBoardLines(result.details, theme, { tick: 0, redactSecrets: true }).join("\n");
	assert.match(live, /CHILD_PROVIDER_ERROR · context window/);
	assert.match(live, /ctx:20\/200k/);
	assert.match(live, /test-provider\/session-model/);
	assert.match(live, /thinking:unknown\/pi-default/);
	assert.match(live, /exit 1/);
	assert.match(live, /recovery: Reduce input/);
	assert.doesNotMatch(live, new RegExp(rawSecret));

	assert.equal(entries[0]?.customType, "pi-flows.run");
	const card = flowCardLines(entries[0]?.data, theme, false).join("\n");
	assert.match(card, /CHILD_PROVIDER_ERROR · context window/);
	assert.match(card, /ctx:20\/200k/);
	assert.match(card, /test-provider\/session-model/);
	assert.match(card, /thinking:unknown\/pi-default/);
	assert.match(card, /recovery: Reduce input/);
	assert.doesNotMatch(card, new RegExp(rawSecret));

	const expanded = flowCardLines(entries[0]?.data, theme, true).join("\n");
	assert.match(expanded, /Cause: The child's model provider returned a terminal error/);
	assert.match(expanded, /Retryable unchanged: no/);
	assert.match(expanded, /Fix: Reduce input/);
	assert.match(expanded, /\[REDACTED_SECRET\]/);
	assert.match(expanded, /Output truncated/);
	assert.doesNotMatch(expanded, new RegExp(rawSecret));
});

test("content-disabled failures persist no provider prose and missing usage stays unknown", async () => {
	const entries: Array<{ data: any }> = [];
	const privateDiagnostic = "input exceeds the context window for PRIVATE_WORKSPACE_7429";
	const { result } = await runFlow(
		{ agent: "analyst", task: "inspect a bounded issue", recordContent: false },
		{ analyst: { reply: "partial", stopReason: "error", errorMessage: privateDiagnostic, exitCode: 1, omitUsage: true } },
		{ api: { appendEntry: (_type: string, data: any) => entries.push({ data }) } },
	);
	const run = result.details.results[0];
	assert.equal(run.providerFailure?.category, "context_window", "classification still uses the transient provider diagnostic");
	assert.equal(run.providerFailure?.diagnostic, "[content omitted: recordContent=false]");
	assert.equal(run.providerFailure?.contextTokens, undefined);
	assert.doesNotMatch(JSON.stringify({ details: result.details, entry: entries[0]?.data }), /PRIVATE_WORKSPACE_7429/);

	const live = flowLiveBoardLines(result.details, theme, { tick: 0, redactSecrets: true }).join("\n");
	const card = flowCardLines(entries[0]?.data, theme, true).join("\n");
	assert.match(live, /ctx:\?\/200k/);
	assert.match(card, /ctx:\?\/200k/);
	assert.doesNotMatch(`${live}\n${card}`, /PRIVATE_WORKSPACE_7429/);
});

test("assistant model IDs keep provider identity for duplicate-id context lookup", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-flows-provider-model-"));
	const agentDir = path.join(cwd, ".pi", "flow-agents");
	await mkdir(agentDir, { recursive: true });
	await writeFile(path.join(agentDir, "bare.md"), "---\nname: bare\ndescription: unpinned test agent\ntools: none\n---\n\nReturn the result.\n");
	const registry = {
		getAvailable: () => [
			{ id: "shared", provider: "alpha", reasoning: true, contextWindow: 8_000, maxTokens: 1024, cost: { input: 1, output: 1 } },
			{ id: "shared", provider: "beta", reasoning: true, contextWindow: 64_000, maxTokens: 1024, cost: { input: 1, output: 1 } },
			{ id: "vendor/shared", provider: "alpha", reasoning: true, contextWindow: 16_000, maxTokens: 1024, cost: { input: 1, output: 1 } },
			{ id: "vendor/shared", provider: "beta", reasoning: true, contextWindow: 96_000, maxTokens: 1024, cost: { input: 1, output: 1 } },
		],
	};
	for (const { model, reportedModel, expectedModel, contextWindow } of [
		{ model: undefined, reportedModel: "shared", expectedModel: "beta/shared", contextWindow: 64_000 },
		{ model: "shared", reportedModel: "shared", expectedModel: "beta/shared", contextWindow: 64_000 },
		{ model: undefined, reportedModel: "vendor/shared", expectedModel: "beta/vendor/shared", contextWindow: 96_000 },
	]) {
		const entries: Array<{ data: any }> = [];
		const { result } = await runFlow(
			{ agent: "bare", agentScope: "project", confirmProjectAgents: false, task: "exercise the provider identity seam", thinking: "max", ...(model ? { model } : {}) },
			{ bare: { reply: "partial", stopReason: "error", errorMessage: "input exceeds the context window", exitCode: 1, provider: "beta", reportedModel } },
			{ cwd, projectTrusted: true, registry, model: { provider: "beta", id: "shared" }, api: { appendEntry: (_type: string, data: any) => entries.push({ data }) } },
		);
		assert.equal(result.details.results[0]?.model, expectedModel);
		assert.equal(result.details.results[0]?.providerFailure?.contextWindow, contextWindow);
		assert.equal(result.details.results[0]?.providerFailure?.thinkingVerified, false);
		assert.match(flowLiveBoardLines(result.details, theme, { tick: 0, redactSecrets: true }).join("\n"), /thinking:max \(requested\)/);
		assert.match(flowCardLines(entries[0]?.data, theme, false).join("\n"), /thinking:max \(requested\)/);
	}
});
