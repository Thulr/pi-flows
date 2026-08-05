import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import { discoverFlowPresets, resolveFlowPreset } from "../extensions/pi-flows/presets.ts";
import { detectRunMode } from "../extensions/pi-flows/modes/registry.ts";
import { FlowParams } from "../extensions/pi-flows/schema.ts";

process.env.PI_FLOWS_PACKAGE_AGENTS_ONLY = "1";
const discovery = discoverFlowPresets(process.cwd(), "user");
const checkParams = Compile(FlowParams);
assert.equal(discovery.issues.length, 0, discovery.issues.map((item) => `${item.code}: ${item.message}`).join("\n"));
assert.deepEqual(discovery.presets.map((preset) => preset.name), ["code-review", "map-codebase", "scout"]);

for (const preset of discovery.presets) {
	const resolved = resolveFlowPreset(
		{ preset: preset.name, task: "Inspect HEAD against main for issue #25.", why: "validation" },
		discovery,
	);
	assert.ok(!("error" in resolved), `"${preset.name}" failed expansion`);
	const detected = detectRunMode(resolved.params);
	assert.ok(!("error" in detected), `"${preset.name}" did not activate exactly one mode`);
	assert.ok(checkParams.Check(resolved.params), `"${preset.name}" expanded outside the public FlowParams schema`);
}

console.log(`presets ok: ${discovery.presets.length} bundled presets`);
