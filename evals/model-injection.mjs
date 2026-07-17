export function injectModel(params, model) {
	const p = structuredClone(params);
	const ref = (r) => { if (r && typeof r === "object" && !r.model) r.model = model; };
	if (!p.model) p.model = model;
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
	if (p.graph) {
		for (const node of p.graph.nodes ?? []) ref(node);
		ref(p.graph.debrief);
	}
	if (p.loop) for (const k of ["body", "judge"]) ref(p.loop[k]);
	if (p.search) for (const k of ["generator", "scorer", "debrief"]) ref(p.search[k]);
	if (p.workflow) {
		for (const phase of p.workflow.phases ?? []) ref(phase);
		ref(p.workflow.debrief);
	}
	if (p.worktree) {
		for (const task of p.worktree.tasks ?? []) ref(task);
		ref(p.worktree.integrator);
	}
	if (p.debate) {
		for (const participant of p.debate.participants ?? []) ref(participant);
		ref(p.debate.adjudicator);
	}
	if (p.dossier) {
		for (const section of p.dossier.sections ?? []) ref(section);
		ref(p.dossier.debrief);
	}
	if (p.monitor) ref(p.monitor.reactor);
	return p;
}
