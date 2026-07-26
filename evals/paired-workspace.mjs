import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

function copyDirectory(source, destination) {
	for (const entry of readdirSync(source)) {
		cpSync(join(source, entry), join(destination, entry), { recursive: true });
	}
}

function snapshotFiles(directory, current = directory) {
	const files = [];
	for (const entry of readdirSync(current).sort()) {
		const path = join(current, entry);
		const stat = lstatSync(path);
		if (stat.isDirectory()) files.push(...snapshotFiles(directory, path));
		else files.push(path);
	}
	return files;
}

function snapshotDigest(directory) {
	const digest = createHash("sha256");
	for (const file of snapshotFiles(directory)) {
		digest.update(relative(directory, file).split(sep).join("/"));
		digest.update("\0");
		const stat = lstatSync(file);
		digest.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
		digest.update("\0");
	}
	return digest.digest("hex");
}

export function pairedCaseWorkspaces(testCase, { dryRun = false, trialId = testCase.name } = {}) {
	if (dryRun) {
		const snapshotId = createHash("sha256").update(`dry-run:${testCase.name}:${trialId}`).digest("hex");
		return {
			snapshotId,
			flows: { cwd: process.cwd() },
			plain: { cwd: process.cwd() },
			dispose() {},
		};
	}

	const snapshot = mkdtempSync(join(tmpdir(), "pi-eval-pair-snapshot-"));
	const flows = mkdtempSync(join(tmpdir(), "pi-eval-pair-flows-"));
	const plain = mkdtempSync(join(tmpdir(), "pi-eval-pair-plain-"));
	try {
		if (testCase.workspace) testCase.setupWorkspace?.(snapshot, { arm: "paired" });
		else if (testCase.cwd) copyDirectory(testCase.cwd, snapshot);
		const snapshotId = snapshotDigest(snapshot);
		copyDirectory(snapshot, flows);
		copyDirectory(snapshot, plain);
		return {
			snapshotId,
			flows: { cwd: flows },
			plain: { cwd: plain },
			dispose() {
				for (const directory of [snapshot, flows, plain]) rmSync(directory, { recursive: true, force: true });
			},
		};
	} catch (error) {
		for (const directory of [snapshot, flows, plain]) rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}
