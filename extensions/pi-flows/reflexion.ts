import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { CapturePolicy, FlowMode } from "./types.ts";
import { capModelVisibleText, sanitizeText } from "./sanitize.ts";

export function reflexionFile(defaultCwd: string, params: any): string | null {
	const spec = params.reflexion;
	if (!spec?.enabled) return null;
	return path.resolve(defaultCwd, spec.file ?? ".pi/flow-reflections.jsonl");
}

export function readReflexions(defaultCwd: string, params: any, policy: CapturePolicy): string {
	const filePath = reflexionFile(defaultCwd, params);
	if (!filePath) return "";
	const maxEntries = Number.isFinite(params.reflexion?.maxEntries) ? Math.max(1, Math.min(20, Math.floor(params.reflexion.maxEntries))) : 5;
	try {
		const lines = fsSync.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxEntries);
		const entries = lines
			.map((line) => {
				try {
					const parsed = JSON.parse(line);
					return typeof parsed.lesson === "string" ? `- ${sanitizeText(parsed.lesson, policy, 2048)}` : null;
				} catch {
					return null;
				}
			})
			.filter(Boolean);
		if (entries.length === 0) return "";
		return `\n## Relevant lessons from prior flow runs\n${entries.join("\n")}\n`;
	} catch {
		return "";
	}
}

export async function appendReflexion(defaultCwd: string, params: any, mode: FlowMode, lesson: string, policy: CapturePolicy): Promise<void> {
	const filePath = reflexionFile(defaultCwd, params);
	if (!filePath) return;
	const sanitized = sanitizeText(capModelVisibleText(lesson), policy, 4096).trim();
	if (!sanitized) return;
	await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined);
	await withFileMutationQueue(filePath, async () => {
		await fs.appendFile(
			filePath,
			`${JSON.stringify({ createdAt: new Date().toISOString(), mode, traceLabel: params.traceLabel, lesson: sanitized })}\n`,
			"utf8",
		);
	}).catch(() => undefined);
}

export function withReflexion(defaultCwd: string, params: any, task: string, policy: CapturePolicy): string {
	const reflexions = readReflexions(defaultCwd, params, policy);
	return reflexions ? `${task}${reflexions}` : task;
}
