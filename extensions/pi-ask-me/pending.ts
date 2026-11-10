/**
 * Pending-question state for `ask_me`.
 *
 * This module owns request state only. It has no TUI imports and no rendering
 * concerns, so the inline screen in `ui.ts` can be replaced without touching
 * the question lifecycle. Callers await a single deferred value and always
 * receive a tagged outcome, never an unresolved promise.
 */

import type { AskMeAnswer, AskMeQuestion } from "./index";

/** Why a question ended without a complete set of answers. */
export type AskMeRejectionReason = "declined" | "aborted" | "shutdown" | "unavailable";

export interface AskMeAnswered {
	status: "answered";
	questions: AskMeQuestion[];
	answers: AskMeAnswer[];
}

export interface AskMeRejected {
	status: "rejected";
	reason: AskMeRejectionReason;
	message: string;
	questions: AskMeQuestion[];
	/** Answers collected before the rejection. May be empty. */
	answers: AskMeAnswer[];
}

/** Tagged result for answered and rejected question lifecycles. */
export type AskMeOutcome = AskMeAnswered | AskMeRejected;

export const REJECTION_MESSAGES: Record<AskMeRejectionReason, string> = {
	declined: "User declined to answer the ask_me questions.",
	aborted: "The ask_me request was aborted before the user answered.",
	shutdown: "The Pi session was torn down before the user answered.",
	unavailable: "No interactive Pi surface was available to show the ask_me questions.",
};

export function isAnswered(outcome: AskMeOutcome): outcome is AskMeAnswered {
	return outcome.status === "answered";
}

export function isRejected(outcome: AskMeOutcome): outcome is AskMeRejected {
	return outcome.status === "rejected";
}

/**
 * Owns the pending requests for one extension/session lifetime.
 *
 * The registry is deliberately instance-owned. Two independent extension
 * consumers cannot reject or count each other's requests during shutdown or
 * tests.
 */
export class AskMePendingScope {
	private readonly active = new Set<AskMePending>();

	create(questions: AskMeQuestion[]): AskMePending {
		return new AskMePending(questions, this);
	}

	/** Reject every unsettled question in this scope. */
	rejectAll(reason: AskMeRejectionReason = "shutdown"): number {
		const pending = Array.from(this.active);
		let rejected = 0;
		for (const question of pending) {
			if (question.reject(reason)) rejected += 1;
		}
		return rejected;
	}

	/** End this scope and release every pending caller. */
	dispose(): number {
		return this.rejectAll("shutdown");
	}

	get activeCount(): number {
		return this.active.size;
	}

	/** @internal */
	register(question: AskMePending): void {
		this.active.add(question);
	}

	/** @internal */
	unregister(question: AskMePending): void {
		this.active.delete(question);
	}
}

export class AskMePending {
	readonly questions: AskMeQuestion[];
	readonly promise: Promise<AskMeOutcome>;

	private readonly answers = new Map<number, AskMeAnswer>();
	private readonly changeListeners = new Set<() => void>();
	private settle!: (outcome: AskMeOutcome) => void;
	private settled = false;
	private readonly scope: AskMePendingScope | undefined;

	constructor(questions: AskMeQuestion[], scope?: AskMePendingScope) {
		this.questions = questions;
		this.scope = scope;
		this.promise = new Promise<AskMeOutcome>((resolve) => {
			this.settle = resolve;
		});
		scope?.register(this);
	}

	get isSettled(): boolean {
		return this.settled;
	}

	get total(): number {
		return this.questions.length;
	}

	get answeredCount(): number {
		return this.answers.size;
	}

	/** Subscribe to answer changes. Returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	questionAt(index: number): AskMeQuestion | undefined {
		return this.questions[index];
	}

	answerAt(index: number): AskMeAnswer | undefined {
		return this.answers.get(index);
	}

	isAnsweredAt(index: number): boolean {
		return this.answers.has(index);
	}

	allAnswered(): boolean {
		return this.questions.every((_question, index) => this.answers.has(index));
	}

	/** Index of the first unanswered question, or -1 when every question is answered. */
	firstUnansweredIndex(): number {
		return this.questions.findIndex((_question, index) => !this.answers.has(index));
	}

	/**
	 * Next unanswered question at or after `from`, wrapping around.
	 * Returns -1 when every question is answered.
	 */
	nextUnansweredIndex(from: number): number {
		const total = this.questions.length;
		for (let step = 1; step <= total; step++) {
			const index = (from + step) % total;
			if (!this.answers.has(index)) return index;
		}
		return -1;
	}

	/** Answers in question order. */
	collectAnswers(): AskMeAnswer[] {
		return Array.from(this.answers.values()).sort((a, b) => a.questionIndex - b.questionIndex);
	}

	setAnswer(index: number, answer: AskMeAnswer): void {
		if (this.settled) return;
		this.answers.set(index, answer);
		this.emitChange();
	}

	clearAnswer(index: number): void {
		if (this.settled) return;
		if (this.answers.delete(index)) this.emitChange();
	}

	/** Resolve with the collected answers. Returns false when already settled. */
	complete(): boolean {
		return this.finish({
			status: "answered",
			questions: this.questions,
			answers: this.collectAnswers(),
		});
	}

	/** Resolve with a tagged rejection. Returns false when already settled. */
	reject(reason: AskMeRejectionReason): boolean {
		return this.finish({
			status: "rejected",
			reason,
			message: REJECTION_MESSAGES[reason],
			questions: this.questions,
			answers: this.collectAnswers(),
		});
	}

	private finish(outcome: AskMeOutcome): boolean {
		if (this.settled) return false;
		this.settled = true;
		this.scope?.unregister(this);
		this.emitChange();
		this.changeListeners.clear();
		this.settle(outcome);
		return true;
	}

	private emitChange(): void {
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch {
				// A failing observer must not break the question lifecycle.
			}
		}
	}
}
