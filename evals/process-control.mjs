export function createProcessTerminator(proc, { isClosed = () => false, graceMs = 5_000 } = {}) {
	let forceKillTimer = null;
	const boundedGraceMs = Number.isFinite(graceMs) ? Math.max(0, Math.floor(graceMs)) : 5_000;
	return {
		stop() {
			if (isClosed()) return;
			try { proc.kill("SIGTERM"); } catch {}
			if (forceKillTimer) return;
			forceKillTimer = setTimeout(() => {
				forceKillTimer = null;
				try { if (!isClosed()) proc.kill("SIGKILL"); } catch {}
			}, boundedGraceMs);
			forceKillTimer.unref?.();
		},
		dispose() {
			if (forceKillTimer) clearTimeout(forceKillTimer);
			forceKillTimer = null;
		},
	};
}
