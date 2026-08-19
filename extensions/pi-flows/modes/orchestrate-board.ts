import type { Decomposition, DecompositionSubtask } from "../decomposition.ts";
import { sanitizeText } from "../sanitize.ts";
import type { CapturePolicy } from "../types.ts";
import { makeOrchestrateUnits, notCompletedManifest, subtaskSummaryText, type OrchestrateUnit, type UnitOutcome } from "./orchestrate-outcomes.ts";

/**
 * Orchestrate's outcome board: the live state of one Decomposition under
 * dispatch — every unit, the undispatched remainder, how each settled, and the
 * two ordered collections a settled wave feeds (the consumed handoff keys the
 * synthesizer's span depends on, and the finding sections its prompt carries).
 *
 * Before this module those five collections were raw `Map`s and arrays passed
 * by reference between the handler and the replanner, which each derived
 * `stateOf` for itself and each mutated the other's state. The board is the one
 * home for every transition, so a state can only be set together with the
 * evidence that belongs to it and the replan swap cannot be left half-done.
 *
 * What a dispatchable unit and a settled outcome *are* stays in
 * orchestrate-outcomes.ts; this module owns how the set of them changes.
 */

/** One settled subtask as a wave reports it. Exactly one of `failureText` / `handoffText` is meaningful: a failed run has no handoff to carry. */
export interface SettledSubtask {
	readonly unit: OrchestrateUnit;
	/** Present when the run failed — the text the manifest reports. */
	readonly failureText?: string;
	/** The validated handoff text a succeeded subtask produced. */
	readonly handoffText?: string;
	/** That handoff's dependency key, when it has one. */
	readonly handoffKey?: string;
}

/** The settled-subtask identities a replan critique reports back to the commander. */
export interface SettledIdentity {
	readonly id: string;
	readonly objective: string;
}

/**
 * The live board for one flow's Decomposition. Constructed at plan revision 1
 * and replaced in part — never rebuilt — by the one bounded mid-flow replan.
 */
export class OrchestrateBoard {
	readonly #units: OrchestrateUnit[];
	readonly #remaining: Map<string, OrchestrateUnit>;
	readonly #outcomes = new Map<string, UnitOutcome>();
	readonly #consumedKeys: string[] = [];
	readonly #findingSections: string[] = [];
	readonly #policy: CapturePolicy;

	private constructor(units: OrchestrateUnit[], policy: CapturePolicy) {
		this.#units = units;
		this.#remaining = new Map(units.map((unit) => [unit.subtask.id, unit]));
		this.#policy = policy;
	}

	/** Open a board over an admitted Decomposition, at plan revision 1. */
	static open(decomposition: Decomposition, policy: CapturePolicy): OrchestrateBoard {
		return new OrchestrateBoard(makeOrchestrateUnits(decomposition, 1), policy);
	}

	/** Every unit the flow has dispatched or will dispatch, in plan order. */
	get units(): readonly OrchestrateUnit[] {
		return this.#units;
	}

	/** Whether any subtask is still undispatched. The wave loop's condition. */
	get hasRemainingWork(): boolean {
		return this.#remaining.size > 0;
	}

	/** How many subtasks have settled, for the live "n/N workers settled" status. */
	get settledCount(): number {
		return this.#outcomes.size;
	}

	/** How one subtask settled, or undefined while it has not. */
	stateOf(id: string): UnitOutcome["state"] | undefined {
		return this.#outcomes.get(id)?.state;
	}

	/** A succeeded subtask's validated handoff text, for a dependent's prompt. */
	outputTextOf(id: string): string | undefined {
		const outcome = this.#outcomes.get(id);
		return outcome?.state === "succeeded" ? outcome.outputText : undefined;
	}

	/** A succeeded subtask's handoff dependency key, for a dependent's span link. */
	outputKeyOf(id: string): string | undefined {
		const outcome = this.#outcomes.get(id);
		return outcome?.state === "succeeded" ? outcome.outputKey : undefined;
	}

