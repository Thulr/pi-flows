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
	 * A budget already inside the wrap-up window before this child's first turn
	 * — a shared flow ceiling other children have been spending against — latches
	 * the wrap-up now and returns the notice, so the child finds it on its first
	 * poll instead of only after a settled turn that may already have crossed
	 * the hard ceiling.
	 */
	wrapUpAtSpawn(): string | undefined {
		if (!this.wrapUp) {
			this.wrapUp = this.budgets.find((budget) => budget.nearsLiveStop());
			if (this.wrapUp) this.notice = this.wrapUp.wrapUpNotice();
		}
		return this.notice;
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
	 * carries out: `terminate` stops the child; `wrapUpNotice` (returned once per
	 * run, on the turn its budget latched) is delivered into the child. The hard
	 * stop is latched on the first decision to stop: a turn that arrives after
	 * `terminate()` must not overwrite the budget that caused it, and the error
	 * is built HERE, not at settle time — a budget keeps charging for turns that
	 * arrive between `terminate()` and the child actually exiting, so a ceiling
	 * crossed only afterwards could otherwise out-rank the one that caused the
	 * stop. The soft threshold is checked strictly after the hard one: a turn
	 * that crosses both at once latches the stop and never asks for a wrap-up
	 * there was no headroom to honor.
	 */
	chargeTurn(turnUsage: UsageStats, healthy: boolean): { terminate?: boolean; wrapUpNotice?: string } {
		for (const budget of this.budgets) budget.charge(turnUsage);
		if (!healthy) return {};
		if (!this.budgetStop) {
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
				return { terminate: true };
			}
		}
		if (!this.budgetStop && !this.wrapUp) {
			this.wrapUp = this.budgets.find((budget) => budget.nearsLiveStop());
			if (this.wrapUp) {
				this.notice = this.wrapUp.wrapUpNotice();
				return { wrapUpNotice: this.notice };
			}
		}
		return {};
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
