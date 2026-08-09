/**
 * The budget half of the child-run seam: every decision the runner takes
 * because of a Budget — the pre-spawn refusal, the mid-stream hard stop, the
 * soft wrap-up request, how a budget-owned outcome settles the result, and the
 * budget events the trace records. Split from runner.ts so the process adapter
 * stays about the subprocess and this module stays about the ceilings; the
 * decisions themselves belong to Budget (budget.ts) — this object only asks.
 */
import { budgetAttributes } from "./trace-attributes.ts";
import type { Budget, ChildSpanScope, FlowError, FlowRunResult, RecordEvent, UsageStats } from "./types.ts";

/**
 * The live children currently armed on each budget. A soft-threshold
 * transition is a fact about the *budget*, not about the child whose settled
 * turn happened to cross it — a sibling mid-turn on the same shared ceiling
 * has the same claim to the steer, and waiting for its own next turn to settle
 * may be exactly one turn too late.
 */
const liveChildren = new WeakMap<Budget, Set<ChildBudgets>>();

export class ChildBudgets {
	/**
	 * The budget decision that stopped this run: which budget, and whether it
	 * was exhausted or could not be enforced at all. One value rather than a
	 * flag pair plus a separate budget reference, because those three could
	 * disagree — a turn arriving between `terminate()` and the child actually
	 * exiting used to be able to clear the budget while the flag stayed latched.
	 */
	private budgetStop?: { budget: Budget; reason: "exhausted" | "unobservable"; error: FlowError };
	/**
	 * The budget that asked this child to wrap up, latched at the moment its
	 * soft threshold crossed. Once set, a later exhaustion is treated as the
	 * paid-for envelope turn arriving, not as a failure: the child was already
	 * told to stop, so its final text goes on to envelope validation instead of
	 * being forfeited with the run.
	 */
	private wrapUp?: Budget;
	/** The notice text actually landed in the wrap-up file, kept for the delivery comparison below. */
	private notice?: string;
	/**
	 * Whether the requested notice observably reached the child session — the
	 * runner saw it echoed back as a user message. Requesting is not receiving:
	 * a child running without extensions never sees the wrap-up file, and
	 * settling its breach gracefully would return arbitrary truncated output as
	 * success. Without this confirmation, exhaustion stays fatal.
	 */
	private noticeDelivered = false;
	/** How the runner lands this child's notice (its wrap-up file). Set by `arm`, cleared by `release`. */
	private deliver?: (notice: string) => void;

	constructor(
		private readonly budgets: Budget[],
		private readonly recordEvent: RecordEvent | undefined,
		private readonly scope: ChildSpanScope | undefined,
	) {}

	/** Whether any budget governs this child — the wrap-up channel is offered only then. */
	get governed(): boolean {
		return this.budgets.length > 0;
	}

	/**
	 * Flow or contract ceiling: refuse to spawn once the applicable budget is
	 * spent. Everything downstream — the event's authority, its attribute
	 * prefix, the error's label and ceiling — comes from the budget that
	 * refused, so a contract-bound refusal can never be reported as a
	 * flow-budget one. A refusal spawns nothing, so it produces no child span;
	 * without the event the trace would simply be missing a child and look
	 * like loss.
	 */
	refuseSpawn(agentName: string): FlowError | undefined {
		const exhausted = this.budgets.find((budget) => budget.refusesSpawn());
		if (!exhausted) return undefined;
		this.recordEvent?.({
			kind: "budget",
			name: "child.refused",
			ok: false,
			scope: this.scope,
			attributes: {
				"flow.budget.refused_agent": agentName,
				"flow.budget.authority": exhausted.authority,
				...budgetAttributes(exhausted.snapshot()),
			},
		});
		return exhausted.exhaustedError();
	}

