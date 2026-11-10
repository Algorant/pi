/**
 * Inline `ask_me` screen managed by Pi's custom UI lifecycle.
 *
 * The full rationale is rendered in the transcript before this component
 * opens. The screen only restates the focused question and lists choices,
 * with detail for the selected option.
 *
 * Rendering lives here; question state lives in `pending.ts`.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	CURSOR_MARKER,
	decodeKittyPrintable,
	ScrollView,
	Key,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
	truncateToWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import type { AskMeQuestion } from "./index";
import { AskMePending, AskMePendingScope, type AskMeOutcome } from "./pending";

const ASK_ME_PAINT_KEY = "pi-ask-me:rationale-paint";

/** Label for the always-available freeform escape. */
export const FREEFORM_LABEL = "Other…";

export type AskMeWaitOptions = {
	/** Scope owned by the extension instance. Direct callers get an isolated scope. */
	scope?: AskMePendingScope;
};

/** The Pi UI methods used to paint the rationale and mount the inline screen. */
export type AskMeUiHost = Pick<ExtensionContext["ui"], "custom" | "setWidget">;

export type AskMePromptComponent = Component & Focusable & { dispose(): void };

type PromptMode = "options" | "freeform";

/**
 * Wrap `text` to the available width and emit it with per-line prefixes.
 *
 * Wrapping measures plain text and styling is applied afterwards, so no line is
 * ever cut short while building content. The screen viewport scrolls the result.
 */
