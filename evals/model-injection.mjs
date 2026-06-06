export function injectModel(params, model) {
	const p = structuredClone(params);
	const ref = (r) => { if (r && typeof r === "object" && !r.model) r.model = model; };
	if (p.agent && !p.model) p.model = model;
	for (const t of p.tasks ?? []) ref(t);
	for (const s of p.chain ?? []) ref(s);
	if (p.evaluate) {
		ref(p.evaluate.operator);
		const critics = Array.isArray(p.evaluate.redteam) ? p.evaluate.redteam : [p.evaluate.redteam];
		critics.forEach(ref);
	}
	if (p.vote) {
		if (Array.isArray(p.vote.voters) && p.vote.voters.length > 0) {
			p.vote.voters.forEach(ref);
		} else if (p.vote.agent) {
			const count = Number.isFinite(p.vote.count) ? Math.floor(p.vote.count) : 3;
			p.vote.voters = Array.from({ length: count }, () => ({ agent: p.vote.agent, model }));
			delete p.vote.agent;
			delete p.vote.count;
		}
		ref(p.vote.debrief);
	}
	if (p.route) ref(p.route.controller);
	if (p.orchestrate) for (const k of ["commander", "recon", "debrief", "verify"]) ref(p.orchestrate[k]);
	return p;
}