	/**
	 * Join the wrap-up channel: register on every governing budget so a
	 * soft-threshold transition any sibling's turn crosses steers this child
	 * too, and steer immediately when a shared ceiling is already inside the
	 * window — a child spawned at 85% must find its notice on the first poll,
	 * not after a settled turn that may already have crossed the hard ceiling.
	 */
	arm(deliver: (notice: string) => void): void {
		this.deliver = deliver;
		// Never steer a child a budget would already hard-stop: nearsLiveStop
		// stays true past the ceiling, and such a child gets stopped, not a
		// notice — nor a seat on the channel a later transition would steer.
		// (A spent spawn-only gate is the caller's refusal to make, and both
		// callers refuse before arming.)
		if (this.budgets.some((budget) => budget.stopsLiveRun())) return;
		for (const budget of this.budgets) {
			let siblings = liveChildren.get(budget);
			if (!siblings) liveChildren.set(budget, siblings = new Set());
			siblings.add(this);
		}
		const near = this.budgets.find((budget) => budget.nearsLiveStop());
		if (near) this.latchWrapUp(near);
	}

	/** Leave the wrap-up channel. The run is over (or refused): later transitions on a shared budget must not write into its reclaimed temp dir. */
	release(): void {
		for (const budget of this.budgets) liveChildren.get(budget)?.delete(this);
		this.deliver = undefined;
	}

	/**
	 * One budget's soft threshold crossed: steer every live child it governs,
	 * not only the one whose turn settled. Only inside the window — a budget at
	 * or past a ceiling that stops live runs would let spend on an exhausted
	 * budget settle gracefully. The screen is `stopsLiveRun`, not `refusesSpawn`:
	 * a flow's spent total-token ceiling only gates later spawns, and the
	 * children legitimately still running under it keep their claim to a steer
	 * when a generated or cost ceiling enters its window.
	 */
	private static steerLiveChildren(budget: Budget): void {
		if (budget.stopsLiveRun()) return;
		for (const child of liveChildren.get(budget) ?? []) child.latchWrapUp(budget);
	}

	/** Latch this child's wrap-up against `budget` and land its notice, once; a child already stopping or steered keeps its first notice. */
	private latchWrapUp(budget: Budget): void {
		if (this.wrapUp || this.budgetStop) return;
		this.wrapUp = budget;
		this.notice = budget.wrapUpNotice();
		this.deliver?.(this.notice);
	}

	/**
	 * A user message from the child's stream that may be the steered notice
	 * echoed back. Delivery is confirmed only by the latched notice appearing
	 * verbatim — a bare marker quoted in ordinary task or handoff text (one
	 * steered child's output riding into a sibling's prompt under the same
	 * shared budget) must not pre-arm graceful settling.
	 */
	confirmDelivery(echoedText: string): void {
		if (this.notice && echoedText.includes(this.notice)) this.noticeDelivered = true;
	}

	/**
	 * Charge one settled turn and decide the mid-stream action, which the caller
	 * carries out: `terminate` stops the child. A soft threshold this turn
	 * crosses is not returned but broadcast — every live child on the crossing
	 * budget (this one included, via its armed channel) is steered at the same
	 * moment. The hard stop is latched on the first decision to stop: a turn
	 * that arrives after `terminate()` must not overwrite the budget that caused
	 * it, and the error is built HERE, not at settle time — a budget keeps
	 * charging for turns that arrive between `terminate()` and the child
	 * actually exiting, so a ceiling crossed only afterwards could otherwise
	 * out-rank the one that caused the stop. The soft threshold is checked
	 * strictly after the hard one: a turn that crosses both at once latches the
	 * stop and never asks for a wrap-up there was no headroom to honor.
	 */
	chargeTurn(turnUsage: UsageStats, healthy: boolean): { terminate?: boolean } {
		for (const budget of this.budgets) budget.charge(turnUsage);
		let terminate = false;
		if (healthy && !this.budgetStop) {
			const unenforceable = turnUsage.costKnown === false ? this.budgets.find((budget) => budget.enforcesCost) : undefined;
			// Which ceilings bite mid-stream depends on the budget's authority;
			// the budget decides, this module only asks. See Budget.stopsLiveRun.
			const stopped = unenforceable ?? this.budgets.find((budget) => budget.stopsLiveRun());
			if (stopped) {
				this.budgetStop = {
					budget: stopped,
					reason: unenforceable ? "unobservable" : "exhausted",
					error: unenforceable ? stopped.unobservableError() : stopped.exhaustedError(),
				};
				terminate = true;
			}
		}
		// Broadcast EVERY governing budget inside the wrap-up window, whatever
		// this child's own state — even a turn that just latched this child's
		// stop, and even an errored turn (the hard stop above is healthy-only,
		// but an errored turn's metered usage moves shared ceilings all the
		// same, and the sibling it endangers deserves the steer either way).
		// A child stopped by its contract still carries the flow ceiling its
		// siblings share, and skipping the broadcast here would steer them one
		// turn late. Per-child dedup lives in latchWrapUp (a stopping child
		// never self-steers); the exhausted case is screened inside
		// steerLiveChildren.
		for (const budget of this.budgets) {
			if (budget.nearsLiveStop()) ChildBudgets.steerLiveChildren(budget);
		}
		return terminate ? { terminate: true } : {};
	}