function pushBlock(
	lines: string[],
	text: string,
	width: number,
	style: (value: string) => string,
	firstPrefix: string,
	restPrefix: string,
	prefixWidth: number,
): void {
	const wrapWidth = Math.max(4, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(text, wrapWidth);
	if (wrapped.length === 0) wrapped.push("");
	for (let index = 0; index < wrapped.length; index++) {
		lines.push((index === 0 ? firstPrefix : restPrefix) + style(wrapped[index] ?? ""));
	}
}

export function createAskMePrompt(
	tui: TUI,
	theme: Theme,
	pending: AskMePending,
): AskMePromptComponent {
	const fg = (tone: string, value: string) => theme.fg(tone as never, value);
	const bold = (value: string) => (typeof theme.bold === "function" ? theme.bold(value) : value);

	// Use Pi's editor so answers wrap at the prompt width, keep cursor-aware
	// editing, and scroll inside the editor's bounded viewport.
	const input = new Editor(tui, {
		borderColor: (value) => fg("border", value),
		selectList: {
			selectedPrefix: (value) => fg("mdLink", value),
			selectedText: (value) => fg("mdLink", value),
			description: (value) => fg("muted", value),
			scrollInfo: (value) => fg("dim", value),
			noMatch: (value) => fg("warning", value),
		},
	});
	const drafts = new Map<number, string>();
	const multi = pending.total > 1;

	let current = 0;
	let optionIndex = 0;
	let mode: PromptMode = "options";
	let notice = "";
	let focused = false;
	let followSelection = false;
	let sizeBlocked = false;
	let choiceRange = { start: 0, end: 0 };
	let bodyLines: string[] = [];
	const viewport = new ScrollView({
		render: () => bodyLines,
		invalidate() {},
	}, { scrollbar: "hidden", overscroll: "contain" });

	function question(): AskMeQuestion | undefined {
		return pending.questionAt(current);
	}

	function isPureFreeform(target: AskMeQuestion): boolean {
		return target.options.length === 0;
	}

	function rowCount(target: AskMeQuestion): number {
		return target.options.length + (target.allowFreeform ? 1 : 0);
	}

	function refresh(): void {
		tui.requestRender();
	}

	function syncFocus(): void {
		input.focused = focused && mode === "freeform";
	}

	function saveDraft(): void {
		const value = input.getText();
		if (value) drafts.set(current, value);
		else drafts.delete(current);
	}

	function enterQuestion(index: number): void {
		saveDraft();
		current = index;
		const answer = pending.answerAt(index);
		optionIndex = answer?.kind === "selection" ? (answer.optionIndex ?? 1) - 1 : 0;
		notice = "";
		const target = question();
		mode = target && (isPureFreeform(target) || answer?.kind === "freeform") ? "freeform" : "options";
		input.setText(drafts.get(current) ?? answer?.text ?? "");
		followSelection = mode === "freeform" || answer !== undefined;
		viewport.scrollToStart();
		syncFocus();
		refresh();
	}

	function advance(): void {
		const next = pending.nextUnansweredIndex(current);
		if (next < 0) {
			pending.complete();
			return;
		}
		enterQuestion(next);
	}

	function commitSelection(target: AskMeQuestion, index: number): void {
		const option = target.options[index];
		if (!option) return;
		pending.setAnswer(current, {
			questionIndex: current,
			...(target.id ? { id: target.id } : {}),
			question: target.question,
			kind: "selection",
			selection: option.title,
			optionIndex: index + 1,
		});
		advance();
	}

	function commitFreeform(target: AskMeQuestion, text: string): void {
		const trimmed = text.trim();
		if (!trimmed) {
			notice = target.options.length > 0
				? "Type an answer, or press Esc to go back to the choices."
				: "Type an answer, or press Esc to decline.";
			refresh();
			return;
		}
		pending.setAnswer(current, {
			questionIndex: current,
			...(target.id ? { id: target.id } : {}),
			question: target.question,
			kind: "freeform",
			text: trimmed,
		});
		drafts.delete(current);
		input.setText("");
		advance();
	}

	input.onSubmit = (value: string) => {
		const target = question();
		if (target) commitFreeform(target, value);
	};

	const onEscape = () => {
		const target = question();
		if (target && !isPureFreeform(target)) {
			mode = "options";
			optionIndex = Math.max(0, target.options.length - 1);
			notice = "";
			syncFocus();
			refresh();
			return;
		}
		pending.reject("declined");
	};

	const unsubscribe = pending.onChange(() => refresh());

	// Initial mode depends on whether the first question has options at all.
	const firstQuestion = question();
	if (firstQuestion && isPureFreeform(firstQuestion)) {
		mode = "freeform";
		followSelection = true;
	}

	function tabLabels(): string[] {
		return pending.questions.map((item, index) => {
			const label = `${index + 1} ${item.header || `Q${index + 1}`} ${pending.isAnsweredAt(index) ? "✓" : "○"}`;
			if (index === current) return bold(fg("mdLink", label));
			return fg(pending.isAnsweredAt(index) ? "success" : "dim", label);
		});
	}

	/**
	 * One rule carrying the chip, the question tabs and the answered counter.
	 * Tabs move to their own line only when the rule is too narrow for them.
	 */
	function topRule(width: number): string[] {
		const ruleWidth = Math.max(8, width);
		// Keep the label on the transparent rule. The user-message token supplies
		// the theme's blue contrast without painting a panel behind the chip.
		const chip = fg("mdLink", " ask_me ");
		const counter = fg("dim", ` ${pending.answeredCount} of ${pending.total} answered `);
		const tabs = multi ? ` ${tabLabels().join("   ")} ` : "";
		const rule = (middle: string) => {
			const gap = ruleWidth - 2 - visibleWidth(chip) - visibleWidth(middle) - visibleWidth(counter);
			return gap >= 1 ? fg("border", "─") + chip + middle + fg("border", "─".repeat(gap)) + counter + fg("border", "─") : undefined;
		};
		const combined = rule(tabs ? fg("border", "─") + tabs : "");
		if (combined) return [combined];
		const plain = rule("") ?? fg("border", "─") + chip + fg("border", "─");
		if (!multi) return [plain];
		return [plain, ...wrapTextWithAnsi(tabLabels().join("   "), Math.max(1, width - 1)).map((line) => ` ${line}`)];
	}

	/** One hint line: essential keys always, optional ones only while they fit. */
	function hintText(target: AskMeQuestion, width: number): string {
		const esc = mode === "freeform" && target.options.length > 0 ? "Esc choices" : "Esc decline";
		const essential = mode === "freeform" ? ["Enter answer", esc] : ["↑↓ choose", "Enter answer", esc];
		const optional = [
			...(mode === "options" && target.allowFreeform ? ["type for custom"] : []),
			...(multi ? ["Tab next"] : []),
			tui.mode === "fullscreen" ? "PgUp/PgDn chat" : "scrollback for chat",
		];
		const parts = [...essential];
		for (const part of optional) {
			const candidate = [...parts.slice(0, -1), part, parts[parts.length - 1]];
			if (visibleWidth(` ${candidate.join(" · ")}`) <= width) parts.splice(parts.length - 1, 0, part);
		}
		return parts.join(" · ");
	}

	function render(width: number): string[] {
		if (pending.isSettled) return [];
		const target = question();
		if (!target) return [];

		const body = Math.max(8, width);
		const lines: string[] = [];

		const budget = Math.floor(tui.terminal.rows * 0.3);
		const top = topRule(body);
		// Keep only the question fixed; all rationale already lives in the
		// conversation. Following choices must not hide the question wording.
		const questionLines: string[] = [];
		pushBlock(questionLines, target.question, body, (value) => bold(fg("text", value)), " ", " ", 1);
		sizeBlocked = top.length + questionLines.length + 2 > budget;
		if (sizeBlocked) {
			return wrapTextWithAnsi("Enlarge the terminal to show the question and choices. Esc cancels.", Math.max(1, width))
				.slice(0, budget).map((line) => fg("warning", line));
		}

		if (mode === "options") {
			for (let index = 0; index < target.options.length; index++) {
				const option = target.options[index];
				const active = index === optionIndex;
				const start = lines.length;
				const title = active ? bold(fg("mdLink", option.title)) : fg("text", option.title);
				// Only the highlighted choice needs a short detail here. The full
				// explanation and comparison were shown before opening the dialog.
				const text = title + (active && option.description ? fg("muted", ` — ${option.description}`) : "");
				pushBlock(lines, text, body, (value) => value, active ? fg("mdLink", " › ") : "   ", "   ", 3);
				if (active) choiceRange = { start, end: lines.length };
			}
			if (target.allowFreeform && target.options.length > 0) {
				const active = optionIndex === target.options.length;
				const start = lines.length;
				pushBlock(lines, FREEFORM_LABEL, body,
					active ? (value) => bold(fg("mdLink", value)) : (value) => fg("dim", value),
					active ? fg("mdLink", " › ") : "   ", "   ", 3);
				if (active) choiceRange = { start, end: lines.length };
			}
		}

		if (mode === "freeform") {
			const start = lines.length;
			const editorLines = input.render(Math.max(4, body - 1));
			for (const line of editorLines) lines.push(` ${line}`);
			// Follow the actual cursor, not the whole editor: on short terminals
			// the editor itself may be taller than the screen viewport.
			const cursorLine = Math.max(0, editorLines.findIndex((line) => line.includes(CURSOR_MARKER)));
			choiceRange = { start: start + cursorLine, end: start + cursorLine + 1 };
		}

		if (notice) {
			lines.push("");
			pushBlock(lines, notice, body, (value) => fg("warning", value), " ", " ", 1);
			choiceRange.end = lines.length;
		}

		const hintLines: string[] = [];
		pushBlock(hintLines, hintText(target, body), body, (value) => fg("dim", value), " ", " ", 1);
		// The 30% limit includes all chrome. Blank rows separate the tabs,
		// question, choices and hints when they fit; they are the first thing
		// given up on a short terminal, before choices start scrolling.
		const hints = hintLines.slice(0, Math.max(0, budget - top.length - questionLines.length - 1));
		const fixed = top.length + questionLines.length + hints.length;
		const scrolling = fixed + lines.length > budget;
		// When choices scroll, one row carries the scroll indicator instead of a gap.
		const gaps = scrolling ? 0 : Math.min(3, budget - fixed - lines.length);
		// The indicator is dropped on the tightest terminals so a choice always fits.
		const showIndicator = scrolling && budget - fixed - 1 >= 1;
		const height = scrolling ? budget - fixed - (showIndicator ? 1 : 0) : lines.length;
		bodyLines = lines;
		viewport.updateLayout(lines.length, height, refresh);
		if (followSelection) {
			if (choiceRange.start < viewport.scrollTop) viewport.scrollTo(choiceRange.start);
			else if (choiceRange.end > viewport.scrollTop + height) viewport.scrollTo(Math.max(choiceRange.start, choiceRange.end - height));
		}
		const visible = viewport.render(body).slice(viewport.scrollTop, viewport.scrollTop + height);
		// Priority order for spacing: question→choices, choices→hints, tabs→question.
		const gapAfterQuestion = gaps >= 1 ? [""] : [];
		const gapBeforeHints = gaps >= 2 ? [""] : [];
		const gapAfterTop = gaps >= 3 ? [""] : [];
		const indicator = showIndicator
			? [fg("dim", `   ${viewport.scrollTop > 0 ? "↑ " : ""}${viewport.scrollTop + height < lines.length ? "↓ " : ""}more ${mode === "options" ? "choices" : "input"} · Shift+↑↓ scroll`)]
			: [];
		// No bottom rule: the editor's own border directly follows the dialog.
		return [...top, ...gapAfterTop, ...questionLines, ...gapAfterQuestion, ...visible, ...indicator, ...gapBeforeHints, ...hints]
			.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	function handleInput(data: string): void {
		if (pending.isSettled) return;
		const target = question();
		if (!target) return;
		// Never accept an answer when its decision text cannot be displayed.
		if (sizeBlocked) {
			if (matchesKey(data, Key.escape)) pending.reject("declined");
			return;
		}

		// Viewport scroll keys are consumed by Pi's own input listener before they
		// reach a focused non-overlay component, so the transcript stays navigable
		// while this prompt holds focus. Nothing here binds PageUp/PageDown.
		// Ctrl+Up/Down belong to Pi’s fullscreen transcript prompt navigation.
		if (matchesKey(data, Key.shift("up")) || matchesKey(data, Key.shift("down"))) {
			followSelection = false;
			viewport.scrollBy(matchesKey(data, Key.shift("up")) ? -1 : 1);
			refresh();
			return;
		}
		if (multi) {
			if (matchesKey(data, Key.shift("tab"))) {
				enterQuestion((current - 1 + pending.total) % pending.total);
				return;
			}
			if (matchesKey(data, Key.tab)) {
				enterQuestion((current + 1) % pending.total);
				return;
			}
		}

		if (mode === "freeform") {
			if (matchesKey(data, Key.escape)) {
				onEscape();
				return;
			}
			input.handleInput(data);
			followSelection = true;
			refresh();
			return;
		}

		if (matchesKey(data, Key.up)) {
			optionIndex = Math.max(0, optionIndex - 1);
			followSelection = true;
			notice = "";
			refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			optionIndex = Math.min(Math.max(0, rowCount(target) - 1), optionIndex + 1);
			followSelection = true;
			notice = "";
			refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (target.allowFreeform && optionIndex === target.options.length) {
				mode = "freeform";
				followSelection = true;
				notice = "";
				syncFocus();
				refresh();
				return;
			}
			commitSelection(target, optionIndex);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			pending.reject("declined");
			return;
		}
		// A chooser that silently swallows typing looks frozen. Start a custom
		// answer on printable input or paste, preserving the very first character.
		const isText = decodeKittyPrintable(data) !== undefined
			|| /^[^\u0000-\u001f\u007f-\u009f]+$/u.test(data)
			|| data.includes("\x1b[200~");
		if (target.allowFreeform && isText) {
			mode = "freeform";
			followSelection = true;
			notice = "";
			syncFocus();
			input.handleInput(data);
			refresh();
		}
	}

	return {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			syncFocus();
		},
		render,
		handleInput,
		invalidate: () => {
			input.invalidate?.();
		},
		dispose: () => {
			unsubscribe();
			// The widget can be torn down without the caller ever being answered
			// (session teardown, extension reload). Never leave the tool suspended.
			pending.reject("shutdown");
		},
	};
}

/**
 * Show the inline prompt and resolve with a tagged outcome.
 *
 * Always resolves. Declining, aborting, and session teardown each produce a
 * rejection variant rather than an unsettled promise.
 */
export async function runAskMe(
	ui: AskMeUiHost,
	questions: AskMeQuestion[],
	signal?: AbortSignal,
	waitOptions: AskMeWaitOptions = {},
): Promise<AskMeOutcome> {
	const scope = waitOptions.scope ?? new AskMePendingScope();
	const ownsScope = !waitOptions.scope;
	const pending = scope.create(questions);

	if (signal?.aborted) {
		pending.reject("aborted");
		if (ownsScope) scope.dispose();
		return pending.promise;
	}

	const onAbort = () => pending.reject("aborted");
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		try {
			// Paint the full Markdown rationale BEFORE opening the inline screen.
			// sendMessage cannot do this: Pi queues it until the tool turn ends.
			try {
				ui.setWidget(ASK_ME_PAINT_KEY, (tui) => {
					tui.renderNow();
					return { render: () => [], invalidate() {} };
				});
			} finally {
				ui.setWidget(ASK_ME_PAINT_KEY, undefined);
			}

			await ui.custom<void>((tui, theme, _keybindings, done) => {
				const prompt = createAskMePrompt(tui, theme, pending);
				const removeCompletionListener = pending.onChange(() => {
					if (pending.isSettled) done(undefined);
				});
				if (pending.isSettled) done(undefined);
				return {
					get focused() { return prompt.focused; },
					set focused(value: boolean) { prompt.focused = value; },
					render: (width: number) => prompt.render(width),
					handleInput: (data: string) => prompt.handleInput(data),
					invalidate: () => prompt.invalidate(),
					dispose() {
						removeCompletionListener();
						prompt.dispose();
					},
				};
			}, {
				blocked: { kind: "question", message: questions[0]!.question.slice(0, 160) },
			});
		} catch {
			pending.reject("unavailable");
		}
		return await pending.promise;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (ownsScope) scope.dispose();
	}
}