	/**
	 * The remaining subtasks whose every dependency has SUCCEEDED — the next
	 * wave. A dependency that failed or stranded never releases its dependents,
	 * which is what makes an empty ready set with work remaining the stranding
	 * signal rather than a cycle (cycles are refused before dispatch).
	 */
	ready(): OrchestrateUnit[] {
		return [...this.#remaining.values()].filter((unit) => unit.subtask.dependsOn.every((dependency) => this.stateOf(dependency) === "succeeded"));
	}

	/** The undispatched subtasks, for a revision prompt or a headroom projection. */
	remainderSubtasks(): DecompositionSubtask[] {
		return [...this.#remaining.values()].map((unit) => unit.subtask);
	}

	/**
	 * Record one settled wave as a single transition. The handler cannot set an
	 * outcome without the evidence that belongs to it, and the two ordered
	 * collections a succeeded subtask feeds are appended here rather than beside
	 * the loop that used to own them.
	 */
	recordWave(settled: readonly SettledSubtask[]): void {
		for (const { unit, failureText, handoffText, handoffKey } of settled) {
			const id = unit.subtask.id;
			this.#remaining.delete(id);
			if (failureText !== undefined) {
				this.#outcomes.set(id, { state: "failed", failureText });
				continue;
			}
			const outputText = handoffText ?? "";
			this.#outcomes.set(id, { state: "succeeded", outputText, ...(handoffKey ? { outputKey: handoffKey } : {}) });
			if (handoffKey) this.#consumedKeys.push(handoffKey);
			this.#findingSections.push(`### Subtask ${unit.label}: ${sanitizeText(unit.subtask.objective, this.#policy, 2 * 1024)}\n\n${outputText}`);
		}
	}

	/**
	 * Strand every remaining subtask on the dependency that blocked it. Used when
	 * nothing is runnable and no replan remains: each names the first dependency
	 * of its own that did not succeed.
	 */
	strandBlocked(): void {
		for (const unit of this.#remaining.values()) {
			// `find` is undefined only if every dependency succeeded, which cannot
			// hold for a remaining unit while the ready set is empty. The optional
			// field keeps that unreachable case rendering as the unnamed blocker the
			// manifest has always reported, rather than inventing a reason for it.
			this.#outcomes.set(unit.subtask.id, { state: "stranded", strandedOn: unit.subtask.dependsOn.find((dependency) => this.stateOf(dependency) !== "succeeded") });
		}
		this.#remaining.clear();
	}

	/** Strand the whole remainder with one reason — a spent ceiling, or a refused replacement. */
	strandRemaining(reason: string): void {
		for (const unit of this.#remaining.values()) this.#outcomes.set(unit.subtask.id, { state: "stranded", strandedReason: reason });
		this.#remaining.clear();
	}

	/**
	 * Swap the remainder for a replan's replacement, as one transition.
	 *
	 * A failed id that reappears in the replacement supersedes its failed
	 * attempt: its outcome is cleared so the fresh unit stands, and the trace
	 * keeps the failed plan-1 span as the record of the first try. Every unit
	 * this retires leaves `units` in the same statement that adds the
	 * replacement, so no caller can observe the board between the two.
	 */
	replaceRemainder(replacement: Decomposition): readonly OrchestrateUnit[] {
		const retired = new Set(this.#remaining.keys());
		this.#remaining.clear();
		for (const subtask of replacement.subtasks) {
			if (this.#outcomes.get(subtask.id)?.state === "failed") {
				this.#outcomes.delete(subtask.id);
				retired.add(subtask.id);
			}
		}
		for (let index = this.#units.length - 1; index >= 0; index -= 1) {
			if (retired.has(this.#units[index]!.subtask.id)) this.#units.splice(index, 1);
		}
		const revisionUnits = makeOrchestrateUnits(replacement, 2);
		this.#units.push(...revisionUnits);
		for (const unit of revisionUnits) this.#remaining.set(unit.subtask.id, unit);
		return revisionUnits;
	}

	/** The ids a replacement may declare as already satisfied dependencies. */
	succeededIds(): Set<string> {
		return new Set(this.#units.filter((unit) => this.stateOf(unit.subtask.id) === "succeeded").map((unit) => unit.subtask.id));
	}

	/** Settled units in one state, as the replan critique names them. */
	settledByState(state: UnitOutcome["state"]): SettledIdentity[] {
		return this.#units
			.filter((unit) => !this.#remaining.has(unit.subtask.id) && this.stateOf(unit.subtask.id) === state)
			.map((unit) => ({ id: unit.subtask.id, objective: unit.subtask.objective }));
	}

	/** How the Decomposition settled, counted once for every surface that reports it. */
	counts(): { succeeded: number; failed: number; stranded: number } {
		const count = (state: UnitOutcome["state"]) => this.#units.filter((unit) => this.stateOf(unit.subtask.id) === state).length;
		return { succeeded: count("succeeded"), failed: count("failed"), stranded: count("stranded") };
	}

	/**
	 * Whether any subtask nothing else depends on succeeded. A Decomposition
	 * whose terminal work all failed has nothing to synthesize, however many
	 * intermediate subtasks succeeded.
	 */
	anyTerminalSucceeded(): boolean {
		const dependedOn = new Set(this.#units.flatMap((unit) => [...unit.subtask.dependsOn]));
		return this.#units.some((unit) => !dependedOn.has(unit.subtask.id) && this.stateOf(unit.subtask.id) === "succeeded");
	}

	/** The synthesizer prompt's findings, in the order the waves produced them. */
	findings(): string {
		return this.#findingSections.join("\n\n---\n\n");
	}

	/** The handoff keys the synthesis span depends on — only the workers whose findings reached it. */
	consumedKeys(): readonly string[] {
		return this.#consumedKeys;
	}

	/** The settled-counts summary every header and refusal footer reads. */
	summaryText(): string {
		return subtaskSummaryText(this.#units, (id) => this.stateOf(id));
	}

	/** The manifest naming work that did not complete, so a merged answer cannot quietly omit it. */
	notCompleted(): string {
		return notCompletedManifest(this.#units, this.#outcomes, this.#policy);
	}
}
