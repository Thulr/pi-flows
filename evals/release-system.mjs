import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import path from "node:path";
import { releaseDigest } from "./release-manifest.mjs";

function git(root, args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function trackedFiles(root, directories) {
	const output = execFileSync("git", ["ls-files", "-z", "--", ...directories], { cwd: root });
	return output.toString("utf8").split("\0").filter(Boolean).sort();
}

function fileHashes(root, files) {
	return Object.fromEntries(files.map((file) => [file, sha256File(path.join(root, file))]));
}

function aggregate(files) {
	return releaseDigest(files);
}

export function captureReleaseSystem(root) {
	const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const packageLock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
	const typesSource = readFileSync(path.join(root, "extensions/pi-flows/types.ts"), "utf8");
	const extensionVersion = typesSource.match(/PI_FLOWS_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? null;
	const promptFiles = trackedFiles(root, ["agents"]).filter((file) => file.endsWith(".md"));
	const promptHashes = fileHashes(root, promptFiles);
	const topologyFiles = trackedFiles(root, ["extensions/pi-flows/modes", "extensions/pi-flows/topology.ts"]);
	const harnessFiles = trackedFiles(root, ["evals"]).filter((file) => file.endsWith(".mjs"));
	const suiteFiles = trackedFiles(root, ["evals/cases.mjs", "evals/pattern-cases.mjs", "evals/selection-cases.mjs", "evals/case-contract.mjs", "evals/fixtures"]);
	return {
		code: {
			commit: git(root, ["rev-parse", "HEAD"]),
			dirty: git(root, ["status", "--porcelain"]).length > 0,
		},
		package: {
			name: packageJson.name,
			version: packageJson.version,
			extensionVersion,
			lockfileVersion: packageLock.lockfileVersion,
			packageManager: packageJson.packageManager ?? null,
		},
		hashes: {
			prompts: { aggregate: aggregate(promptHashes), files: promptHashes },
			toolSchema: sha256File(path.join(root, "extensions/pi-flows/schema.ts")),
			topology: aggregate(fileHashes(root, topologyFiles)),
			harness: aggregate(fileHashes(root, harnessFiles)),
			suite: aggregate(fileHashes(root, suiteFiles)),
		},
		environment: {
			node: process.version,
			npm: execFileSync("npm", ["--version"], { cwd: root, encoding: "utf8" }).trim(),
			platform: platform(),
			arch: arch(),
			ci: Boolean(process.env.CI),
		},
	};
}
