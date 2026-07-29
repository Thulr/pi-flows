import { open, unlink } from "node:fs/promises";

export async function withExclusiveFileLock(lockPath, operation) {
	let lock;
	try {
		lock = await open(lockPath, "wx", 0o600);
		return await operation();
	} catch (error) {
		if (error.code === "EEXIST") throw new Error("failure ledger is locked by another writer");
		throw error;
	} finally {
		await lock?.close();
		if (lock) await unlink(lockPath).catch(() => {});
	}
}