	/**
	 * Apply a budget-owned outcome to the result; false when no budget stopped
	 * this run and the ordinary exit-code cascade should decide instead.
	 *
	 * A ceiling crossed after the wrap-up notice demonstrably reached the child
	 * is the paid-for envelope turn arriving, not a failure: the child is still
	 * terminated so the spend stays bounded, but the run settles gracefully and
	 * its final text goes on to envelope validation instead of being forfeited
	 * (issue #104). A notice merely requested — never seen echoed into the
	 * child session — keeps the hard stop, and an unobservable budget always
	 * does: spend that cannot be metered cannot be graciously settled either.
	 */
	settle(result: FlowRunResult): boolean {
		if (!this.budgetStop) return false;
		if (this.graceful) {
			result.exitCode = 0;
			result.stopReason = "budget_wrap_up";
			return true;
		}
		result.exitCode = 1;
		result.stopReason = this.budgetStop.reason === "unobservable" ? "budget_unobservable" : "budget_exceeded";
		result.error = this.budgetStop.error;
		result.errorMessage = result.error.message;
		return true;
	}

	/** Trace evidence for the wrap-up request and the termination, each its own unit linked to the child (the span owns the child's key). */
	recordOutcome(agentName: string): void {
		if (this.wrapUp) {
			this.recordEvent?.({
				kind: "budget",
				name: "child.wrap_up",
				scope: this.eventScope("wrapup"),
				attributes: {
					"flow.budget.wrapup_agent": agentName,
					"flow.budget.authority": this.wrapUp.authority,
					"flow.budget.wrapup_delivered": this.noticeDelivered,
					...budgetAttributes(this.wrapUp.snapshot()),
				},
			});
		}
		if (this.budgetStop) {
			this.recordEvent?.({
				kind: "budget",
				name: this.budgetStop.reason === "unobservable" ? "child.unobservable" : "child.exhausted",
				ok: false,
				scope: this.eventScope("budget"),
				attributes: {
					"flow.budget.terminated_agent": agentName,
					"flow.budget.authority": this.budgetStop.budget.authority,
					// True when the exhaustion settled a steered wrap-up instead of
					// forfeiting the run — the trace must distinguish salvage from loss.
					...(this.graceful ? { "flow.budget.graceful": true } : {}),
					...budgetAttributes(this.budgetStop.budget.snapshot()),
				},
			});
		}
	}

	private get graceful(): boolean {
		return this.budgetStop?.reason === "exhausted" && this.wrapUp !== undefined && this.noticeDelivered;
	}

	private eventScope(unit: string): ChildSpanScope | undefined {
		return this.scope?.key
			? { stage: this.scope.stage, key: `${this.scope.key}.${unit}`, dependsOn: [this.scope.key] }
			: this.scope;
	}
}
