/**
 * Everything the capture flow decides in code: the keyword override, the
 * priority defaults, the standard acceptance criterion, the board threshold and
 * the Jev questions. Jev only answers the questions; it never sets a number or a rule.
 *
 * Wording, the duplicate threshold and the top-two cut are first guesses. Bump
 * QUESTIONS_VERSION whenever the wording changes so log lines stay comparable.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const QUESTIONS_VERSION = "task-capture-v2";

export type Kind = "papercut" | "task" | "research";
export const KINDS: readonly Kind[] = ["papercut", "task", "research"];

export const STANDARD_ACCEPTANCE = "Scope and acceptance criteria are refined at triage before work begins.";

/** Probability a candidate needs before it is offered as a possible duplicate. */
export const DUPLICATE_THRESHOLD = 0.2;
export const MAX_DUPLICATES = 2;

/** Probability another board needs before /task files there instead of on the current board. */
export const BOARD_THRESHOLD = 0.6;

export type TaskRef = { id: string; title: string };
export type Duplicate = TaskRef & { probability: number };

export type ClassifierContext = Parameters<ExtensionContext["modelRegistry"]["classify"]>[1];

const PREFIX = /^\s*(papercut|research|task)\s*:\s*/i;

/**
 * Keyword override.
 * - A leading `papercut:`, `research:` or `task:` sets the kind and is stripped from the title.
 * - Otherwise "papercut" or "research" anywhere (word boundary) sets the kind.
 * - Both of those words, or neither, leave the kind to Jev. The bare word "task"
 *   only counts as a prefix, because it is common in ordinary sentences.
 */
export function parseSentence(raw: string): { title: string; kind?: Kind } {
	const text = raw.trim();
	const prefix = PREFIX.exec(text);
	if (prefix) return { title: text.slice(prefix[0].length).trim(), kind: prefix[1].toLowerCase() as Kind };
	const papercut = /\bpapercut\b/i.test(text);
	const research = /\bresearch\b/i.test(text);
	if (papercut !== research) return { title: text, kind: papercut ? "papercut" : "research" };
	return { title: text };
}

export function priorityFor(kind: Kind): "low" | "medium" {
	return kind === "papercut" ? "low" : "medium";
}

const DUPLICATE_INSTRUCTIONS =
	"Does `sentence` describe the same piece of work as one of the existing Tasks in the criteria? " +
	"Pick a Task only when it is clearly the same problem or request. " +
	"Pick `none` when the sentence is new work, even if it touches the same area.";

const KIND_INSTRUCTIONS = "What kind of Tandem Task should `sentence` become?";

const KIND_CRITERIA: Record<Kind, string> = {
	papercut: "A small annoyance, glitch or bit of friction to fix later; low urgency",
	task: "A concrete piece of work to implement, fix or change",
	research: "A question to investigate or compare before deciding what to do",
};

const BOARD_INSTRUCTIONS =
	"Which project board should the Task described by `sentence` be filed on? " +
	"Pick another project only when the sentence names it (or its Ceph, the agent that runs it) or is clearly about its work. " +
	"Otherwise pick the first option, the board of the session the sentence was typed in.";

/** A candidate board as Jev sees it; the current board comes first because Jev leans toward the first option. */
export type BoardOption = { key: string; description: string };

/** First call: which board (when there is a choice) and which kind (when the keyword override did not decide). */
export function buildFileContext(title: string, boards: BoardOption[], askKind: boolean): ClassifierContext {
	const questions: ClassifierContext["questions"] = {};
	if (boards.length > 1) {
		const criteria: Record<string, string> = {};
		for (const board of boards) criteria[board.key] = board.description;
		questions.workspace = { type: "choice", instructions: BOARD_INSTRUCTIONS, criteria };
	}
	if (askKind) questions.kind = { type: "choice", instructions: KIND_INSTRUCTIONS, criteria: { ...KIND_CRITERIA } };
	return { state: { sentence: title }, questions };
}

/** Second call, once the target board is known: is the sentence already one of its active Tasks? `none` goes last. */
export function buildDuplicateContext(title: string, tasks: TaskRef[]): ClassifierContext {
	const criteria: Record<string, string> = {};
	for (const task of tasks) criteria[task.id] = task.title;
	criteria.none = "None of the existing Tasks; this is new work";
	return { state: { sentence: title }, questions: { duplicate: { type: "choice", instructions: DUPLICATE_INSTRUCTIONS, criteria } } };
}

/** The most probable real Tasks (not `none`) at or above the threshold. */
export function pickDuplicates(probabilities: Record<string, number>, tasks: TaskRef[]): Duplicate[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	return Object.entries(probabilities)
		.flatMap(([id, probability]) => {
			const task = byId.get(id);
			return task && probability >= DUPLICATE_THRESHOLD ? [{ ...task, probability }] : [];
		})
		.sort((a, b) => b.probability - a.probability)
		.slice(0, MAX_DUPLICATES);
}
